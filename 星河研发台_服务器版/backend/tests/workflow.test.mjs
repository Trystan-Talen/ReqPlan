import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequirementTransition, availableRequirementActions, availableTaskStatuses, checkTaskTransition, taskGranularity, normalizeBaseline, getScheduleComparison, roleCan, requirementDeliveryState } from '../../frontend/workflow.js';

test('共享需求流程保持门禁、角色验收及中文旧任务兼容', () => {
  const previous = { status: '测试中', acceptance: '验收口径' }, next = { ...previous, status: '已完成' };
  assert.equal(checkRequirementTransition('viewer', previous, next, { tasks: [{status:'已完成'}] }).code, 'FORBIDDEN');
  for (const role of ['product', 'lead', 'tester']) assert.equal(checkRequirementTransition(role, previous, next, { tasks: [{status:'已完成'}] }).ok, true);
  assert.equal(checkRequirementTransition('developer', previous, next, { tasks: [{status:'已完成'}] }).code, 'FORBIDDEN');
  assert.equal(checkRequirementTransition('tester', previous, next, { tasks: [{status:'已完成'}, {status:'已终止'}] }).ok, true);
  assert.equal(checkRequirementTransition('admin', previous, next, { tasks: [{status:'done',archived:true}] }).code, 'TRANSITION_GATE');
  assert.equal(checkRequirementTransition('admin', {status:'未确定'}, {status:'已完成'}).code, 'STATE_TRANSITION');
  assert.equal(availableRequirementActions('developer', previous).some(action => action.status === '已完成'), false);
  assert.equal(availableRequirementActions('tester', previous).find(action => action.status === '已完成').allowed, false);
  assert.deepEqual(availableRequirementActions('viewer', previous), []);
  const ready = { status:'已确定', deliveryWorkflow:true, acceptance:'有标准', assigneeId:'dev', planStart:'2026-09-01', planEnd:'2026-09-10' };
  assert.equal(requirementDeliveryState(ready).status, '已确定');
  assert.equal(requirementDeliveryState(ready,[{status:'wait',ownerId:'dev',estimateHours:8}]).status,'待排期');
  assert.equal(requirementDeliveryState(ready,[{status:'wait',ownerId:'dev',estimateHours:8,startDate:'2026-09-02',dueDate:'2026-09-11'},{status:'terminated'}]).status,'已排期');
  assert.equal(availableRequirementActions('product', ready).some(action => action.status === '待排期'), false);
  assert.equal(availableRequirementActions('lead', ready).some(action => ['待排期','已排期'].includes(action.status)), false);
});

test('角色流转矩阵：产品管评审和终止，主开发拆分排期，开发提测，测试验收或带原因退回，管理层与观察者只读', () => {
  const draft = { status:'未确定', description:'背景' };
  assert.equal(checkRequirementTransition('product', draft, {...draft,status:'待评审'}).ok, true);
  for (const role of ['lead','developer','tester','viewer','executive']) assert.equal(checkRequirementTransition(role, draft, {...draft,status:'待评审'}).code, 'FORBIDDEN');
  assert.equal(checkRequirementTransition('lead', draft, {...draft,status:'已终止'}, {reason:'取消'}).code, 'FORBIDDEN');
  assert.equal(checkRequirementTransition('product', draft, {...draft,status:'已终止'}).status, 400);
  const developing = { status:'开发中', acceptance:'标准', assigneeId:'dev', planStart:'2026-09-01', planEnd:'2026-09-10' };
  assert.equal(checkRequirementTransition('developer', developing, {...developing,status:'测试中'}, {tasks:[{status:'develop'}]}).code, 'AUTOMATIC_WORKFLOW');
  assert.equal(requirementDeliveryState({...developing,deliveryWorkflow:true},[{status:'test'},{status:'terminated'}]).status,'测试中');
  assert.equal(checkRequirementTransition('product', developing, {...developing,status:'测试中'}, {tasks:[{status:'test'}]}).code, 'AUTOMATIC_WORKFLOW');
  const testing = {...developing, status:'测试中'};
  assert.equal(checkRequirementTransition('tester', testing, {...testing,status:'开发中'}).status, 400);
  assert.equal(checkRequirementTransition('tester', testing, {...testing,status:'开发中'}, {reason:'登录失败',tasks:[{status:'test'}]}).ok, true);
  assert.equal(availableRequirementActions('tester', testing).find(action => action.status === '开发中').requiresReason, true);
  assert.deepEqual(availableRequirementActions('executive', testing), []);
  assert.equal(roleCan('lead','assignTasks'), true); assert.equal(roleCan('product','assignTasks'), false);
  assert.equal(roleCan('developer','createOwnTask'), true); assert.equal(roleCan('tester','createOwnTask'), false);
  assert.equal(roleCan('developer','reviewRequirement'), false); assert.equal(roleCan('tester','reviewRequirement'), true);
  assert.equal(roleCan('admin','editRequirement'), true); assert.equal(roleCan('executive','planRequirement'), false);
});

test('共享任务动作只显示相邻且角色允许的选项，终止仍必须填原因', () => {
  assert.deepEqual(availableTaskStatuses('developer','待开始'), ['wait','develop']);
  assert.deepEqual(availableTaskStatuses('developer','测试中'), ['test','develop','done']);
  assert.deepEqual(availableTaskStatuses('product','测试中'), ['test','develop','done']);
  assert.deepEqual(availableTaskStatuses('viewer','测试中'), ['test']);
  assert.deepEqual(availableTaskStatuses('developer','测试中',{ownTask:true}), ['test','develop']);
  assert.deepEqual(availableTaskStatuses('lead','测试中',{ownTask:true}), ['test','develop','done','terminated']);
  assert.deepEqual(availableTaskStatuses('tester','测试中'), ['test','develop','done']);
  assert.equal(checkTaskTransition('lead','develop','terminated').ok, false);
  assert.equal(checkTaskTransition('lead','develop','terminated',{reason:'范围取消'}).ok, true);
  assert.equal(checkTaskTransition('product','develop','terminated',{reason:'范围取消'}).ok, false);
  assert.deepEqual(availableTaskStatuses('lead','测试中'), ['test','develop','done','terminated']);
  assert.deepEqual(availableTaskStatuses('product','待开始'), ['wait']);
  assert.deepEqual(availableTaskStatuses('developer','wait',{dependencies:[{status:'terminated'}]}), ['wait']);
  assert.equal(checkTaskTransition('developer','wait','develop',{dependencies:[{status:'已完成'}]}).ok, true);
});

test('粒度建议不硬性阻止正常工时，缺失点数不换算工时', () => {
  for (const value of [0,-1,NaN,Infinity,undefined,'8']) assert.equal(taskGranularity(value).valid, false);
  for (const value of [1,40]) { assert.equal(taskGranularity(value).valid, true); assert.equal(taskGranularity(value).warnings.length, 1); }
  for (const value of [4,8,24]) assert.deepEqual(taskGranularity(value), {valid:true,warnings:[]});
});

test('基线兼容两种字段，缺失与非法日期不产生误导差值', () => {
  assert.deepEqual(normalizeBaseline({startDate:'2026-09-01',dueDate:'2026-09-10'}), {planStart:'2026-09-01',planEnd:'2026-09-10',capturedAt:''});
  assert.equal(normalizeBaseline({planStart:'2026-02-30'}), null);
  const comparison = getScheduleComparison({baseline:{planStart:'2026-09-01',planEnd:'2026-09-10'},planStart:'2026-08-31',planEnd:'2026-09-12',rescheduleCount:2});
  assert.equal(comparison.startDeltaDays,-1); assert.equal(comparison.endDeltaDays,2); assert.equal(comparison.rescheduleCount,2);
  assert.equal(getScheduleComparison({planStart:'2026-09-01'}).startDeltaDays,null);
});
