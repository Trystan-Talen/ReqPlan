import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workCalendar, schedulePlan } from '../scripts/plan-tasks.mjs';

test('工作日历跳过周末与节假日', () => {
  assert.deepEqual(workCalendar('2026-11-05', ['2026-11-09']).slice(0, 4), ['2026-11-05', '2026-11-06', '2026-11-10', '2026-11-11']);
});

test('按阶段排队、按人每日产能顺排，前置任务完成后的下一个工作日开始', () => {
  const plan = { startDate: '2026-09-21', capacityHours: 7, capacityOverrides: [{ from: '2026-09-21', until: '2026-09-22', hours: 8 }], holidays: [], acceptanceBufferDays: 1, owners: { A: 'amy', B: 'bob' },
    tasks: [
      { req: 'r2', owner: 'A', phase: 'N1', hours: 7, title: '后排' },
      { req: 'r1', owner: 'A', phase: 'S', hours: 12, title: '冲刺一' },
      { req: 'r1', owner: 'B', phase: 'N0', hours: 2, title: '草案' },
      { req: 'r1', owner: 'A', phase: 'S', hours: 3, title: '冲刺二', after: ['草案'] },
    ] };
  const { tasks, requirements, load } = schedulePlan(plan);
  const byTitle = Object.fromEntries(tasks.map(item => [item.title, item]));
  assert.deepEqual([byTitle['冲刺一'].startDate, byTitle['冲刺一'].dueDate], ['2026-09-21', '2026-09-22']); // 8 + 4
  assert.deepEqual([byTitle['冲刺二'].startDate, byTitle['冲刺二'].dueDate], ['2026-09-22', '2026-09-22']); // 草案 9/21 完成 → 9/22 起，剩余 4 小时
  assert.deepEqual([byTitle['后排'].startDate, byTitle['后排'].dueDate], ['2026-09-22', '2026-09-23']); // 1 小时 + 6 小时（9/23 起每天 7 小时）
  const r1 = requirements.find(item => item.id === 'r1');
  assert.equal(r1.planStart, '2026-09-21'); assert.equal(r1.planEnd, '2026-09-23');
  assert.equal(r1.assignee, 'amy'); assert.deepEqual(r1.collaborators, ['bob']);
  assert.equal(load.get('amy').hours, 22);
  assert.throws(() => schedulePlan({ ...plan, tasks: [{ req: 'r', owner: 'A', phase: 'S', hours: 1, title: 'x', after: ['不存在'] }] }), /必须排在它前面/);
  assert.throws(() => schedulePlan({ ...plan, tasks: [{ req: 'r', owner: 'A', phase: 'N9', hours: 1, title: 'x' }] }), /未知阶段/);
});

test('2026-09-18 合并版计划：任务 2～3 天粒度，10/9 冲刺在 10/9 前完成，工时与原计划一致', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const plan = read('task-plan-2026-09-18-merged.json'), original = read('task-plan-2026-09-18.json');
  const { tasks, load } = schedulePlan(plan);
  assert.equal(tasks.length, 71);
  assert.equal(tasks.reduce((sum, item) => sum + item.hours, 0), original.tasks.reduce((sum, item) => sum + item.hours, 0));
  assert.ok(tasks.every(item => item.hours <= 30));
  assert.ok(tasks.filter(item => item.hours <= 8).length <= 12);
  assert.ok(tasks.filter(item => item.phase === 'S').every(item => item.dueDate <= '2026-10-09'));
  assert.ok(tasks.filter(item => item.phase === 'N0').every(item => item.dueDate <= '2026-09-29'));
  // 除预设可砍项（视频、阿拉伯文）外，全部任务在 12/4 代码冻结前完成。
  assert.ok(tasks.filter(item => item.phase !== 'N3cut').every(item => item.dueDate <= '2026-12-04'));
  assert.ok(load.size === 3);
});
