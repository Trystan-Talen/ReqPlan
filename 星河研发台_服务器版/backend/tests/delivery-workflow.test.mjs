import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { requirementDeliveryState, availableRequirementActions } from '../../frontend/workflow.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const actor = Object.fromEntries(['admin', 'product', 'lead', 'dev', 'tester', 'viewer', 'outsider'].map(id => [id, { id }]));
  for (const id of Object.keys(actor)) db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?,'active',0)").run(id, id, id, id === 'admin' ? 'admin' : 'member');
  const b = createBusiness(db);
  let project = b.createProject(actor.admin, { name: '自动交付', ownerId: 'product', targetDate: '2027-01-01' });
  for (const [userId, role] of [['lead', 'lead'], ['dev', 'developer'], ['tester', 'tester'], ['viewer', 'viewer']]) project = b.setMember(actor.admin, project.id, { userId, role, version: project.version }).project;
  const create = (extra = {}) => b.createRequirement(actor.product, { projectId: project.id, title: '确认开发的需求', description: '交付背景与范围', acceptance: '整体功能符合预期', ...extra });
  const get = id => b.getRequirement(actor.admin, id);
  const task = (requirement, extra = {}) => b.createTask(actor.lead, { projectId: project.id, requirementId: requirement.id, title: '实现功能', ownerId: 'dev', estimateHours: 8, startDate: '2026-09-01', dueDate: '2026-10-01', ...extra });
  const prepare = (extra = {}, taskCount = 1) => {
    let requirement = create(extra);
    requirement = b.updateRequirement(actor.lead, requirement.id, { version: requirement.version, assigneeId: 'dev', planStart: '2026-09-01', planEnd: '2026-10-01' });
    const tasks = Array.from({ length: taskCount }, () => task(requirement));
    requirement = get(requirement.id);
    return { requirement, tasks };
  };
  const move = (item, status, who = status === 'done' ? 'tester' : 'dev', extra = {}) => b.updateTask(actor[who], item.id, { version: item.version, status, ...extra });
  const finish = item => move(move(move(item, 'develop'), 'test'), 'done');
  return { db, b, actor, project, create, get, task, prepare, move, finish };
}
const code = expected => error => error.code === expected;

test('共享计划门禁包含验收标准，最终验收门禁不混入排期和前置条件', () => {
  const requirement = { id: 'r-gates', status: '测试中', deliveryWorkflow: true, assigneeId: 'dev', acceptance: '', planSubmitted: false, dependencyIds: ['unfinished'] };
  const tasks = [{ requirementId: requirement.id, status: 'done', ownerId: 'dev', estimateHours: 8 }];
  let state = requirementDeliveryState(requirement, tasks);
  assert.equal(state.planReady, false);
  assert.deepEqual(state.planGates, ['请填写需求验收标准']);
  assert.deepEqual(state.acceptanceGates, ['请填写需求验收标准']);
  assert.equal(state.gates.filter(message => message.includes('验收标准')).length, 1);
  state = requirementDeliveryState({ ...requirement, acceptance: '交付验收' }, tasks);
  assert.equal(state.planReady, true); assert.equal(state.startAllowed, false);
  assert.deepEqual(state.acceptanceGates, []); assert.equal(state.readyForAcceptance, true);
  state = requirementDeliveryState({ ...requirement, acceptance: '交付验收', workflowHold: true }, []);
  assert.equal(state.readyForAcceptance, false);
  assert.equal(state.acceptanceGates.length, 2);
  assert(state.acceptanceGates.every(message => !/排期|前置需求|主责开发/.test(message)));
});

test('需求池新建即已确认，背景和验收必填，来源字段与自动控制字段不可伪造', t => {
  const { b, actor, create, project } = fixture(t);
  const requirement = create();
  assert.deepEqual([requirement.status, requirement.deliveryWorkflow, requirement.planSubmitted, requirement.originType], ['已确定', true, false, 'direct']);
  for (const extra of [{ status: '未确定' }, { status: '待评审' }, { status: '开发中' }, { description: '' }, { acceptance: ' ' }]) assert.throws(() => create(extra), code('TRANSITION_GATE'));
  for (const extra of [{ originType: 'proposal' }, { originProposalId: 'fake' }, { deliveryWorkflow: false }, { planSubmitted: true }]) assert.throws(() => create(extra), code('VALIDATION_ERROR'));
  for (const user of ['lead', 'dev', 'tester', 'viewer', 'outsider']) assert.throws(() => b.createRequirement(actor[user], { projectId: project.id, title: '未授权确认' }), error => error.status === 403);
  assert.throws(() => b.updateRequirement(actor.admin, requirement.id, { version: requirement.version, status: '开发中' }), code('WORKFLOW_ACTION_REQUIRED'));
  assert.throws(() => b.updateRequirement(actor.admin, requirement.id, { version: requirement.version, acceptance: '' }), code('TRANSITION_GATE'));
});

test('仅维护主责和任务即自动待排期、已排期、开发与提测，无需提交计划，最终仍需人工验收', t => {
  const { b, actor, create, get, task, move } = fixture(t);
  let requirement = create();
  requirement = b.updateRequirement(actor.lead, requirement.id, { version: requirement.version, assigneeId: 'dev' });
  let first = task(requirement, { startDate: '', dueDate: '' }), second = task(requirement, { startDate: '', dueDate: '' });
  assert.equal(get(requirement.id).status, '待排期');
  assert.throws(() => move(first, 'develop'), code('TRANSITION_GATE'));
  requirement = get(requirement.id);
  assert.equal(requirement.status, '待排期');
  requirement = b.updateRequirement(actor.lead, requirement.id, { version: requirement.version, planStart: '2026-09-01', planEnd: '2026-10-01' });
  assert.equal(requirement.status, '待排期'); // 承诺日期不代表研发任务已排期。
  first = b.updateTask(actor.lead, first.id, { version: first.version, startDate: '2026-09-01', dueDate: '2026-10-01' });
  second = b.updateTask(actor.lead, second.id, { version: second.version, startDate: '2026-09-01', dueDate: '2026-10-01' });
  assert.equal(get(requirement.id).status, '已排期'); assert.equal(get(requirement.id).planSubmitted, false);
  first = move(first, 'develop'); assert.equal(get(requirement.id).status, '开发中');
  first = move(first, 'test'); assert.equal(get(requirement.id).status, '开发中');
  second = move(move(second, 'develop'), 'test'); assert.equal(get(requirement.id).status, '测试中');
  let latest = get(requirement.id);
  assert.throws(() => b.updateRequirement(actor.admin, latest.id, { version: latest.version, status: '已完成' }), code('TRANSITION_GATE'));
  first = move(first, 'done'); second = move(second, 'done');
  latest = get(requirement.id); assert.equal(latest.status, '测试中');
  const state = requirementDeliveryState(latest, [first, second]); assert.equal(state.readyForAcceptance, true);
  assert.throws(() => b.updateRequirement(actor.dev, latest.id, { version: latest.version, status: '已完成' }), error => error.status === 403);
  assert.equal(availableRequirementActions('developer', latest, { tasks: [first, second] }).length, 0);
  assert.equal(b.updateRequirement(actor.product, latest.id, { version: latest.version, status: '已完成' }).status, '已完成');
  const history = b.listHistory(actor.product, { entityType: 'requirement', entityId: latest.id });
  const automatic = history.filter(item => item.detail.automatic);
  assert(automatic.some(item => item.detail.triggerTaskId === first.id && item.actorName === 'dev'));
  assert(automatic.some(item => item.detail.after.status === '测试中' && item.detail.taskAfterStatus === 'test'));
});

test('开工时同时检查前置需求，失败不写任务、需求或审计，完成前置后才能开工', t => {
  const { b, actor, db, prepare, get, move, finish } = fixture(t);
  const before = prepare(), after = prepare({ dependencyIds: [before.requirement.id] });
  const auditCount = db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.throws(() => move(after.tasks[0], 'develop'), code('DEPENDENCY_GATE'));
  assert.equal(get(after.requirement.id).version, after.requirement.version);
  assert.equal(b.getTask(actor.dev, after.tasks[0].id).status, 'wait');
  assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n, auditCount);
  finish(before.tasks[0]); const ready = get(before.requirement.id);
  b.updateRequirement(actor.product, ready.id, { version: ready.version, status: '已完成' });
  move(after.tasks[0], 'develop'); assert.equal(get(after.requirement.id).status, '开发中');
});

test('任务返工和新增范围令测试中需求自动退回，人工退回必须落实到返工任务', t => {
  const { b, actor, prepare, get, task, move, finish } = fixture(t);
  const prepared = prepare(); let first = finish(prepared.tasks[0]), requirement = get(prepared.requirement.id);
  assert.throws(() => b.returnRequirement(actor.product, requirement.id, { version: requirement.version, reason: '不通过', taskIds: [] }), code('VALIDATION_ERROR'));
  assert.throws(() => b.returnRequirement(actor.product, requirement.id, { version: requirement.version, reason: '', taskIds: [first.id] }), code('VALIDATION_ERROR'));
  assert.throws(() => b.returnRequirement(actor.dev, requirement.id, { version: requirement.version, reason: '不通过', taskIds: [first.id] }), error => error.status === 403);
  const unrelated = prepare().tasks[0];
  for (const invalidId of [unrelated.id, 'missing-task']) assert.throws(() => b.returnRequirement(actor.product, requirement.id, { version: requirement.version, reason: '不通过', taskIds: [invalidId] }), error => error.status === 400 && error.message === '返工任务必须是本需求测试中或已完成的有效任务');
  requirement = b.returnRequirement(actor.product, requirement.id, { version: requirement.version, reason: '联调结果不符合验收标准', taskIds: [first.id] });
  assert.equal(requirement.status, '开发中');
  first = b.getTask(actor.dev, first.id); assert.equal(first.status, 'develop'); assert.equal(first.completedAt, '');
  b.updateRequirement(actor.product, requirement.id, { version: requirement.version, description: '更新需求说明' });
  assert.equal(get(requirement.id).status, '开发中');
  first = move(move(first, 'test'), 'done'); assert.equal(get(requirement.id).status, '测试中');
  const added = task(requirement); assert.equal(get(requirement.id).status, '开发中');
  finish(added); assert.equal(get(requirement.id).status, '测试中');
  first = move(first, 'develop', 'tester', { reason: '任务复测失败' });
  assert.equal(get(requirement.id).status, '开发中');
});

test('任务移入移出、删除恢复、批量新增都在同次保存中同步受影响需求', t => {
  const { b, actor, prepare, get, task, finish } = fixture(t);
  const a = prepare(), c = prepare(); finish(a.tasks[0]); finish(c.tasks[0]);
  let extra = task(a.requirement); assert.equal(get(a.requirement.id).status, '开发中');
  extra = b.updateTask(actor.lead, extra.id, { version: extra.version, requirementId: c.requirement.id });
  assert.deepEqual([get(a.requirement.id).status, get(c.requirement.id).status], ['测试中', '开发中']);
  extra = b.archiveTask(actor.admin, extra.id, { version: extra.version }); assert.equal(get(c.requirement.id).status, '测试中');
  extra = b.archiveTask(actor.admin, extra.id, { version: extra.version, archived: false }); assert.equal(get(c.requirement.id).status, '开发中');
  finish(extra); const requirement = get(c.requirement.id);
  const batch = b.createTaskBatch(actor.lead, requirement.id, { version: requirement.version, requestId: 'new-scope', tasks: [{ title: '新增补充实现', ownerId: 'dev', estimateHours: 4 }] });
  assert.equal(batch.requirement.status, '开发中');
  assert.equal(get(c.requirement.id).status, '开发中');
});

test('没有有效交付任务、全部终止或全部删除不能自动提测或完成', t => {
  const { b, actor, prepare, get, move } = fixture(t);
  const prepared = prepare(); let task = move(prepared.tasks[0], 'develop');
  task = move(task, 'terminated', 'lead', { reason: '交付范围取消' });
  let requirement = get(prepared.requirement.id);
  assert.equal(requirement.status, '开发中');
  let delivery = requirementDeliveryState(requirement, [task]);
  assert.equal(delivery.readyForAcceptance, false); assert.match(delivery.gates.join(''), /没有有效交付任务/);
  assert.throws(() => b.updateRequirement(actor.product, requirement.id, { version: requirement.version, status: '已完成' }), code('AUTOMATIC_WORKFLOW'));
  task = b.archiveTask(actor.admin, task.id, { version: task.version }); requirement = get(requirement.id);
  delivery = requirementDeliveryState(requirement, [task]); assert.equal(delivery.counts.total, 0); assert.equal(delivery.readyForAcceptance, false);
  assert.equal(requirement.status, '开发中');
});

test('已完成需求保护交付范围，显式重开阻止自动提测，终止重开允许重新安排任务', t => {
  const { b, actor, prepare, get, task, finish, move } = fixture(t);
  const prepared = prepare(); let finished = finish(prepared.tasks[0]), requirement = get(prepared.requirement.id);
  requirement = b.updateRequirement(actor.product, requirement.id, { version: requirement.version, status: '已完成' });
  assert.throws(() => task(requirement), code('STATE_TRANSITION'));
  assert.throws(() => move(finished, 'develop', 'tester'), code('STATE_TRANSITION'));
  assert.throws(() => b.updateTask(actor.lead, finished.id, { version: finished.version, ownerId: 'lead' }), code('STATE_TRANSITION'));
  assert.throws(() => b.archiveTask(actor.admin, finished.id, { version: finished.version }), code('STATE_TRANSITION'));
  finished = b.updateTask(actor.lead, finished.id, { version: finished.version, description: '仅补充交付说明' });
  assert.equal(get(requirement.id).status, '已完成');
  assert.throws(() => b.reopenRequirement(actor.dev, requirement.id, { version: requirement.version, reason: '返工' }), error => error.status === 403);
  requirement = b.reopenRequirement(actor.product, requirement.id, { version: requirement.version, reason: '发现验收遗漏' });
  assert.equal(requirement.status, '开发中'); assert.equal(requirement.workflowHold, true);
  b.updateTask(actor.lead, finished.id, { version: finished.version, title: '补充描述不会消除重开标记' });
  assert.equal(get(requirement.id).workflowHold, true); assert.equal(get(requirement.id).status, '开发中');
  finished = b.getTask(actor.lead, finished.id); move(finished, 'develop', 'tester', { reason: '落实返工' });
  assert.equal(get(requirement.id).workflowHold, false);
  requirement = get(requirement.id);
  assert.throws(() => b.updateRequirement(actor.lead, requirement.id, { version: requirement.version, status: '已终止', reason: '关闭' }), error => error.status === 403);
  requirement = b.updateRequirement(actor.product, requirement.id, { version: requirement.version, status: '已终止', reason: '项目不再交付' });
  requirement = b.reopenRequirement(actor.product, requirement.id, { version: requirement.version, reason: '重新纳入开发' });
  assert.deepEqual([requirement.status, requirement.planSubmitted, requirement.workflowHold], ['已确定', false, false]);
});

test('自动流转与任务写入在同一事务中失败回滚，并发版本不能覆盖系统更新', t => {
  const { b, actor, db, prepare, get, move } = fixture(t);
  const prepared = prepare(), old = prepared.requirement, before = db.prepare('SELECT count(*) n FROM audit').get().n;
  db.exec(`CREATE TRIGGER fail_sync BEFORE UPDATE ON requirements WHEN NEW.id='${old.id}' BEGIN SELECT RAISE(ABORT,'injected'); END`);
  assert.throws(() => move(prepared.tasks[0], 'develop'), /injected/);
  assert.equal(b.getTask(actor.dev, prepared.tasks[0].id).status, 'wait');
  assert.equal(get(old.id).version, old.version); assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n, before);
  db.exec('DROP TRIGGER fail_sync'); move(prepared.tasks[0], 'develop');
  assert.throws(() => b.updateRequirement(actor.lead, old.id, { version: old.version, planEnd: '2026-11-01' }), code('VERSION_CONFLICT'));
  assert.equal(get(old.id).status, '开发中');
});

test('交付承诺和研发日期独立，旧记录只读不迁移，首次任务写自动采用新规则', t => {
  const { b, actor, db, create, get, task } = fixture(t);
  let requirement = create(); requirement = b.updateRequirement(actor.lead, requirement.id, { version: requirement.version, assigneeId: 'dev' }); const child = task(requirement, { startDate: '', dueDate: '' });
  requirement = get(requirement.id);
  const changes = [{ requirementId: requirement.id, version: requirement.version, planStart: '2026-09-01', planEnd: '2026-10-01' }];
  const preview = b.previewSchedule(actor.lead, requirement.projectId, { changes });
  const result = b.applySchedule(actor.lead, requirement.projectId, { changes, previewToken: preview.previewToken, reason: '确认计划日期' });
  assert.equal(result.requirements[0].status, '待排期');
  const legacy = { ...get(requirement.id), deliveryWorkflow: false, planSubmitted: false, status: '已确定' };
  db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  const original = db.prepare('SELECT data FROM requirements WHERE id=?').get(legacy.id).data;
  b.bootstrap(actor.product); b.getRequirement(actor.product, legacy.id);
  assert.equal(db.prepare('SELECT data FROM requirements WHERE id=?').get(legacy.id).data, original);
  assert.equal(requirementDeliveryState(legacy, [child]).status, '已确定');
  const updated = b.updateTask(actor.lead, child.id, { version: child.version, startDate: '2026-09-03', dueDate: '2026-10-05' });
  const current = get(legacy.id), state = requirementDeliveryState(current, [updated]);
  assert.equal(current.status, '已排期'); assert.equal(current.deliveryWorkflow, true); assert.equal(current.planSubmitted, false);
  assert.deepEqual([current.planStart, current.planEnd], ['2026-09-01', '2026-10-01']);
  assert.deepEqual(current.baseline, result.requirements[0].baseline);
  assert.deepEqual([state.developmentStart, state.developmentEnd, state.delayDays], ['2026-09-03', '2026-10-05', 4]);
});

test('研发周期汇总只含有效任务，部分排期显式计数，不覆盖交付承诺', () => {
  const requirement = { id: 'r-rollup', deliveryWorkflow: true, status: '已确定', assigneeId: 'dev', acceptance: '验收', planStart: '2026-08-01', planEnd: '2026-10-10' };
  const defaults = { requirementId: requirement.id, ownerId: 'dev', estimateHours: 8, status: 'wait' };
  const tasks = [
    { ...defaults, startDate: '2026-09-05', dueDate: '2026-10-15' },
    { ...defaults, startDate: '2026-09-01', dueDate: '' },
    { ...defaults, startDate: '2026-10-30', dueDate: '2026-09-01' },
    { ...defaults, startDate: '2026-01-01', dueDate: '2027-01-01', archived: true },
    { ...defaults, startDate: '2026-01-01', dueDate: '2027-01-01', status: 'terminated' },
    { ...defaults, requirementId: 'other', startDate: '2026-01-01', dueDate: '2027-01-01' },
  ];
  const state = requirementDeliveryState(requirement, tasks);
  assert.deepEqual([state.developmentStart, state.developmentEnd, state.scheduledCount, state.unscheduledCount, state.delayDays], ['2026-09-01', '2026-10-15', 1, 2, 5]);
  assert.equal(state.scheduleReady, false); assert.equal(state.status, '待排期');
  assert.deepEqual([requirement.planStart, requirement.planEnd], ['2026-08-01', '2026-10-10']);
  assert.equal(requirementDeliveryState({ ...requirement, planEnd: '' }, tasks).delayDays, null);
});

test('历史已开工需求缺旧排期仍可提测验收，首次开工才检查完整任务排期', t => {
  const { b, actor, db, create, task, get, move } = fixture(t);
  const requirement = create(), child = task(requirement, { startDate: '', dueDate: '' });
  assert.throws(() => move(child, 'develop'), code('TRANSITION_GATE'));
  db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify({ ...requirement, status: '开发中', deliveryWorkflow: false, planStart: '', planEnd: '' }), requirement.id);
  db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...child, status: 'develop' }), child.id);
  let updated = b.getTask(actor.dev, child.id); updated = move(updated, 'test');
  assert.equal(get(requirement.id).status, '测试中'); updated = move(updated, 'done');
  const current = get(requirement.id);
  assert.equal(b.updateRequirement(actor.product, current.id, { version: current.version, status: '已完成' }).status, '已完成');
});

test('历史早期需求只能在提议模块确认，保留编号、任务和文档关联', t => {
  const { b, actor, db, create, task } = fixture(t);
  const requirement = create({ docRefs: [{ document: '交付说明.md', sections: ['A-1'] }] }), child = task(requirement);
  const legacy = { ...requirement, status: '待评审', deliveryWorkflow: false };
  db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  for (const input of [{ status: '已确定' }, { title: '绕过提议更新内容' }]) assert.throws(() => b.updateRequirement(actor.product, legacy.id, { version: legacy.version, ...input }), code('PROPOSAL_WORKFLOW_REQUIRED'));
  assert.throws(() => task(legacy), code('PROPOSAL_WORKFLOW_REQUIRED'));
  assert.throws(() => b.updateTask(actor.lead, child.id, { version: child.version, status: 'develop' }), code('PROPOSAL_WORKFLOW_REQUIRED'));
  assert.throws(() => b.previewSchedule(actor.lead, legacy.projectId, { changes: [{ requirementId: legacy.id, version: legacy.version, planStart: '2026-09-01', planEnd: '2026-10-01' }] }), error => error.details.rows[0].code === 'PROPOSAL_WORKFLOW_REQUIRED');
  const result = b.confirmLegacyRequirement(actor.product, legacy.id, { version: legacy.version, originProposalId: 'legacy-proposal', acceptance: '产品确认验收标准' });
  assert.equal(result.id, legacy.id); assert.equal(result.status, '已确定'); assert.equal(result.originProposalId, 'legacy-proposal');
  assert.deepEqual(result.docRefs, legacy.docRefs); assert.equal(b.getTask(actor.lead, child.id).requirementId, legacy.id);
});
