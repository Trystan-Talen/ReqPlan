import { getScheduleComparison, ROLE_LABELS } from './workflow.js';
import { esc } from './ui-kit.js';

export const escapeHtml = esc;
const fields = {title:'标题',name:'名称',description:'背景与说明',acceptance:'验收标准',priority:'优先级',status:'状态',assigneeId:'主责开发',ownerId:'负责人',collaboratorIds:'协作成员',planStart:'计划开始',planEnd:'计划截止',startDate:'开始日期',dueDate:'截止日期',targetDate:'目标交付',estimatePoints:'需求点数',estimateHours:'预估工时',source:'需求来源',requirementId:'关联需求',dependencyIds:'前置任务',milestones:'里程碑',archived:'归档状态'};
const statusLabels = {wait:'待开始',develop:'开发中',test:'测试中',done:'已完成',terminated:'已终止',active:'已启用',disabled:'已停用'};
function valueText(key,value,nameOf) {
  if (value === undefined || value === null || value === '') return '未设置';
  if (['assigneeId','ownerId'].includes(key)) return nameOf(value);
  if (key === 'collaboratorIds') return value.map(nameOf).join('、') || '无';
  if (key === 'status') return statusLabels[value] || value;
  if (key === 'milestones' && Array.isArray(value)) return value.map(item => `${item.label || item.name}：${item.date || '未设置'}`).join('\n') || '无';
  if (Array.isArray(value)) return value.join('、') || '无';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function auditChanges(entry,nameOf = value => value) {
  const detail = entry.detail;
  if (!detail || typeof detail !== 'object') return [];
  if (['set_member','membership.set'].includes(entry.action) && typeof detail.after==='string') {
    const roles={manager:'项目经理（旧）',...ROLE_LABELS};
    return [{label:'成员角色',before:roles[detail.before]||detail.before||'未加入',after:roles[detail.after]||detail.after}];
  }
  if (!detail.before || !detail.after || typeof detail.before!=='object' || typeof detail.after!=='object') return [];
  return Object.entries(fields).filter(([key]) => JSON.stringify(detail.before[key]) !== JSON.stringify(detail.after[key])).map(([key,label]) => ({label:entry.entityType==='task'&&key==='description'?'任务内容':label,before:valueText(key,detail.before[key],nameOf),after:valueText(key,detail.after[key],nameOf)}));
}
export function renderAuditEntry(entry,{actor='',summary='',stamp='',nameOf} = {}) {
  const changes = auditChanges(entry,nameOf);
  const detail = entry.detail;
  const oldText = typeof detail === 'string' ? detail : '';
  const reason = typeof detail?.reason === 'string' ? detail.reason : '';
  return `<article class="history-row"><time>${escapeHtml(stamp)} · ${escapeHtml(actor)}${entry.legacy ? ' · 原系统记录' : ''}</time><p>${escapeHtml(summary)}</p>${entry.from || entry.to ? `<p class="field-help">${escapeHtml(entry.from || '未设置')} → ${escapeHtml(entry.to || '未设置')}</p>` : ''}${oldText && oldText !== summary ? `<p class="detail-copy">${escapeHtml(oldText)}</p>` : ''}${reason ? `<p class="field-help">操作说明：${escapeHtml(reason)}</p>` : ''}${changes.length ? `<details class="change-details"><summary>查看修改内容（${changes.length} 项）</summary><div class="table-wrap"><table class="change-table"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${changes.map(item => `<tr><th scope="row">${item.label}</th><td>${escapeHtml(item.before)}</td><td>${escapeHtml(item.after)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}</article>`;
}
export function renderBaseline(requirement) {
  const comparison = getScheduleComparison(requirement);
  if (!comparison.baseline) return '<p class="field-help">尚未发生已有排期的调整；首次改期时会保留原计划作为基线。</p>';
  const delta = value => value === null ? '无法计算' : value === 0 ? '未偏移' : value > 0 ? `推迟 ${value} 天` : `提前 ${Math.abs(value)} 天`;
  return `<section class="baseline-panel"><h3>排期基线对比</h3><p class="field-help">保留首次改期前的计划 · 已改期 ${Number(comparison.rescheduleCount || 0)} 次${comparison.baseline.capturedAt ? ` · 基线记录于 ${escapeHtml(comparison.baseline.capturedAt.slice(0,10))}` : ' · 原记录未提供基线记录日期'}</p><div class="table-wrap"><table class="change-table"><thead><tr><th>日期</th><th>原始基线</th><th>当前计划</th><th>偏移</th></tr></thead><tbody><tr><th scope="row">开始</th><td>${escapeHtml(comparison.baseline.planStart || '未设置')}</td><td>${escapeHtml(requirement.planStart || '未设置')}</td><td>${delta(comparison.startDeltaDays)}</td></tr><tr><th scope="row">截止</th><td>${escapeHtml(comparison.baseline.planEnd || '未设置')}</td><td>${escapeHtml(requirement.planEnd || '未设置')}</td><td>${delta(comparison.endDeltaDays)}</td></tr></tbody></table></div></section>`;
}
export function renderErrorDetails(details) {
  const entries = Array.isArray(details) ? details : Array.isArray(details?.rows) ? details.rows : Array.isArray(details?.gates) ? details.gates : [];
  return entries.length ? `<ul class="validation-list">${entries.map(item => `<li>${escapeHtml(typeof item === 'string' ? item : `${item.row ? `第 ${item.row} 行：` : ''}${item.message || item.error || '校验未通过'}`)}</li>`).join('')}</ul>` : '';
}
export function renderTextComparison(before,after) {
  const left = before.split('\n'), right = after.split('\n'), length = Math.min(2000,Math.max(left.length,right.length));
  return `<p class="field-help">按行对照；高亮表示同一行号内容不同${Math.max(left.length,right.length)>length ? '，仅展示前 2000 行，完整内容可下载查看' : ''}。</p><div class="table-wrap"><table class="change-table text-comparison"><thead><tr><th>行</th><th>对照版本</th><th>目标版本</th></tr></thead><tbody>${Array.from({length},(_,i) => `<tr${left[i] !== right[i] ? ' class="changed-line"' : ''}><th scope="row">${i+1}</th><td>${escapeHtml((left[i] || '').slice(0,4000))}</td><td>${escapeHtml((right[i] || '').slice(0,4000))}</td></tr>`).join('')}</tbody></table></div>`;
}
