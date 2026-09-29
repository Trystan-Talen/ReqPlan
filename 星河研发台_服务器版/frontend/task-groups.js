// 按需求组织研发任务。只返回 HTML；所有任务交互由调用方提供的 renderTask 负责。
import { esc, badge, toneBadge, button, personChip, empty, icon } from './ui-kit.js';
import { requirementDeliveryState } from './workflow.js';

const isEarly = requirement => ['未确定', '待评审'].includes(requirement.status);
const isClosed = requirement => ['已完成', '已终止'].includes(requirement.status);
const mayChange = requirement => !requirement.archived && !isEarly(requirement) && !isClosed(requirement);
const nameOf = (id, users) => users.find(user => user.id === id)?.name || (id ? '未知成员' : '待指定');
const readAccess = (check, requirement, role) => typeof check === 'function' ? Boolean(check(requirement)) : ['lead', 'admin'].includes(role);
const fallbackTask = task => `<div class="task-group-fallback">${button({ label: task.title || '未命名任务', variant: 'text', data: { task: task.id } })}${badge(task.status)}</div>`;

function scheduleSummary(requirement, delivery) {
  const start = delivery.developmentStart || '待排期', end = delivery.developmentEnd || '待排期';
  const total = delivery.counts.total;
  const scheduled = Number(delivery.scheduledCount) || 0, unscheduled = Number(delivery.unscheduledCount) || 0;
  const dates = total ? `${esc(start)} — ${esc(end)}` : '拆分任务后自动汇总';
  const coverage = total ? `${scheduled} / ${total} 项任务已排期${unscheduled ? `，${unscheduled} 项待补齐日期` : ''}` : '按有效任务的最早开始、最晚截止计算';
  const delay = !isClosed(requirement) && Number.isFinite(delivery.delayDays) && delivery.delayDays > 0 ? toneBadge('danger', `预计晚于承诺 ${delivery.delayDays} 天`) : '';
  return `<dl class="task-group-schedule"><div><dt>研发周期</dt><dd>${dates}</dd><p>${esc(coverage)}</p></div><div><dt>承诺交付</dt><dd>${esc(requirement.planEnd || '未设置')}${delay ? `<span class="task-group-delay">${delay}</span>` : ''}</dd><p>${requirement.planEnd ? '保留需求承诺，不随任务日期覆盖' : '可在需求详情维护承诺日期'}</p></div></dl>`;
}

/**
 * requirements 由调用方决定可见范围，包含尚无任务的已确认需求。
 * tasks 用于完整进度汇总；filteredTasks（可选）仅决定展示哪些任务。
 * canManage/canSplit 为 requirement => boolean；终止、完成、归档、早期提议始终不显示新增入口。
 * expandedIds 为 Set 或数组；省略时优先展开前两个尚未拆分的需求。
 * renderTask(task) 必须返回已安全转义的 HTML，不能直接回传任务字段。
 * 折叠事件：details > summary[data-task-group] 保存需求编号。
 */
export function renderRequirementTaskGroups({ requirements = [], tasks = [], users = [], role = '', renderTask = fallbackTask, canManage, canSplit, expandedIds, filteredTasks } = {}) {
  const visibleTasks = filteredTasks === undefined ? tasks : filteredTasks;
  const knownIds = new Set(requirements.map(item => item.id));
  const byRequirement = new Map(), visibleByRequirement = new Map();
  for (const [items, target] of [[tasks, byRequirement], [visibleTasks, visibleByRequirement]]) for (const task of items) {
    const key = task.requirementId || '';
    if (!target.has(key)) target.set(key, []);
    target.get(key).push(task);
  }
  const shownRequirements = requirements.filter(requirement => (!isEarly(requirement) && !requirement.archived) || (visibleByRequirement.get(requirement.id) || []).length);
  const candidates = shownRequirements.filter(mayChange);
  const defaults = [...candidates.filter(requirement => !(byRequirement.get(requirement.id) || []).some(task => !task.archived)), ...candidates.filter(requirement => (byRequirement.get(requirement.id) || []).some(task => !task.archived))].slice(0, 2).map(item => item.id);
  const expanded = expandedIds instanceof Set ? expandedIds : new Set(Array.isArray(expandedIds) ? expandedIds : defaults);
  const groups = shownRequirements.map(requirement => {
    const linked = byRequirement.get(requirement.id) || [], visible = visibleByRequirement.get(requirement.id) || [];
    const delivery = requirementDeliveryState(requirement, linked, requirements);
    const editable = mayChange(requirement), manage = editable && readAccess(canManage, requirement, role), split = editable && readAccess(canSplit, requirement, role);
    const metadata = requirement.archived ? toneBadge('terminated', '已归档') : isEarly(requirement) ? toneBadge('review', '历史关联 · 待评估') : '';
    const owner = personChip(requirement.assigneeId, nameOf(requirement.assigneeId, users));
    const actions = manage || split ? `<div class="task-group-actions">${manage ? button({ label: '研发设置', variant: 'text', iconName: 'edit', data: { manageDevelopment: requirement.id } }) : ''}<div class="task-group-create">${split ? `<details class="task-group-more"><summary aria-label="更多拆分方式">${icon('menu')}</summary><div class="task-group-more-menu">${button({ label: '批量拆分任务', variant: 'text', data: { batchRequirement: requirement.id } })}</div></details>${button({ label: '新建任务', variant: 'primary', size: 'small', iconName: 'plus', data: { linkedTask: requirement.id } })}` : ''}</div></div>` : '';
    const context = `<details class="task-group-context"><summary>背景与验收</summary><div class="task-group-context-copy"><section><h4>背景与目标</h4><p>${esc(requirement.description || '尚未填写背景与目标。')}</p></section><section><h4>验收标准</h4><p>${esc(requirement.acceptance || '尚未填写验收标准。')}</p></section></div></details>`;
    const taskBody = visible.length ? `<div class="task-group-cards">${visible.map(task => renderTask(task)).join('')}</div>` : `<p class="task-group-empty">${linked.length ? '没有符合当前筛选的任务。' : split ? '尚未拆分任务。可从新建任务开始。' : '尚未拆分任务，等待主开发安排。'}</p>`;
    return `<details class="requirement-task-group"${expanded.has(requirement.id) ? ' open' : ''}><summary class="task-group-summary" data-task-group="${esc(requirement.id)}"><span class="task-group-heading"><span class="task-group-title">${button({ label: requirement.title || '未命名需求', variant: 'text', data: { requirement: requirement.id } })}${badge(delivery.status)}${metadata}</span><span class="task-group-meta"><code>${esc(requirement.id)}</code><span>主责开发</span>${owner}</span></span><span class="task-group-progress">${delivery.counts.done} / ${delivery.counts.total}<small>有效任务完成</small>${visible.length !== linked.length ? `<small>当前显示 ${visible.length} 项</small>` : ''}</span><span class="task-group-chevron" aria-hidden="true">${icon('arrow')}</span></summary><div class="task-group-body">${scheduleSummary(requirement, delivery)}${context}${actions}${taskBody}</div></details>`;
  });
  const orphans = visibleTasks.filter(task => !knownIds.has(task.requirementId));
  if (orphans.length) groups.push(`<details class="requirement-task-group"${expandedIds === undefined || expanded.has('__unlinked__') ? ' open' : ''}><summary class="task-group-summary" data-task-group="__unlinked__"><span class="task-group-heading"><strong>未关联或原需求不可用</strong><span class="task-group-meta">保留历史任务，关联信息可在任务详情核对。</span></span><span class="task-group-progress">${orphans.length}<small>项任务</small></span><span class="task-group-chevron" aria-hidden="true">${icon('arrow')}</span></summary><div class="task-group-body"><div class="task-group-cards">${orphans.map(task => renderTask(task)).join('')}</div></div></details>`);
  return groups.length ? `<div class="requirement-task-groups">${groups.join('')}</div>` : empty('暂无可展示的研发需求', '需求确认后会显示在这里，再按需求拆分和推进任务。');
}
