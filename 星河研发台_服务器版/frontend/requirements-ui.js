// 需求提议与交付流程：只生成安全的界面片段，路由、权限和提交由 app.js 处理。
import { esc, badge, priority, personChip, button, empty, loading, notice, detailList, field, input, select, area, options, REQUIRED } from './ui-kit.js';
import { requirementDeliveryState, REQUIREMENT_REVIEW_ROLES } from './workflow.js';
import { renderDocumentLinkFields } from './document-link-fields.js';
import { renderRequirementDocuments } from './documents-ui.js';

const PROPOSAL_STATES = Object.freeze(['待评估', '评估中', '待补充', '暂缓', '不采纳', '已转需求']);
const DELIVERY_STAGES = Object.freeze(['已确定', '待排期', '已排期', '开发中', '测试中', '已完成']);
const proposalStatus = proposal => ({ 未确定: '待评估', 待评审: '评估中' }[proposal.status] || proposal.status || '待评估');
const dateText = value => value ? String(value).slice(0, 10) : '未记录';
const nameOf = (id, users = []) => users.find(user => user.id === id)?.name || id || '未记录';
const proposerOf = (proposal, users) => proposal.proposerName || nameOf(proposal.createdBy, users);

/** 仅返回列表面板的内容；标题、筛选和唯一主操作由页面提供。 */
export function renderProposalList({ items = [], users = [] } = {}) {
  if (!items.length) return empty('暂无需求提议', '新的想法先在这里评估，确认采纳后进入需求池。');
  return `<div class="table-wrap"><table class="data-table proposal-list"><thead><tr><th scope="col">提议</th><th scope="col">优先级</th><th scope="col">评估状态</th><th scope="col">提出人</th><th scope="col">最近更新</th></tr></thead><tbody>${items.map(proposal => `<tr><td class="proposal-title-cell"><div class="proposal-title">${button({ label: proposal.title || '未命名提议', variant: 'text', data: { proposal: proposal.id } })}</div><span class="item-meta"><code>${esc(proposal.id)}</code>${proposal.source ? ` · ${esc(proposal.source)}` : ''}</span>${proposal.description ? `<p class="proposal-summary">${esc(proposal.description)}</p>` : ''}</td><td>${priority(proposal.priority)}</td><td>${badge(proposalStatus(proposal))}</td><td>${personChip(proposal.createdBy, proposerOf(proposal, users))}</td><td><span class="item-meta">${esc(dateText(proposal.updatedAt || proposal.createdAt))}</span></td></tr>`).join('')}</tbody></table></div>`;
}

/** 返回包含 dialog-body 的详情片段，页脚由调用方根据权限提供。 */
export function renderProposalDetails(proposal, { users = [], documents = [] } = {}) {
  const status = proposalStatus(proposal);
  const section = (title, text) => `<section class="detail-section"><h3>${esc(title)}</h3><div class="detail-copy">${esc(text)}</div></section>`;
  const linkedRequirement = proposal.requirementId ? `<section class="detail-section"><h3>已确认的需求</h3><div class="proposal-link">${button({ label: '查看已确认需求', variant: 'text', data: { requirement: proposal.requirementId } })}<code>${esc(proposal.requirementId)}</code></div><p class="field-help">提议保留评估记录，后续任务拆分、排期与验收在需求中进行。</p></section>` : '';
  const legacyLink = proposal.legacyRequirementId ? `<section class="detail-section"><h3>原有资料</h3>${button({ label: '查看原有附件与关联资料', variant: 'text', data: { requirement: proposal.legacyRequirementId } })}<p class="field-help">原有编号、附件与关联关系均保留。</p></section>` : '';
  return `<div class="dialog-body"><div class="detail-hero"><span class="detail-hero-id">${esc(proposal.id)}</span><h3>${esc(proposal.title || '未命名提议')}</h3><div class="detail-summary">${badge(status)}${priority(proposal.priority, true)}</div></div>${proposal.archived ? notice('此提议已归档，内容与评估记录仍保留。') : status === '已转需求' ? notice('此提议已采纳并转为需求，请在需求详情继续推进交付。') : ''}${detailList([['提出人', proposerOf(proposal, users)], ['需求来源', proposal.source || '未填写'], ['创建时间', dateText(proposal.createdAt)], ['最近更新', dateText(proposal.updatedAt || proposal.createdAt)]], { columns: 2 })}${section('背景与目标', proposal.description || '尚未补充背景与目标。')}${section('验收标准', proposal.acceptance || '尚未补充，可在评估时完善。')}<section class="detail-section"><h3>关联文档</h3>${renderRequirementDocuments(proposal, documents, { fromProposal: proposal })}</section>${section('评估说明', proposal.decisionReason || proposal.evaluationNote || '暂无评估说明。')}${linkedRequirement}${legacyLink}<section class="detail-section"><h3>评估与修改记录</h3><div id="proposal-history" aria-live="polite">${loading('正在读取提议记录…')}</div></section></div>`;
}

/** 提议与确认需求使用相同内容字段；确认只提高必填要求，不更换内容结构。 */
export function requirementContentFields(item = {}, { confirmed = false, disabled = false, documents = [], projectId } = {}) {
  item = item || {};
  const disabledAttr = disabled ? ' disabled' : '', requiredAttr = confirmed ? ' required' : '', requiredMark = confirmed ? REQUIRED : '';
  const context = projectId ? { ...item, projectId } : item;
  return `${field('需求标题' + REQUIRED, 'title', input('title', item.title || '', `required maxlength="200"${disabledAttr}`), true)}${field('优先级', 'priority', select('priority', options(['P0', 'P1', 'P2'], item.priority || 'P2', { P0: 'P0 · 最高', P1: 'P1 · 高', P2: 'P2 · 普通' }), disabledAttr))}${field('需求来源', 'source', input('source', item.source || '', `maxlength="200" placeholder="如：客户反馈、内部优化"${disabledAttr}`))}${field('背景与目标' + requiredMark, 'description', area('description', item.description || '', `rows="5" maxlength="20000"${requiredAttr}${disabledAttr}`), true, '说明遇到的问题、希望解决什么，以及影响哪些人。')}${field('验收标准' + requiredMark, 'acceptance', area('acceptance', item.acceptance || '', `rows="4" maxlength="20000"${requiredAttr}${disabledAttr}`), true, '描述交付后可核对的结果；确认需求前需填写完整。')}${renderDocumentLinkFields(context, documents, { disabled })}`;
}

/** 仅返回表单字段；外层 form-grid 由调用方提供。普通提出人看不到评估决定字段。 */
export function proposalFields(proposal = {}, { canEvaluate = false, userName = '', documents = [], confirmed = false, projectId } = {}) {
  proposal = proposal || {};
  const status = proposalStatus(proposal);
  const readonly = proposal.archived || status === '已转需求';
  const disabled = readonly ? ' disabled' : '';
  const evaluationFields = canEvaluate && !readonly ? field('评估状态', 'status', select('status', options(PROPOSAL_STATES.filter(item => item !== '已转需求'), status)), false, '采纳并转为需求需使用独立的确认操作。') + field('评估说明', 'decisionReason', area('decisionReason', proposal.decisionReason || proposal.evaluationNote || '', 'rows="3" maxlength="2000"'), true, '待补充、暂缓或不采纳时，请说明原因和下一步。') : '';
  return `${requirementContentFields(proposal, { confirmed, disabled: readonly, documents, projectId })}${field('提出人' + REQUIRED, 'proposerName', input('proposerName', proposal.proposerName || userName, `required maxlength="200"${disabled}`))}${evaluationFields}`;
}

function deliveryNext(requirement, delivery, role, projectedStatus = delivery.status) {
  if (requirement.archived) return ['需求已归档', '内容与历史记录已保留。恢复需求后才能继续推进。'];
  if (requirement.status === '已终止') return ['需求已终止', '任务进度不会继续推动需求；重新启动需要人工确认并说明原因。'];
  if (requirement.status === '已完成') return ['需求已通过验收', '如需补充交付范围或安排返工，请先重新打开需求并说明原因。'];
  if (!delivery.enabled) return ['等待评估确认', '提议确认采纳后，进入研发任务安排主责开发、拆分和排期。'];
  if (requirement.workflowHold) return ['等待安排返工', '需求已退回或重新打开。请在研发任务中补充整改任务，或将需要返工的任务退回开发；系统不会立即将需求自动提测。'];
  if (projectedStatus !== delivery.status) return ['任务进度待对齐', `关联任务对应「${projectedStatus}」阶段，当前仍保留原有阶段。后续保存任务或研发设置时，系统将自动对齐。`];
  if (delivery.status === '已确定') return ['补齐研发任务', '在研发任务中设置主责开发、拆分任务，并补齐负责人和预估工时；需求阶段将随任务信息自动更新。'];
  if (delivery.status === '待排期') return ['为研发任务排期', `还有 ${delivery.unscheduledCount} 项有效任务需要补齐开始和截止日期。全部排好后，需求将自动进入已排期。`];
  if (delivery.status === '已排期') return ['等待任务开工', delivery.startAllowed ? '开工条件已满足。首个有效任务开始开发后，需求将自动进入开发中。' : '完成下方开工条件后，首个有效任务开始开发时将自动推动需求。'];
  if (delivery.status === '开发中') return ['按研发任务推进', '所有有效任务均已提测或完成，且填写需求验收标准后，需求将自动进入测试中。'];
  if (delivery.status === '测试中') return delivery.readyForAcceptance ? ['等待需求验收', role === 'admin' || REQUIREMENT_REVIEW_ROLES.includes(role) ? '关联有效任务已全部完成。请核对整体交付与验收标准，再人工确认需求验收。' : '关联有效任务已全部完成，等待产品经理、主开发或测试确认需求验收。'] : ['完成测试与任务验收', '逐项验证并完成关联任务。全部有效任务完成后，再由有权限的人确认需求验收。'];
  return ['等待评估确认', '提议确认采纳后，进入需求池继续拆分、排期与交付。'];
}

/** 不生成操作按钮：展示阶段、下一步和共享规则计算的缺项。 */
export function renderDeliveryWorkflow(requirement, { tasks = [], dependencies = [], role = '' } = {}) {
  const delivery = requirementDeliveryState(requirement, tasks, dependencies);
  const terminal = requirement.archived || ['已完成', '已终止'].includes(requirement.status);
  const current = terminal ? requirement.status : delivery.status;
  // 历史阶段只在相关写入时采用自动规则；这里只预告，不改变展示阶段或数据。
  const projectedStatus = delivery.enabled && requirement.deliveryWorkflow !== true
    ? requirementDeliveryState({ ...requirement, deliveryWorkflow: true }, tasks, dependencies).status : delivery.status;
  const [nextTitle, nextDescription] = deliveryNext(requirement, delivery, role, projectedStatus);
  const stages = `<ol class="delivery-stages" aria-label="需求交付阶段">${DELIVERY_STAGES.map((status, index) => `<li class="delivery-stage${status === current ? ' is-current' : ''}"${status === current ? ' aria-current="step"' : ''}><span class="delivery-stage-number" aria-hidden="true">${index + 1}</span><span>${esc(status)}</span></li>`).join('')}</ol>`;
  const gates = terminal ? [] : current === '已确定' ? delivery.planGates : ['待排期', '已排期'].includes(current) ? delivery.startGates : current === '测试中' ? delivery.acceptanceGates : delivery.gates;
  const counts = delivery.counts;
  const developmentDates = `${delivery.developmentStart || '待排期'} — ${delivery.developmentEnd || '待排期'}`;
  const schedule = detailList([['研发周期（任务汇总）', counts.total ? developmentDates : '拆分任务后自动汇总'], ['承诺交付', requirement.planEnd || '未设置']], { columns: 2 });
  const delay = !['已完成', '已终止'].includes(requirement.status) && Number.isFinite(delivery.delayDays) && delivery.delayDays > 0 ? `<p class="overdue-text small">预计研发截止晚于承诺 ${delivery.delayDays} 天；承诺日期保持不变。</p>` : '';
  const summary = counts.total ? `<p class="delivery-task-summary">有效任务 ${counts.total} 项 · 待开始 ${counts.wait} · 开发中 ${counts.develop} · 测试中 ${counts.test} · 已完成 ${counts.done}</p>` : '<p class="delivery-task-summary">暂无有效交付任务；空任务范围不会自动视为完成。</p>';
  return `<section class="delivery-workflow" aria-label="需求生命周期"><div class="delivery-workflow-heading"><h3>交付流程</h3>${badge(current)}${!terminal && delivery.enabled ? '<span class="field-help">执行进度自动同步 · 最终验收人工确认</span>' : ''}</div>${stages}${schedule}${delay}<div class="delivery-next"><strong>${esc(nextTitle)}</strong><p>${esc(nextDescription)}</p></div>${summary}${gates.length ? `<div class="delivery-gates"><h4>还需满足</h4><ul>${[...new Set(gates)].map(message => `<li>${esc(message)}</li>`).join('')}</ul></div>` : ''}</section>`;
}
