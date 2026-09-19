import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementProgress, requirementHealth, projectSummary, packLanes, maxParallelProjects, portfolioTimelineContext, renderPortfolio } from '../../frontend/portfolio.js';
import { createTimelineState } from '../../frontend/timeline.js';

const today = '2026-10-10';
const req = (values = {}) => ({ id: 'r1', projectId: 'p1', title: '需求', status: '开发中', planStart: '2026-10-01', planEnd: '2026-10-20', ...values });
const task = (values = {}) => ({ id: 't1', projectId: 'p1', requirementId: 'r1', title: '任务', status: 'develop', ownerId: 'u1', estimateHours: 8, startDate: '2026-10-01', dueDate: '2026-10-05', ...values });

test('需求进度按未终止任务工时计算，没有工时时按个数', () => {
  const tasks = [task({ id: 'a', status: 'done', estimateHours: 6 }), task({ id: 'b', estimateHours: 2 }), task({ id: 'c', status: 'terminated', estimateHours: 50 }), task({ id: 'd', status: 'done', archived: true, estimateHours: 50 })];
  assert.equal(requirementProgress(req(), tasks), 0.75);
  assert.equal(requirementProgress(req(), [task({ id: 'a', status: '已完成', estimateHours: 0 }), task({ id: 'b', estimateHours: 0 })]), 0.5);
  assert.equal(requirementProgress(req(), []), 0);
  assert.equal(requirementProgress(req({ status: '已完成' }), []), 1);
});

test('已延期：超过计划结束日或计划晚于基线，延期天数取较大者', () => {
  const overdue = requirementHealth(req({ planEnd: '2026-10-07' }), { tasks: [], today });
  assert.equal(overdue.state, 'late'); assert.equal(overdue.lateDays, 3);
  const slipped = requirementHealth(req({ planEnd: '2026-10-30', baseline: { planStart: '2026-10-01', planEnd: '2026-10-20' } }), { tasks: [], today });
  assert.equal(slipped.state, 'late'); assert.equal(slipped.lateDays, 10);
  const both = requirementHealth(req({ planEnd: '2026-10-08', baseline: { planStart: '2026-10-01', planEnd: '2026-10-03' } }), { tasks: [], today });
  assert.equal(both.lateDays, 5);
  assert.equal(requirementHealth(req({ status: '已完成', planEnd: '2026-10-01' }), { tasks: [], today }).state, 'done');
  assert.equal(requirementHealth(req({ status: '已终止', planEnd: '2026-10-01' }), { tasks: [], today }).state, 'terminated');
});

test('有风险：已过时间比进度高 20 个百分点以上，或前置需求未完成且已到开始日', () => {
  // 10/1–10/20 共 20 天，10/10 已过 9 天 = 45%。
  const behind = requirementHealth(req(), { tasks: [task({ status: 'done', estimateHours: 2 }), task({ id: 't2', estimateHours: 8 })], today });
  assert.equal(behind.state, 'risk'); assert.match(behind.reasons[0], /时间已过 45%，进度 20%/);
  assert.equal(requirementHealth(req(), { tasks: [task({ status: 'done', estimateHours: 3 }), task({ id: 't2', estimateHours: 7 })], today }).state, 'normal');
  const blocked = requirementHealth(req({ dependencyIds: ['r0'] }), { tasks: [task({ status: 'done' })], requirements: [req({ id: 'r0', title: '前置', status: '开发中' })], today });
  assert.equal(blocked.state, 'risk'); assert.match(blocked.reasons.join(), /前置需求未完成：前置/);
  const notStarted = requirementHealth(req({ planStart: '2026-10-12', dependencyIds: ['r0'] }), { tasks: [], requirements: [req({ id: 'r0', status: '开发中' })], today });
  assert.equal(notStarted.state, 'normal');
  assert.equal(requirementHealth(req({ planStart: '', planEnd: '' }), { tasks: [], today }).state, 'unscheduled');
});

test('项目取最差需求状态；最晚需求晚于目标日期也算延期；统计逾期任务与积压', () => {
  const project = { id: 'p1', name: '项目', targetDate: '2026-10-25', milestones: [{ label: '已过', date: '2026-10-01' }, { label: 'N1', date: '2026-10-16' }] };
  const requirements = [req({ id: 'r1' }), req({ id: 'r2', planEnd: '2026-10-28' }), req({ id: 'r3', status: '已确定', planStart: '', planEnd: '' }), req({ id: 'r4', status: '待评审', planStart: '', planEnd: '' }), req({ id: 'r5', status: '已终止' })];
  const tasks = [task({ requirementId: 'r1', status: 'done', estimateHours: 6 }), task({ id: 't2', requirementId: 'r1', estimateHours: 2, dueDate: '2026-10-08' }), task({ id: 't3', requirementId: 'r2', estimateHours: 8, dueDate: '2026-10-28' })];
  const summary = projectSummary(project, { requirements, tasks, today });
  assert.equal(summary.state, 'late'); assert.equal(summary.lateDays, 3);
  assert.equal(summary.start, '2026-10-01'); assert.equal(summary.end, '2026-10-28');
  assert.equal(summary.progress, 6 / 16);
  assert.equal(summary.total, 4); assert.deepEqual(summary.counts, { review: 1, plan: 1, progress: 2, test: 0, done: 0 });
  assert.equal(summary.overdueTasks, 1);
  assert.deepEqual(summary.backlog, { review: 1, split: 1, schedule: 1 });
  assert.equal(summary.nextMilestone.label, 'N1'); assert.equal(summary.nextMilestone.daysLeft, 6);
  assert.equal(projectSummary({ id: 'p1', targetDate: '2026-12-01' }, { requirements: [req({ status: '已完成' })], tasks: [], today }).state, 'done');
  assert.equal(projectSummary({ id: 'p9' }, { requirements, tasks, today }).state, 'empty');
});

test('人员泳道：重叠任务分道，并行项目数按同一天计算', () => {
  const items = [{ startDay: 1, endDay: 3, task: { projectId: 'a' } }, { startDay: 2, endDay: 4, task: { projectId: 'b' } }, { startDay: 4, endDay: 5, task: { projectId: 'a' } }, { startDay: 6, endDay: 6, task: { projectId: 'c' } }];
  const packed = packLanes(items);
  assert.equal(packed.lanes, 2); assert.deepEqual(packed.items.map(item => item.lane), [0, 1, 0, 0]);
  assert.equal(maxParallelProjects(items), 2);
  assert.equal(maxParallelProjects([{ startDay: 1, endDay: 2, task: { projectId: 'a' } }, { startDay: 2, endDay: 3, task: { projectId: 'a' } }]), 1);
});

test('全局甘特范围覆盖所有可见项目周期、需求与任务；页面转义用户内容并提供两种视图', () => {
  const projects = [{ id: 'p1', name: '<b>项目</b>', startDate: '2026-09-01', targetDate: '2026-12-05', milestones: [{ label: 'N1', date: '2026-10-16' }] }, { id: 'p2', name: '已归档', archived: true, startDate: '2020-01-01', targetDate: '2020-02-01' }];
  const requirements = [req({ title: '<img src=x>' })], tasks = [task({ title: '"任务"', dueDate: '2027-01-02' })];
  const context = portfolioTimelineContext({ projects: projects.filter(item => !item.archived), requirements, tasks, today });
  assert.equal(context.project.startDate, '2026-09-01'); assert.equal(context.tasks.length, 2);
  const args = { projects, requirements, tasks, users: [{ id: 'u1', name: '开发甲' }], today, state: { ...createTimelineState(today), fit: true }, filters: { view: 'project', project: 'all', owner: 'all', issues: false }, expanded: new Set(['p:p1', 'r:r1']), viewportWidth: 900 };
  const html = renderPortfolio(args);
  assert.doesNotMatch(html, /<b>项目|<img src=x>/); assert.match(html, /&lt;b&gt;项目/);
  assert.match(html, /data-requirement="r1"/); assert.match(html, /data-task="t1"/); assert.doesNotMatch(html, /已归档/);
  assert.match(html, /data-timeline-fit aria-pressed="true"/);
  const person = renderPortfolio({ ...args, filters: { ...args.filters, view: 'person' } });
  assert.match(person, /portfolio-lane-bar/); assert.match(person, /开发甲/);
  assert.match(renderPortfolio({ ...args, projects: [] }), /还没有可查看的项目/);
  const issues = renderPortfolio({ ...args, filters: { ...args.filters, issues: true }, requirements: [req({ planEnd: '2026-12-01' })], tasks: [] });
  assert.match(issues, /没有符合条件的项目/);
});
