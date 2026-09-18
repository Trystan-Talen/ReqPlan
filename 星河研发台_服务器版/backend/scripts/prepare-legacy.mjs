import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, extname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const SENSITIVE = /password|token|secret|credential|salt|key/i;
const USER_FIELDS = ['id', 'username', 'name', 'role', 'title', 'active'];
const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json' };
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const technical = name => name.startsWith('.') || ['node_modules', '__MACOSX'].includes(name);
function cleanHistory(value, secrets) {
  if (Array.isArray(value)) return value.map(item => cleanHistory(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, item]) => [key, cleanHistory(item, secrets)]));
  if (typeof value === 'string' && secrets.some(secret => value.includes(secret))) return '[已移除敏感内容]';
  return value;
}
function safeBaseUrl(value) {
  if (value === '') return '';
  if (typeof value !== 'string') fail('原模型服务地址不是文本');
  let url; try { url = new URL(value); } catch { fail('原模型服务地址不是有效网址'); }
  url.username = ''; url.password = ''; url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (SENSITIVE.test(key)) url.searchParams.delete(key);
  // Leave an already safe source address byte-for-byte unchanged.
  return url.href === new URL(value).href ? value : url.href;
}

export function prepareLegacy({ source, output, dryRun = false } = {}) {
  if (!source || !output) fail('必须指定 --source 原数据库与 --output 新目录中的快照文件');
  const sourcePath = realpathSync(resolve(source)); const outputPath = resolve(output); const outputDirectory = dirname(outputPath);
  if (!statSync(sourcePath).isFile()) fail('原数据库必须是文件');
  if (existsSync(outputDirectory) || existsSync(outputPath)) fail('输出目录必须尚不存在，拒绝覆盖既有内容');
  const bytes = readFileSync(sourcePath); let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { fail('原数据库不是有效的结构化数据'); }
  for (const key of ['projects', 'requirements', 'tasks', 'users']) if (!Array.isArray(raw[key])) fail(`原数据库缺少 ${key} 集合`);
  const ids = new Set();
  for (const collection of ['projects', 'requirements', 'tasks', 'users']) for (const item of raw[collection]) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item.id) || ids.has(item.id)) fail('原数据库包含重复或非法记录编号');
    ids.add(item.id);
  }
  const projectIds = new Set(raw.projects.map(item => item.id)); const requirements = new Map(raw.requirements.map(item => [item.id, item])); const userIds = new Set(raw.users.map(item => item.id));
  for (const row of raw.requirements) if (!projectIds.has(row.projectId)) fail('需求关联项目不存在');
  for (const row of raw.tasks) if (!projectIds.has(row.projectId) || (row.requirementId && requirements.get(row.requirementId)?.projectId !== row.projectId)) fail('任务存在未知或跨项目关联');
  for (const row of [...raw.projects, ...raw.requirements, ...raw.tasks]) for (const userId of [row.ownerId, row.assigneeId, ...(row.collaboratorIds || [])]) if (userId && !userIds.has(userId)) fail('原业务存在未知人员关联');
  const secrets = [];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (SENSITIVE.test(key) && typeof child === 'string' && child) secrets.push(child); else if (child && typeof child === 'object') collect(child); }
  }
  collect(raw.settings); raw.users.forEach(collect); collect(raw.history);
  const settings = {};
  if (typeof raw.settings?.aiModel === 'string') settings.aiModel = raw.settings.aiModel;
  if (raw.settings?.aiBaseUrl !== undefined) settings.aiBaseUrl = safeBaseUrl(raw.settings.aiBaseUrl);
  const snapshot = { format: 'xinghe-legacy-v1', source: `${basename(dirname(dirname(sourcePath)))}/data/${basename(sourcePath)}`, projects: raw.projects, requirements: raw.requirements, tasks: raw.tasks, users: raw.users.map(user => Object.fromEntries(USER_FIELDS.filter(key => Object.hasOwn(user, key)).map(key => [key, user[key]]))), history: cleanHistory(raw.history || [], secrets), settings, attachments: [] };
  const dataDirectory = dirname(sourcePath); const filesDirectory = join(dataDirectory, 'files'); const copies = [];
  if (existsSync(filesDirectory)) {
    const filesRoot = realpathSync(filesDirectory); if (!inside(dataDirectory, filesRoot)) fail('附件目录指向源数据目录外部，拒绝读取');
    const visited = new Set();
    function walk(path, requestId, scope) {
      const absolute = realpathSync(path); if (!inside(filesRoot, absolute)) fail('附件符号链接指向外部路径，拒绝读取');
      const info = statSync(absolute);
      if (info.isDirectory()) {
        if (visited.has(absolute)) fail('附件目录存在循环或重复符号链接'); visited.add(absolute);
        for (const child of readdirSync(path).sort()) if (!technical(child)) walk(join(path, child), requestId, scope);
        return;
      }
      if (!info.isFile()) fail('附件不是普通文件');
      const mime = MIME[extname(path).toLowerCase()]; if (!mime) fail('原附件存在不支持的类型，未生成可能缺失内容的快照');
      if (!info.size || info.size > 2 * 1024 * 1024) fail('原附件为空或超过 2 兆字节限制');
      const content = readFileSync(absolute);
      try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content); if (decoded.includes('\0')) throw new Error(); } catch { fail('原附件不是有效的 UTF-8（统一字符编码）文本'); }
      const file = `files/${relative(filesDirectory, path).split(sep).join('/')}`;
      snapshot.attachments.push({ id: `legacy-${digest(file).slice(0,32)}`, requirementId: requestId, name: basename(path), mime, file }); copies.push({ file, content });
    }
    for (const requestId of readdirSync(filesDirectory).sort()) {
      if (technical(requestId)) continue;
      if (!requirements.has(requestId)) fail('附件目录关联了未知需求');
      const requestDirectory = join(filesDirectory, requestId); const actual = realpathSync(requestDirectory);
      if (!inside(filesRoot, actual) || !statSync(actual).isDirectory()) fail('需求附件目录不是安全的内部目录');
      for (const category of readdirSync(requestDirectory).sort()) {
        if (technical(category)) continue;
        if (!['doc','proto'].includes(category)) fail('存在未识别的附件分类，拒绝遗漏附件');
        walk(join(requestDirectory, category), requestId, category);
      }
    }
  }
  const serialized = JSON.stringify(snapshot, null, 2) + '\n';
  // Refuse rather than rewrite precise business data or attachment bytes if a
  // credential has also been pasted into a business record or original file.
  for (const secret of secrets) if (serialized.includes(secret) || copies.some(file => file.content.includes(Buffer.from(secret)))) fail('业务内容或附件包含原始凭证值，请先人工脱敏；源文件未修改');
  const result = { projects: snapshot.projects.length, requirements: snapshot.requirements.length, tasks: snapshot.tasks.length, users: snapshot.users.length, attachments: snapshot.attachments.length, businessSha256: digest(JSON.stringify({ projects: snapshot.projects, requirements: snapshot.requirements, tasks: snapshot.tasks })), sourceSha256: digest(bytes), dryRun: Boolean(dryRun) };
  if (dryRun) return result;
  mkdirSync(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(outputDirectory, { mode: 0o700 });
  try {
    for (const file of copies) { const target = join(outputDirectory, file.file); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, file.content, { flag: 'wx', mode: 0o600 }); }
    writeFileSync(outputPath, serialized, { flag: 'wx', mode: 0o600 });
  } catch (error) { rmSync(outputDirectory, { recursive: true, force: true }); throw error; }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {}; const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--source') options.source = args[++i]; else if (args[i] === '--output') options.output = args[++i]; else if (args[i] === '--dry-run') options.dryRun = true; else fail('用法：node scripts/prepare-legacy.mjs --source 原项目/data/db.json --output 新目录/legacy.json [--dry-run]');
    }
    process.stdout.write(JSON.stringify(prepareLegacy(options)) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
