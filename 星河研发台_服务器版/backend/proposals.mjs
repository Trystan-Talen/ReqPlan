import { randomUUID, createHash } from 'node:crypto';
import { businessError } from './business.mjs';
import { transaction, writeAudit } from './database.mjs';
import { normalizeDocumentLinks } from './document-links.mjs';

export const PROPOSAL_STATUSES = ['待评估', '评估中', '待补充', '暂缓', '不采纳', '已转需求'];
const CONTENT_FIELDS = ['title', 'description', 'acceptance', 'priority', 'source', 'proposerName', 'docRefs', 'acceptanceCases'];
const SUBMITTER_ROLES = ['product', 'lead', 'developer', 'tester'];
const EARLY = new Set(['未确定', '待评审']);
const fail = (status, message, code = 'VALIDATION_ERROR') => { throw businessError(status, message, code); };
const stamp = () => new Date().toISOString();
const fingerprint = value => createHash('sha256').update(JSON.stringify(JSON.parse(value))).digest('hex');
function inputRecord(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail(400, '提交内容必须是普通对象');
  for (const key of Object.keys(input)) if (!fields.includes(key)) fail(400, `不支持的字段：${key}`);
}
function text(value, label, max = 200, required = false) {
  value ??= '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, `${label}格式不正确或超过长度限制`);
  value = value.trim(); if (required && !value) fail(400, `请填写${label}`); return value;
}
function identifier(value) {
  const result = text(value, '记录编号', 100, true);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) fail(400, '记录编号格式不正确');
  return result;
}
function expectedVersion(value, version) {
  if (!Number.isSafeInteger(version) || version < 1) fail(400, '编辑时必须提交当前版本号', 'VERSION_REQUIRED');
  if (value.version !== version) fail(409, '内容已被其他人修改，请重新载入后操作', 'VERSION_CONFLICT');
}
function validate(input, previous = {}) {
  const data = { ...previous };
  for (const key of CONTENT_FIELDS) if (Object.hasOwn(input, key)) data[key] = input[key];
  data.title = text(data.title, '提议标题', 200, true);
  data.description = text(data.description, '背景与目标', 20000);
  data.acceptance = text(data.acceptance, '验收标准', 20000);
  data.source = text(data.source, '提议来源', 200);
  data.proposerName = text(data.proposerName, '提出人', 200, true);
  data.priority ||= 'P1';
  if (!['P0', 'P1', 'P2'].includes(data.priority)) fail(400, '优先级不是允许的选项');
  Object.assign(data, normalizeDocumentLinks(data));
  return data;
}

export function createProposalService(db, business) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  function access(actor, projectId, write = false) {
    const project = business.getProject(actor, projectId);
    const user = get('SELECT id,name,role,executive FROM users WHERE id=?', actor.id);
    const membership = get('SELECT role FROM memberships WHERE project_id=? AND user_id=?', projectId, user.id);
    const role = user.role === 'admin' ? 'admin' : membership?.role || 'executive';
    if (write && role !== 'admin' && !SUBMITTER_ROLES.includes(role)) fail(403, '当前项目角色只能查看需求提议', 'FORBIDDEN');
    if (write && project.archived) fail(409, '项目已归档，请先恢复项目', 'ARCHIVED');
    return { user, role, project };
  }
  function value(row) {
    const data = JSON.parse(row.data), legacy = row.legacy_requirement_id && data.status !== '已转需求' ? get('SELECT archived,data FROM requirements WHERE id=?', row.legacy_requirement_id) : null;
    const original = legacy ? JSON.parse(legacy.data) : {};
    // Older proposal overlays did not store these fields. Inherit only missing
    // values from their original requirement; explicit empty arrays mean removal.
    const docRefs = data.docRefs === undefined ? original.docRefs ?? [] : data.docRefs;
    const acceptanceCases = data.acceptanceCases === undefined ? original.acceptanceCases ?? [] : data.acceptanceCases;
    return { ...data, docRefs, acceptanceCases, id: row.id, projectId: row.project_id, createdBy: row.created_by || '', requirementId: row.requirement_id || '', legacyRequirementId: row.legacy_requirement_id || '', version: Number(row.version), archived: Boolean(row.archived || legacy?.archived), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function legacyValue(row) {
    const requirement = JSON.parse(row.data);
    const createdBy = get("SELECT user_id FROM audit WHERE entity_type='requirement' AND entity_id=? AND action='create' ORDER BY id LIMIT 1", row.id)?.user_id || requirement.createdBy || requirement.ownerId || '';
    const creator = createdBy && get('SELECT name FROM users WHERE id=?', createdBy);
    return { id: row.id, projectId: row.project_id, title: requirement.title || '', description: requirement.description || '', acceptance: requirement.acceptance || '', docRefs: requirement.docRefs ?? [], acceptanceCases: requirement.acceptanceCases ?? [], priority: requirement.priority || 'P1', source: requirement.source || '历史需求', proposerName: creator?.name || '历史提出人', createdBy: createdBy || '', status: requirement.status === '待评审' ? '评估中' : '待评估', decisionReason: '', requirementId: '', legacyRequirementId: row.id, legacyVersion: Number(row.version), legacyFingerprint: fingerprint(row.data), version: Number(row.version), archived: Boolean(row.archived), createdAt: requirement.createdAt || row.created_at, updatedAt: row.updated_at };
  }
  function find(id) {
    identifier(id);
    const saved = get('SELECT * FROM proposals WHERE id=?', id);
    if (saved) return value(saved);
    const old = get('SELECT * FROM requirements WHERE id=?', id);
    if (old && EARLY.has(JSON.parse(old.data).status)) return legacyValue(old);
    fail(404, '需求提议不存在', 'NOT_FOUND');
  }
  function read(actor, id) { const item = find(id); access(actor, item.projectId); return item; }
  function list(actor, { projectId, includeArchived = false } = {}) {
    if (projectId) access(actor, identifier(projectId));
    const ids = new Set(business.listProjects(actor, { includeArchived }).filter(project => !projectId || project.id === projectId).map(project => project.id));
    const saved = all('SELECT * FROM proposals').filter(row => ids.has(row.project_id)).map(value).filter(item => includeArchived || !item.archived);
    const overlays = new Set(all('SELECT legacy_requirement_id FROM proposals WHERE legacy_requirement_id IS NOT NULL').map(row => row.legacy_requirement_id));
    const legacy = all('SELECT * FROM requirements').filter(row => ids.has(row.project_id) && (includeArchived || !row.archived) && !overlays.has(row.id) && EARLY.has(JSON.parse(row.data).status)).map(legacyValue);
    return [...saved, ...legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  function audit(user, action, before, after, reason = '') {
    writeAudit(db, user.id, action, 'proposal', after.id, { projectId: after.projectId, actorName: user.name, ...(before ? { before } : {}), after, reason });
  }
  function insert(item, version = 1) {
    db.prepare('INSERT INTO proposals(id,project_id,data,created_by,requirement_id,legacy_requirement_id,version,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(item.id, item.projectId, JSON.stringify(item), item.createdBy || null, item.requirementId || null, item.legacyRequirementId || null, version, item.archived ? 1 : 0, item.createdAt, item.updatedAt);
    return value(get('SELECT * FROM proposals WHERE id=?', item.id));
  }
  function persist(before, after) {
    if (before.legacyRequirementId && before.status !== '已转需求') {
      const legacy = get('SELECT version,archived,data FROM requirements WHERE id=?', before.legacyRequirementId);
      if (!legacy || legacy.archived) fail(409, '原需求已归档，请先恢复', 'ARCHIVED');
      if (fingerprint(legacy.data) !== before.legacyFingerprint || !EARLY.has(JSON.parse(legacy.data).status)) fail(409, '历史需求内容已在其他入口修改，请联系管理员核对后处理', 'VERSION_CONFLICT');
    }
    return save(before, after);
  }
  function save(before, after) {
    after = { ...after, updatedAt: stamp() };
    const row = get('SELECT * FROM proposals WHERE id=?', before.id);
    if (!row) return insert(after, before.version + 1);
    const result = db.prepare('UPDATE proposals SET data=?,requirement_id=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(JSON.stringify(after), after.requirementId || null, after.updatedAt, before.id, before.version);
    if (result.changes !== 1) fail(409, '内容已被其他人修改，请重新载入后操作', 'VERSION_CONFLICT');
    return value(get('SELECT * FROM proposals WHERE id=?', before.id));
  }
  function create(actor, input) {
    inputRecord(input, ['projectId', ...CONTENT_FIELDS]);
    return transaction(db, () => {
      const projectId = identifier(input.projectId), { user } = access(actor, projectId, true), time = stamp();
      const data = validate({ proposerName: user.name, ...input });
      const result = insert({ ...data, id: `q-${randomUUID()}`, projectId, createdBy: user.id, status: '待评估', decisionReason: '', createdAt: time, updatedAt: time });
      audit(user, 'create', null, result); return result;
    });
  }
  function update(actor, id, input) {
    inputRecord(input, [...CONTENT_FIELDS, 'version', 'status', 'decisionReason']);
    return transaction(db, () => {
      const before = find(id), { user, role } = access(actor, before.projectId, true);
      expectedVersion(before, input.version);
      if (before.archived) fail(409, '需求提议已归档，请先恢复', 'ARCHIVED');
      if (before.status === '已转需求') fail(409, '提议已转入需求池，请在关联需求中修改', 'PROPOSAL_CONVERTED');
      const evaluating = ['admin', 'product'].includes(role);
      if (!evaluating && (before.createdBy !== user.id || !['待评估', '待补充'].includes(before.status))) fail(403, '只能修改本人待评估或待补充的提议', 'FORBIDDEN');
      if (!evaluating && (Object.hasOwn(input, 'status') || Object.hasOwn(input, 'decisionReason'))) fail(403, '评估状态和结论由产品经理维护', 'FORBIDDEN');
      const data = validate(input, before);
      if (Object.hasOwn(input, 'status')) {
        if (!PROPOSAL_STATUSES.slice(0, -1).includes(input.status)) fail(400, '请通过确认转需求操作纳入需求池');
        data.status = input.status;
      }
      if (Object.hasOwn(input, 'decisionReason')) data.decisionReason = text(input.decisionReason, '评估说明', 2000);
      if (data.status !== before.status && ['待补充', '暂缓', '不采纳'].includes(data.status)) data.decisionReason = text(input.decisionReason, '评估说明', 2000, true);
      if (!evaluating && before.status === '待补充') { data.status = '待评估'; data.decisionReason = '提出人已补充，等待产品评估。'; }
      const result = persist(before, data);
      audit(user, before.status === data.status ? 'update' : 'transition', before, result, data.decisionReason); return result;
    });
  }
  function approve(actor, id, input) {
    inputRecord(input, [...CONTENT_FIELDS, 'version', 'decisionReason', 'ownerId']);
    return transaction(db, () => {
      const before = find(id), { user, role } = access(actor, before.projectId, true);
      if (!['admin', 'product'].includes(role)) fail(403, '只有产品经理或系统管理员可以确认转需求', 'FORBIDDEN');
      // An authorized retry returns the original linked record; it can never create a duplicate.
      if (before.status === '已转需求') return { proposal: before, requirement: business.getRequirement(actor, before.requirementId), replayed: true };
      expectedVersion(before, input.version);
      if (before.archived) fail(409, '需求提议已归档，请先恢复', 'ARCHIVED');
      const data = validate(input, before);
      text(data.description, '背景与目标', 20000, true); text(data.acceptance, '验收标准', 20000, true);
      data.decisionReason = text(input.decisionReason || '评估通过，确认纳入研发需求池。', '评估说明', 2000, true);
      const requirementInput = { projectId: before.projectId, title: data.title, description: data.description, acceptance: data.acceptance, priority: data.priority, source: data.source || '需求提议', docRefs: data.docRefs, acceptanceCases: data.acceptanceCases, ...(input.ownerId ? { ownerId: input.ownerId } : {}) };
      let requirement;
      if (before.legacyRequirementId) {
        const legacy = get('SELECT version,archived,data FROM requirements WHERE id=?', before.legacyRequirementId);
        if (!legacy || fingerprint(legacy.data) !== before.legacyFingerprint || !EARLY.has(JSON.parse(legacy.data).status)) fail(409, '历史需求内容已在其他入口修改，请联系管理员核对后处理', 'VERSION_CONFLICT');
        requirement = business.confirmLegacyRequirement(actor, before.legacyRequirementId, { ...requirementInput, version: legacy.version, originProposalId: before.id, ...(before.createdBy ? { originSubmittedBy: before.createdBy } : {}) });
      } else requirement = business.createRequirementFromProposal(actor, requirementInput, { proposalId: before.id, submittedBy: before.createdBy });
      const result = save(before, { ...data, status: '已转需求', requirementId: requirement.id, approvedBy: user.id, approvedAt: stamp() });
      audit(user, 'approve', before, result, data.decisionReason);
      return { proposal: result, requirement, replayed: false };
    });
  }
  function history(actor, id) {
    const item = read(actor, id);
    const entries = business.listHistory(actor, { entityType: 'proposal', entityId: item.id, limit: 200 });
    if (item.legacyRequirementId) entries.push(...business.listHistory(actor, { entityType: 'requirement', entityId: item.legacyRequirementId, limit: 200 }));
    return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || Number(b.id) - Number(a.id)).slice(0, 200);
  }
  return { list, read, create, update, approve, history };
}
