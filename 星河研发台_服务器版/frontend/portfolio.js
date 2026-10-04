// 项目全景与全局甘特图（团队空间）。纯函数：状态判定 + HTML 输出；事件在 app.js 中处理。
// 逾期只统计已过截止日的未完成事项；未来延期预测单独显示，历史基线留在需求详情。
import { esc, toneBadge, metric, metricStrip, panel, empty, segmented, switchToggle } from './ui-kit.js';
import { taskStage, requirementDeliveryState } from './workflow.js';
import { parseDay, formatDay, resolveTimelineExtent, resolveTimelineZoom, buildTimelineScale, timelineZoomControls, timelineDateForm, timelineNavigation, timelineAxis, timelineGridlines, timelineChartAttrs, timelineLabelWidth } from './timeline.js';

const RISK_GAP = 0.2;
const hours = task => Number(task.estimateHours) || 0;
const isLive = task => !task.archived && taskStage(task.status) !== 'terminated';
const isFinished = task => taskStage(task.status) === 'done';
const percent = value => `${Math.round(value * 100)}%`;
const number = value => Number(value.toFixed(3));

/** Task dates describe execution; planStart/planEnd remain the independent commitment. */
export function requirementWindow(requirement, tasks = []) {
  const live=tasks.filter(task=>task.requirementId===requirement.id&&(!task.projectId||task.projectId===requirement.projectId)&&isLive(task));
  const dates=live.map(task=>({start:parseDay(task.startDate),end:parseDay(task.dueDate)}));
  const valid=dates.filter(item=>item.start!==null&&item.end!==null&&item.start<=item.end);
  const starts=dates.filter(item=>item.start!==null&&(item.end===null||item.start<=item.end)).map(item=>item.start);
  const ends=dates.filter(item=>item.end!==null&&(item.start===null||item.start<=item.end)).map(item=>item.end);
  const start=starts.length?Math.min(...starts):null,end=ends.length?Math.max(...ends):null;
  const taskRange=start!==null&&end!==null&&start<=end;
  const commitmentStart=parseDay(requirement.planStart),commitmentEnd=parseDay(requirement.planEnd);
  const legacy=!requirement.deliveryWorkflow&&!taskRange&&commitmentStart!==null&&commitmentEnd!==null&&commitmentStart<=commitmentEnd;
  return {start:taskRange?formatDay(start):legacy?requirement.planStart:'',end:taskRange?formatDay(end):legacy?requirement.planEnd:'',source:taskRange?'tasks':legacy?'legacy':'none',complete:live.length>0&&valid.length===live.length,unscheduled:live.length-valid.length,taskCount:live.length};
}

/** 需求进度：已完成任务工时 ÷ 未终止任务总工时；没有工时时按任务个数。 */
export function requirementProgress(requirement, tasks) {
  if (requirement.status === '已完成') return 1;
  const live = tasks.filter(task => task.requirementId === requirement.id && isLive(task));
  if (!live.length) return 0;
  const total = live.reduce((sum, task) => sum + hours(task), 0);
  if (total > 0) return live.filter(isFinished).reduce((sum, task) => sum + hours(task), 0) / total;
  return live.filter(isFinished).length / live.length;
}

/**
 * 需求健康度。state：done / terminated / unscheduled / late / risk / normal。
 * 承诺逾期与研发逾期分别计数；未来任务预计晚于承诺仅列为风险。
 * 历史基线不参与当前健康度或全局排期展示。
 */
export function requirementHealth(requirement, { tasks = [], requirements = [], today }) {
  const progress = requirementProgress(requirement, tasks);
  const window=requirementWindow(requirement,tasks);
  const commitmentEnd = parseDay(requirement.planEnd);
  const result = (state, extra = {}) => ({ state, progress, window, lateDays: 0, commitmentOverdueDays:0, executionOverdueDays:0, forecastDelayDays:0, overdueTasks:0, reasons: [], ...extra });
  if (requirement.status === '已终止') return result('terminated');
  if (requirement.status === '已完成') return result('done');
  const start = parseDay(window.start), end = parseDay(window.end), now = parseDay(today);
  const pending = tasks.filter(task=>task.requirementId===requirement.id&&(!task.projectId||task.projectId===requirement.projectId)&&isLive(task)&&!isFinished(task));
  const pendingEnds = pending.map(task=>parseDay(task.dueDate)).filter(day=>day!==null);
  const overdueEnds = now===null ? [] : pendingEnds.filter(day=>day<now);
  const commitmentOverdueDays = now!==null&&commitmentEnd!==null&&now>commitmentEnd?now-commitmentEnd:0;
  const executionOverdueDays = overdueEnds.length ? now-Math.min(...overdueEnds) : 0;
  const forecastDelayDays = pendingEnds.length&&commitmentEnd!==null ? Math.max(0,Math.max(...pendingEnds)-commitmentEnd) : 0;
  const dates={commitmentOverdueDays,executionOverdueDays,forecastDelayDays,overdueTasks:overdueEnds.length};
  const dateReasons=[commitmentOverdueDays?`承诺截止已逾期 ${commitmentOverdueDays} 天`:'',executionOverdueDays?`${overdueEnds.length} 项未完成任务已逾期，最长 ${executionOverdueDays} 天`:'',forecastDelayDays?`未完成任务预计结束晚于承诺 ${forecastDelayDays} 天`:''].filter(Boolean);
  if (commitmentOverdueDays || executionOverdueDays) return result('late', {...dates,lateDays:Math.max(commitmentOverdueDays,executionOverdueDays),reasons:dateReasons});
  if (start === null || end === null || start > end) return result('unscheduled', {...dates,reasons:['研发任务尚未排期']});
  const reasons = [];
  if(forecastDelayDays)reasons.push(...dateReasons);
  if(window.source==='tasks'&&!window.complete)reasons.push(`${window.unscheduled} 项有效任务日期待完善`);
  if (now !== null && now >= start) {
    const elapsed = Math.min(1, (now - start) / (end - start + 1));
    if (elapsed - progress > RISK_GAP) reasons.push(`时间已过 ${percent(elapsed)}，进度 ${percent(progress)}`);
    const blocked = (requirement.dependencyIds || []).map(id => requirements.find(item => item.id === id)).filter(item => item && !item.archived && item.status !== '已完成');
    if (blocked.length) reasons.push(`前置需求未完成：${blocked.map(item => item.title).join('、')}`);
  }
  return result(reasons.length ? 'risk' : 'normal', { ...dates,reasons });
}

const BUCKETS = [['review', ['未确定', '待评审']], ['plan', ['已确定', '待排期', '已排期']], ['progress', ['开发中']], ['test', ['测试中']], ['done', ['已完成']]];
const bucketOf = status => BUCKETS.find(([, list]) => list.includes(status))?.[0] || 'plan';

/** 项目汇总：需求起止、进度、状态分布、健康度、逾期任务、积压、下一节点。 */
export function projectSummary(project, { requirements = [], tasks = [], today }) {
  const reqs = requirements.filter(item => item.projectId === project.id && !item.archived);
  const projectTasks = tasks.filter(item => item.projectId === project.id && !item.archived);
  const rows = reqs.map(requirement => ({ requirement, ...requirementHealth(requirement, { tasks: projectTasks, requirements: reqs, today }) }));
  const active = rows.filter(row => row.state !== 'terminated'), scheduled = active.filter(row => row.window.start&&row.window.end);
  const starts = scheduled.map(row => parseDay(row.window.start)), ends = scheduled.map(row => parseDay(row.window.end));
  const start = starts.length ? Math.min(...starts) : null, end = ends.length ? Math.max(...ends) : null;
  // Project progress is weighted by the live task hours of each active requirement.
  let totalHours = 0, doneHours = 0;
  for (const row of active) { const weight = projectTasks.filter(task => task.requirementId === row.requirement.id && isLive(task)).reduce((sum, task) => sum + hours(task), 0); totalHours += weight; doneHours += weight * row.progress; }
  const progress = totalHours > 0 ? doneHours / totalHours : active.length ? active.filter(row => row.state === 'done').length / active.length : 0;
  const counts = Object.fromEntries(BUCKETS.map(([key]) => [key, 0])); for (const row of active) counts[bucketOf(row.requirement.status)]++;
  const now = parseDay(today), target = parseDay(project.targetDate);
  const unfinished = active.filter(row=>row.state!=='done');
  const unfinishedIds = new Set(unfinished.map(row=>row.requirement.id));
  const pendingTasks = projectTasks.filter(task=>unfinishedIds.has(task.requirementId)&&isLive(task)&&!isFinished(task));
  const pendingEnds = pendingTasks.map(task=>parseDay(task.dueDate)).filter(day=>day!==null);
  const commitmentEnds = unfinished.map(row=>parseDay(row.requirement.planEnd)).filter(day=>day!==null);
  const projectOverdueDays = unfinished.length&&now!==null&&target!==null ? Math.max(0,now-target) : 0;
  const commitmentOverdueDays = Math.max(0,...unfinished.map(row=>row.commitmentOverdueDays));
  const executionOverdueDays = Math.max(0,...unfinished.map(row=>row.executionOverdueDays));
  const taskForecastDelayDays = target!==null&&pendingEnds.length ? Math.max(0,Math.max(...pendingEnds)-target) : 0;
  const commitmentForecastDelayDays = target!==null&&commitmentEnds.length ? Math.max(0,Math.max(...commitmentEnds)-target) : 0;
  const forecastDelayDays = Math.max(taskForecastDelayDays,commitmentForecastDelayDays);
  const late = active.filter(row => row.state === 'late'), risk = active.filter(row => row.state === 'risk');
  const lateDays = Math.max(projectOverdueDays,commitmentOverdueDays,executionOverdueDays);
  const reasons = [projectOverdueDays?`项目交付截止已逾期 ${projectOverdueDays} 天`:'',commitmentOverdueDays?`${late.filter(row=>row.commitmentOverdueDays>0).length} 条需求承诺逾期，最长 ${commitmentOverdueDays} 天`:'',executionOverdueDays?`未完成任务已逾期，最长 ${executionOverdueDays} 天`:'',taskForecastDelayDays?`未完成任务预计结束晚于项目目标 ${taskForecastDelayDays} 天`:'',commitmentForecastDelayDays?`需求承诺晚于项目目标 ${commitmentForecastDelayDays} 天`:''].filter(Boolean);
  const state = !active.length ? 'empty' : !unfinished.length ? 'done' : lateDays > 0 ? 'late' : risk.length||forecastDelayDays ? 'risk' : 'normal';
  if (risk.length) reasons.push(`${risk.length} 条需求有风险`);
  const overdueTasks = pendingTasks.filter(task => parseDay(task.dueDate) !== null && now !== null && parseDay(task.dueDate) < now).length;
  const preparation=active.filter(row=>!['未确定','待评审','已完成','已终止'].includes(row.requirement.status)).map(row=>requirementDeliveryState(row.requirement,projectTasks.filter(task=>task.requirementId===row.requirement.id),reqs));
  const backlog = { review: active.filter(row => ['未确定', '待评审'].includes(row.requirement.status)).length, split: preparation.filter(state=>!state.planReady).length, schedule: preparation.filter(state=>state.planReady&&!state.scheduleReady).length };
  const milestones = (project.milestones || []).filter(item => parseDay(item.date) !== null).sort((a, b) => a.date.localeCompare(b.date));
  const next = milestones.find(item => now === null || parseDay(item.date) >= now) || null;
  return { project, rows, start: start === null ? '' : formatDay(start), end: end === null ? '' : formatDay(end), progress, counts, total: active.length, done: counts.done, state, lateDays, projectOverdueDays, commitmentOverdueDays, executionOverdueDays, forecastDelayDays, reasons, overdueTasks, backlog, unscheduled: preparation.filter(item=>!item.scheduleReady).length, nextMilestone: next ? { ...next, daysLeft: now === null ? null : parseDay(next.date) - now } : null, milestones };
}

/** 同一天最多同时推进的项目数（按任务起止日计算）。 */
export function maxParallelProjects(items) {
  let most = 0;
  for (const { startDay } of items) most = Math.max(most, new Set(items.filter(item => item.startDay <= startDay && item.endDay >= startDay).map(item => item.task.projectId)).size);
  return most;
}

/** 按人员视图的泳道：同一人时间重叠的任务放到不同泳道，保证条不互相遮挡。 */
export function packLanes(items) {
  const lanes = [], placed = [];
  for (const item of [...items].sort((a, b) => a.startDay - b.startDay || a.endDay - b.endDay)) {
    let lane = lanes.findIndex(lastEnd => lastEnd < item.startDay);
    if (lane < 0) { lane = lanes.length; lanes.push(item.endDay); } else lanes[lane] = item.endDay;
    placed.push({ ...item, lane });
  }
  return { items: placed, lanes: lanes.length };
}

const HEALTH = { late: ['danger', '已逾期'], risk: ['test', '有风险'], normal: ['done', '正常'], done: ['done', '已完成'], unscheduled: ['plan', '待排期'], terminated: ['terminated', '已终止'], empty: ['plan', '暂无需求'] };
export function healthBadge(state, lateDays = 0, detail = {}) {
  const [tone, label] = HEALTH[state] || HEALTH.normal;
  if(state==='late') {
    for(const [key,title] of [['projectOverdueDays','交付逾期'],['commitmentOverdueDays','承诺逾期'],['executionOverdueDays','任务逾期']]) if(detail[key]>0)return toneBadge(tone,`${title} ${detail[key]} 天`);
    return toneBadge(tone,lateDays?`${label} ${lateDays} 天`:label);
  }
  return toneBadge(tone,state==='risk'&&detail.forecastDelayDays>0?`预计延期 ${detail.forecastDelayDays} 天`:label);
}

/** 全局甘特图的时间范围：所有可见项目的周期、里程碑、需求与任务日期。app.js 的缩放/拖动沿用排期页逻辑。 */
export function portfolioTimelineContext({ projects, requirements, tasks, today }) {
  const days = projects.flatMap(project => [project.startDate, project.targetDate]).map(parseDay).filter(day => day !== null);
  const ids = new Set(projects.map(project => project.id));
  const items = [...requirements.filter(item => ids.has(item.projectId) && !item.archived).flatMap(item => {
    const window=requirementWindow(item,tasks);
    return [{startDate:window.start,dueDate:window.end},{startDate:item.planStart,dueDate:item.planEnd}];
  }), ...tasks.filter(item => ids.has(item.projectId) && isLive(item))];
  return { project: { startDate: days.length ? formatDay(Math.min(...days)) : '', targetDate: days.length ? formatDay(Math.max(...days)) : '', milestones: projects.flatMap(project => project.milestones || []) }, tasks: items, today };
}

function matchesQuery(query, ...values) { return !query || values.some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(query)); }

export function renderPortfolio({ projects, requirements, tasks, users, today, state, filters, expanded, query = '', viewportWidth = 900, colorOf = () => 'var(--project-1)' }) {
  const names = new Map(users.map(item => [item.id, item.name])), nameOf = id => names.get(id) || (id ? '未知成员' : '未分配');
  const visible = projects.filter(project => !project.archived);
  if (!visible.length) return panel({ bodyHtml: empty('还没有可查看的项目', '加入项目或由管理员创建项目后，全局排期会显示在这里。') });
  const summaries = visible.map(project => projectSummary(project, { requirements, tasks, today }));
  const q = String(query).trim().toLocaleLowerCase('zh-CN');
  const count = key => summaries.filter(item => item.state === key).length;
  const unscheduled = summaries.reduce((sum, item) => sum + item.backlog.schedule, 0);
  const metrics = metricStrip([
    metric('进行中项目', String(summaries.filter(item => item.state !== 'done').length), `共 ${summaries.length} 个可见项目`, 'folder', 'blue'),
    metric('存在逾期的项目', String(count('late')), '仅统计实际任务、承诺或交付逾期', 'alert', '', count('late') > 0),
    metric('有风险项目', String(count('risk')), '预计延期、进度滞后或前置未完成', 'flag', 'amber'),
    metric('待排期需求', String(unscheduled), '拆分齐备但任务日期尚未完善', 'calendar', 'purple'),
  ]);

  const nextCell = item => {
    const next = item.nextMilestone; if (!next) return '<span class="muted">—</span>';
    const left = next.daysLeft === null ? '' : next.daysLeft === 0 ? '今天' : `还有 ${next.daysLeft} 天`;
    return `<span class="portfolio-next"><strong>${esc(next.label || next.name || '里程碑')}</strong><span class="item-meta">${esc(next.date)}${left ? ` · ${left}` : ''}</span></span>`;
  };
  const segments = item => `<div class="portfolio-progress"><div class="portfolio-segments" role="img" aria-label="${BUCKETS.map(([key]) => `${SEGMENT_LABEL[key]} ${item.counts[key]} 条`).join('，')}">${item.total ? BUCKETS.filter(([key]) => item.counts[key]).map(([key]) => `<span class="portfolio-segment portfolio-segment-${key}" style="width:${number(item.counts[key] / item.total * 100)}%" title="${SEGMENT_LABEL[key]} ${item.counts[key]} 条"></span>`).join('') : ''}</div><span class="item-meta">完成 ${item.done} / ${item.total} · 进度 ${percent(item.progress)}</span></div>`;
  const backlog = item => { const parts = [['待评审', item.backlog.review], ['待拆分', item.backlog.split], ['待排期', item.backlog.schedule]].filter(([, value]) => value); return parts.length ? parts.map(([label, value]) => `${label} ${value}`).join(' · ') : '<span class="muted">无</span>'; };
  const overviewRows = summaries.map(item => `<tr><td class="title-cell"><span class="portfolio-project-name"><span class="project-glyph portfolio-glyph" style="--project:${colorOf(item.project.id)}" aria-hidden="true">${esc([...item.project.name][0] || '项')}</span><span><a class="item-title" href="#/p/${encodeURIComponent(item.project.id)}/overview">${esc(item.project.name)}</a><span class="item-meta">负责人 ${esc(nameOf(item.project.ownerId))} · 目标 ${esc(item.project.targetDate || '未设置')}</span></span></span></td><td>${nextCell(item)}</td><td>${segments(item)}</td><td><span title="${esc(item.reasons.join('；'))}">${healthBadge(item.state, item.lateDays, item)}</span></td><td class="num-cell${item.overdueTasks ? ' overdue-text' : ''}">${item.overdueTasks}</td><td class="portfolio-backlog">${backlog(item)}</td></tr>`).join('');
  const overview = panel({ title: '项目概况', count: summaries.length, bodyHtml: `<div class="table-wrap"><table class="data-table"><thead><tr><th>项目</th><th>下一节点</th><th>需求进度</th><th>状态</th><th class="num-cell">逾期任务</th><th>积压</th></tr></thead><tbody>${overviewRows}</tbody></table></div>`, noteHtml: '只有未完成任务、需求承诺或项目交付截止日已经过去，才显示实际逾期；未来任务或承诺晚于交付目标显示预计延期。研发周期按有效任务汇总，历史记录缺少任务日期时仅以当前承诺区间作参考。' });

  // ---------- Gantt ----------
  const shown = summaries.filter(item => (filters.project === 'all' || item.project.id === filters.project) && (!filters.issues || ['late', 'risk'].includes(item.state)));
  const context = portfolioTimelineContext({ projects: shown.map(item => item.project), requirements, tasks, today });
  const extent = resolveTimelineExtent(context);
  const zoom = resolveTimelineZoom(state, extent, viewportWidth, context);
  const px = zoom.px, scale = buildTimelineScale(extent, px), todayDay = parseDay(today);
  const x = day => number((day - extent.startDay) * px);
  const todayInside = todayDay !== null && todayDay >= extent.startDay && todayDay <= extent.endDay;
  const span = (startValue, endValue) => { const a = parseDay(startValue), b = parseDay(endValue); return a === null || b === null || a > b ? null : { left: x(a), width: Math.max(6, number((b - a + 1) * px)), a, b }; };
  const ownerMatch = id => filters.owner === 'all' || id === filters.owner;
  const toggle = (key, label) => `<button type="button" class="portfolio-toggle${expanded.has(key) || q ? ' is-open' : ''}" data-portfolio-toggle="${esc(key)}" aria-expanded="${expanded.has(key) || Boolean(q)}" aria-label="${expanded.has(key) ? '收起' : '展开'}${esc(label)}">›</button>`;
  const spacer = '<span class="portfolio-toggle-space" aria-hidden="true"></span>';
  const outsideLabel = (bar, text) => { const need = timelineLabelWidth(text); if (bar.width >= need) return ''; const after = bar.left + bar.width + 8 + need <= zoom.trackWidth; return `<span class="schedule-bar-label${after ? '' : ' is-before'}" style="left:${number(after ? bar.left + bar.width + 8 : Math.max(0, bar.left - 8 - need))}px" aria-hidden="true">${esc(text)}</span>`; };
  const taskRow = (task, level) => {
    const bar = span(task.startDate, task.dueDate), stage = taskStage(task.status), late = bar && todayDay !== null && bar.b < todayDay && !['done', 'terminated'].includes(stage);
    const label = STAGE_LABEL[stage] || '待开始';
    return `<div class="schedule-row portfolio-row portfolio-level-${level}"><div class="schedule-name">${spacer}<span class="portfolio-name-copy"><button class="schedule-task-name" data-task="${esc(task.id)}">${esc(task.title)}</button><small>${esc(nameOf(task.ownerId))}<span>·</span>${label}${Number(task.estimateHours) ? `<span>·</span>${Number(task.estimateHours)} 小时` : ''}${late ? '<span class="schedule-late-label">已逾期</span>' : ''}</small></span></div><div class="schedule-track">${bar ? `<button data-task="${esc(task.id)}" class="schedule-bar schedule-bar-${STAGE_LABEL[stage] ? stage : 'wait'}${late ? ' is-overdue' : ''}${bar.width >= timelineLabelWidth(task.title) ? '' : ' is-compact'}" style="left:${bar.left}px;width:${bar.width}px" title="${esc(task.title)} · ${task.startDate} — ${task.dueDate}" aria-label="${esc(task.title)}，${label}，${task.startDate} 至 ${task.dueDate}${late ? '，已逾期' : ''}">${bar.width >= timelineLabelWidth(task.title) ? `<span>${esc(task.title)}</span>` : ''}</button>${outsideLabel(bar, task.title)}` : '<span class="portfolio-undated">日期待完善</span>'}</div></div>`;
  };
  const requirementRow = (row, projectTasks) => {
    const req = row.requirement, key = 'r:' + req.id, children = projectTasks.filter(task => task.requirementId === req.id && !task.archived && ownerMatch(task.ownerId) && matchesQuery(q, task.title, task.id, req.title, req.id));
    const window=row.window,bar = span(window.start,window.end),commitment=span(req.planStart,req.planEnd);
    const tone = row.state === 'late' ? ' is-overdue' : row.state === 'risk' ? ' is-risk' : '';
    const stage = { '开发中': 'develop', '测试中': 'test', '已完成': 'done', '已终止': 'terminated' }[req.status] || 'wait';
    const open = expanded.has(key) || Boolean(q);
    const title = `${req.title}（${percent(row.progress)}）`;
    const windowLabel=window.source==='legacy'?'历史承诺区间（非任务汇总）':window.complete?'研发周期':'研发周期（任务日期待完善）';
    const commitmentLabel=req.planStart||req.planEnd?` · 承诺 ${req.planStart||'未设置'} — ${req.planEnd||'未设置'}`:'';
    const html = `<div class="schedule-row portfolio-row portfolio-level-1"><div class="schedule-name">${children.length ? toggle(key, req.title) : spacer}<span class="portfolio-name-copy"><button class="schedule-task-name" data-requirement="${esc(req.id)}">${esc(req.title)}</button><small>${esc(nameOf(req.assigneeId))}<span>·</span>${esc(req.status)}${window.source==='legacy'?'<span>·</span>历史承诺区间':''}${['late','risk'].includes(row.state)?healthBadge(row.state,row.lateDays,row):''}</small></span></div><div class="schedule-track">${commitment&&window.source!=='legacy'?`<span class="portfolio-cycle" style="left:${commitment.left}px;width:${commitment.width}px" title="承诺区间 ${esc(req.planStart)} — ${esc(req.planEnd)}" role="img" aria-label="承诺区间 ${esc(req.planStart)} 至 ${esc(req.planEnd)}"></span>`:''}${bar ? `<button data-requirement="${esc(req.id)}" class="schedule-bar schedule-bar-${stage} portfolio-requirement-bar${tone}${bar.width >= timelineLabelWidth(title) ? '' : ' is-compact'}" style="left:${bar.left}px;width:${bar.width}px;--progress:${number(row.progress * 100)}%" title="${esc(req.title)} · ${windowLabel} ${window.start} — ${window.end}${esc(commitmentLabel)} · 进度 ${percent(row.progress)}${row.reasons.length ? ' · ' + esc(row.reasons.join('；')) : ''}" aria-label="${esc(req.title)}，${windowLabel} ${window.start} 至 ${window.end}${esc(commitmentLabel)}，进度 ${percent(row.progress)}${row.reasons.length?'，'+esc(row.reasons.join('；')):''}">${bar.width >= timelineLabelWidth(title) ? `<span>${esc(title)}</span>` : ''}</button>${outsideLabel(bar, title)}` : '<span class="portfolio-undated">研发任务尚未排期</span>'}</div></div>`;
    return html + (open ? children.sort(byStart('startDate')).map(task => taskRow(task, 2)).join('') : '');
  };
  const projectRows = shown.map(item => {
    const project = item.project, key = 'p:' + project.id, projectTasks = tasks.filter(task => task.projectId === project.id);
    const reqRows = item.rows.filter(row => row.state !== 'terminated' && (!filters.issues || ['late', 'risk'].includes(row.state)) && (filters.owner === 'all' || row.requirement.assigneeId === filters.owner || projectTasks.some(task => task.requirementId === row.requirement.id && !task.archived && task.ownerId === filters.owner)) && (matchesQuery(q, project.name, row.requirement.title, row.requirement.id) || projectTasks.some(task => task.requirementId === row.requirement.id && matchesQuery(q, task.title, task.id))));
    if (q && !reqRows.length && !matchesQuery(q, project.name)) return '';
    const open = expanded.has(key) || Boolean(q);
    const bar = span(item.start, item.end), cycle = span(project.startDate, project.targetDate);
    const target = parseDay(project.targetDate);
    const marks = item.milestones.filter(mark => parseDay(mark.date) >= extent.startDay && parseDay(mark.date) <= extent.endDay).map(mark => `<span class="portfolio-milestone${mark.kind === 'target' || mark.date === project.targetDate ? ' is-target' : ''}" style="left:${x(parseDay(mark.date) + .5)}px" title="${esc(mark.label || mark.name || '里程碑')} · ${esc(mark.date)}" role="img" aria-label="${esc(mark.label || mark.name || '里程碑')}，${esc(mark.date)}">◆</span>`).join('');
    const label = `${project.name} · ${percent(item.progress)}`;
    const meta = [`${esc(nameOf(project.ownerId))}`, item.unscheduled ? `待排期 ${item.unscheduled} 条` : '', ['late','risk'].includes(item.state)?healthBadge(item.state,item.lateDays,item):''].filter(Boolean).join('<span>·</span>');
    const head = `<div class="schedule-row portfolio-row portfolio-level-0"><div class="schedule-name">${reqRows.length ? toggle(key, project.name) : spacer}<span class="portfolio-name-copy"><a class="schedule-task-name" href="#/p/${encodeURIComponent(project.id)}/timeline">${esc(project.name)}</a><small>${meta}</small></span></div><div class="schedule-track">${cycle ? `<span class="portfolio-cycle" style="left:${cycle.left}px;width:${cycle.width}px" title="项目周期 ${esc(project.startDate)} — ${esc(project.targetDate)}"></span>` : ''}${bar ? `<span class="portfolio-project-bar${item.state === 'late' ? ' is-late' : ''}" style="left:${bar.left}px;width:${bar.width}px;--project:${colorOf(project.id)};--progress:${number(item.progress * 100)}%" title="${esc(project.name)} · 需求排期 ${item.start} — ${item.end} · 进度 ${percent(item.progress)}${item.reasons.length ? ' · ' + esc(item.reasons.join('；')) : ''}">${bar.width >= timelineLabelWidth(label) ? `<span>${esc(label)}</span>` : ''}</span>${outsideLabel(bar, label)}` : ''}${marks}${target !== null && target >= extent.startDay && target <= extent.endDay ? `<i class="portfolio-target-line" style="left:${x(target + .5)}px" aria-hidden="true"></i>` : ''}</div></div>`;
    return head + (open ? reqRows.sort((a, b) => (parseDay(a.window.start) ?? Infinity) - (parseDay(b.window.start) ?? Infinity) || String(a.requirement.id).localeCompare(String(b.requirement.id))).map(row => requirementRow(row, projectTasks)).join('') : '');
  }).join('');

  // Person view: every unfinished dated task in the shown projects, packed into lanes.
  const shownIds = new Set(shown.map(item => item.project.id));
  const openTasks = tasks.filter(task => shownIds.has(task.projectId) && isLive(task) && !isFinished(task) && task.ownerId && ownerMatch(task.ownerId) && matchesQuery(q, task.title, task.id, nameOf(task.ownerId)));
  const projectName = new Map(visible.map(project => [project.id, project.name]));
  const people = [...new Set(openTasks.map(task => task.ownerId))].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
  const personRows = people.map(id => {
    const own = openTasks.filter(task => task.ownerId === id), dated = own.map(task => ({ task, startDay: parseDay(task.startDate), endDay: parseDay(task.dueDate) })).filter(item => item.startDay !== null && item.endDay !== null && item.startDay <= item.endDay);
    const packed = packLanes(dated), parallel = maxParallelProjects(dated);
    const bars = packed.items.map(({ task, startDay, endDay, lane }) => {
      const left = x(startDay), width = Math.max(6, number((endDay - startDay + 1) * px)), text = `${projectName.get(task.projectId) || ''} · ${task.title}`, late = todayDay !== null && endDay < todayDay;
      return `<button data-task="${esc(task.id)}" class="portfolio-lane-bar${late ? ' is-overdue' : ''}" style="left:${left}px;width:${width}px;top:${8 + lane * 30}px;--project:${colorOf(task.projectId)}" title="${esc(text)} · ${task.startDate} — ${task.dueDate}" aria-label="${esc(text)}，${task.startDate} 至 ${task.dueDate}${late ? '，已逾期' : ''}">${width >= 40 ? `<span>${esc(task.title)}</span>` : ''}</button>`;
    }).join('');
    const hoursTotal = own.reduce((sum, task) => sum + hours(task), 0);
    return `<div class="schedule-row portfolio-row portfolio-person-row" style="height:${Math.max(46, 16 + packed.lanes * 30)}px"><div class="schedule-name"><span class="portfolio-name-copy"><strong class="portfolio-person-name">${esc(nameOf(id))}</strong><small>${own.length} 个未完成任务${hoursTotal ? `<span>·</span>${hoursTotal} 小时` : ''}${own.length - dated.length ? `<span>·</span>${own.length - dated.length} 个待定日期` : ''}</small>${parallel >= 2 ? `<small${parallel >= 3 ? ' class="portfolio-risk-label"' : ''}>同一天最多 ${parallel} 个项目并行</small>` : ''}</span></div><div class="schedule-track">${bars}</div></div>`;
  }).join('');

  const rowsHtml = filters.view === 'person' ? personRows : projectRows;
  const people2 = [...new Set(tasks.filter(task => shownIds.has(task.projectId) && !task.archived && task.ownerId).map(task => task.ownerId).concat(requirements.filter(item => shownIds.has(item.projectId) && item.assigneeId).map(item => item.assigneeId)))].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN'));
  const selected = (value, current) => value === current ? ' selected' : '';
  const controls = `<div class="schedule-controls">${segmented([{ value: 'project', label: '按项目' }, { value: 'person', label: '按人员' }], filters.view, 'portfolio-view', '甘特图视图')}${timelineZoomControls(state, zoom, scale, px)}<div class="schedule-filters"><label><span>项目</span><select data-portfolio-filter="project" aria-label="按项目筛选"><option value="all"${selected('all', filters.project)}>全部项目</option>${visible.map(project => `<option value="${esc(project.id)}"${selected(project.id, filters.project)}>${esc(project.name)}</option>`).join('')}</select></label><label><span>负责人</span><select data-portfolio-filter="owner" aria-label="按负责人筛选"><option value="all"${selected('all', filters.owner)}>全部负责人</option>${people2.map(id => `<option value="${esc(id)}"${selected(id, filters.owner)}>${esc(nameOf(id))}</option>`).join('')}</select></label>${switchToggle('portfolio-issues', '只看逾期 / 有风险', filters.issues)}</div></div>${timelineDateForm(state)}`;
  const expandAll = filters.view === 'project' ? `<div class="portfolio-expand"><button type="button" class="text-button" data-portfolio-expand="all">全部展开</button><button type="button" class="text-button" data-portfolio-expand="none">全部收起</button></div>` : '';
  const legend = filters.view === 'project'
    ? '<div class="schedule-legend"><span><i class="portfolio-legend-project"></i>项目（深色为已完成进度）</span><span><i class="schedule-legend-active"></i>研发周期 / 任务</span><span>虚线框：承诺区间</span><span><i class="portfolio-legend-risk"></i>有风险</span><span><i class="schedule-legend-late"></i>实际逾期</span><span><i class="portfolio-legend-target"></i>目标日期</span>' + (todayInside ? '<span><i class="schedule-legend-today"></i>今天</span>' : '') + '</div>'
    : `<div class="schedule-legend">${shown.map(item => `<span><i class="portfolio-legend-swatch" style="--project:${colorOf(item.project.id)}"></i>${esc(item.project.name)}</span>`).join('')}<span><i class="schedule-legend-late"></i>已逾期</span></div>`;
  const emptyChart = rowsHtml ? '' : `<div class="schedule-chart-empty"><strong>${filters.view === 'person' ? '没有已分配的未完成任务' : '没有符合条件的项目'}</strong><span>${filters.view === 'person' ? '主开发拆分任务并指定负责人后，每个人的并行负载会显示在这里。' : '调整项目、负责人或「只看逾期 / 有风险」后再次查看。'}</span></div>`;
  const chart = `<div class="schedule-scroll${zoom.isFit ? ' is-fit' : ''}" role="region" aria-label="全局甘特图。按住拖动查看，⌘ 或 Ctrl 加滚轮缩放" tabindex="0"><div class="schedule-chart portfolio-chart" ${timelineChartAttrs(extent, zoom, px, todayInside, todayDay)} style="--track:${number(zoom.trackWidth)}px">${timelineGridlines(scale, todayInside, x(todayDay + .5))}${timelineAxis(scale, todayDay, px, filters.view === 'person' ? '人员 / 未完成任务' : '项目 / 需求 / 任务')}${rowsHtml}${emptyChart}</div></div>`;
  const range = `<div class="schedule-range"><div class="schedule-range-copy"><h2 data-timeline-visible>${extent.start} <span>—</span> ${extent.end}</h2><p>${extent.empty ? '还没有排期日期，暂显示当前月份。' : `覆盖 ${shown.length} 个项目，${extent.dataStart} — ${extent.dataEnd}。${zoom.isFit ? '当前为全局视图，放大后可拖动查看。' : '按住图表拖动查看，⌘/Ctrl + 滚轮缩放。'}`}</p></div>${timelineNavigation(state, extent, zoom, todayInside)}</div>`;
  const gantt = `<section class="panel schedule-panel">${controls}${range}</section><section class="panel schedule-panel"><div class="schedule-chart-heading"><h2>全局甘特图</h2><span>${scale.label}显示${zoom.isFit ? ' · 全局' : ''}</span>${expandAll}${legend}</div>${chart}</section>`;
  return metrics + overview + gantt;
}

const STAGE_LABEL = { wait: '待开始', develop: '开发中', test: '测试中', done: '已完成', terminated: '已终止' };
const SEGMENT_LABEL = { review: '待评审', plan: '已确定 / 待排期 / 已排期', progress: '开发中', test: '测试中', done: '已完成' };
const byStart = field => (a, b) => (parseDay(a[field]) ?? Infinity) - (parseDay(b[field]) ?? Infinity) || String(a.title).localeCompare(String(b.title), 'zh-CN');
