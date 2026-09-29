import { randomUUID, createHash } from 'node:crypto';
import { createAttachmentService } from './attachments.mjs';
import { createDocumentService } from './documents.mjs';
import { transaction as databaseTransaction } from './database.mjs';
import { normalizeDocumentLinks } from './document-links.mjs';
import { REQUIREMENT_STATUSES, TASK_STATUSES, PROJECT_ROLES, OWNER_ROLES, REVIEW_ROLES, REQUIREMENT_REVIEW_ROLES, LEAD_REQUIREMENT_FIELDS, taskStage, roleCan, checkRequirementTransition, checkTaskTransition, normalizeBaseline, taskGranularity, requirementDeliveryState } from '../frontend/workflow.js';
export { REQUIREMENT_STATUSES, TASK_STATUSES, PROJECT_ROLES } from '../frontend/workflow.js';
const REQ_FIELDS = ['title', 'description', 'acceptance', 'projectId', 'source', 'status', 'priority', 'ownerId', 'assigneeId', 'collaboratorIds', 'planStart', 'planEnd', 'estimatePoints', 'dependencyIds', 'docRefs', 'acceptanceCases'];
const TASK_FIELDS = ['title', 'projectId', 'requirementId', 'ownerId', 'status', 'startDate', 'dueDate', 'estimateHours', 'estimatePoints', 'description', 'dependencyIds'];
const PROJECT_FIELDS = ['name', 'description', 'ownerId', 'status', 'startDate', 'targetDate', 'milestones'];
const now = () => new Date().toISOString();
const uid = prefix => `${prefix}-${randomUUID()}`;
const own = (value, key) => Object.hasOwn(value, key);
export function businessError(status, message, code = 'VALIDATION_ERROR') {
  const error = new Error(message); error.status = status; error.statusCode = status; error.code = code; return error;
}
const fail = (status, message, code) => { throw businessError(status, message, code); };
function inputRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(400, '提交内容必须是普通对象');
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(400, `不支持的字段：${key}`);
  return value;
}
function text(value, name, max = 200, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, `${name}格式不正确或超过长度限制`);
  const result = value.trim(); if (required && !result) fail(400, `请填写${name}`); return result;
}
function id(value, required = true) {
  const result = text(value, '记录编号', 100, required);
  if (result && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) fail(400, '记录编号格式不正确');
  return result;
}
function date(value, label) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, `${label}应为年-月-日`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '0001-01-01') fail(400, `${label}不是有效日期`);
  return value;
}
function number(value, label, max = 100000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(400, `${label}必须为 0 至 ${max} 的数字`);
  return value;
}
function enumValue(value, values, label) { if (!values.includes(value)) fail(400, `${label}不是允许的选项`); return value; }
function dates(start, end) { if (start && end && start > end) fail(400, '截止日期不能早于开始日期'); }
function publicUser(row) { return { id: row.id, username: row.username, name: row.name, role: row.role, executive: Boolean(row.executive), status: row.status }; }
function rowValue(row) {
  if (!row) return null;
  const data = JSON.parse(row.data);
  return { ...data, id: row.id, version: Number(row.version), archived: Boolean(row.archived), updatedAt: row.updated_at };
}

export function createBusiness(db) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  // Preserve the immediate write lock at the outer boundary, and use a
  // savepoint when composing with proposal approval's surrounding transaction.
  const transaction = operation => databaseTransaction(db, operation);
  function actorUser(actor) {
    const user = actor && get('SELECT id,username,name,role,executive,status,must_change_password FROM users WHERE id=?', id(actor.id));
    if (!user || user.status !== 'active') fail(401, '请登录有效账号', 'UNAUTHENTICATED');
    if (user.must_change_password) fail(403, '请先设置或更换密码', 'PASSWORD_CHANGE_REQUIRED');
    return user;
  }
  function record(table, recordId) {
    const row = get(`SELECT * FROM ${table} WHERE id=?`, id(recordId));
    if (!row) fail(404, '记录不存在', 'NOT_FOUND');
    return row;
  }
  // Roles: 'admin' for system administrators, the membership role for members, and
  // 'executive' for managers who read every project without joining it.
  function permission(actor, projectId, allowed, allowArchived = false) {
    const user = actorUser(actor); const projectRow = record('projects', projectId);
    const membership = get('SELECT role FROM memberships WHERE project_id=? AND user_id=?', projectId, user.id);
    if (user.role !== 'admin' && !membership && !user.executive) fail(403, '无权访问该项目', 'FORBIDDEN');
    const role = user.role === 'admin' ? 'admin' : membership ? membership.role : 'executive';
    if (allowed && role !== 'admin' && !allowed.includes(role)) fail(403, '当前项目角色无权执行此操作', 'FORBIDDEN');
    if (allowed && projectRow.archived && !allowArchived) fail(409, '项目已归档，请先恢复项目', 'ARCHIVED');
    return { user, role, projectRow, project: rowValue(projectRow) };
  }
  function projectOwner(actor, projectId, allowArchived = false) {
    const access = permission(actor, projectId, null);
    if (access.role !== 'admin' && access.project.ownerId !== access.user.id) fail(403, '只有项目负责人或系统管理员可以管理项目', 'FORBIDDEN');
    if (access.projectRow.archived && !allowArchived) fail(409, '项目已归档，请先恢复项目', 'ARCHIVED');
    return access;
  }
  // A developer takes part in a requirement as its lead developer, a collaborator or a task owner.
  function participates(requirementId, userId) {
    const row = get('SELECT data FROM requirements WHERE id=?', requirementId); if (!row) return false;
    const value = JSON.parse(row.data);
    return value.assigneeId === userId || (value.collaboratorIds || []).includes(userId) || all('SELECT data FROM tasks WHERE requirement_id=? AND archived=0', requirementId).some(task => JSON.parse(task.data).ownerId === userId);
  }
  function audit(user, action, type, entityId, projectId, detail = {}) {
    run('INSERT INTO audit(user_id,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)', user.id, action, type, entityId, JSON.stringify({ projectId, ...detail, actorName: user.name }), now());
  }
  function expectedVersion(row, version) {
    if (!Number.isSafeInteger(version) || version < 1) fail(400, '编辑时必须提交当前版本号', 'VERSION_REQUIRED');
    if (row.version !== version) fail(409, '内容已被其他人修改，请重新载入后操作', 'VERSION_CONFLICT');
  }
  function updateRow(table, row, data, archived = Boolean(row.archived)) {
    const stamp = now();
    const result = run(`UPDATE ${table} SET data=?,version=version+1,archived=?,updated_at=? WHERE id=? AND version=?`, JSON.stringify(data), archived ? 1 : 0, stamp, row.id, row.version);
    if (result.changes !== 1) fail(409, '内容版本冲突，请重新载入', 'VERSION_CONFLICT');
    return rowValue(record(table, row.id));
  }
  function projectMember(projectId, userId, optional = false) {
    const value = id(userId, !optional); if (!value) return '';
    const found = get('SELECT u.status,u.role global_role,m.role project_role FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.project_id=? WHERE u.id=?', projectId, value);
    if (!found || found.status === 'disabled' || (!found.project_role && found.global_role !== 'admin')) fail(400, '负责人或协作人必须是本项目未停用的成员或系统管理员');
    return value;
  }
  function validateProject(input, previous = {}) {
    const result = { ...previous };
    for (const key of PROJECT_FIELDS) if (own(input, key)) result[key] = input[key];
    result.name = text(result.name, '项目名称', 120, true); result.description = text(result.description, '项目说明', 20000);
    result.status = enumValue(result.status || '规划中', ['规划中', '进行中', '已完成', '已终止'], '项目状态');
    result.ownerId = id(result.ownerId); result.startDate = date(result.startDate, '项目开始日期'); result.targetDate = date(result.targetDate, '项目目标日期'); dates(result.startDate, result.targetDate);
    if (!Array.isArray(result.milestones || []) || (result.milestones || []).length > 100) fail(400, '里程碑数量或格式不正确');
    result.milestones = (result.milestones || []).map(item => { inputRecord(item, ['label', 'date', 'kind']); return { label: text(item.label, '里程碑名称', 200, true), date: date(item.date, '里程碑日期'), kind: text(item.kind || 'checkpoint', '里程碑类型', 40, true) }; });
    return result;
  }
  function validateRequirement(input, previous = {}) {
    const result = { ...previous }; for (const key of REQ_FIELDS) if (own(input, key)) result[key] = input[key];
    result.title = text(result.title, '需求标题', 200, true); result.description = text(result.description, '背景说明', 20000); result.acceptance = text(result.acceptance, '验收标准', 20000);
    result.projectId = id(result.projectId); result.ownerId = projectMember(result.projectId, result.ownerId);
    result.assigneeId = projectMember(result.projectId, result.assigneeId, true);
    result.source = text(result.source, '需求来源', 200); result.status = enumValue(result.status || '未确定', REQUIREMENT_STATUSES, '需求状态'); result.priority = enumValue(result.priority || 'P1', ['P0', 'P1', 'P2'], '优先级');
    if (!Array.isArray(result.collaboratorIds || []) || (result.collaboratorIds || []).length > 100) fail(400, '协作人格式不正确');
    result.collaboratorIds = (result.collaboratorIds || []).map(value => projectMember(result.projectId, value));
    if (new Set(result.collaboratorIds).size !== result.collaboratorIds.length) fail(400, '协作人不能重复');
    result.planStart = date(result.planStart, '需求开始日期'); result.planEnd = date(result.planEnd, '需求截止日期'); dates(result.planStart, result.planEnd);
    result.estimatePoints = number(result.estimatePoints ?? 0, '需求估算点数', 10000);
    validateRequirementDependencies(result);
    Object.assign(result, normalizeDocumentLinks(result));
    return result;
  }
  function validateRequirementDependencies(result) {
    if (result.dependencyIds === undefined) result.dependencyIds = [];
    if (!Array.isArray(result.dependencyIds) || result.dependencyIds.length > 100) fail(400, '前置需求应为最多 100 个需求编号');
    result.dependencyIds = [...new Set(result.dependencyIds.map(value => id(value)))];
    if (result.dependencyIds.includes(result.id)) fail(400, '需求不能依赖自身', 'DEPENDENCY_CYCLE');
    for (const dependencyId of result.dependencyIds) {
      const dependency = get('SELECT id,archived FROM requirements WHERE id=? AND project_id=?', dependencyId, result.projectId);
      // Cross-project and absent identifiers deliberately have the same response.
      if (!dependency || dependency.archived) fail(400, '前置需求必须是本项目现有的未归档需求', 'INVALID_DEPENDENCY');
    }
    if (result.id && result.dependencyIds.length) {
      const graph = new Map(all('SELECT id,data FROM requirements WHERE project_id=? AND archived=0', result.projectId).map(row => [row.id, JSON.parse(row.data).dependencyIds || []]));
      graph.set(result.id, result.dependencyIds);
      const pending = [...result.dependencyIds], visited = new Set();
      while (pending.length) {
        const dependencyId = pending.pop();
        if (dependencyId === result.id) fail(400, '前置需求不能形成循环依赖', 'DEPENDENCY_CYCLE');
        if (visited.has(dependencyId)) continue;
        visited.add(dependencyId); pending.push(...(graph.get(dependencyId) || []));
      }
    }
  }
  function requirementTransition(role, previous, next, reason) {
    const tasks = all('SELECT data FROM tasks WHERE requirement_id=? AND archived=0', next.id).map(row => JSON.parse(row.data));
    const dependencies = (next.dependencyIds || []).map(dependencyId => rowValue(get('SELECT * FROM requirements WHERE id=? AND project_id=?', dependencyId, next.projectId)));
    const check = checkRequirementTransition(role, previous, next, { tasks, dependencies, reason: text(reason, '操作说明', 1000) });
    if (!check.ok) fail(check.status, check.message, check.code);
  }

  function deliveryState(requirement, taskOverride) {
    let tasks = all('SELECT * FROM tasks WHERE requirement_id=?', requirement.id).map(rowValue);
    if (taskOverride) tasks = [...tasks.filter(task => task.id !== taskOverride.id), taskOverride];
    const dependencies = (requirement.dependencyIds || []).map(dependencyId => rowValue(get('SELECT * FROM requirements WHERE id=? AND project_id=?', dependencyId, requirement.projectId)));
    return requirementDeliveryState(requirement, tasks, dependencies);
  }
  function syncDelivery(user, requirementId, trigger = {}) {
    if (!requirementId) return null;
    const row = record('requirements', requirementId), before = rowValue(row);
    if (before.archived || ['未确定', '待评审', '已完成', '已终止'].includes(before.status)) return before;
    const data = { ...JSON.parse(row.data), deliveryWorkflow: true };
    if (data.workflowHold && trigger.clearHold) data.workflowHold = false;
    const state = deliveryState(data);
    data.status = state.status;
    if (['开发中', '测试中'].includes(data.status) && !data.deliveryStartedAt) data.deliveryStartedAt = now();
    if (data.status === before.status && before.deliveryWorkflow && Boolean(data.workflowHold) === Boolean(before.workflowHold) && data.deliveryStartedAt === before.deliveryStartedAt) return before;
    const result = updateRow('requirements', row, data);
    audit(user, data.status === before.status ? 'update' : 'transition', 'requirement', row.id, row.project_id, { before, after: data, automatic: true, reason: trigger.reason || '根据研发计划和关联任务自动同步', ...trigger });
    return result;
  }
  function assertTaskParentOpen(requirementId) {
    if (!requirementId) return;
    const row = record('requirements', requirementId), requirement = JSON.parse(row.data);
    if (['已完成', '已终止'].includes(requirement.status)) fail(409, '需求已经结束，请先重新打开需求再调整交付任务', 'STATE_TRANSITION');
  }
  function assertTaskStart(data, before = {}) {
    if (!data.requirementId || !['develop', 'test', 'done'].includes(taskStage(data.status))) return;
    if (data.requirementId === before.requirementId && taskStage(data.status) === taskStage(before.status)) return;
    const parent = rowValue(record('requirements', data.requirementId));
    const current = deliveryState(parent), next = deliveryState(parent, data);
    const firstStartGates = [...next.planGates, ...(next.scheduleReady ? [] : ['请为所有有效任务填写完整的计划起止日期'])];
    if (!current.hasStarted && firstStartGates.length) fail(409, firstStartGates.join('；'), 'TRANSITION_GATE');
    // Historical tasks already under way may finish testing even when old dates
    // are incomplete. Starting/reopening development still respects dependencies.
    if (taskStage(data.status) === 'develop' && next.pendingDependencies.length) fail(409, '前置需求尚未完成', 'DEPENDENCY_GATE');
  }

  function validateTask(input, previous = {}) {
    const result = { ...previous }; for (const key of TASK_FIELDS) if (own(input, key)) result[key] = input[key];
    result.title = text(result.title, '任务标题', 200, true); result.description = text(result.description, '任务说明', 20000); result.projectId = id(result.projectId);
    result.ownerId = projectMember(result.projectId, result.ownerId, true); result.requirementId = id(result.requirementId, false);
    result.status = enumValue(result.status || 'wait', TASK_STATUSES, '任务状态'); result.startDate = date(result.startDate, '任务开始日期'); result.dueDate = date(result.dueDate, '任务截止日期'); dates(result.startDate, result.dueDate);
    if (own(result, 'estimateHours')) result.estimateHours = number(result.estimateHours, '估算工时');
    if (own(result, 'estimatePoints')) result.estimatePoints = number(result.estimatePoints, '估算点数', 10000);
    if (!own(result, 'estimateHours') && !own(result, 'estimatePoints')) result.estimateHours = 0;
    if (result.dependencyIds === undefined) result.dependencyIds = [];
    if (!Array.isArray(result.dependencyIds) || result.dependencyIds.length > 100) fail(400, '前置任务应为最多 100 个任务编号');
    result.dependencyIds = [...new Set(result.dependencyIds.map(value => id(value)))];
    if (result.dependencyIds.includes(result.id)) fail(400, '任务不能依赖自身', 'DEPENDENCY_CYCLE');
    for (const dependencyId of result.dependencyIds) {
      // Never reveal whether an inaccessible identifier belongs to another project.
      const dependency = get('SELECT id,archived FROM tasks WHERE id=? AND project_id=?', dependencyId, result.projectId);
      if (!dependency || dependency.archived) fail(400, '前置任务必须是本项目现有的未归档任务', 'INVALID_DEPENDENCY');
    }
    if (result.id && result.dependencyIds.length) {
      const graph = new Map(all('SELECT id,data FROM tasks WHERE project_id=? AND archived=0', result.projectId).map(row => [row.id, JSON.parse(row.data).dependencyIds || []]));
      graph.set(result.id, result.dependencyIds);
      const pending = [...result.dependencyIds], visited = new Set();
      while (pending.length) {
        const dependencyId = pending.pop();
        if (dependencyId === result.id) fail(400, '前置任务不能形成循环依赖', 'DEPENDENCY_CYCLE');
        if (visited.has(dependencyId)) continue;
        visited.add(dependencyId); pending.push(...(graph.get(dependencyId) || []));
      }
    }
    if (result.requirementId) {
      const parent = record('requirements', result.requirementId); const requirement = JSON.parse(parent.data);
      if (parent.project_id !== result.projectId) fail(400, '任务与关联需求必须属于同一项目');
      if (parent.archived) fail(409, '关联需求已归档，请先恢复', 'ARCHIVED');
      if (['未确定', '待评审'].includes(requirement.status) && (!previous.id || result.requirementId !== previous.requirementId || taskStage(result.status) !== taskStage(previous.status))) fail(409, '关联需求尚未确认，请先在需求提议模块评估通过后再安排研发任务', 'PROPOSAL_WORKFLOW_REQUIRED');
      if (['已完成', '已终止'].includes(requirement.status) && !['done', 'terminated'].includes(taskStage(result.status))) fail(409, '关联需求已经结束，请先重新打开需求', 'STATE_TRANSITION');
    }
    return result;
  }
  function entityPermission(actor, row, type, write = false) {
    const access = permission(actor, row.project_id, write ? ['product', 'lead', 'developer', 'tester'] : null);
    const value = rowValue(row);
    if (write && access.role !== 'admin') {
      const allowed = type === 'task'
        ? access.role === 'lead' || access.role === 'tester' || (access.role === 'developer' && value.ownerId === access.user.id) || (REVIEW_ROLES.includes(access.role) && ['test', 'done'].includes(taskStage(value.status)))
        : ['product', 'lead', 'tester'].includes(access.role) || (access.role === 'developer' && (participates(row.id, access.user.id) || ['测试中', '已完成'].includes(value.status)));
      if (!allowed) fail(403, type === 'task' ? '只能修改自己负责的任务' : '只能修改自己参与的需求', 'FORBIDDEN');
    }
    if (write && row.archived) fail(409, '记录已归档，请先恢复', 'ARCHIVED');
    return { ...access, value };
  }
  // Fields outside a role's scope may be resubmitted unchanged, never altered.
  function restrictFields(input, before, after, allowedFields, message) {
    const blank = value => value === undefined || value === null || value === '' || value === 0 || (Array.isArray(value) && !value.length) ? '' : value;
    for (const key of Object.keys(input)) if (!allowedFields.includes(key) && JSON.stringify(blank(after[key])) !== JSON.stringify(blank(before[key]))) fail(403, message, 'FORBIDDEN');
  }
  function listProjects(actor, options = {}) {
    const user = actorUser(actor);
    const rows = user.role === 'admin' || user.executive ? all('SELECT * FROM projects ORDER BY created_at,id') : all('SELECT p.* FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.created_at,p.id', user.id);
    return rows.filter(row => options.includeArchived || !row.archived).map(rowValue);
  }
  function listEntities(actor, table, options = {}) {
    if (options.projectId) permission(actor, options.projectId);
    const allowed = new Set(listProjects(actor, { includeArchived: options.includeArchived }).map(project => project.id));
    return all(`SELECT * FROM ${table} ORDER BY created_at,id`).filter(row => allowed.has(row.project_id) && (!options.projectId || row.project_id === options.projectId) && (options.includeArchived || !row.archived)).map(rowValue);
  }
  function createProject(actor, input) {
    inputRecord(input, [...PROJECT_FIELDS, 'ownerRole']); const user = actorUser(actor);
    if (user.role !== 'admin') fail(403, '只有系统管理员可以创建项目', 'FORBIDDEN');
    return transaction(() => {
      const data = validateProject({ ownerId: user.id, ...input }); const owner = get('SELECT status FROM users WHERE id=?', data.ownerId);
      if (!owner || owner.status === 'disabled') fail(400, '项目负责人不存在或已停用');
      const ownerRole = input.ownerRole === undefined ? 'product' : enumValue(input.ownerRole, OWNER_ROLES, '负责人角色');
      delete data.ownerRole;
      const stamp = now(); data.id = uid('p'); data.createdAt = stamp;
      run('INSERT INTO projects(id,data,version,archived,created_at,updated_at) VALUES(?,?,1,0,?,?)', data.id, JSON.stringify(data), stamp, stamp);
      run('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)', data.id, data.ownerId, ownerRole);
      audit(user, 'create', 'project', data.id, data.id, { after: data }); return rowValue(record('projects', data.id));
    });
  }
  function updateProject(actor, projectId, input) {
    inputRecord(input, [...PROJECT_FIELDS, 'version']);
    return transaction(() => { const access = projectOwner(actor, projectId); expectedVersion(access.projectRow, input.version);
      const before = JSON.parse(access.projectRow.data); const data = validateProject(input, before);
      if (!get('SELECT id FROM users WHERE id=? AND status!=?', data.ownerId, 'disabled')) fail(400, '项目负责人不存在或已停用');
      if (data.ownerId !== before.ownerId && !OWNER_ROLES.includes(get('SELECT role FROM memberships WHERE project_id=? AND user_id=?', projectId, data.ownerId)?.role)) fail(409, '项目负责人必须是本项目的产品经理或主开发，请先设置成员角色');
      const result = updateRow('projects', access.projectRow, data); audit(access.user, 'update', 'project', projectId, projectId, { before, after: data }); return result;
    });
  }
  function archiveProject(actor, projectId, input) {
    inputRecord(input, ['version', 'archived']); if (own(input, 'archived') && typeof input.archived !== 'boolean') fail(400, '归档标记必须是布尔值');
    return transaction(() => { const access = projectOwner(actor, projectId, true); expectedVersion(access.projectRow, input.version);
      const archived = input.archived !== false; const result = updateRow('projects', access.projectRow, JSON.parse(access.projectRow.data), archived);
      audit(access.user, archived ? 'archive' : 'restore', 'project', projectId, projectId); return result;
    });
  }
  function insertConfirmedRequirement(actor, input, origin = { originType: 'direct' }) {
    inputRecord(input, REQ_FIELDS);
    return transaction(() => { const access = permission(actor, id(input.projectId), ['product']);
      if (input.assigneeId && access.role !== 'admin') fail(403, '主责开发由主开发在拆分任务时指定', 'FORBIDDEN');
      if (input.status && input.status !== '已确定') fail(400, '需求池只接收已确认开发的需求，待评估内容请先提交需求提议', 'TRANSITION_GATE');
      const data = validateRequirement({ ownerId: access.user.id, ...input, status: '已确定' });
      if (!data.description || !data.acceptance) fail(400, '已确认需求必须填写背景与目标及验收标准', 'TRANSITION_GATE');
      Object.assign(data, origin, { deliveryWorkflow: true, planSubmitted: false, workflowHold: false });
      const stamp = now(); data.id = uid('r'); data.createdAt = stamp; data.baseline = data.planStart || data.planEnd ? { planStart: data.planStart, planEnd: data.planEnd, capturedAt: stamp } : null; data.rescheduleCount = 0;
      run('INSERT INTO requirements(id,project_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,1,0,?,?)', data.id, data.projectId, JSON.stringify(data), stamp, stamp);
      audit(access.user, 'create', 'requirement', data.id, data.projectId, { after: data }); return rowValue(record('requirements', data.id));
    });
  }
  function createRequirement(actor, input) { return insertConfirmedRequirement(actor, input); }
  // Only the internal proposal service calls this method; request payloads cannot
  // spoof origin fields because the public create endpoint accepts REQ_FIELDS.
  function createRequirementFromProposal(actor, input, { proposalId, submittedBy } = {}) {
    return insertConfirmedRequirement(actor, input, { originType: 'proposal', originProposalId: id(proposalId), originSubmittedBy: id(submittedBy) });
  }
  function confirmLegacyRequirement(actor, requirementId, input) {
    inputRecord(input, [...REQ_FIELDS, 'version', 'originProposalId', 'originSubmittedBy']);
    return transaction(() => {
      const row = record('requirements', requirementId), access = permission(actor, row.project_id, ['product']);
      expectedVersion(row, input.version);
      if (row.archived) fail(409, '需求已归档，请先恢复', 'ARCHIVED');
      const before = JSON.parse(row.data);
      if (!['未确定', '待评审'].includes(before.status)) fail(409, '该需求已经确认，无需重复转入需求池', 'STATE_TRANSITION');
      if (input.projectId && input.projectId !== row.project_id) fail(400, '需求不能直接跨项目移动');
      if (input.assigneeId && input.assigneeId !== before.assigneeId && access.role !== 'admin') fail(403, '主责开发由主开发指定', 'FORBIDDEN');
      const data = validateRequirement({ ...input, status: '已确定' }, before);
      if (!data.description || !data.acceptance) fail(400, '确认需求前必须填写背景与目标及验收标准', 'TRANSITION_GATE');
      Object.assign(data, { deliveryWorkflow: true, planSubmitted: false, workflowHold: false, originType: 'proposal', originProposalId: id(input.originProposalId || `legacy-${row.id}`), originSubmittedBy: id(input.originSubmittedBy || before.ownerId) });
      const result = updateRow('requirements', row, data);
      audit(access.user, 'transition', 'requirement', row.id, row.project_id, { before, after: data, reason: '需求提议评估通过，保留原编号及任务、文档关联' });
      return result;
    });
  }
  function submitRequirementPlan(actor, requirementId, input) {
    inputRecord(input, ['version']);
    return transaction(() => {
      const row = record('requirements', requirementId), access = permission(actor, row.project_id, ['lead']);
      expectedVersion(row, input.version);
      if (row.archived) fail(409, '需求已归档，请先恢复', 'ARCHIVED');
      const before = JSON.parse(row.data);
      if (['未确定', '待评审', '已完成', '已终止'].includes(before.status)) fail(409, '只有已确认且未结束的需求可以提交研发计划', 'STATE_TRANSITION');
      const data = { ...before, deliveryWorkflow: true, planSubmitted: true, planSubmittedAt: now(), planSubmittedBy: access.user.id };
      const state = deliveryState(data);
      if (!state.planReady) fail(409, state.planGates.join('；'), 'TRANSITION_GATE');
      data.status = state.status;
      if (['开发中', '测试中'].includes(data.status) && !data.deliveryStartedAt) data.deliveryStartedAt = now();
      const result = updateRow('requirements', row, data);
      audit(access.user, 'submit_plan', 'requirement', row.id, row.project_id, { before, after: data, reason: '兼容旧版计划入口；研发阶段已改为按任务自动同步' });
      return result;
    });
  }
  function returnRequirement(actor, requirementId, input) {
    inputRecord(input, ['version', 'reason', 'taskIds']);
    const reason = text(input.reason, '退回原因', 1000, true);
    if (!Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.length > 100) fail(400, '请选择至少一个需要返工的任务');
    const taskIds = [...new Set(input.taskIds.map(value => id(value)))];
    return transaction(() => {
      const row = record('requirements', requirementId), access = permission(actor, row.project_id, REQUIREMENT_REVIEW_ROLES);
      expectedVersion(row, input.version);
      const before = JSON.parse(row.data);
      if (row.archived) fail(409, '需求已归档，请先恢复', 'ARCHIVED');
      if (deliveryState(before).status !== '测试中') fail(409, '只有测试中的需求可以退回整改', 'STATE_TRANSITION');
      const rows = taskIds.map(taskId => { const task = get('SELECT * FROM tasks WHERE id=? AND requirement_id=?', taskId, row.id), data = task ? JSON.parse(task.data) : null; if (!task || task.archived || !['test', 'done'].includes(taskStage(data.status))) fail(400, '返工任务必须是本需求测试中或已完成的有效任务'); return task; });
      for (const task of rows) {
        const previous = JSON.parse(task.data), data = { ...previous, status: 'develop', completedAt: '' };
        updateRow('tasks', task, data); audit(access.user, 'transition', 'task', task.id, row.project_id, { before: previous, after: data, reason, requirementReview: row.id });
      }
      const data = { ...before, status: '开发中', deliveryWorkflow: true, workflowHold: false, deliveryStartedAt: before.deliveryStartedAt || now() };
      const result = updateRow('requirements', row, data);
      audit(access.user, 'transition', 'requirement', row.id, row.project_id, { before, after: data, reason, taskIds, manualReview: true });
      return result;
    });
  }
  function reopenRequirement(actor, requirementId, input) {
    inputRecord(input, ['version', 'reason']);
    const reason = text(input.reason, '重新打开原因', 1000, true);
    return transaction(() => {
      const row = record('requirements', requirementId), before = JSON.parse(row.data);
      const access = permission(actor, row.project_id, before.status === '已终止' ? ['product', 'lead'] : REQUIREMENT_REVIEW_ROLES);
      expectedVersion(row, input.version);
      if (row.archived) fail(409, '需求已归档，请先恢复', 'ARCHIVED');
      if (!['已完成', '已终止'].includes(before.status)) fail(409, '只有已经结束的需求可以重新打开', 'STATE_TRANSITION');
      const data = before.status === '已终止'
        ? { ...before, status: '已确定', deliveryWorkflow: true, planSubmitted: false, workflowHold: false, deliveryStartedAt: '' }
        : { ...before, status: '开发中', deliveryWorkflow: true, planSubmitted: true, workflowHold: true, deliveryStartedAt: before.deliveryStartedAt || now() };
      const result = updateRow('requirements', row, data);
      audit(access.user, 'transition', 'requirement', row.id, row.project_id, { before, after: data, reason, manualReview: true });
      return result;
    });
  }
  function updateRequirement(actor, requirementId, input) {
    inputRecord(input, [...REQ_FIELDS, 'version', 'reason', 'force']);
    return transaction(() => { const row = record('requirements', requirementId); const access = entityPermission(actor, row, 'requirement', true); expectedVersion(row, input.version);
      if (input.projectId && input.projectId !== row.project_id) fail(400, '需求不能直接跨项目移动');
      const before = JSON.parse(row.data); const data = validateRequirement(input, before);
      if (['未确定', '待评审'].includes(before.status)) fail(409, '待评估内容请在需求提议模块编辑并评估，评估通过后转入需求池', 'PROPOSAL_WORKFLOW_REQUIRED');
      if (access.role === 'product') restrictFields(input, before, data, [...REQ_FIELDS.filter(key => key !== 'assigneeId'), 'version', 'reason', 'force'], '主责开发由主开发指定');
      if (access.role === 'lead') restrictFields(input, before, data, [...LEAD_REQUIREMENT_FIELDS, 'version'], '需求内容由产品经理维护；主开发可调整主责开发、协作人、排期和依赖');
      if (['developer', 'tester'].includes(access.role)) restrictFields(input, before, data, ['version', 'status', 'reason'], '开发和测试角色只能流转需求状态');
      if (before.status !== data.status && (['未确定', '待评审'].includes(before.status) || ['未确定', '待评审'].includes(data.status))) fail(409, '需求评估请在需求提议模块完成，评估通过后转入需求池', 'PROPOSAL_WORKFLOW_REQUIRED');
      if (before.status !== data.status && (data.status === '开发中' || ['已完成', '已终止'].includes(before.status) && data.status !== '已终止')) fail(409, '请使用退回整改或重新打开操作，并记录原因及返工任务', 'WORKFLOW_ACTION_REQUIRED');
      if ((before.description && !data.description) || (before.acceptance && !data.acceptance)) fail(400, '已确认需求必须保留背景与目标及验收标准', 'TRANSITION_GATE');
      const effectiveBefore = before.status === data.status ? before : { ...before, status: deliveryState({ ...before, deliveryWorkflow: true }).status };
      requirementTransition(access.role, effectiveBefore, data, input.reason);
      const planChanged = data.planStart !== (before.planStart || '') || data.planEnd !== (before.planEnd || '');
      if (planChanged && data.planEnd && access.project.targetDate && data.planEnd > access.project.targetDate && input.force !== true) fail(409, '新排期超出项目目标，请确认后重新提交', 'SCHEDULE_CONFIRMATION_REQUIRED');
      if (planChanged) preserveBaseline(before, data);
      data.deliveryWorkflow = true;
      updateRow('requirements', row, data); audit(access.user, before.status === data.status ? 'update' : 'transition', 'requirement', data.id, data.projectId, { before, after: data, reason: text(input.reason, '操作说明', 1000) });
      return syncDelivery(access.user, data.id, { reason: '需求研发计划信息变更后自动同步' });
    });
  }
  function preserveBaseline(before, data) {
    if (!normalizeBaseline(before.baseline)) {
      const original = before.planStart || before.planEnd ? before : data;
      data.baseline = original.planStart || original.planEnd ? { planStart: original.planStart || '', planEnd: original.planEnd || '', capturedAt: now() } : null;
    }
    if (before.planStart || before.planEnd) data.rescheduleCount = (Number.isSafeInteger(before.rescheduleCount) && before.rescheduleCount >= 0 ? before.rescheduleCount : 0) + 1;
  }
  function schedulePreview(actor, projectId, input) {
    const access = permission(actor, projectId, ['product', 'lead']);
    if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 100) fail(400, '请提交 1 至 100 条需求排期', 'BATCH_VALIDATION');
    const changes = [], warnings = [], errors = [], seen = new Set();
    input.changes.forEach((entry, index) => {
      try {
        inputRecord(entry, ['requirementId', 'version', 'planStart', 'planEnd']);
        const requirementId = id(entry.requirementId);
        if (seen.has(requirementId)) fail(400, '同一需求不能在一批改期中重复提交');
        seen.add(requirementId);
        const row = get('SELECT * FROM requirements WHERE id=? AND project_id=?', requirementId, projectId);
        if (!row) fail(404, '本项目中不存在该需求', 'NOT_FOUND');
        if (row.archived) fail(409, '需求已归档，请先恢复', 'ARCHIVED');
        expectedVersion(row, entry.version);
        const value = JSON.parse(row.data), before = { planStart: value.planStart || '', planEnd: value.planEnd || '' };
        if (['未确定', '待评审'].includes(value.status)) fail(409, '待评估内容必须先在需求提议模块确认，再安排研发计划', 'PROPOSAL_WORKFLOW_REQUIRED');
        const after = { planStart: own(entry, 'planStart') ? date(entry.planStart, '需求开始日期') : before.planStart, planEnd: own(entry, 'planEnd') ? date(entry.planEnd, '需求截止日期') : before.planEnd };
        dates(after.planStart, after.planEnd);
        const changed = after.planStart !== before.planStart || after.planEnd !== before.planEnd;
        const exceedsTarget = Boolean(changed && after.planEnd && access.project.targetDate && after.planEnd > access.project.targetDate);
        changes.push({ requirementId, title: value.title, version: row.version, before, after, changed, exceedsTarget });
        if (exceedsTarget) warnings.push({ row: index + 1, requirementId, message: '新排期超出项目目标，需要明确确认。' });
        if (changed) {
          const tasks = all('SELECT data FROM tasks WHERE requirement_id=? AND archived=0', requirementId).map(task => JSON.parse(task.data));
          if (tasks.some(task => (after.planStart && task.startDate && task.startDate < after.planStart) || (after.planEnd && task.dueDate && task.dueDate > after.planEnd))) warnings.push({ row: index + 1, requirementId, message: '关联任务日期超出新需求计划，请检查任务排期；任务日期不会自动移动。' });
        }
      } catch (error) {
        if (!error.status) throw error;
        errors.push({ index, row: index + 1, status: error.status, code: error.code, message: error.message });
      }
    });
    if (errors.length) {
      const versionConflict = errors.some(error => error.code === 'VERSION_CONFLICT');
      const error = businessError(versionConflict ? 409 : 400, `${errors.length} 行排期需要修改，整批未保存`, versionConflict ? 'VERSION_CONFLICT' : 'BATCH_VALIDATION');
      error.errors = errors; error.details = { rows: errors }; throw error;
    }
    const projectVersion = access.projectRow.version;
    const previewToken = createHash('sha256').update(JSON.stringify({ actorId: access.user.id, projectId, projectVersion, targetDate: access.project.targetDate || '', changes })).digest('hex');
    return { access, preview: { changes, warnings, requiresConfirmation: changes.some(change => change.exceedsTarget), projectVersion, previewToken } };
  }
  function previewSchedule(actor, projectId, input) {
    inputRecord(input, ['changes']);
    return transaction(() => schedulePreview(actor, projectId, input).preview);
  }
  function applySchedule(actor, projectId, input) {
    inputRecord(input, ['changes', 'previewToken', 'reason', 'force']);
    const reason = text(input.reason, '改期原因', 1000, true);
    if (own(input, 'force') && typeof input.force !== 'boolean') fail(400, '超期确认必须为布尔值');
    return transaction(() => {
      const { access, preview } = schedulePreview(actor, projectId, input);
      if (typeof input.previewToken !== 'string' || input.previewToken !== preview.previewToken) fail(409, '预览已失效，请重新预览排期后提交', 'SCHEDULE_PREVIEW_STALE');
      if (preview.requiresConfirmation && input.force !== true) fail(409, '新排期超出项目目标，请确认后重新提交', 'SCHEDULE_CONFIRMATION_REQUIRED');
      const requirements = [];
      for (const change of preview.changes) {
        const row = record('requirements', change.requirementId);
        if (!change.changed) { requirements.push(rowValue(row)); continue; }
        const before = JSON.parse(row.data), data = { ...before, ...change.after };
        preserveBaseline(before, data);
        updateRow('requirements', row, data);
        audit(access.user, 'reschedule', 'requirement', row.id, row.project_id, { before, after: data, reason, batch: true });
        requirements.push(syncDelivery(access.user, row.id, { reason: '需求排期变更后自动同步', batch: true }));
      }
      return { requirements, changedCount: preview.changes.filter(change => change.changed).length };
    });
  }
  function createTask(actor, input) {
    inputRecord(input, TASK_FIELDS);
    return transaction(() => { const access = permission(actor, id(input.projectId), ['lead', 'developer']);
      const data = validateTask({ ownerId: access.user.id, ...input });
      if (!data.requirementId) fail(400, '任务必须关联需求');
      assertTaskParentOpen(data.requirementId);
      assertTaskAuthority(access, data.requirementId, [data]);
      if (taskStage(data.status) !== 'wait') fail(400, '新任务从待开始阶段创建', 'TRANSITION_GATE');
      const stamp = now(); data.id = uid('t'); data.createdAt = stamp; data.createdBy = access.user.id; data.completedAt = '';
      run('INSERT INTO tasks(id,project_id,requirement_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)', data.id, data.projectId, data.requirementId || null, JSON.stringify(data), stamp, stamp);
      audit(access.user, 'create', 'task', data.id, data.projectId, { after: data });
      syncDelivery(access.user, data.requirementId, { triggerTaskId: data.id, reason: '新增交付任务后自动同步', clearHold: true });
      return rowValue(record('tasks', data.id));
    });
  }
  // Lead developers assign anyone; developers add tasks for themselves under requirements they take part in.
  function assertTaskAuthority(access, requirementId, tasks) {
    if (roleCan(access.role, 'assignTasks')) return;
    if (tasks.some(task => task.ownerId !== access.user.id)) fail(403, '只能创建自己负责的任务，派给他人请联系主开发', 'FORBIDDEN');
    if (!participates(requirementId, access.user.id)) fail(403, '只能在自己参与的需求下补充任务', 'FORBIDDEN');
  }
  function createTaskBatch(actor, requirementId, input) {
    inputRecord(input, ['version', 'requestId', 'tasks']);
    const requestId = id(input.requestId);
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 100) fail(400, '请提交 1 至 100 条任务', 'BATCH_VALIDATION');
    // Stable key ordering makes retries independent of JSON property ordering.
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    const digest = createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');
    return transaction(() => {
      const row = record('requirements', requirementId);
      const access = permission(actor, row.project_id, ['lead', 'developer']);
      if (row.archived) fail(409, '关联需求已归档，请先恢复', 'ARCHIVED');
      const key = 'task_batch:' + createHash('sha256').update(JSON.stringify([access.user.id, row.id, requestId])).digest('hex');
      const previous = get('SELECT value FROM app_meta WHERE key=?', key);
      if (previous) {
        const saved = JSON.parse(previous.value);
        if (saved.digest !== digest) fail(409, '此提交编号已用于不同内容，请重新生成提交编号', 'IDEMPOTENCY_CONFLICT');
        // A retry must still satisfy the caller's current assignment authority.
        assertTaskAuthority(access, row.id, saved.result.tasks);
        return { ...saved.result, replayed: true };
      }
      expectedVersion(row, input.version);
      assertTaskParentOpen(row.id);
      const errors = [], warnings = [], validated = [];
      input.tasks.forEach((entry, index) => {
        try {
          inputRecord(entry, TASK_FIELDS);
          if (own(entry, 'projectId') && entry.projectId !== row.project_id) fail(400, '任务与关联需求必须属于同一项目');
          if (own(entry, 'requirementId') && entry.requirementId !== row.id) fail(400, '批量任务必须关联当前需求');
          const granularity = taskGranularity(entry.estimateHours);
          if (!granularity.valid) fail(400, granularity.warnings[0]);
          const data = validateTask({ ownerId: access.user.id, ...entry, projectId: row.project_id, requirementId: row.id });
          if (!roleCan(access.role, 'assignTasks') && data.ownerId !== access.user.id) fail(403, '只能创建自己负责的任务，派给他人请联系主开发', 'FORBIDDEN');
          if (taskStage(data.status) !== 'wait') fail(400, '新任务从待开始阶段创建', 'TRANSITION_GATE');
          for (const message of granularity.warnings) warnings.push({ index, row: index + 1, message });
          validated.push(data);
        } catch (error) {
          if (!error.status) throw error;
          errors.push({ index, row: index + 1, status: error.status, code: error.code, message: error.message });
        }
      });
      if (!errors.length && !roleCan(access.role, 'assignTasks') && !participates(row.id, access.user.id)) fail(403, '只能在自己参与的需求下补充任务', 'FORBIDDEN');
      if (errors.length) {
        const error = businessError(400, `${errors.length} 行任务需要修改，整包未保存`, 'BATCH_VALIDATION');
        error.errors = errors; error.details = { rows: errors }; throw error;
      }
      const stamp = now();
      const tasks = validated.map(data => {
        data.id = uid('t'); data.createdAt = stamp; data.createdBy = access.user.id; data.completedAt = '';
        run('INSERT INTO tasks(id,project_id,requirement_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)', data.id, row.project_id, row.id, JSON.stringify(data), stamp, stamp);
        audit(access.user, 'create', 'task', data.id, row.project_id, { requirementId: row.id, batchRequestId: requestId, after: data });
        return rowValue(record('tasks', data.id));
      });
      updateRow('requirements', row, JSON.parse(row.data));
      audit(access.user, 'split_tasks', 'requirement', row.id, row.project_id, { taskIds: tasks.map(task => task.id), count: tasks.length, requestId });
      const requirement = syncDelivery(access.user, row.id, { triggerTaskIds: tasks.map(task => task.id), reason: '批量拆分任务后自动同步', clearHold: true });
      const result = { requirement, tasks, warnings, replayed: false };
      run('INSERT INTO app_meta(key,value) VALUES(?,?)', key, JSON.stringify({ digest, result }));
      return result;
    });
  }
  function updateTask(actor, taskId, input) {
    inputRecord(input, [...TASK_FIELDS, 'version', 'reason']);
    return transaction(() => { const row = record('tasks', taskId); const access = entityPermission(actor, row, 'task', true); expectedVersion(row, input.version);
      if (input.projectId && input.projectId !== row.project_id) fail(400, '任务不能直接跨项目移动');
      const before = JSON.parse(row.data); const data = validateTask(input, before);
      if (access.role === 'developer' && before.ownerId === access.user.id) restrictFields(input, before, data, TASK_FIELDS.filter(key => !['ownerId', 'requirementId', 'projectId'].includes(key)).concat(['version', 'reason']), '任务转派和关联变更需要主开发');
      else if (['developer', 'product', 'tester'].includes(access.role)) restrictFields(input, before, data, ['version', 'status', 'reason'], '只能验收或退回他人的任务');
      if (before.requirementId && !data.requirementId) fail(400, '任务必须关联需求');
      const deliveryFields = TASK_FIELDS.filter(key => !['title', 'description', 'projectId'].includes(key));
      if (deliveryFields.some(key => JSON.stringify(before[key]) !== JSON.stringify(data[key]))) {
        assertTaskParentOpen(before.requirementId); assertTaskParentOpen(data.requirementId);
      }
      const dependencies = data.dependencyIds.map(dependencyId => rowValue(get('SELECT * FROM tasks WHERE id=? AND project_id=?', dependencyId, data.projectId)));
      const transition = checkTaskTransition(access.role, before.status, data.status, { reason: text(input.reason, '操作说明', 1000), dependencies, ownTask: before.ownerId === access.user.id });
      if (!transition.ok) fail(transition.status, transition.message, transition.code);
      assertTaskStart(data, before);
      data.completedAt = taskStage(data.status) === 'done' ? (taskStage(before.status) === 'done' ? before.completedAt || '' : now()) : '';
      const result = updateRow('tasks', row, data); run('UPDATE tasks SET requirement_id=? WHERE id=?', data.requirementId || null, taskId);
      audit(access.user, before.status === data.status ? 'update' : 'transition', 'task', taskId, data.projectId, { before, after: data, reason: text(input.reason, '操作说明', 1000) });
      for (const requirementId of new Set([before.requirementId, data.requirementId])) syncDelivery(access.user, requirementId, { triggerTaskId: taskId, taskBeforeStatus: before.status, taskAfterStatus: data.status, reason: before.requirementId !== data.requirementId ? '任务关联需求变更后自动同步' : '任务状态或计划变更后自动同步', clearHold: before.status !== data.status && ['wait', 'develop'].includes(taskStage(data.status)) });
      return result;
    });
  }
  function archiveEntity(actor, entityId, input, type) {
    inputRecord(input, ['version', 'archived']); if (own(input, 'archived') && typeof input.archived !== 'boolean') fail(400, '归档标记必须是布尔值');
    return transaction(() => { const table = type === 'requirement' ? 'requirements' : 'tasks'; const row = record(table, entityId); const access = permission(actor, row.project_id, type === 'requirement' ? ['product'] : []); expectedVersion(row, input.version);
      const archived = input.archived !== false; const data = JSON.parse(row.data);
      if (type === 'task' && Boolean(row.archived) !== archived) assertTaskParentOpen(data.requirementId);
      if (type === 'task' && archived && !row.archived) {
        const dependents = all('SELECT id,data FROM tasks WHERE project_id=? AND archived=0 AND id<>?', row.project_id, entityId)
          .filter(task => (JSON.parse(task.data).dependencyIds || []).includes(entityId));
        if (dependents.length) fail(409, `无法删除或归档：仍有 ${dependents.length} 个任务依赖此任务，请先修改这些任务的前置依赖。`, 'TASK_IN_USE');
      }
      if (type === 'task' && !archived) validateTask(data, data);
      if (type === 'requirement' && !archived) validateRequirementDependencies({ ...data });
      const result = updateRow(table, row, data, archived); let cascaded = 0;
      if (type === 'requirement' && archived) for (const task of all('SELECT * FROM tasks WHERE requirement_id=? AND archived=0', entityId)) { updateRow('tasks', task, JSON.parse(task.data), true); audit(access.user, 'archive', 'task', task.id, row.project_id, { reason: '关联需求归档' }); cascaded += 1; }
      audit(access.user, archived ? 'archive' : 'restore', type, entityId, row.project_id, { cascaded });
      if (type === 'task') syncDelivery(access.user, data.requirementId, { triggerTaskId: entityId, reason: archived ? '任务删除或归档后重新检查交付范围' : '恢复交付任务后自动同步', clearHold: !archived && ['wait', 'develop'].includes(taskStage(data.status)) });
      const requirement = type === 'requirement' && !archived ? syncDelivery(access.user, entityId, { reason: '需求恢复后重新检查交付范围' }) : result;
      return { ...requirement, cascaded };
    });
  }
  function listMembers(actor, projectId) {
    permission(actor, projectId);
    return all('SELECT u.id,u.username,u.name,u.status,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.name,u.id', projectId).map(row => ({ userId: row.id, username: row.username, name: row.name, status: row.status, role: row.role }));
  }
  function setMember(actor, projectId, input) {
    inputRecord(input, ['userId', 'role', 'version']);
    return transaction(() => { const access = projectOwner(actor, projectId); expectedVersion(access.projectRow, input.version); const userId = id(input.userId); const role = enumValue(input.role, PROJECT_ROLES, '项目成员角色');
      if (!get('SELECT id FROM users WHERE id=? AND status!=?', userId, 'disabled')) fail(400, '成员不存在或已停用');
      if (access.project.ownerId === userId && !OWNER_ROLES.includes(role)) fail(409, '项目负责人必须是产品经理或主开发，请先转移负责人');
      const before = get('SELECT role FROM memberships WHERE project_id=? AND user_id=?', projectId, userId);
      run('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role', projectId, userId, role);
      const project = updateRow('projects', access.projectRow, JSON.parse(access.projectRow.data)); audit(access.user, 'set_member', 'project', projectId, projectId, { userId, before: before?.role || null, after: role }); return { project, members: listMembers(actor, projectId) };
    });
  }
  function removeMember(actor, projectId, userId, input) {
    inputRecord(input, ['version']);
    return transaction(() => { const access = projectOwner(actor, projectId); expectedVersion(access.projectRow, input.version); userId = id(userId);
      const before = get('SELECT role FROM memberships WHERE project_id=? AND user_id=?', projectId, userId); if (!before) fail(404, '项目成员不存在');
      const related = [...all('SELECT data FROM requirements WHERE project_id=? AND archived=0', projectId), ...all('SELECT data FROM tasks WHERE project_id=? AND archived=0', projectId)].some(row => { const x = JSON.parse(row.data); return x.ownerId === userId || x.assigneeId === userId || (x.collaboratorIds || []).includes(userId); });
      if (access.project.ownerId === userId || related) fail(409, '成员仍负责项目或工作，请先完成转派');
      run('DELETE FROM memberships WHERE project_id=? AND user_id=?', projectId, userId); const project = updateRow('projects', access.projectRow, JSON.parse(access.projectRow.data)); audit(access.user, 'remove_member', 'project', projectId, projectId, { userId, role: before.role }); return { project, removedUserId: userId };
    });
  }
  function listHistory(actor, options = {}) {
    if (options.projectId) permission(actor, options.projectId);
    const projects = new Set(listProjects(actor, { includeArchived: true }).map(item => item.id));
    const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
    // Legacy records have no trusted project column: derive it from the current
    // requirement, and reject conflicting identity claims before exposing detail.
    const entries = all('SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC,a.id DESC').map(row => ({ id: row.id, userId: row.user_id, actorName: JSON.parse(row.detail).actorName || row.actor_name || row.user_id || '系统', action: row.action, entityType: row.entity_type, entityId: row.entity_id, detail: JSON.parse(row.detail), createdAt: row.created_at }));
    const saved = get('SELECT value FROM app_meta WHERE key=?', 'legacy_history');
    let legacy = [];
    try { legacy = saved ? JSON.parse(saved.value) : []; } catch { /* Keep modern history readable if old metadata is malformed. */ }
    if (Array.isArray(legacy)) for (const entry of legacy) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.requirementId !== 'string') continue;
      const requirement = get('SELECT id,project_id FROM requirements WHERE id=?', entry.requirementId);
      if (!requirement || !projects.has(requirement.project_id)) continue;
      const detail = entry.detail && typeof entry.detail === 'object' && !Array.isArray(entry.detail) ? entry.detail : {};
      if ((entry.projectId && entry.projectId !== requirement.project_id) || (detail.projectId && detail.projectId !== requirement.project_id) || (entry.entityId && entry.entityId !== requirement.id) || (entry.entityType && entry.entityType !== 'requirement') || (detail.requirementId && detail.requirementId !== requirement.id) || (detail.entityId && detail.entityId !== requirement.id) || (detail.entityType && detail.entityType !== 'requirement')) continue;
      const conflictingSnapshot = [detail.before, detail.after].some(value => value && typeof value === 'object' && !Array.isArray(value) && ((value.projectId && value.projectId !== requirement.project_id) || (value.id && value.id !== requirement.id) || (value.requirementId && value.requirementId !== requirement.id) || (value.entityId && value.entityId !== requirement.id)));
      if (conflictingSnapshot) continue;
      entries.push({ id: entry.id, legacy: true, requirementId: requirement.id, projectId: requirement.project_id, entityType: 'requirement', entityId: requirement.id, userId: entry.actorId || '', actorId: entry.actorId || '', actorName: entry.actorName || '', actorRole: entry.actorRole || '', action: entry.action || 'update', from: entry.from ?? '', to: entry.to ?? '', detail: entry.detail ?? '', createdAt: entry.at || entry.createdAt || entry.date || '', at: entry.at || '', date: entry.date || '' });
    }
    const timestamp = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return -Infinity;
      const day = value.slice(0, 10), stamp = Date.parse(`${day}T00:00:00Z`);
      if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== day) return -Infinity;
      const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
      return Number.isFinite(parsed) ? parsed : -Infinity;
    };
    return entries.filter(item => {
      const projectId = item.legacy ? item.projectId : item.detail?.projectId;
      return projects.has(projectId) && (!options.projectId || projectId === options.projectId) && (!options.entityType || item.entityType === options.entityType) && (!options.entityId || item.entityId === options.entityId);
    }).sort((a, b) => {
      const left = timestamp(a.createdAt), right = timestamp(b.createdAt);
      if (left !== right) return left < right ? 1 : -1;
      return String(b.id).localeCompare(String(a.id), 'en', { numeric: true });
    }).slice(0, limit);
  }
  const { listAttachments, uploadAttachment, getAttachment, listAttachmentVersions } = createAttachmentService(db, {
    authorizeRead: (actor, row) => entityPermission(actor, row, 'requirement'),
    authorizeWrite: (actor, row) => { const access = permission(actor, row.project_id, ['product', 'lead']); if (row.archived) fail(409, '记录已归档，请先恢复', 'ARCHIVED'); return { ...access, value: rowValue(row) }; },
    audit,
  });
  // Product managers maintain every document type; lead developers may maintain technical specs.
  const documents = createDocumentService(db, {
    authorize: (actor, projectId, write, type) => {
      if (!write) return permission(actor, projectId, null);
      const access = permission(actor, projectId, ['product', 'lead']);
      if (access.role === 'lead' && type !== '技术方案') fail(403, '主开发只能上传和维护技术方案，其他文档由产品经理维护', 'FORBIDDEN');
      return access;
    },
    audit,
  });
  function bootstrap(actor, options = {}) {
    const user = actorUser(actor); const projects = listProjects(actor, options); const projectIds = new Set(projects.map(item => item.id));
    const requirements = listEntities(actor, 'requirements', options); const tasks = listEntities(actor, 'tasks', options);
    const memberships = all('SELECT project_id,user_id,role FROM memberships').filter(row => projectIds.has(row.project_id)).map(row => ({ projectId: row.project_id, userId: row.user_id, role: row.role }));
    const visibleUserIds = new Set([user.id, ...memberships.map(item => item.userId)]);
    for (const item of [...projects, ...requirements, ...tasks]) for (const userId of [item.ownerId, item.assigneeId, ...(item.collaboratorIds || [])]) if (userId) visibleUserIds.add(userId);
    const canManageMembers = user.role === 'admin' || projects.some(project => project.ownerId === user.id);
    // Project owners need the safe account directory to add existing accounts
    // which do not yet belong to a project. Credentials stay in auth-only APIs.
    const users = all('SELECT id,username,name,role,executive,status FROM users').filter(row => canManageMembers || visibleUserIds.has(row.id)).map(publicUser);
    return { currentUser: publicUser(user), projects, requirements, tasks, users, memberships, documents: documents.listForProjects(projectIds), requirementStatuses: REQUIREMENT_STATUSES, taskStatuses: TASK_STATUSES, projectRoles: PROJECT_ROLES };
  }
  return Object.freeze({ bootstrap, listProjects, getProject: (actor, projectId) => permission(actor, projectId).project, createProject, updateProject, archiveProject,
    listRequirements: (actor, options = {}) => listEntities(actor, 'requirements', options), getRequirement: (actor, requirementId) => { const row = record('requirements', requirementId); return entityPermission(actor, row, 'requirement').value; }, createRequirement, createRequirementFromProposal, confirmLegacyRequirement, submitRequirementPlan, returnRequirement, reopenRequirement, updateRequirement, archiveRequirement: (actor, requirementId, input) => archiveEntity(actor, requirementId, input, 'requirement'),
    listTasks: (actor, options = {}) => listEntities(actor, 'tasks', options), getTask: (actor, taskId) => { const row = record('tasks', taskId); return entityPermission(actor, row, 'task').value; }, createTask, createTaskBatch, updateTask, archiveTask: (actor, taskId, input) => archiveEntity(actor, taskId, input, 'task'),
    previewSchedule, applySchedule, listMembers, setMember, removeMember, listHistory, listAttachments, uploadAttachment, getAttachment, listAttachmentVersions,
    listDocuments: documents.listDocuments, listDocumentVersions: documents.listVersions, getDocumentContent: documents.getContent, uploadDocument: documents.uploadDocument, updateDocument: documents.updateDocument });
}
