import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkbench } from '../../frontend/workbench-model.js';
import { summarizeWork } from '../work-service.mjs';

const DATE = '2026-10-16';
const project = (id = 'p', extra = {}) => ({ id, name: id, status: '进行中', ...extra });
const requirement = (id = 'r', extra = {}) => ({ id, projectId: 'p', title: id, status: '已排期', assigneeId: 'dev', acceptance: '通过验收', ...extra });
const task = (id = 't', extra = {}) => ({ id, projectId: 'p', requirementId: 'r', title: id, ownerId: 'dev', status: 'wait', estimateHours: 8, startDate: DATE, dueDate: '2026-10-22', ...extra });
const member = (role, projectId = 'p', userId = 'me') => ({ userId, projectId, role });
const fixture = (extra = {}) => ({ projects: [project()], requirements: [requirement()], tasks: [], memberships: [member('developer')], users: [], documents: [], ...extra });
const user = { id: 'me', role: 'member' };
const model = (data, options = {}) => buildWorkbench({ data, user, date: DATE, ...options });
const candidates = data => ({ date: DATE, personal: { tasks: [...data.tasks], splits: [...data.requirements], reviews: [...data.tasks], requirements: [...data.requirements] },
  reminders: data.requirements.map(item => ({ entityType: 'requirement', entityId: item.id, kind: 'review', read: true })) });
const ids = items => items.map(item => item.entityId);
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};

test('逾期严格早于今天；未来七日包含今天和第七日，不含第八日或非法、带时区日期', () => {
  const data = fixture({ tasks: [
    task('late', { dueDate: '2026-10-15' }), task('today', { dueDate: DATE }), task('seventh', { dueDate: '2026-10-22' }),
    task('eighth', { dueDate: '2026-10-23' }), task('invalid', { dueDate: '2026-02-30' }),
    task('timestamp', { dueDate: '2026-10-16T00:00:00+08:00' }), task('bad-year', { dueDate: '0000-01-01' }),
    task('done', { status: '已完成', dueDate: '2026-10-15' }), task('terminated', { status: '已终止', dueDate: '2026-10-15' }),
    task('archived', { archived: true, dueDate: '2026-10-15' }),
  ] });
  const result = model(data);
  assert.equal(result.windowEnd, '2026-10-22');
  assert.equal(result.metrics.overdue, 1);
  assert.equal(result.metrics.dueSoon, 2);
  assert.equal(result.projects[0].totalTasks, 8);
  assert.equal(result.projects[0].completedTasks, 1);
  assert.equal(result.projects[0].waitingTasks, 7);
  assert.deepEqual(result.projects[0].dueSoonTasks.map(item => item.id), ['today', 'seventh']);
  for (const invalid of ['2026-02-30', '2026-10-16T00:00:00Z', '2026-10-16T23:00:00-05:00', '0000-01-01', '2026-1-01', '']) {
    assert.throws(() => model(data, { date: invalid }), /统计日期无效/);
  }
  assert.equal(model(fixture(), { date: '2024-02-28' }).windowEnd, '2024-03-05');
});

test('排除归档项目与早期需求；空项目和已结束交付不因旧目标日期被判需关注', () => {
  const projects = ['empty', 'proposal', 'done', 'terminated', 'await-review', 'task-only', 'archive'].map(id => project(id, { targetDate: '2026-10-09', archived: id === 'archive' }));
  const data = fixture({ projects, requirements: [
    requirement('idea', { projectId: 'proposal', status: '未确定' }), requirement('pending', { projectId: 'proposal', status: '待评审' }),
    requirement('closed', { projectId: 'done', status: '已完成' }), requirement('stopped', { projectId: 'terminated', status: '已终止' }),
    requirement('accept', { projectId: 'await-review', status: '测试中' }), requirement('hidden', { projectId: 'archive' }),
  ], tasks: [task('finished', { projectId: 'await-review', requirementId: 'accept', status: 'done' }),
    task('standalone', { projectId: 'task-only', requirementId: null, dueDate: '2026-10-10' }), task('hidden-task', { projectId: 'archive', dueDate: '2026-10-10' })] });
  const result = model(data);
  assert.equal(result.metrics.projectCount, 6);
  assert.equal(result.metrics.requirementCount, 3);
  assert.equal(result.metrics.targetPast, 2, '有效任务完成仍须确认需求验收');
  assert.equal(result.metrics.overdue, 1);
  assert.deepEqual(result.projects.filter(item => item.targetPastDays).map(item => item.project.id), ['await-review', 'task-only']);
  assert.equal(result.projects.find(item => item.project.id === 'await-review').targetPastDays, 7);
});

test('需求阶段、准备缺项和日期冲突复用工作流；已结束需求不保留执行延期', () => {
  const data = fixture({ projects: [project('p', { targetDate: '2026-10-20' })], requirements: [
    requirement('prepare', { deliveryWorkflow: true, assigneeId: null }),
    requirement('late-commit', { planEnd: '2026-10-10' }),
    requirement('after-target', { planEnd: '2026-10-22' }),
    requirement('no-commitment'),
    requirement('finished', { status: '已完成', planEnd: '2026-10-10' }),
  ], tasks: [task('missing-owner', { requirementId: 'prepare', ownerId: null, dueDate: '2026-10-20' }),
    task('late-development', { requirementId: 'late-commit', dueDate: '2026-10-21' }),
    task('beyond-target', { requirementId: 'after-target' }), task('no-promise', { requirementId: 'no-commitment', dueDate: '2026-10-23' }),
    task('old-done', { requirementId: 'finished', status: 'done', dueDate: '2026-10-22' })] });
  const result = model(data).projects[0];
  assert.equal(result.stageCounts['已确定'], 1);
  assert.equal(result.stageCounts['已排期'], 3);
  assert.equal(result.stageCounts['已完成'], 1);
  assert.deepEqual(result.unassignedTasks.map(item => item.id), ['missing-owner']);
  assert.deepEqual(result.preparation.map(item => item.requirement.id), ['prepare']);
  assert(result.preparation[0].state.planGates.includes('请指定主责开发'));
  assert.deepEqual(result.commitmentOverdue.map(item => item.id), ['late-commit']);
  assert.deepEqual(result.planConflicts.map(item => item.id), ['late-commit', 'after-target', 'no-commitment']);
});

test('项目按目标已过、今天节点、具体异常、近期节点稳定排序，历史里程碑不推断未完成', () => {
  const projectIds = ['quiet', 'soon', 'issue', 'today', 'late-first', 'late-second', 'past-node'];
  const data = fixture({ projects: projectIds.map(id => project(id, {
    ...(id.startsWith('late') ? { targetDate: '2026-10-10' } : {}),
    milestones: [{ label: '旧节点', date: '2026-10-09' }, { label: '无效节点', date: '2026-02-30' },
      ...(id === 'today' ? [{ label: '今日节点', date: DATE }] : id === 'soon' ? [{ label: '近期节点', date: '2026-10-20' }] : [])],
  })), requirements: [], tasks: ['issue', 'late-first', 'late-second'].map(id => task(id, { projectId: id, requirementId: null, dueDate: '2026-10-15' })) });
  const result = model(data);
  assert.deepEqual(result.projects.map(item => item.project.id), ['late-first', 'late-second', 'today', 'issue', 'soon', 'quiet', 'past-node']);
  assert.deepEqual(result.projects.find(item => item.project.id === 'today').nextMilestone, { label: '今日节点', date: DATE });
  assert.equal(result.projects.find(item => item.project.id === 'past-node').nextMilestone, null);
});

test('待办未读取或日期不同保持未知，不以零代替；事项按实体去重，通知已读不解除事项', () => {
  const data = fixture({ memberships: [member('lead')], requirements: [requirement('r', { assigneeId: null })],
    tasks: [task('mine', { ownerId: 'me', dueDate: '2026-10-15', dependencyIds: ['missing'] }),
      task('review', { ownerId: 'me', status: '测试中' })] });
  assert.equal(model(data).todos, null);
  assert.equal(model(data).metrics.actionable, null);
  assert.equal(model(data, { work: { ...candidates(data), date: '2026-10-15' } }).metrics.actionable, null);
  const work = candidates(data);
  work.personal.tasks.push(data.tasks[0]);
  work.reminders.push({ entityType: 'task', entityId: 'mine', kind: 'overdue', read: false });
  const result = model(data, { work });
  assert.equal(result.metrics.actionable, 3);
  assert.deepEqual(ids(result.todos), ['mine', 'r', 'review']);
  assert.deepEqual(result.todos[0].reasons, ['任务已逾期 1 天', '1 个前置任务尚未完成', '我的待开始任务']);
  assert.equal(result.todos.find(item => item.entityId === 'review').kind, 'review');
  assert.equal(result.todos.find(item => item.entityId === 'r').openTasks, true);
  assert.equal(model(data, { work: { ...work, reminders: [] } }).metrics.actionable, 3);
});

test('管理员的管理权限不制造业务职责，待激活账号仅形成管理提示', () => {
  const data = fixture({ memberships: [], users: [{ id: 'dev', status: 'pending' }, { id: 'other', status: 'pending' }],
    tasks: [task('team'), task('review', { status: 'test' }), task('own', { ownerId: 'me' }),
      task('own-review', { ownerId: 'me', status: 'test' }), task('done', { ownerId: 'other', status: 'done' }),
      task('archived', { ownerId: 'other', archived: true }), task('terminated', { ownerId: 'other', status: 'terminated' })] });
  const admin = model(data, { user: { ...user, role: 'admin' }, work: candidates(data) });
  assert.deepEqual(ids(admin.todos), ['own-review', 'own']);
  assert.deepEqual(admin.activation, { accountCount: 1, taskCount: 2 });
  assert.equal(model(data, { work: candidates(data) }).activation, null);
  assert.equal(model(data, { work: candidates(data) }).metrics.actionable, 0);
});

test('任务验收遵守项目角色和自身验收规则，只读角色与无成员管理层无可执行待办', () => {
  for (const role of ['product', 'lead', 'developer', 'tester', 'viewer', 'executive']) {
    const data = fixture({ memberships: role === 'executive' ? [] : [member(role)], tasks: [
      task('own-wait', { ownerId: 'me' }), task('own-test', { ownerId: 'me', status: 'test' }),
      task('other-test', { status: '测试中' }),
    ] });
    const result = model(data, { work: candidates(data), user: { ...user, executive: role === 'executive' } });
    const expected = role === 'lead' ? ['other-test', 'own-test', 'own-wait'] : role === 'developer' ? ['other-test', 'own-wait']
      : ['product', 'tester'].includes(role) ? ['other-test'] : [];
    assert.deepEqual(ids(result.todos).sort(), expected.sort(), role);
  }
});

test('需求验收仅来自有效验收提醒，非全部负责或协作需求；全部任务完成仍需正式验收权限', () => {
  for (const role of ['product', 'lead', 'developer', 'tester', 'viewer']) {
    const data = fixture({ memberships: [member(role)], requirements: [
      requirement('ready', { status: '测试中', ownerId: 'me', assigneeId: 'me' }),
      requirement('blocked', { status: '测试中' }), requirement('held', { status: '测试中', workflowHold: true }),
      requirement('just-owned', { ownerId: 'me', collaboratorIds: ['me'] }),
    ], tasks: [task('done', { requirementId: 'ready', status: '已完成' }), task('testing', { requirementId: 'blocked', status: 'test' }),
      task('held-done', { requirementId: 'held', status: 'done' }), task('not-due', { requirementId: 'just-owned', dueDate: '2026-11-01' })] });
    const result = model(data, { work: candidates(data) });
    assert.equal(result.todos.some(item => item.entityId === 'ready'), ['product', 'lead', 'tester'].includes(role), role);
    assert(!result.todos.some(item => ['blocked', 'held', 'just-owned'].includes(item.entityId)), role);
  }
});

test('过期或越权的工作候选不能带入隐藏项目、归档实体、结束需求任务或伪造身份字段', () => {
  const data = fixture({ projects: [project(), project('p2')], memberships: [member('developer'), member('viewer', 'p2')],
    requirements: [requirement(), requirement('closed', { status: '已完成' }), requirement('archived-r', { archived: true }), requirement('r2', { projectId: 'p2' })],
    tasks: [task('own', { ownerId: 'me' }), task('team'), task('gone', { ownerId: 'me', archived: true }),
      task('closed-task', { ownerId: 'me', requirementId: 'closed' }), task('archived-parent', { ownerId: 'me', requirementId: 'archived-r' }),
      task('readonly', { ownerId: 'me', projectId: 'p2', requirementId: 'r2' }), task('read-review', { projectId: 'p2', requirementId: 'r2', status: 'test' })] });
  const work = candidates(data);
  work.personal.tasks = [...data.tasks.map(item => ({ ...item, ownerId: 'me', projectId: 'p', title: '伪造标题' })), task('injected', { projectId: 'secret', ownerId: 'me' })];
  work.personal.splits.push(requirement('secret', { projectId: 'secret' }));
  const result = model(data, { work });
  assert.deepEqual(ids(result.todos), ['own']);
  assert.equal(result.todos[0].title, 'own');
  assert(!JSON.stringify(result.todos).includes('secret'));
});

test('跨项目职责独立：某项目的主开发不能吸收其他项目安排或验收职责', () => {
  const data = fixture({ projects: [project(), project('p2')], memberships: [member('lead'), member('viewer', 'p2')],
    requirements: [requirement('r', { assigneeId: null }), requirement('r2', { projectId: 'p2', assigneeId: null })],
    tasks: [task('t'), task('t2', { projectId: 'p2', requirementId: 'r2', status: 'test' })] });
  assert.deepEqual(ids(model(data, { work: candidates(data) }).todos), ['r']);
  assert.deepEqual(ids(model(data, { user: { ...user, role: 'admin' }, work: candidates(data) }).todos), ['r']);
});

test('与现有工作服务合并时补齐主开发自身任务验收，前置阻塞只附加到既有事项', () => {
  const data = fixture({ memberships: [member('lead')], tasks: [task('own-test', { ownerId: 'me', status: 'test' }),
    task('team-blocked', { dependencyIds: ['missing'], startDate: '2026-10-01', dueDate: '2026-10-15' })] });
  const work = summarizeWork(data, user, DATE);
  assert.equal(work.personal.reviews.length, 0, '现有服务不主动列出自身任务验收');
  assert(work.reminders.some(item => item.entityId === 'team-blocked'));
  const result = model(data, { work });
  assert.deepEqual(ids(result.todos), ['own-test']);
});

test('统计不修改输入、不补造更新时间、不将旧工作响应作为新日期待办', () => {
  const data = fixture({ projects: [project('p', { milestones: [{ label: '后', date: '2026-10-22' }, { label: '前', date: DATE }] })],
    requirements: [requirement('r', { deliveryWorkflow: true, updatedAt: '2026-09-22T00:00:00Z' })], tasks: [task('t', { ownerId: 'me' })] });
  const work = candidates(data), before = JSON.stringify({ data, work });
  freeze(data); freeze(work);
  const result = model(data, { work });
  assert.equal(result.metrics.actionable, 1);
  assert.equal(JSON.stringify({ data, work }), before);
  assert.equal(model(data, { work, date: '2026-10-17' }).metrics.actionable, null);
});
