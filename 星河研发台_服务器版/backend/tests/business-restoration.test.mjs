import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { normalizeBaseline, getScheduleComparison } from '../../frontend/workflow.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const [id, role] of [['admin','admin'],['product','member'],['lead','member'],['dev','member'],['viewer','member'],['outsider','member']]) db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?,'active',0)").run(id,id,id,role);
  const b = createBusiness(db), actor = Object.fromEntries(['admin','product','lead','dev','viewer','outsider'].map(id => [id, { id }]));
  let project = b.createProject(actor.admin, { name: '恢复功能测试', targetDate: '2026-12-01' });
  for (const [userId, role] of [['product','product'],['lead','lead'],['dev','developer'],['viewer','viewer']]) project = b.setMember(actor.admin, project.id, { userId, role, version: project.version }).project;
  const other = b.createProject(actor.admin, { name: '隔离项目' });
  const create = (title = '需求', projectId = project.id) => b.createRequirement(actor.admin, { projectId, title, description: '背景', acceptance: '验收标准', ownerId: 'admin', assigneeId: 'dev', planStart: '2026-09-01', planEnd: '2026-10-01' });
  const requirement = create();
  const task = (title = '任务', extra = {}) => b.createTask(actor.admin, { projectId: project.id, requirementId: requirement.id, title, ownerId: 'dev', estimateHours: 8, ...extra });
  const counts = () => ['tasks','audit','app_meta'].map(table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  return { db, b, actor, project, other, requirement, create, task, counts };
}

test('批量拆分逐行校验且失败零写入，工时必填正数且不从点数推导', t => {
  const { b, actor, requirement, counts } = fixture(t), before = counts();
  const input = { version: requirement.version, requestId: 'invalid-batch', tasks: [{ title: '可用行', estimateHours: 8 }, { title: '', estimateHours: 4 }, { title: '点数不可转工时', estimatePoints: 5 }, { title: '零工时', estimateHours: 0 }, { title: '未知字段', estimateHours: 8, unsupported: true }] };
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, input), error => {
    assert.equal(error.code, 'BATCH_VALIDATION');
    assert.deepEqual(error.details.rows.map(item => item.row), [2,3,4,5]);
    return true;
  });
  assert.deepEqual(counts(), before);
  assert.equal(b.getRequirement(actor.admin, requirement.id).version, requirement.version);
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, { ...input, tasks: Array.from({ length: 101 }, () => ({ title: '超量', estimateHours: 8 })) }), error => error.status === 400);
});

test('批量拆分全成全败、粒度只提示、需求版本递增和幂等隔离', t => {
  const { b, actor, requirement, counts } = fixture(t);
  const input = { version: requirement.version, requestId: 'stable-request', tasks: [{ title: '短任务', ownerId: 'dev', estimateHours: 1, estimatePoints: 8 }, { title: '长任务', ownerId: 'dev', estimateHours: 40 }] };
  const result = b.createTaskBatch(actor.lead, requirement.id, input);
  assert.equal(result.tasks.length, 2); assert.equal(result.warnings.length, 2);
  assert.equal(result.requirement.version, requirement.version + 1);
  assert.equal(result.tasks[0].estimateHours, 1); assert.equal(result.tasks[0].estimatePoints, 8);
  assert(result.tasks.every(task => task.requirementId === requirement.id));
  const saved = counts();
  const reordered = { tasks: input.tasks.map(({ title, ownerId, estimateHours, ...rest }) => ({ ...rest, estimateHours, ownerId, title })), requestId: input.requestId, version: input.version };
  const replay = b.createTaskBatch(actor.lead, requirement.id, reordered);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.tasks, result.tasks); assert.deepEqual(counts(), saved);
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, { ...input, tasks: [{ title: '内容不同', estimateHours: 8 }] }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, { ...input, requestId: 'fresh-id' }), error => error.code === 'VERSION_CONFLICT');
  const distinct = b.createTaskBatch(actor.admin, requirement.id, { ...input, version: result.requirement.version });
  assert.equal(distinct.replayed, false); assert.notEqual(distinct.tasks[0].id, result.tasks[0].id);
});

test('批量重放重新核对当前角色分派权限与成员资格且不留下写入',t=>{
  const {db,b,actor,project,requirement,counts}=fixture(t);
  const input={version:requirement.version,requestId:'role-change-retry',tasks:[{title:'分派开发',ownerId:'dev',estimateHours:8}]};
  b.createTaskBatch(actor.lead,requirement.id,input);
  const demoted=b.setMember(actor.admin,project.id,{version:project.version,userId:'lead',role:'developer'}).project;
  const before=counts();
  assert.throws(()=>b.createTaskBatch(actor.lead,requirement.id,input),error=>error.status===403&&error.code==='FORBIDDEN');
  assert.deepEqual(counts(),before);
  b.setMember(actor.admin,project.id,{version:demoted.version,userId:'lead',role:'lead'});
  assert.equal(b.createTaskBatch(actor.lead,requirement.id,input).replayed,true);
  db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(project.id,'lead');
  assert.throws(()=>b.createTaskBatch(actor.lead,requirement.id,input),error=>error.status===403);
});

test('批量拆分拒绝越权、非法成员、跨需求内容和归档项目', t => {
  const { b, actor, project, other, requirement, counts } = fixture(t);
  const input = { version: requirement.version, requestId: 'permissions', tasks: [{ title: '任务', estimateHours: 8 }] }, before = counts();
  for (const role of ['viewer','outsider']) assert.throws(() => b.createTaskBatch(actor[role], requirement.id, input), error => error.status === 403);
  for (const extra of [{ ownerId: 'outsider' }, { ownerId: 'product' }, { projectId: other.id }, { requirementId: 'missing-requirement' }, { status: 'develop' }]) assert.throws(() => b.createTaskBatch(actor.dev, requirement.id, { ...input, tasks: [{ ...input.tasks[0], ...extra }] }), error => error.code === 'BATCH_VALIDATION');
  assert.deepEqual(counts(), before);
  b.archiveProject(actor.admin, project.id, { version: project.version });
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, input), error => error.code === 'ARCHIVED');
});

test('批量拆分遇到写入中断回滚任务、需求版本、审计与幂等记录', t => {
  const { db, b, actor, requirement, counts } = fixture(t), before = counts();
  db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON tasks WHEN json_extract(NEW.data,'$.title')='模拟失败' BEGIN SELECT RAISE(ABORT,'injected'); END");
  const input = { version: requirement.version, requestId: 'retry-after-failure', tasks: [{ title: '本来也会插入', estimateHours: 8 }, { title: '模拟失败', estimateHours: 8 }] };
  assert.throws(() => b.createTaskBatch(actor.lead, requirement.id, input), /injected/);
  assert.deepEqual(counts(), before); assert.equal(b.getRequirement(actor.admin, requirement.id).version, requirement.version);
  db.exec('DROP TRIGGER injected_failure');
  assert.equal(b.createTaskBatch(actor.lead, requirement.id, input).tasks.length, 2);
});

test('旧历史按真实需求所属项目合并，保留内容并拒绝身份矛盾记录', t => {
  const { db, b, actor, project, other, requirement } = fixture(t);
  const secret = b.createRequirement(actor.admin, { projectId: other.id, title: '隔离需求' });
  const legacy = [
    { id: 'h-good', requirementId: requirement.id, actorId: 'dev', actorName: '当时姓名', actorRole: '开发', action: '流转', from: '已排期', to: '开发中', detail: '保留原始说明', at: '2026-09-02T00:00:00Z' },
    { id: 'h-invalid-date', requirementId: requirement.id, actorName: '旧成员', detail: '非法日期仍可追溯', at: '2026-02-30T00:00:00Z' },
    { id: 'h-older', requirementId: requirement.id, detail: '较早记录', date: '2026-09-01' },
    { id: 'h-secret', requirementId: secret.id, detail: '不可见项目内容' },
    { id: 'h-conflict1', requirementId: requirement.id, projectId: other.id, detail: '矛盾项目' },
    { id: 'h-conflict2', requirementId: requirement.id, entityId: secret.id, detail: '矛盾实体' },
    { id: 'h-conflict3', requirementId: requirement.id, detail: { requirementId: secret.id, value: '矛盾详情' } },
    { id: 'h-conflict4', requirementId: requirement.id, detail: { before: { id: secret.id, projectId: other.id, title: '另一项目的正文' } } },
    { id: 'h-conflict5', requirementId: requirement.id, detail: { after: { id: secret.id, title: '另一需求的正文' } } },
    { id: 'h-missing', requirementId: 'missing-id', detail: '悬空记录' },
  ];
  db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run('legacy_history', JSON.stringify(legacy));
  const rows = b.listHistory(actor.viewer, { projectId: project.id, entityType: 'requirement', entityId: requirement.id }).filter(item => item.legacy);
  assert.deepEqual(rows.map(item => item.id), ['h-good','h-older','h-invalid-date']);
  assert.equal(rows[0].actorName, '当时姓名'); assert.equal(rows[0].from, '已排期'); assert.equal(rows[0].to, '开发中'); assert.equal(rows[0].detail, '保留原始说明');
  assert.equal(rows[0].projectId, project.id);
  assert.deepEqual(b.listHistory(actor.outsider), []);
  assert.equal(b.listHistory(actor.viewer, { entityId: secret.id }).length, 0);
  assert(b.listHistory(actor.admin).some(item => item.id === 'h-secret'));
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{malformed', 'legacy_history');
  assert(b.listHistory(actor.viewer).length > 0);
});

test('改期基线保留最初计划、兼容旧字段且未改期不批量重写', t => {
  const { db, b, actor, requirement } = fixture(t);
  assert.deepEqual(normalizeBaseline(requirement.baseline), requirement.baseline);
  let current = b.updateRequirement(actor.product, requirement.id, { version: requirement.version, planStart: '2026-09-03', planEnd: '2026-10-03' });
  assert.equal(current.baseline.planStart, '2026-09-01'); assert.equal(current.rescheduleCount, 1);
  current = b.updateRequirement(actor.product, current.id, { version: current.version, planEnd: '2026-10-05' });
  assert.equal(current.baseline.planEnd, '2026-10-01'); assert.equal(getScheduleComparison(current).endDeltaDays, 4);
  const legacy = { startDate: '2026-08-01', dueDate: '2026-08-31' };
  db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify({ ...current, baseline: legacy }), current.id);
  current = b.updateRequirement(actor.product, current.id, { version: current.version, planEnd: '2026-10-06' });
  assert.deepEqual(current.baseline, legacy); assert.equal(normalizeBaseline(current.baseline).planEnd, '2026-08-31');
  const without = b.createRequirement(actor.product, { projectId: current.projectId, title: '尚未排期' });
  const first = b.updateRequirement(actor.product, without.id, { version: without.version, planStart: '2026-09-10', planEnd: '2026-09-20' });
  assert.equal(first.baseline.planStart, '2026-09-10'); assert.equal(first.rescheduleCount, 0); assert(first.baseline.capturedAt);
});

test('批量改期预览无写入、超期确认、整批版本冲突及项目变化使预览过期', t => {
  const { b, actor, project, requirement, create, counts } = fixture(t), second = create('需求二'), before = counts();
  const changes = [{ requirementId: requirement.id, version: requirement.version, planStart: '2026-10-01', planEnd: '2026-12-20' }, { requirementId: second.id, version: second.version, planStart: '2026-10-02', planEnd: '2026-11-01' }];
  assert.throws(() => b.previewSchedule(actor.dev, project.id, { changes }), error => error.status === 403);
  const preview = b.previewSchedule(actor.product, project.id, { changes });
  assert.deepEqual(counts(), before); assert.equal(preview.requiresConfirmation, true); assert.equal(preview.changes.length, 2);
  const input = { changes, previewToken: preview.previewToken, reason: '依赖交付延期' };
  assert.throws(() => b.applySchedule(actor.product, project.id, input), error => error.code === 'SCHEDULE_CONFIRMATION_REQUIRED');
  assert.equal(b.getRequirement(actor.admin, requirement.id).version, requirement.version);
  b.updateProject(actor.admin, project.id, { version: project.version, targetDate: '2026-12-02' });
  assert.throws(() => b.applySchedule(actor.product, project.id, { ...input, force: true }), error => error.code === 'SCHEDULE_PREVIEW_STALE');
  const refreshed = b.previewSchedule(actor.product, project.id, { changes });
  const result = b.applySchedule(actor.product, project.id, { ...input, previewToken: refreshed.previewToken, force: true });
  assert.equal(result.changedCount, 2); assert.equal(result.requirements[0].baseline.planStart, '2026-09-01');
  assert.equal(result.requirements[1].planStart, '2026-10-02');
  assert.throws(() => b.applySchedule(actor.product, project.id, { ...input, previewToken: refreshed.previewToken, force: true }), error => error.code === 'VERSION_CONFLICT');
});

test('批量改期任一错误或写入中断不留下部分改期', t => {
  const { db, b, actor, project, requirement, create, counts } = fixture(t), second = create('第二需求'), before = counts();
  const changes = [{ requirementId: requirement.id, version: requirement.version, planEnd: '2026-11-01' }, { requirementId: second.id, version: second.version, planStart: '2026-10-10', planEnd: '2026-10-01' }];
  assert.throws(() => b.previewSchedule(actor.product, project.id, { changes }), error => error.details.rows[0].row === 2);
  changes[1].planEnd = '2026-11-02';
  const preview = b.previewSchedule(actor.product, project.id, { changes });
  db.exec(`CREATE TRIGGER injected_failure BEFORE UPDATE ON requirements WHEN NEW.id='${second.id}' BEGIN SELECT RAISE(ABORT,'injected'); END`);
  assert.throws(() => b.applySchedule(actor.product, project.id, { changes, previewToken: preview.previewToken, reason: '调整里程碑' }), /injected/);
  assert.deepEqual(counts(), before); assert.equal(b.getRequirement(actor.admin, requirement.id).planEnd, '2026-10-01');
});

test('任务依赖拒绝跨项目、自环和递归环并在开工时检查完成状态', t => {
  const { b, actor, project, other, task } = fixture(t);
  let first = task('前置任务'), second = task('后续任务', { dependencyIds: [first.id,first.id] });
  assert.deepEqual(second.dependencyIds, [first.id]);
  assert.throws(() => b.updateTask(actor.dev, second.id, { version: second.version, status: 'develop' }), error => error.code === 'DEPENDENCY_GATE');
  assert.throws(() => b.updateTask(actor.dev, first.id, { version: first.version, dependencyIds: [first.id] }), error => error.code === 'DEPENDENCY_CYCLE');
  const third = task('末端任务', { dependencyIds: [second.id] });
  assert.throws(() => b.updateTask(actor.dev, first.id, { version: first.version, dependencyIds: [third.id] }), error => error.code === 'DEPENDENCY_CYCLE');
  const hiddenRequirement = b.createRequirement(actor.admin, { projectId: other.id, title: '隐藏需求' });
  const hidden = b.createTask(actor.admin, { projectId: other.id, requirementId: hiddenRequirement.id, title: '隐藏任务' });
  for (const hiddenId of [hidden.id, 'missing-id']) assert.throws(() => b.createTask(actor.lead, { projectId: project.id, requirementId: first.requirementId, title: '非法引用', dependencyIds: [hiddenId] }), error => error.code === 'INVALID_DEPENDENCY' && error.message === '前置任务必须是本项目现有的未归档任务');
  first = b.updateTask(actor.dev, first.id, { version: first.version, status: 'develop' });
  first = b.updateTask(actor.dev, first.id, { version: first.version, status: 'test' });
  first = b.updateTask(actor.admin, first.id, { version: first.version, status: 'done' });
  second = b.updateTask(actor.dev, second.id, { version: second.version, status: 'develop' });
  assert.equal(second.status, 'develop');
});
