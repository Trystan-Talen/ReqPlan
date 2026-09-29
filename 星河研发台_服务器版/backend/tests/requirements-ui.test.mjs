import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProposalList, renderProposalDetails, proposalFields, requirementContentFields, renderDeliveryWorkflow } from '../../frontend/requirements-ui.js';
import { STATUS_TONES, TONES } from '../../frontend/ui-kit.js';

const proposal = { id: 'proposal-1', projectId: 'p-1', title: '导出用量明细', description: '便于财务核对。', proposerName: '业务同事', source: '客户反馈', priority: 'P1', acceptance: '支持导出所选时间范围。', status: '待评估', createdBy: 'u-1', createdAt: '2026-09-28T08:00:00Z' };
const requirement = { id: 'req-1', status: '已确定', assigneeId: 'u-1', acceptance: '核对导出内容。', deliveryWorkflow: true, planSubmitted: false, planStart: '', planEnd: '', dependencyIds: [] };
const task = { id: 'task-1', requirementId: 'req-1', title: '实现导出', ownerId: 'u-1', estimateHours: 8, status: 'wait', startDate: '2026-09-28', dueDate: '2026-10-10' };

test('提议列表只提供标题入口，空状态解释评估与需求池的关系', () => {
  const html = renderProposalList({ items: [proposal, { ...proposal, id: 'proposal-2', status: '暂缓' }] });
  assert.equal((html.match(/<button\b/g) || []).length, 2);
  assert.equal((html.match(/data-proposal=/g) || []).length, 2);
  assert.doesNotMatch(html, /编辑提议|删除提议|data-action=/);
  assert.match(renderProposalList(), /确认采纳后进入需求池/);
  for (const status of ['待评估', '评估中', '待补充', '暂缓', '不采纳', '已转需求']) assert.ok(TONES.includes(STATUS_TONES[status]), `${status} 应复用状态色调`);
});

test('提议所有用户字段、人员信息和操作参数均转义', () => {
  const attack = '\"><img src=x onerror=alert(1)>\'&';
  const tainted = Object.fromEntries(Object.keys(proposal).map(key => [key, attack]));
  Object.assign(tainted, { decisionReason: attack, requirementId: attack, legacyRequirementId: attack, updatedAt: attack });
  const user = { id: attack, name: attack };
  const outputs = [renderProposalList({ items: [tainted], users: [user] }), renderProposalDetails(tainted, { users: [user] }), proposalFields(tainted, { canEvaluate: true, userName: attack }), renderProposalDetails({ ...tainted, proposerName: '' }, { users: [user] })];
  for (const html of outputs) {
    assert.doesNotMatch(html, /<img\b|<script\b/);
    assert.doesNotMatch(html, /data-(?:proposal|requirement|legacy-requirement)="">/);
    assert.match(html, /&lt;img/);
  }
  assert.match(outputs[1], /data-requirement="&quot;&gt;&lt;img/);
  assert.equal((outputs[1].match(/data-requirement=/g) || []).length, 2);
});

test('普通提出人的表单不暴露评估决定，已转需求保持只读', () => {
  const ownForm = proposalFields(proposal, { userName: '当前用户' });
  assert.doesNotMatch(ownForm, /class="form-grid"/);
  assert.match(proposalFields(null, { userName: '当前用户' }), /name="proposerName" value="当前用户"/);
  assert.doesNotMatch(ownForm, /name="status"|name="decisionReason"/);
  assert.match(ownForm, /name="proposerName" value="业务同事"/);
  const evaluateForm = proposalFields(proposal, { canEvaluate: true });
  assert.match(evaluateForm, /name="status"/);
  assert.match(evaluateForm, /name="decisionReason"/);
  assert.doesNotMatch(evaluateForm, /<option value="已转需求"/);
  const convertedForm = proposalFields({ ...proposal, status: '已转需求' }, { canEvaluate: true });
  assert.doesNotMatch(convertedForm, /name="status"|name="decisionReason"/);
  assert.equal((convertedForm.match(/<(?:input|select|textarea)\b/g) || []).length, (convertedForm.match(/ disabled/g) || []).length);
});

test('提议与确认需求共用核心内容结构，确认与审批要求完整背景和验收', () => {
  const draft = requirementContentFields(proposal);
  const confirmed = requirementContentFields(proposal, { confirmed: true });
  assert.ok(proposalFields(proposal).startsWith(draft));
  for (const name of ['title', 'priority', 'source', 'description', 'acceptance', 'documentLinksPresent']) {
    assert.match(draft, new RegExp(`name="${name}"`));
    assert.match(confirmed, new RegExp(`name="${name}"`));
  }
  for (const name of ['description', 'acceptance']) {
    assert.doesNotMatch(draft, new RegExp(`<textarea[^>]*name="${name}"[^>]* required`));
    assert.match(confirmed, new RegExp(`<textarea[^>]*name="${name}"[^>]* required`));
    assert.match(proposalFields(proposal, { confirmed: true, canEvaluate: true }), new RegExp(`<textarea[^>]*name="${name}"[^>]* required`));
  }
  assert.doesNotMatch(draft, /提交评审|提议标题|预期结果与验收标准/);
  assert.match(requirementContentFields(null), /关联文档/);
});

test('提议详情保留历史和原有资料入口，转出需求与提议明确关联', () => {
  const html = renderProposalDetails({ ...proposal, status: '已转需求', requirementId: 'req-1', legacyRequirementId: 'old-req-1' });
  assert.match(html, /^<div class="dialog-body">/);
  assert.match(html, /id="proposal-history" aria-live="polite"/);
  assert.match(html, /data-requirement="req-1"/);
  assert.match(html, /data-requirement="old-req-1"/);
  assert.doesNotMatch(html, /dialog-footer/);
});

test('提议详情展示关联文档并携带返回提议上下文', () => {
  const document = { id: 'doc-1', projectId: proposal.projectId, name: '导出需求.md', title: '导出需求说明', type: 'PRD', version: 1, sections: [] };
  const html = renderProposalDetails({ ...proposal, docRefs: [{ document: document.name, sections: [] }] }, { documents: [document] });
  assert.match(html, /<h3>关联文档<\/h3>/);
  assert.match(html, /data-open-document="doc-1"/);
  assert.match(html, /data-from-proposal="proposal-1"/);
  assert.match(html, /全文参考/);
  assert.doesNotMatch(html, /data-from-requirement/);
});

test('交付流程从共享规则展示缺项，任务全部完成仍提示人工验收', () => {
  const incomplete = renderDeliveryWorkflow({ ...requirement, assigneeId: '' });
  assert.match(incomplete, /请指定主责开发/);
  assert.match(incomplete, /没有有效交付任务/);
  const submitted = { ...requirement, status: '已排期', planSubmitted: true, planStart: '2026-09-28', planEnd: '2026-10-10' };
  const ready = renderDeliveryWorkflow(submitted, { tasks: [task], role: 'lead' });
  assert.match(ready, /首个有效任务开始开发后/);
  const acceptance = renderDeliveryWorkflow({ ...submitted, status: '测试中' }, { tasks: [{ ...task, status: 'done' }], role: 'product' });
  assert.match(acceptance, /等待需求验收/);
  assert.match(acceptance, /人工确认需求验收/);
  assert.match(acceptance, /aria-current="step"[\s\S]*?测试中/);
  assert.doesNotMatch(acceptance, /<button\b/);
  const observer = renderDeliveryWorkflow({ ...submitted, status: '测试中' }, { tasks: [{ ...task, status: 'done' }], role: 'viewer' });
  assert.match(observer, /等待产品经理、主开发或测试确认/);
});

test('终止或归档任务不能制造待验收，返工与完成需求显示独立指引', () => {
  const scheduled = { ...requirement, status: '开发中', planSubmitted: true, planStart: '2026-09-28', planEnd: '2026-10-10' };
  const emptyScope = renderDeliveryWorkflow(scheduled, { tasks: [{ ...task, status: 'terminated' }, { ...task, id: 'task-2', status: 'done', archived: true }] });
  assert.match(emptyScope, /空任务范围不会自动视为完成/);
  assert.doesNotMatch(emptyScope, /等待需求验收/);
  const rework = renderDeliveryWorkflow({ ...scheduled, workflowHold: true }, { tasks: [{ ...task, status: 'done' }] });
  assert.match(rework, /等待安排返工/);
  assert.doesNotMatch(rework, /等待需求验收/);
  const done = renderDeliveryWorkflow({ ...scheduled, status: '已完成' }, { tasks: [{ ...task, status: 'done' }] });
  assert.match(done, /先重新打开需求并说明原因/);
  assert.doesNotMatch(done, /还需满足/);
  const archived = renderDeliveryWorkflow({ ...scheduled, archived: true });
  assert.match(archived, /恢复需求后才能继续推进/);
});

test('已确认历史需求也使用任务自动同步，异常状态内容经过转义', () => {
  const legacy = renderDeliveryWorkflow({ ...requirement, deliveryWorkflow: false, status: '开发中' }, { tasks: [task] });
  assert.match(legacy, /执行进度自动同步 · 最终验收人工确认/);
  assert.doesNotMatch(legacy, /提交研发计划|启用自动流转|先确认研发计划/);
  const attack = renderDeliveryWorkflow({ ...requirement, deliveryWorkflow: false, status: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(attack, /<img/);
  assert.match(attack, /&lt;img/);
});

test('历史阶段与任务条件不一致时解释下一次写入对齐，不提示零项待补齐', () => {
  for (const status of ['已确定', '待排期']) {
    const legacy = Object.freeze({ ...requirement, deliveryWorkflow: false, status });
    const html = renderDeliveryWorkflow(legacy, { tasks: [task], role: 'lead' });
    assert.match(html, /任务进度待对齐/);
    assert.match(html, /关联任务对应「已排期」阶段/);
    assert.match(html, /后续保存任务或研发设置时，系统将自动对齐/);
    assert.match(html, new RegExp(`aria-current="step"[\\s\\S]*?<span>${status}</span>`));
    assert.doesNotMatch(html, /还有 0 项|提交研发计划|启用自动流转/);
    assert.equal(legacy.status, status);
    assert.equal(legacy.deliveryWorkflow, false);
  }
  const readyForTest = renderDeliveryWorkflow({ ...requirement, status: '开发中', deliveryWorkflow: false }, { tasks: [{ ...task, status: 'test' }] });
  assert.match(readyForTest, /关联任务对应「测试中」阶段/);
  const incomplete = renderDeliveryWorkflow({ ...requirement, status: '已排期', deliveryWorkflow: false }, { tasks: [] });
  assert.match(incomplete, /关联任务对应「已确定」阶段/);
  assert.match(incomplete, /没有有效交付任务/);
});

test('任务拆分提示覆盖验收标准，最终验收只展示当前验收门禁', () => {
  const plan = renderDeliveryWorkflow({ ...requirement, acceptance: '' }, { tasks: [task], role: 'lead' });
  assert.match(plan, /请填写需求验收标准/);
  assert.doesNotMatch(plan, /提交研发计划|启用自动流转/);
  const ready = renderDeliveryWorkflow({ ...requirement, status: '测试中', planSubmitted: true, assigneeId: '', planStart: '', planEnd: '' }, { tasks: [{ ...task, status: 'done' }], role: 'product' });
  assert.match(ready, /等待需求验收/);
  assert.doesNotMatch(ready, /还需满足|请指定主责开发|请填写需求计划起止日期/);
  const unfinished = renderDeliveryWorkflow({ ...requirement, status: '测试中', planSubmitted: true, planStart: '', planEnd: '' }, { tasks: [{ ...task, status: 'test' }], role: 'product' });
  assert.match(unfinished, /还需满足/);
  assert.doesNotMatch(unfinished, /请填写需求计划起止日期/);
  assert.doesNotMatch(unfinished, /等待需求验收/);
});


test('研发周期由任务日期汇总，需求承诺保留并提示延期', () => {
  const item = { ...requirement, planStart: '2026-09-01', planEnd: '2026-10-05' };
  const html = renderDeliveryWorkflow(item, { tasks: [task], role: 'lead' });
  assert.match(html, /研发周期（任务汇总）/);
  assert.match(html, /2026-09-28 — 2026-10-10/);
  assert.match(html, /承诺交付[\s\S]*2026-10-05/);
  assert.match(html, /晚于承诺 5 天/);
  const unscheduled = renderDeliveryWorkflow(item, { tasks: [{ ...task, dueDate: '' }], role: 'lead' });
  assert.match(unscheduled, /为研发任务排期/);
  assert.match(unscheduled, /还有 1 项有效任务需要补齐开始和截止日期/);
  assert.doesNotMatch(unscheduled, /补齐需求排期|研发计划已提交/);
});

test('完成或终止需求不再展示预计延期，仍保留两套日期', () => {
  for (const status of ['已完成', '已终止']) {
    const html = renderDeliveryWorkflow({ ...requirement, status, planEnd: '2026-10-05' }, { tasks: [{ ...task, status: 'done', completedAt: '2026-09-28T08:00:00Z' }] });
    assert.match(html, /2026-09-28 — 2026-10-10/);
    assert.match(html, /承诺交付[\s\S]*2026-10-05/);
    assert.doesNotMatch(html, /预计研发截止晚于承诺/);
  }
});
