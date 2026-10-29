import { esc, icon, badge, button, metric, metricStrip, panel, sectionHeading, empty, loading, notice, toneBadge } from './ui-kit.js';

// The model owns scope, dates, permissions and deduplication; this module only renders it.
const count = value => Array.isArray(value) ? value.length : Number(value) || 0;
const projectLink = (project, projectPath) => `<a href="${esc(projectPath(project.id))}">${esc(project.name)}</a>`;

// Move the same personal section so reading and keyboard order follow the
// mobile layout. Desktop keeps the original grouped, sticky sidebar.
export function syncWorkbenchOrder(layout, narrow) {
  const sidebar = layout?.querySelector?.('.workbench-sidebar');
  const personal = layout?.querySelector?.('.workbench-personal');
  const target = narrow ? layout : sidebar;
  if (!personal || !target || personal.parentElement === target || typeof target.prepend !== 'function') return;
  const focused = layout.ownerDocument?.activeElement;
  const restoreFocus = focused && personal.contains(focused);
  target.prepend(personal);
  if (restoreFocus) focused.focus({ preventScroll: true });
}

function projectSignals(item) {
  const signals = [];
  if (item.targetPastDays > 0) signals.push(['danger', `目标日期已过 ${item.targetPastDays} 天`]);
  if (count(item.overdueTasks)) signals.push(['danger', `${count(item.overdueTasks)} 个任务逾期`]);
  if (count(item.commitmentOverdue)) signals.push(['danger', `${count(item.commitmentOverdue)} 项需求承诺逾期`]);
  if (count(item.planConflicts)) signals.push(['test', `${count(item.planConflicts)} 项计划日期冲突`]);
  if (count(item.unassignedTasks)) signals.push(['pending', `${count(item.unassignedTasks)} 个任务未分配`]);
  else if (count(item.preparation)) signals.push(['pending', `${count(item.preparation)} 项交付准备待完善`]);
  if (count(item.dueSoonTasks)) signals.push(['test', `${count(item.dueSoonTasks)} 个任务近期到期`]);
  return signals;
}

function renderProject(item, model, { projectPath, projectColor, canPrepare }) {
  const project = item.project;
  const stages = Object.entries(item.stageCounts || {}).filter(([, value]) => count(value) > 0).map(([label, value]) => `${label} ${count(value)}`).join(' · ');
  const milestone = item.nextMilestone;
  const milestoneLabel = milestone?.label || milestone?.name || '计划节点';
  const milestoneHtml = milestone
    ? `<span>${milestone.date === model.date ? '今天到达计划节点' : '下一计划节点'}</span><strong>${esc(milestoneLabel)}</strong><time datetime="${esc(milestone.date)}">${esc(milestone.date)}</time>`
    : `<span>${project.targetDate ? '项目目标日期' : '计划节点'}</span><strong>${esc(project.targetDate || '暂无后续计划节点')}</strong>`;
  const signals = projectSignals(item);
  const attentionHtml = signals.length
    ? signals.slice(0, 2).map(([tone, label]) => toneBadge(tone, label)).join('') + (signals.length > 2 ? button({ label: `另 ${signals.length - 2} 类关注`, variant: 'text', data: { workbenchRisk: project.id } }) : '')
    : '<span class="workbench-no-signal">当前未发现日期或交付准备异常</span>';
  const actions = [];
  if (count(item.unassignedTasks)) {
    actions.push(button({ label: canPrepare(project.id) ? '完善任务负责人' : '查看未分配任务', variant: 'text', data: { task: item.unassignedTasks[0].id } }));
  } else if (count(item.preparation)) {
    actions.push(button({ label: canPrepare(project.id) ? '完善交付准备' : '查看交付准备', variant: 'text', data: { openRequirementTasks: item.preparation[0].requirement.id } }));
  } else if (signals.length) {
    const label = item.targetPastDays > 0 ? '核实交付状态' : count(item.overdueTasks) ? '核实逾期任务' : count(item.commitmentOverdue) ? '核实需求交付' : count(item.planConflicts) ? '核对计划冲突' : '查看近期到期任务';
    actions.push(button({ label, variant: 'text', data: { workbenchRisk: project.id } }));
  }
  if (count(item.unassignedTasks) || count(item.preparation)) {
    actions.push(button({ label: count(item.overdueTasks) ? '查看逾期与风险' : '查看关注事项', variant: 'text', data: { workbenchRisk: project.id } }));
  } else {
    actions.push(`<a class="section-link" href="${esc(projectPath(project.id, 'timeline'))}">查看交付排期 ${icon('arrow')}</a>`);
  }
  const completed = count(item.completedTasks), total = count(item.totalTasks);
  const requirementCount = Object.values(item.stageCounts || {}).reduce((sum, value) => sum + count(value), 0);
  const taskSummary = total ? `已完成 ${completed} / ${total} 项 · 开发中 ${count(item.developTasks)} · 测试中 ${count(item.testTasks)} · 待开始 ${count(item.waitingTasks)}` : '暂无有效任务';
  const progressSummary = total ? `任务已完成 ${completed} / ${total}` : '暂无有效任务';
  return `<article class="workbench-project" style="--project:${esc(projectColor(project.id))}"><div class="workbench-project-heading"><h3>${projectLink(project, projectPath)}</h3>${project.status ? badge(project.status) : ''}</div><div class="workbench-signals">${attentionHtml}</div><div class="workbench-project-actions"><span class="workbench-next-label">下一步</span>${actions.slice(0, 2).join('')}</div><details class="workbench-project-detail"><summary><span>${esc(progressSummary)} · ${requirementCount} 条需求</span><span class="workbench-detail-label">进展与计划</span></summary><div class="workbench-project-progress"><p><span>需求</span>${esc(stages || '暂无已确认需求')}</p><p><span>任务</span>${esc(taskSummary)}</p><div class="workbench-milestone">${milestoneHtml}</div><a class="section-link" href="${esc(projectPath(project.id, 'timeline'))}">查看完整交付排期 ${icon('arrow')}</a></div></details></article>`;
}

function renderTodos(model, { workError }) {
  if (workError) return panel({ bodyHtml: `<div class="workbench-retry">${notice('暂时无法读取待办，请重试。', 'danger')}${button({ label: '重新读取待办', action: 'refresh-workbench', size: 'small' })}</div>` });
  if (model.todos === null) return panel({ bodyHtml: loading('正在读取你的待办…') });
  const todos = model.todos || [];
  const projectNames = new Map((model.projects || []).map(item => [item.project.id, item.project.name]));
  const content = todos.length ? `<div class="workbench-todos">${todos.slice(0, 5).map(item => {
    const data = item.openTasks ? { openRequirementTasks: item.entityId } : item.entityType === 'task' ? { task: item.entityId } : { requirement: item.entityId };
    const reasons = (item.reasons || []).slice(0, 2).join(' · ');
    return `<article class="workbench-todo">${button({ label: item.title, variant: 'text', size: 'touch', title: '点击查看完整事项', data })}<p class="workbench-todo-context"><span>${esc(projectNames.get(item.projectId) || '项目事项')}</span>${item.date ? `<span class="workbench-todo-date">${item.entityType === 'task' ? '任务截止' : '承诺截止'} <time datetime="${esc(item.date)}">${esc(item.date)}</time></span>` : ''}</p>${reasons ? `<p>${esc(reasons)}</p>` : ''}</article>`;
  }).join('')}</div>` : empty('暂无直接分配或待处理事项', '团队风险仍可在「项目推进」中查看。', '', '', { compact: true });
  return panel({ bodyHtml: content, noteHtml: `<div class="workbench-todo-links">${todos.length > 5 ? button({ label: `查看全部 ${todos.length} 项`, variant: 'text', size: 'touch', action: 'workbench-todos' }) : ''}<a class="section-link" href="#/notifications">站内提醒 ${icon('arrow')}</a></div>` });
}

function renderUpcomingMilestones(model, { projectPath, compact = false }) {
  const upcoming = (model.projects || []).filter(item => item.nextMilestone?.date >= model.date && item.nextMilestone.date <= model.windowEnd)
    .slice().sort((a, b) => a.nextMilestone.date.localeCompare(b.nextMilestone.date));
  if (!upcoming.length) return '';
  const rows = upcoming.slice(0, 3).map(({ project, nextMilestone }) => `<article class="workbench-upcoming-item"><div><time datetime="${esc(nextMilestone.date)}">${nextMilestone.date === model.date ? '今天 · ' : ''}${esc(nextMilestone.date)}</time><a class="section-link" href="${esc(projectPath(project.id, 'timeline'))}">查看排期 ${icon('arrow')}</a></div><strong>${esc(nextMilestone.label || nextMilestone.name || '计划节点')}</strong><p>${esc(project.name)}</p></article>`).join('');
  const bodyHtml = `<div class="workbench-upcoming">${rows}</div>`;
  const noteHtml = `<div class="workbench-upcoming-note"><span>未来 7 天的计划日期，不代表已完成，不计入个人待办。</span>${upcoming.length > 3 ? `<a class="section-link" href="#/portfolio">在全局排期查看其他节点 ${icon('arrow')}</a>` : ''}</div>`;
  if (compact) {
    const nearest = upcoming[0].nextMilestone.date;
    return panel({ bodyHtml: `<details class="workbench-upcoming-disclosure"><summary><strong>近期计划节点 · ${upcoming.length}</strong><span>各项目下一节点 · 最近${nearest === model.date ? '今天' : ` ${esc(nearest)}`}</span><span class="workbench-upcoming-toggle">计划明细</span></summary>${bodyHtml}<div class="workbench-upcoming-explanation">${noteHtml}</div></details>` });
  }
  return panel({ title: '近期计划节点', bodyHtml, noteHtml });
}

/** Render the four metrics and the existing main/aside workbench layout, without its hero. */
export function renderWorkbenchContent(model, {
  nameOf = id => id,
  projectPath = (id, view = 'overview') => `#/p/${encodeURIComponent(id)}/${view}`,
  projectColor = () => 'var(--accent)',
  canPrepare = () => false,
  visibleProjectIds = null,
  search = '',
  workError = false
} = {}) {
  const metrics = model.metrics || {};
  const projectIds = visibleProjectIds === null ? null : new Set(visibleProjectIds);
  const projects = (model.projects || []).filter(item => !projectIds || projectIds.has(item.project.id));
  const unavailable = workError || model.todos === null;
  const metricHtml = metricStrip([
    metric('项目目标已过', count(metrics.targetPast), '目标日期已过且仍有未完成事项', 'flag', 'purple', count(metrics.targetPast) > 0),
    metric('逾期任务', count(metrics.overdue), '已过截止日；不含完成、终止和归档', 'alert', 'amber', count(metrics.overdue) > 0),
    metric('未来 7 天到期', count(metrics.dueSoon), `${model.date} — ${model.windowEnd}，含今天`, 'calendar', 'blue', false, { keepDates: true }),
    metric('待我处理', unavailable ? '—' : count(metrics.actionable), workError ? '读取失败，请重试' : model.todos === null ? '正在读取个人职责内的事项' : '按职责统计；同一事项只计一次', 'check', 'green')
  ], { mobileCompact: true });
  const projectContent = projects.length ? panel({ bodyHtml: projects.map(item => renderProject(item, model, { projectPath, projectColor, canPrepare })).join(''), noteHtml: '按有效任务数量与当前需求阶段展示；任务完成不等于项目交付。' }) : panel({ bodyHtml: search ? empty('没有符合条件的项目', '请尝试其他关键词；上方指标与个人待办仍按全部可访问项目统计。') : empty('还没有可访问的项目', '可在项目目录检查访问范围，或联系项目负责人加入。') });
  const projectCount = search ? `${projects.length} / ${count(metrics.projectCount)} 个项目` : `${count(metrics.projectCount)} 个项目 · ${count(metrics.requirementCount)} 条需求`;
  const activation = model.activation?.accountCount > 0 ? panel({ padded: true, bodyHtml: `<div class="workbench-activation">${notice(`${count(model.activation.accountCount)} 个待激活账号关联 ${count(model.activation.taskCount)} 个未完成任务，请核实成员是否能够参与协作。`)}<a class="section-link" href="#/users">查看团队账号 ${icon('arrow')}</a><p>账号激活提示不计入个人待办。</p></div>` }) : '';
  return `${metricHtml}<div class="split team-layout"><section class="section-block">${sectionHeading('项目推进', { count: projectCount, actionsHtml: `<a class="section-link" href="#/projects">项目目录 ${icon('arrow')}</a>` })}${projectContent}</section><div class="stack activity-panel workbench-sidebar"><section class="section-block workbench-personal">${sectionHeading('待我处理', { count: unavailable ? '—' : count(metrics.actionable), actionsHtml: `<a class="section-link" href="#/personal">我的工作 ${icon('arrow')}</a>` })}${renderTodos(model, { workError, nameOf })}</section>${renderUpcomingMilestones(model, { projectPath, compact: !unavailable && count(model.todos) > 5 })}${activation}</div></div>`;
}
