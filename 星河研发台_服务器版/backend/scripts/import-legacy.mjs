import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openDatabase, transaction, writeAudit } from '../database.mjs';

export const DEFAULT_SEED = fileURLToPath(new URL('../seed/legacy.json', import.meta.url));
const KEY = 'legacy_import_v1';
const roles = { '项目管理': 'product', '管理层': 'viewer', '产品': 'product', '开发': 'developer', '测试': 'tester' };
const sha = content => createHash('sha256').update(content).digest('hex');
function fail(message) { throw new Error(message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function identifier(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) fail('迁移数据编号不合法'); return value; }
function safeSnapshot(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:password|password_hash|passwordHash|aiApiKey|apiKey|api_key|accessToken|refreshToken|token|secret|salt|credentials)$/i.test(key)) fail('迁移快照含账号密码或服务凭证，拒绝导入');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('迁移快照含不安全字段');
    safeSnapshot(item);
  }
}
function validate(snapshot) {
  if (!plain(snapshot) || snapshot.format !== 'xinghe-legacy-v1') fail('不是受支持的脱敏业务快照');
  safeSnapshot(snapshot);
  const seen = new Set();
  for (const collection of ['users', 'projects', 'requirements', 'tasks']) {
    if (!Array.isArray(snapshot[collection]) || snapshot[collection].length > 20000) fail('迁移集合缺失或数量过大');
    for (const row of snapshot[collection]) {
      if (!plain(row)) fail('迁移记录必须为普通对象'); identifier(row.id);
      if (seen.has(row.id)) fail('迁移记录编号重复'); seen.add(row.id);
    }
  }
  if (!snapshot.users.length || !snapshot.projects.length) fail('业务快照必须包含用户和项目');
  const users = new Map(snapshot.users.map(user => [user.id, user]));
  const names = new Set();
  for (const user of snapshot.users) {
    if (typeof user.username !== 'string' || !user.username.trim() || user.username.length > 100 || typeof user.name !== 'string' || !user.name.trim()) fail('用户登录名或姓名缺失');
    if (names.has(user.username.toLowerCase())) fail('用户登录名重复'); names.add(user.username.toLowerCase());
    if (!roles[user.role]) fail('原始用户角色无法映射，请人工确认');
  }
  const projects = new Set(snapshot.projects.map(project => project.id)); const requirements = new Map(snapshot.requirements.map(row => [row.id, row]));
  function person(userId) { if (userId && !users.has(userId)) fail('业务记录引用不存在的用户'); }
  for (const project of snapshot.projects) { if (typeof project.name !== 'string' || !project.name.trim()) fail('项目名称缺失'); person(project.ownerId); }
  for (const row of snapshot.requirements) {
    if (!projects.has(row.projectId) || !row.title) fail('需求项目关联或标题不正确'); person(row.ownerId); person(row.assigneeId);
    for (const userId of row.collaboratorIds || []) person(userId);
  }
  for (const row of snapshot.tasks) {
    if (!projects.has(row.projectId) || !row.title) fail('任务项目关联或标题不正确'); person(row.ownerId);
    if (row.requirementId && requirements.get(row.requirementId)?.projectId !== row.projectId) fail('任务关联需求缺失或跨项目');
    if (row.estimateHours !== undefined && (typeof row.estimateHours !== 'number' || !Number.isFinite(row.estimateHours) || row.estimateHours < 0)) fail('原工时不是有效数字');
  }
  return snapshot;
}

/** Import only into an empty database. A repeated identical source is a no-op. */
export function importLegacy(db, source = DEFAULT_SEED, options = {}) {
  const path = typeof source === 'string' ? resolve(source) : null;
  const snapshot = validate(path ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(source));
  const root = realpathSync(options.filesRoot || (path ? dirname(path) : dirname(DEFAULT_SEED)));
  const attachmentIds = new Set();
  const attachments = (snapshot.attachments || []).map(item => {
    if (!plain(item)) fail('附件索引格式错误'); identifier(item.id);
    if (attachmentIds.has(item.id)) fail('附件编号重复'); attachmentIds.add(item.id);
    const requirement = snapshot.requirements.find(row => row.id === item.requirementId); if (!requirement) fail('附件关联需求不存在');
    if (typeof item.file !== 'string' || isAbsolute(item.file)) fail('附件路径不合法');
    const absolute = realpathSync(resolve(root, item.file)); const relation = relative(root, absolute);
    if (relation === '..' || relation.startsWith('../') || isAbsolute(relation)) fail('附件越过快照目录边界');
    if (typeof item.name !== 'string' || /[\\/\u0000-\u001f]/.test(item.name) || !item.name || item.name.length > 200) fail('附件文件名不合法');
    if (!['text/plain', 'text/markdown', 'text/html', 'application/json'].includes(item.mime)) fail('附件类型不支持');
    const content = readFileSync(absolute); if (!content.length || content.length > 2 * 1024 * 1024) fail('附件必须为非空文件且不超过 2 兆字节');
    try { new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { fail('附件不是有效的统一字符编码文本'); }
    return { ...item, projectId: requirement.projectId, content, digest: sha(content) };
  });
  const digest = sha(JSON.stringify({ snapshot, attachmentDigests: attachments.map(item => ({ id: item.id, digest: item.digest })) }));
  if (options.dryRun) return { digest, projects: snapshot.projects.length, requirements: snapshot.requirements.length, tasks: snapshot.tasks.length, users: snapshot.users.length, attachments: attachments.length, dryRun: true, alreadyImported: false };
  return transaction(db, () => {
    const existing = db.prepare('SELECT value FROM app_meta WHERE key=?').get(KEY);
    if (existing) {
      const manifest = JSON.parse(existing.value); if (manifest.digest !== digest) fail('已导入另一份快照；为保护现有编辑，拒绝覆盖');
      return { ...manifest, alreadyImported: true };
    }
    for (const table of ['users', 'projects', 'requirements', 'tasks', 'memberships', 'attachments']) if (db.prepare(`SELECT count(*) n FROM ${table}`).get().n) fail('只允许向空数据库导入；现有数据未被修改');
    const stamp = new Date().toISOString();
    for (const user of snapshot.users) db.prepare('INSERT INTO users(id,username,name,role,status,password_hash,must_change_password,created_at,updated_at) VALUES(?,?,?,\'member\',\'pending\',NULL,1,?,?)').run(user.id, user.username, user.name, stamp, stamp);
    // Existing business objects are stored byte-for-value as JSON. Technical
    // import timestamps live only in SQL metadata, never invented business dates.
    for (const row of snapshot.projects) db.prepare('INSERT INTO projects(id,data,version,archived,created_at,updated_at) VALUES(?,?,1,0,?,?)').run(row.id, JSON.stringify(row), row.createdAt || '', row.updatedAt || '');
    for (const row of snapshot.requirements) db.prepare('INSERT INTO requirements(id,project_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,1,0,?,?)').run(row.id, row.projectId, JSON.stringify(row), row.createdAt || '', row.updatedAt || '');
    for (const row of snapshot.tasks) db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)').run(row.id, row.projectId, row.requirementId || null, JSON.stringify(row), row.createdAt || '', row.updatedAt || '');
    // The former application exposed all three projects to its six accounts.
    // Preserve that scope while retaining product/developer/tester distinctions;
    // no source role is silently promoted to a global administrator.
    for (const project of snapshot.projects) for (const user of snapshot.users) db.prepare('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)').run(project.id, user.id, project.ownerId === user.id ? (roles[user.role] === 'developer' ? 'lead' : 'product') : roles[user.role]);
    for (const item of attachments) db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content,version,created_at,created_by) VALUES(?,?,?,?,?,?,1,\'\',NULL)').run(item.id, item.requirementId, item.projectId, item.name, item.mime, item.content);
    const manifest = { digest, source: snapshot.source || '脱敏业务快照', importedAt: stamp, projects: snapshot.projects.length, requirements: snapshot.requirements.length, tasks: snapshot.tasks.length, users: snapshot.users.length, attachments: attachments.length, membershipPolicy: '保留原全局项目可见性：所有原用户在所有原项目按原业务角色加入，各项目负责人在自己项目担任产品经理（原开发角色担任主开发）；全部账号待激活且无密码，无自动全局管理员。' };
    for (const [key, value] of Object.entries({ [KEY]: manifest, legacy_users: snapshot.users, legacy_history: snapshot.history || [], legacy_settings: snapshot.settings || {} })) db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
    writeAudit(db, null, 'legacy_import', 'workspace', null, { digest, projects: manifest.projects, requirements: manifest.requirements, tasks: manifest.tasks, attachments: manifest.attachments });
    return { ...manifest, alreadyImported: false };
  });
}

function main() {
  const args = process.argv.slice(2); let dbPath = process.env.DATABASE_PATH || process.env.DB_PATH; let seed = DEFAULT_SEED; let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db') dbPath = args[++i]; else if (args[i] === '--seed' || args[i] === '--source') seed = args[++i]; else if (args[i] === '--dry-run') dryRun = true; else fail('用法：node scripts/import-legacy.mjs --db 数据库路径 [--source 脱敏快照路径] [--dry-run]');
  }
  if (dryRun) { process.stdout.write(JSON.stringify(importLegacy(null, seed, { dryRun: true })) + '\n'); return; }
  if (!dbPath) fail('请通过 --db 指定空数据库路径');
  const db = openDatabase(dbPath);
  try { const result = importLegacy(db, seed); process.stdout.write(JSON.stringify({ projects: result.projects, requirements: result.requirements, tasks: result.tasks, users: result.users, attachments: result.attachments, alreadyImported: result.alreadyImported }) + '\n'); }
  finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
