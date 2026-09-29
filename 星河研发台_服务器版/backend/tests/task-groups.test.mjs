import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRequirementTaskGroups } from '../../frontend/task-groups.js';

const requirement = { id: 'r-1', title: '用量导出', status: '已确定', assigneeId: 'u-1', description: '供财务核对。', acceptance: '导出范围与账单一致。', planEnd: '2026-10-05' };
const task = { id: 't-1', requirementId: 'r-1', title: '开发导出功能', ownerId: 'u-1', estimateHours: 8, status: 'wait', startDate: '2026-09-28', dueDate: '2026-10-10' };
const users = [{ id: 'u-1', name: '小林' }];
const expandedGroups = html => [...html.matchAll(/<details class="requirement-task-group" open><summary class="task-group-summary" data-task-group="([^"]+)"/g)].map(match => match[1]);

test('按需求而非任务建组，优先展开未拆分需求并提供一个主操作', () => {
  const requirements = [requirement, { ...requirement, id: 'r-2', title: '还未拆分的需求' }, { ...requirement, id: 'r-3', title: '另一条待拆分需求' }];
  const html = renderRequirementTaskGroups({ requirements, tasks: [task], users, role: 'lead' });
  assert.equal((html.match(/class="requirement-task-group"/g) || []).length, 3);
  assert.deepEqual(expandedGroups(html), ['r-2', 'r-3']);
  for (const id of ['r-1', 'r-2', 'r-3']) {
    assert.match(html, new RegExp(`data-requirement="${id}"`));
    assert.match(html, new RegExp(`data-manage-development="${id}"`));
    assert.match(html, new RegExp(`data-linked-task="${id}"`));
    assert.match(html, new RegExp(`data-batch-requirement="${id}"`));
  }
  assert.equal((html.match(/class="btn btn-primary btn-small"/g) || []).length, 3);
  assert.match(html, /class="task-group-more"[\s\S]*批量拆分任务/);
  assert.match(html, /尚未拆分任务。可从新建任务开始。/);
});

test('展开状态由调用方控制，筛选任务不会改变完整进度和研发周期', () => {
  const allTasks = [{ ...task, status: 'done' }, { ...task, id: 't-2', title: '第二个任务', status: 'develop', dueDate: '2026-10-15' }, { ...task, id: 't-3', status: 'done', archived: true }];
  const html = renderRequirementTaskGroups({ requirements: [requirement], tasks: allTasks, filteredTasks: [allTasks[1]], expandedIds: new Set(['r-1']), users, role: 'viewer' });
  assert.deepEqual(expandedGroups(html), ['r-1']);
  assert.match(html, /1 \/ 2<small>有效任务完成/);
  assert.match(html, /当前显示 1 项/);
  assert.match(html, /data-task="t-2"/);
  assert.doesNotMatch(html, /data-task="t-1"|data-task="t-3"/);
  assert.match(html, /2026-09-28 — 2026-10-15/);
  assert.match(html, /预计晚于承诺 10 天/);
  assert.match(html, /承诺交付[\s\S]*2026-10-05/);
  assert.deepEqual(expandedGroups(renderRequirementTaskGroups({ requirements: [requirement], tasks: [task], expandedIds: [] })), []);
});

test('归档、早期和结束需求保留已有任务，但不出现新增或研发设置', () => {
  for (const changes of [{ archived: true }, { status: '未确定' }, { status: '待评审' }, { status: '已完成' }, { status: '已终止' }]) {
    const html = renderRequirementTaskGroups({ requirements: [{ ...requirement, ...changes }], tasks: [task], users, role: 'admin', canManage: () => true, canSplit: () => true });
    assert.match(html, /data-task="t-1"/);
    assert.doesNotMatch(html, /data-linked-task|data-batch-requirement|data-manage-development/);
  }
  const earlyEmpty = renderRequirementTaskGroups({ requirements: [{ ...requirement, status: '未确定' }], tasks: [], role: 'admin' });
  assert.match(earlyEmpty, /暂无可展示的研发需求/);
  const missingParent = renderRequirementTaskGroups({ requirements: [], tasks: [task] });
  assert.match(missingParent, /未关联或原需求不可用/);
  assert.match(missingParent, /data-task="t-1"/);
});

test('研发设置和拆分权限由调用方分别控制，任务渲染回调收到原始任务', () => {
  const received = [];
  const html = renderRequirementTaskGroups({ requirements: [requirement], tasks: [task], role: 'developer', canManage: () => false, canSplit: item => item.id === requirement.id, renderTask: item => { received.push(item); return '<p>已有任务组件</p>'; } });
  assert.deepEqual(received, [task]);
  assert.match(html, /data-linked-task="r-1"/);
  assert.doesNotMatch(html, /data-manage-development/);
  assert.match(html, /已有任务组件/);
  const readonly = renderRequirementTaskGroups({ requirements: [requirement], tasks: [task], role: 'viewer' });
  assert.doesNotMatch(readonly, /data-linked-task|data-batch-requirement|data-manage-development/);
});

test('分组标题、背景、验收、人员、编号和默认任务标题均转义', () => {
  const attack = '\"><img src=x onerror=alert(1)>\'&';
  const badRequirement = { ...requirement, id: attack, title: attack, description: attack, acceptance: attack, assigneeId: attack, planEnd: attack };
  const badTask = { ...task, id: attack, requirementId: attack, title: attack, ownerId: attack };
  const html = renderRequirementTaskGroups({ requirements: [badRequirement], tasks: [badTask], users: [{ id: attack, name: attack }], role: 'admin', expandedIds: [attack] });
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  for (const attribute of ['data-task-group', 'data-requirement', 'data-manage-development', 'data-linked-task', 'data-task']) assert.match(html, new RegExp(`${attribute}="&quot;&gt;&lt;img`));
});

test('部分任务尚未排期显示缺项，全部终止不伪造完成进度', () => {
  const partial = renderRequirementTaskGroups({ requirements: [requirement], tasks: [{ ...task, dueDate: '' }], users });
  assert.match(partial, /0 \/ 1 项任务已排期，1 项待补齐日期/);
  assert.match(partial, /2026-09-28 — 待排期/);
  const terminated = renderRequirementTaskGroups({ requirements: [requirement], tasks: [{ ...task, status: 'terminated' }], users });
  assert.match(terminated, /0 \/ 0<small>有效任务完成/);
  assert.match(terminated, /拆分任务后自动汇总/);
  assert.doesNotMatch(terminated, /预计晚于承诺/);
});

test('完成或终止需求保留研发与承诺日期，不再展示预计延期风险', () => {
  for (const status of ['已完成', '已终止']) {
    const html = renderRequirementTaskGroups({ requirements: [{ ...requirement, status }], tasks: [{ ...task, status: 'done', completedAt: '2026-09-28T08:00:00Z' }] });
    assert.match(html, /2026-09-28 — 2026-10-10/);
    assert.match(html, /承诺交付[\s\S]*2026-10-05/);
    assert.doesNotMatch(html, /预计晚于承诺|class="task-group-delay"/);
  }
});
