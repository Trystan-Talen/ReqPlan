import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementProgress, requirementHealth, requirementWindow, projectSummary, packLanes, maxParallelProjects, portfolioTimelineContext, renderPortfolio } from '../../frontend/portfolio.js';
import { createTimelineState } from '../../frontend/timeline.js';

const today = '2026-10-10';
const req = (values = {}) => ({ id: 'r1', projectId: 'p1', title: '需求', status: '开发中',assigneeId:'u1',acceptance:'符合验收标准', planStart: '2026-10-01', planEnd: '2026-10-20', ...values });
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
  const behind = requirementHealth(req(), { tasks: [task({ status: 'done', estimateHours: 2 }), task({ id: 't2', estimateHours: 8,dueDate:'2026-10-20' })], today });
  assert.equal(behind.state, 'risk'); assert.match(behind.reasons[0], /时间已过 45%，进度 20%/);
  assert.equal(requirementHealth(req(), { tasks: [task({ status: 'done', estimateHours: 3 }), task({ id: 't2', estimateHours: 7,dueDate:'2026-10-20' })], today }).state, 'normal');
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
  assert.deepEqual(summary.backlog, { review: 1, split: 1, schedule: 0 });
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
  assert.equal(context.project.startDate, '2026-09-01');
  assert(context.tasks.some(item=>item.startDate==='2026-10-01'&&item.dueDate==='2026-10-20'),'甘特范围仍覆盖承诺区间');
  assert(context.tasks.some(item=>item.startDate==='2026-10-01'&&item.dueDate==='2027-01-02'),'同时覆盖任务研发区间');
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

test('研发窗口从有效任务汇总，承诺与基线独立保留，未排期不能用承诺冒充',()=>{
  const requirement=req({deliveryWorkflow:true,status:'待排期',planStart:'2026-09-01',planEnd:'2026-11-01'});
  const tasks=[task({startDate:'2026-10-03',dueDate:'2026-10-14'}),task({id:'t2',startDate:'2026-10-06',dueDate:'2026-10-18'}),task({id:'off',status:'terminated',startDate:'2026-01-01',dueDate:'2027-01-01'}),task({id:'archived',archived:true,startDate:'2025-01-01',dueDate:'2028-01-01'})];
  assert.deepEqual(requirementWindow(requirement,tasks),{start:'2026-10-03',end:'2026-10-18',source:'tasks',complete:true,unscheduled:0,taskCount:2});
  assert.equal(requirement.planStart,'2026-09-01');assert.equal(requirement.planEnd,'2026-11-01');
  const empty=requirementHealth(requirement,{tasks:[],today});assert.equal(empty.state,'unscheduled');assert.equal(empty.window.source,'none');
  const legacy=requirementWindow({...requirement,deliveryWorkflow:false},[]);assert.equal(legacy.source,'legacy');assert.equal(legacy.start,'2026-09-01');
  const partial=requirementHealth(requirement,{tasks:[tasks[0],task({id:'missing-date',startDate:'',dueDate:''})],today});
  assert.equal(partial.state,'risk');assert.match(partial.reasons.join('；'),/1 项有效任务日期待完善/);
  const summary=projectSummary({id:'p1'},{requirements:[requirement],tasks,today});assert.equal(summary.start,'2026-10-03');assert.equal(summary.end,'2026-10-18');
  const missingDates=projectSummary({id:'p1'},{requirements:[requirement],tasks:[task({status:'wait',startDate:'',dueDate:''})],today});assert.equal(missingDates.backlog.split,0);assert.equal(missingDates.backlog.schedule,1);
});

test('承诺逾期、任务预计超承诺和研发逾期给出不同风险原因',()=>{
  const requirement=req({deliveryWorkflow:true,planEnd:'2026-10-15'});
  const future=requirementHealth(requirement,{tasks:[task({status:'wait',startDate:'2026-10-12',dueDate:'2026-10-18'})],today});
  assert.equal(future.state,'risk');assert.equal(future.forecastDelayDays,3);assert.equal(future.commitmentOverdueDays,0);assert.equal(future.lateDays,0);
  assert.match(future.reasons.join('；'),/任务预计结束晚于承诺 3 天/);assert.doesNotMatch(future.reasons.join('；'),/已逾期/);
  const commitment=requirementHealth({...requirement,planEnd:'2026-10-08'},{tasks:[task({status:'done',dueDate:'2026-10-07'})],today});
  assert.equal(commitment.state,'late');assert.equal(commitment.commitmentOverdueDays,2);assert.equal(commitment.executionOverdueDays,0);assert.match(commitment.reasons[0],/承诺截止已逾期 2 天/);
  const execution=requirementHealth(requirement,{tasks:[task({dueDate:'2026-10-09'})],today});
  assert.equal(execution.state,'late');assert.equal(execution.commitmentOverdueDays,0);assert.equal(execution.executionOverdueDays,1);assert.match(execution.reasons[0],/研发任务区间已逾期 1 天/);
});

test('甘特主条显示研发日期，承诺与基线可追溯，旧承诺备用明确标注',()=>{
  const projects=[{id:'p1',name:'项目',targetDate:'2026-11-01'}];
  const requirements=[req({deliveryWorkflow:true,planStart:'2026-09-20',planEnd:'2026-10-25',baseline:{planStart:'2026-09-18',planEnd:'2026-10-22'}})];
  const args={projects,requirements,tasks:[task({startDate:'2026-10-02',dueDate:'2026-10-18'})],users:[],today,state:{...createTimelineState(today),fit:true},filters:{view:'project',project:'all',owner:'all',issues:false},expanded:new Set(['p:p1']),viewportWidth:900};
  const html=renderPortfolio(args);
  assert.match(html,/研发周期 2026-10-02 — 2026-10-18/);assert.match(html,/承诺区间 2026-09-20 — 2026-10-25/);assert.match(html,/承诺基线 2026-09-18 — 2026-10-22/);
  const context=portfolioTimelineContext(args);assert(context.tasks.some(item=>item.startDate==='2026-09-18'&&item.dueDate==='2026-10-22'));
  const legacy=renderPortfolio({...args,requirements:[{...requirements[0],deliveryWorkflow:false}],tasks:[]});assert.match(legacy,/历史承诺区间（非任务汇总）/);
  const unscheduled=renderPortfolio({...args,tasks:[]});assert.match(unscheduled,/研发任务尚未排期/);assert.doesNotMatch(unscheduled,/portfolio-requirement-bar/);
});
