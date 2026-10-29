import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWorkbenchContent } from '../../frontend/workbench-ui.js';

const project = (id, overrides = {}) => ({
  project: { id, name: `项目 ${id}`, status: '进行中', targetDate: '2026-10-09' },
  requirements: [], tasks: [], stageCounts: { 已排期: 2 }, completedTasks: 0, totalTasks: 3,
  waitingTasks: 3, developTasks: 0, testTasks: 0, targetPastDays: 7,
  overdueTasks: [{ id: `${id}-late` }], dueSoonTasks: [], unassignedTasks: [], preparation: [],
  commitmentOverdue: [], planConflicts: [], nextMilestone: null, ...overrides
});
const model = overrides => ({
  date: '2026-10-16', windowEnd: '2026-10-22',
  metrics: { projectCount: 2, requirementCount: 4, targetPast: 2, overdue: 2, dueSoon: 0, actionable: 0 },
  projects: [project('a'), project('b')], todos: [], activation: null, ...overrides
});

test('工作台搜索只筛项目推进，保留完整指标、本人待办及其项目上下文', () => {
  const input = model({ todos: [{ entityId: 'task-b', entityType: 'task', projectId: 'b', title: '我的接口任务', reasons: ['我的开发中任务'] }] });
  input.metrics.actionable = 1;
  const all = renderWorkbenchContent(input);
  const filtered = renderWorkbenchContent(input, { search: '项目 a', visibleProjectIds: new Set(['a']) });
  assert.equal(all.split('<div class="split team-layout">')[0], filtered.split('<div class="split team-layout">')[0]);
  assert.match(filtered, /1 \/ 2 个项目/);
  assert.match(filtered, /data-task="task-b"/);
  assert.match(filtered, /<p class="workbench-todo-context"><span>项目 b<\/span><\/p>/);
  assert.doesNotMatch(filtered, /<h3><a[^>]*>项目 b<\/a>/);
  assert.equal((filtered.match(/class="workbench-project"/g) || []).length, 1);
  const empty = renderWorkbenchContent(input, { search: '不存在', visibleProjectIds: [] });
  assert.match(empty, /没有符合条件的项目/);
  assert.match(empty, /data-task="task-b"/);
});

test('待办读取中与读取失败显示未知，不能伪装为零或继承旧待办', () => {
  const input = model({ todos: null });
  input.metrics.actionable = null;
  const pending = renderWorkbenchContent(input);
  assert.match(pending, /待我处理[\s\S]*?metric-value">—<\/div>/);
  assert.match(pending, /正在读取你的待办/);
  assert.doesNotMatch(pending, /暂无直接分配/);
  const error = renderWorkbenchContent(model(), { workError: true });
  assert.match(error, /待我处理[\s\S]*?metric-value">—<\/div>/);
  assert.match(error, /data-action="refresh-workbench"/);
  assert.doesNotMatch(error, /暂无直接分配/);
});

test('只读项目使用查看文案，具有准备权限时才显示完善入口', () => {
  const input = model({ projects: [project('a', { unassignedTasks: [{ id: 'task-unassigned' }] }), project('b', { preparation: [{ requirement: { id: 'req-plan' }, state: { planGates: ['请分配主责'] } }] })] });
  const readonly = renderWorkbenchContent(input);
  assert.match(readonly, /查看未分配任务/);
  assert.match(readonly, /查看交付准备/);
  assert.doesNotMatch(readonly, />完善任务负责人<|>完善交付准备</);
  assert.match(readonly, /data-task="task-unassigned"/);
  assert.match(readonly, /data-open-requirement-tasks="req-plan"/);
  const editable = renderWorkbenchContent(input, { canPrepare: id => id === 'a' });
  assert.match(editable, /完善任务负责人/);
  assert.doesNotMatch(editable, />完善交付准备</);
  assert.match(editable, /data-workbench-risk="a"/);
});

test('里程碑只显示计划节点，不捏造完成状态；没有有效任务不显示虚构百分比', () => {
  const input = model({ projects: [project('a', { totalTasks: 0, nextMilestone: { label: '接口联调', date: '2026-10-16' } })] });
  const html = renderWorkbenchContent(input);
  assert.match(html, /今天到达计划节点<\/span><strong>接口联调/);
  assert.match(html, /暂无有效任务/);
  assert.doesNotMatch(html, /节点未完成|节点已完成|0%/);
  assert.match(html.replace(/<[^>]+>/g, ''), /2026-10-16 — 2026-10-22，含今天/);
  assert.match(html, /<time class="metric-note-date" datetime="2026-10-16">2026-10-16<\/time>/);
  assert.match(html, /<time class="metric-note-date" datetime="2026-10-22">2026-10-22<\/time>/);
});

test('个人待办最多展示五项，正确连接原详情、任务组与完整清单', () => {
  const todos = Array.from({ length: 7 }, (_, index) => ({ entityType: index === 0 ? 'requirement' : 'task', entityId: `item-${index}`, title: `事项 ${index}`, projectId: 'a', reasons: ['需要处理'], openTasks: index === 0 }));
  const input = model({ todos, activation: { accountCount: 3, taskCount: 70 } });
  input.metrics.actionable = 7;
  const html = renderWorkbenchContent(input);
  assert.equal((html.match(/class="workbench-todo"/g) || []).length, 5);
  assert.match(html, /data-open-requirement-tasks="item-0"/);
  assert.match(html, /data-task="item-1"/);
  assert.match(html, /data-action="workbench-todos">查看全部 7 项/);
  assert.match(html, /href="#\/notifications"/);
  assert.match(html, /3 个待激活账号关联 70 个未完成任务/);
  assert.match(html, /账号激活提示不计入个人待办/);
  assert.doesNotMatch(renderWorkbenchContent(model()), /href="#\/users"/);
});

test('工作台转义项目、节点、待办与操作标识，不输出用户注入的结构', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const input = model({ projects: [project(attack, { project: { id: attack, name: attack, status: attack }, stageCounts: { [attack]: 1 }, nextMilestone: { label: attack, date: attack }, unassignedTasks: [{ id: attack }] })], todos: [{ title: attack, entityType: 'task', entityId: attack, projectId: attack, date: attack, reasons: [attack] }] });
  const html = renderWorkbenchContent(input, { projectPath: () => `#/p/${attack}`, projectColor: () => attack });
  assert.doesNotMatch(html, /<img|onerror="/);
  assert.match(html, /&quot;&gt;&lt;img/);
  assert.match(html, /data-task="&quot;&gt;&lt;img/);
});

test('紧凑项目保留统计与原入口，阶段和完整计划可展开，其他风险进入原抽屉', () => {
  const input = model({ projects: [project('a', { commitmentOverdue: [{}], planConflicts: [{}], unassignedTasks: [{ id: 'unassigned' }], nextMilestone: { label: '计划节点', date: '2026-10-16' } })] });
  const before = JSON.stringify(input);
  const html = renderWorkbenchContent(input, { canPrepare: () => true });
  assert.match(html, /任务已完成 0 \/ 3 · 2 条需求/);
  assert.match(html, /<details class="workbench-project-detail"><summary>/);
  assert.match(html, /需求<\/span>已排期 2/);
  assert.match(html, /开发中 0 · 测试中 0 · 待开始 3/);
  assert.match(html, /data-workbench-risk="a">另 3 类关注/);
  assert.match(html, /data-task="unassigned">完善任务负责人/);
  assert.match(html, /href="#\/p\/a\/timeline">查看完整交付排期/);
  assert.equal(JSON.stringify(input), before);
});

test('近期节点独立于个人待办和搜索，七日边界不变且不推断完成', () => {
  const input = model({ projects: [
    project('today', { nextMilestone: { label: '今天节点', date: '2026-10-16' } }),
    project('day7', { nextMilestone: { label: '第七天节点', date: '2026-10-22' } }),
    project('day8', { nextMilestone: { label: '第八天节点', date: '2026-10-23' } }),
    project('past', { nextMilestone: { label: '过去节点', date: '2026-10-15' } })
  ] });
  const html = renderWorkbenchContent(input, { search: '无匹配', visibleProjectIds: [] });
  assert.match(html, /没有符合条件的项目/);
  assert.match(html, /class="empty-state-compact"/);
  assert.match(html, /metric-value">0<\/div>/);
  assert.match(html, /今天节点/);
  assert.match(html, /第七天节点/);
  assert.doesNotMatch(html, /第八天节点|过去节点/);
  assert.match(html, /计划日期，不代表已完成，不计入个人待办/);
  assert.doesNotMatch(renderWorkbenchContent(model()), /近期计划节点/);
});
