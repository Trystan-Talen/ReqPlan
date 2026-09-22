import { badge } from './ui-kit.js';

// Calendar arithmetic uses UTC day numbers. Local midnight/DST never changes a day length.
const DAY = 86_400_000;
const STATUS = { wait: '待开始', develop: '开发中', test: '测试中', done: '已完成', terminated: '已终止' };
const MODES = { week: '周', month: '月', quarter: '季度', project: '完整项目', custom: '自定义' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const stage = value => ({ '待开始': 'wait', '开发中': 'develop', '测试中': 'test', '已完成': 'done', '已终止': 'terminated' }[value] || value);

export function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / DAY : null;
}

const MIN_DAY = parseDay('0001-01-01');
const MAX_DAY = parseDay('9999-12-31');

export function formatDay(day) {
  const date = new Date(day * DAY);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function monthStart(day, offset = 0) {
  const date = new Date(day * DAY);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.getTime() / DAY;
}

function monthRange(anchor, quarter = false) {
  const month = new Date(anchor * DAY).getUTCMonth();
  const start = monthStart(anchor, quarter ? -(month % 3) : 0);
  return { startDay: start, endDay: monthStart(start, quarter ? 3 : 1) - 1 };
}

function weekStart(day) { return day - ((new Date(day * DAY).getUTCDay() + 6) % 7); }
function activeTasks(tasks) { return tasks.filter(task => !task.archived); }

export function createTimelineState(today) {
  if (parseDay(today) === null) throw new Error('今天的日期格式不正确。');
  return { mode: 'month', anchor: today, start: '', end: '', owner: 'all', status: 'all' };
}

export function resolveTimelineRange(state, { today, project = {}, tasks = [] }) {
  const todayDay = parseDay(today);
  if (todayDay === null) throw new Error('今天的日期格式不正确。');
  const anchor = parseDay(state.anchor) ?? todayDay;
  const mode = MODES[state.mode] ? state.mode : 'month';
  let range, error = '', isFallback = false;
  if (mode === 'week') { const startDay = weekStart(anchor); range = { startDay, endDay: startDay + 6 }; }
  else if (mode === 'project') {
    const dates = [project.startDate, project.targetDate, project.endDate, ...(project.milestones || []).map(item => item.date), ...activeTasks(tasks).flatMap(task => [task.startDate, task.dueDate])].map(parseDay).filter(day => day !== null);
    if (dates.length) range = dates.reduce((result, day) => ({ startDay: Math.min(result.startDay, day), endDay: Math.max(result.endDay, day) }), { startDay: Infinity, endDay: -Infinity });
    else { range = monthRange(anchor); isFallback = true; }
  } else if (mode === 'custom') {
    const startDay = parseDay(state.start), endDay = parseDay(state.end);
    if (startDay === null || endDay === null) error = '请填写有效的开始日期和结束日期。';
    else if (endDay < startDay) error = '结束日期不能早于开始日期。';
    if (error) { range = monthRange(anchor); isFallback = true; }
    else range = { startDay, endDay };
  } else range = monthRange(anchor, mode === 'quarter');
  // The first/last supported week can be partial, but never contains an invalid year.
  range.startDay = Math.max(MIN_DAY, range.startDay);
  range.endDay = Math.min(MAX_DAY, range.endDay);
  return { ...range, start: formatDay(range.startDay), end: formatDay(range.endDay), days: range.endDay - range.startDay + 1, mode, error, isFallback };
}

export function moveTimeline(state, direction, context) {
  const range = resolveTimelineRange(state, context);
  if (direction === 'today') {
    if (state.mode === 'custom') {
      const startDay = parseDay(context.today);
      return { ...state, anchor: context.today, start: context.today, end: formatDay(Math.min(MAX_DAY, startDay + range.days - 1)) };
    }
    return { ...state, mode: state.mode === 'project' ? 'month' : state.mode, anchor: context.today };
  }
  const step = direction < 0 ? -1 : 1;
  if (state.mode === 'project' || range.error || (step < 0 && range.startDay === MIN_DAY) || (step > 0 && range.endDay === MAX_DAY)) return { ...state };
  if (state.mode === 'custom') {
    const shift = Math.max(MIN_DAY - range.startDay, Math.min(MAX_DAY - range.endDay, step * range.days));
    return { ...state, anchor: formatDay(range.startDay + shift), start: formatDay(range.startDay + shift), end: formatDay(range.endDay + shift) };
  }
  const anchor = state.mode === 'week' ? range.startDay + step * 7 : monthStart(range.startDay, step * (state.mode === 'quarter' ? 3 : 1));
  return { ...state, anchor: formatDay(Math.max(MIN_DAY, Math.min(MAX_DAY, anchor))) };
}

// Long projects use grouped months; even a millennia-long range has <= 61 cells.
// Cells retain their actual duration, so task positions are always proportional to time.
export function buildTimelineTicks(range, scaleDays = range.days) {
  const ticks = [];
  const monthCount = (new Date(range.endDay * DAY).getUTCFullYear() - new Date(range.startDay * DAY).getUTCFullYear()) * 12 + new Date(range.endDay * DAY).getUTCMonth() - new Date(range.startDay * DAY).getUTCMonth() + 1;
  const unit = scaleDays <= 45 ? 'day' : scaleDays <= 210 ? 'week' : 'month';
  const stride = unit === 'month' ? Math.max(1, Math.ceil(monthCount / 60)) : 1;
  let cursor = range.startDay;
  while (cursor <= range.endDay) {
    const next = unit === 'day' ? cursor + 1 : unit === 'week' ? weekStart(cursor) + 7 : monthStart(cursor, stride);
    const endDay = Math.min(next - 1, range.endDay);
    const value = formatDay(cursor), weekday = new Date(cursor * DAY).getUTCDay();
    const label = unit === 'day' ? `${Number(value.slice(8))}` : unit === 'week' ? `${Number(value.slice(5, 7))}/${Number(value.slice(8))}` : `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月`;
    const detail = unit === 'day' ? (value.slice(8) === '01' ? `${Number(value.slice(5, 7))}月` : ['日', '一', '二', '三', '四', '五', '六'][weekday]) : unit === 'week' ? (Number(value.slice(8)) <= 7 ? `${Number(value.slice(5, 7))}月` : '') : stride > 1 ? `${stride}个月` : '';
    ticks.push({ startDay: cursor, endDay, start: value, end: formatDay(endDay), label, detail, weekend: unit === 'day' && (weekday === 0 || weekday === 6), monthStart: value.slice(8) === '01', left: (cursor - range.startDay) / range.days * 100, width: (endDay - cursor + 1) / range.days * 100 });
    cursor = endDay + 1;
  }
  return { unit, stride, ticks, label: unit === 'day' ? '按日显示' : unit === 'week' ? '按周显示' : stride > 1 ? `每格 ${stride} 个月` : '按月显示' };
}

// ---- Zoomable project timeline -------------------------------------------------
// The chart spans only the project's scheduled dates (plus a small margin), so it can
// never be dragged into empty time. Zoom is pixels per day: "fit" shows the whole
// project in one screen; the maximum keeps the drawn chart bounded for long projects.
export const TIMELINE_LIMITS = Object.freeze({ maxDayPx: 96, maxChartPx: 40000, minCellPx: 44 });
const PRESET_DAYS = { week: 7, month: 31, quarter: 92 };

export function resolveTimelineExtent({ project = {}, tasks = [], today }) {
  const dates = [project.startDate, project.targetDate, project.endDate, ...(project.milestones || []).map(item => item.date), ...activeTasks(tasks).flatMap(task => [task.startDate, task.dueDate])].map(parseDay).filter(day => day !== null);
  if (!dates.length) {
    const todayDay = parseDay(today) ?? parseDay('2000-01-01'), fallback = monthRange(todayDay);
    return { startDay: fallback.startDay, endDay: fallback.endDay, days: fallback.endDay - fallback.startDay + 1, start: formatDay(fallback.startDay), end: formatDay(fallback.endDay), dataStart: '', dataEnd: '', dataDays: 0, empty: true };
  }
  const first = dates.reduce((a, b) => Math.min(a, b)), last = dates.reduce((a, b) => Math.max(a, b));
  const margin = Math.max(3, Math.round((last - first + 1) * .03));
  const startDay = Math.max(MIN_DAY, first - margin), endDay = Math.min(MAX_DAY, last + margin);
  return { startDay, endDay, days: endDay - startDay + 1, start: formatDay(startDay), end: formatDay(endDay), dataStart: formatDay(first), dataEnd: formatDay(last), dataDays: last - first + 1, empty: false };
}

export function resolveTimelineZoom(state, extent, viewportWidth, context = {}) {
  const width = Math.max(1, Number(viewportWidth) || 900);
  const fit = width / extent.days;
  const max = Math.max(fit, Math.min(TIMELINE_LIMITS.maxDayPx, TIMELINE_LIMITS.maxChartPx / extent.days));
  let wanted;
  if (state.fit) wanted = fit;
  else if (Number.isFinite(state.zoom) && state.zoom > 0) wanted = state.zoom;
  else if (state.mode === 'custom') { const range = resolveTimelineRange(state, { today: context.today, project: context.project, tasks: context.tasks }); wanted = range.error ? width / 31 : width / range.days; }
  else wanted = width / (PRESET_DAYS[state.mode] || 31);
  const px = Math.max(fit, Math.min(max, wanted));
  return { px, fit, max, width, isFit: px <= fit * 1.0001, trackWidth: Math.max(width, extent.days * px) };
}

function yearStart(day, offset = 0) { const date = new Date(day * DAY); date.setUTCMonth(0, 1); date.setUTCFullYear(date.getUTCFullYear() + offset); return date.getTime() / DAY; }
const niceStep = (needed, steps) => steps.find(step => step >= needed) ?? Math.ceil(needed / steps.at(-1)) * steps.at(-1);

export function buildTimelineScale(extent, px) {
  const unit = px >= 22 ? 'day' : px >= 4.2 ? 'week' : 'month';
  const lower = [], upper = [];
  const push = (list, startDay, next, label, detail = '', extra = {}) => { const endDay = Math.min(next - 1, extent.endDay); list.push({ startDay, endDay, start: formatDay(startDay), end: formatDay(endDay), label, detail, left: (startDay - extent.startDay) * px, width: (endDay - startDay + 1) * px, ...extra }); return endDay + 1; };
  let cursor = extent.startDay;
  if (unit === 'day') {
    while (cursor <= extent.endDay) { const value = formatDay(cursor), weekday = new Date(cursor * DAY).getUTCDay(); cursor = push(lower, cursor, cursor + 1, String(Number(value.slice(8))), ['日', '一', '二', '三', '四', '五', '六'][weekday], { weekend: weekday === 0 || weekday === 6, boundary: value.slice(8) === '01' }); }
  } else if (unit === 'week') {
    while (cursor <= extent.endDay) { const value = formatDay(weekStart(cursor)); cursor = push(lower, cursor, weekStart(cursor) + 7, `${Number(value.slice(5, 7))}/${Number(value.slice(8))}`); }
  } else {
    const stride = niceStep(TIMELINE_LIMITS.minCellPx / (30.44 * px), [1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200]);
    while (cursor <= extent.endDay) { const value = formatDay(cursor); cursor = push(lower, cursor, monthStart(cursor, stride), stride >= 12 ? `${Number(value.slice(0, 4))}` : `${Number(value.slice(5, 7))}月`, '', { boundary: value.slice(5, 7) === '01' }); }
  }
  cursor = extent.startDay;
  if (unit === 'month') {
    const stride = niceStep(60 / (365.25 * px), [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]);
    while (cursor <= extent.endDay) { const year = Number(formatDay(cursor).slice(0, 4)); cursor = push(upper, cursor, yearStart(cursor, stride), stride > 1 ? `${year} – ${Math.min(9999, year + stride - 1)}` : `${year}年`); }
  } else {
    while (cursor <= extent.endDay) { const value = formatDay(cursor); cursor = push(upper, cursor, monthStart(cursor, 1), `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月`); }
  }
  return { unit, lower, upper, label: unit === 'day' ? '按日' : unit === 'week' ? '按周' : '按月' };
}

const labelWidth = text => [...String(text)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11.6 : 6.8), 0) + 20;

export function taskInterval(task) {
  const startDay = parseDay(task.startDate), endDay = parseDay(task.dueDate);
  return startDay !== null && endDay !== null && startDay <= endDay ? { startDay, endDay } : null;
}

export function timelineBar(task, range) {
  const interval = taskInterval(task);
  if (!interval || interval.endDay < range.startDay || interval.startDay > range.endDay) return null;
  const start = Math.max(interval.startDay, range.startDay), end = Math.min(interval.endDay, range.endDay);
  return { left: (start - range.startDay) / range.days * 100, width: (end - start + 1) / range.days * 100, clippedStart: interval.startDay < range.startDay, clippedEnd: interval.endDay > range.endDay };
}

export function filterTimelineTasks(tasks, state) {
  return activeTasks(tasks).filter(task => (state.owner === 'all' || String(task.ownerId || '') === state.owner) && (state.status === 'all' || stage(task.status) === stage(state.status)));
}

function isOverdue(task, todayDay) {
  const due = parseDay(task.dueDate);
  return due !== null && due < todayDay && !['done', 'terminated'].includes(stage(task.status));
}

function statusLabel(task) { return STATUS[stage(task.status)] || '未设置'; }
function statusClass(task) { return Object.hasOwn(STATUS, stage(task.status)) ? stage(task.status) : 'wait'; }
function displayedDate(value) { return parseDay(value) === null ? '未设置' : value; }
function selected(value, current) { return value === current ? ' selected' : ''; }
const number = value => Number(value.toFixed(6));

const glyph = path => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

// Shared chart chrome: the project schedule and the cross-project portfolio use the same
// zoom controls, axis, gridlines and scroll container, so drag / wheel zoom / "today"
// handlers in app.js work on both.
export function timelineZoomControls(state, zoom, scale, px) {
  const zoomControls = `<div class="schedule-zoom" role="group" aria-label="时间缩放"><button type="button" class="schedule-fit${zoom.isFit ? ' is-active' : ''}" data-timeline-fit aria-pressed="${zoom.isFit}" title="一屏查看全部排期">${glyph('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}全局</button><span class="schedule-zoom-divider" aria-hidden="true"></span><button type="button" data-timeline-zoom="out" aria-label="缩小" title="缩小（⌘/Ctrl + 滚轮）"${zoom.isFit ? ' disabled' : ''}>${glyph('<path d="M5 12h14"/>')}</button><span class="schedule-zoom-level" aria-live="polite">${scale.label}</span><button type="button" data-timeline-zoom="in" aria-label="放大" title="放大（⌘/Ctrl + 滚轮）"${px >= zoom.max * .9999 ? ' disabled' : ''}>${glyph('<path d="M12 5v14M5 12h14"/>')}</button></div>`;
  const presets = `<div class="schedule-modes" role="group" aria-label="快速缩放">${[['week', '周'], ['month', '月'], ['quarter', '季度'], ['custom', '自定义']].map(([mode, label]) => { const active = !zoom.isFit && !Number.isFinite(state.zoom) && state.mode === mode; return `<button type="button" data-timeline-mode="${mode}" aria-pressed="${active}" class="${active ? 'is-active' : ''}">${label}</button>`; }).join('')}</div>`;
  return zoomControls + presets;
}
export function timelineDateForm(state) {
  return state.mode === 'custom' ? `<div class="schedule-custom"><label>开始日期<input type="date" data-timeline-date="start" aria-label="排期开始日期" value="${escape(state.start)}"></label><span aria-hidden="true">—</span><label>结束日期<input type="date" data-timeline-date="end" aria-label="排期结束日期" value="${escape(state.end)}"></label><small>按这段日期缩放；仍可拖动查看其他时间。</small></div>` : '';
}
export function timelineNavigation(state, extent, zoom, todayInside) {
  const dateJump = `<label class="schedule-jump"><span>定位日期</span><input type="date" data-timeline-date="anchor" aria-label="定位到指定日期" min="${extent.start}" max="${extent.end}" value="${escape(state.anchor)}"></label>`;
  return `<div class="schedule-navigation">${dateJump}<button type="button" data-action="timeline-prev" aria-label="向前查看"${zoom.isFit ? ' disabled' : ''}>‹</button><button type="button" data-action="timeline-today"${todayInside ? '' : ' disabled title="今天不在排期范围内"'}>今天</button><button type="button" data-action="timeline-next" aria-label="向后查看"${zoom.isFit ? ' disabled' : ''}>›</button></div>`;
}
export function timelineAxis(scale, todayDay, px, nameLabel) {
  return `<div class="schedule-row schedule-header"><div class="schedule-name">${nameLabel}</div><div class="schedule-axis"><div class="schedule-axis-upper">${scale.upper.map(cell => `<div class="schedule-band" style="left:${number(cell.left)}px;width:${number(cell.width)}px" title="${cell.start} — ${cell.end}"><span>${escape(cell.label)}</span></div>`).join('')}</div><div class="schedule-axis-lower${scale.unit === 'day' && px < 34 ? ' is-dense' : ''}">${scale.lower.map(tick => `<div class="schedule-tick${todayDay >= tick.startDay && todayDay <= tick.endDay ? ' is-today' : ''}${tick.weekend ? ' is-weekend' : ''}" style="left:${number(tick.left)}px;width:${number(tick.width)}px" title="${tick.start} — ${tick.end}"><strong>${escape(tick.label)}</strong>${tick.detail ? `<span>${escape(tick.detail)}</span>` : ''}</div>`).join('')}</div></div></div>`;
}
export function timelineGridlines(scale, todayInside, todayX) {
  return `<div class="schedule-gridlines" aria-hidden="true">${scale.lower.filter(tick => tick.weekend).map(tick => `<b style="left:${number(tick.left)}px;width:${number(tick.width)}px"></b>`).join('')}${scale.lower.map(tick => `<i${tick.boundary ? ' class="is-boundary"' : ''} style="left:${number(tick.left)}px"></i>`).join('')}${todayInside ? `<i class="schedule-today-line" style="left:${todayX}px"></i>` : ''}</div>`;
}
export function timelineChartAttrs(extent, zoom, px, todayInside, todayDay) {
  return `data-extent-start="${extent.startDay}" data-extent-days="${extent.days}" data-px="${number(px)}" data-fit-px="${number(zoom.fit)}" data-max-px="${number(zoom.max)}" data-fit="${zoom.isFit ? 1 : 0}" data-today="${todayInside ? todayDay : ''}"`;
}
export { labelWidth as timelineLabelWidth };

export function renderTimeline({ state, project = {}, tasks = [], users = [], today, query = '', viewportWidth = 900 }) {
  const extent = resolveTimelineExtent({ project, tasks, today });
  const zoom = resolveTimelineZoom(state, extent, viewportWidth, { today, project, tasks });
  const px = zoom.px, scale = buildTimelineScale(extent, px), todayDay = parseDay(today);
  const x = day => number((day - extent.startDay) * px);
  const names = new Map(users.map(user => [user.id, user.name]));
  const ownerName = id => names.get(id) || (id ? '未知成员' : '未分配');
  const search = String(query).trim().toLocaleLowerCase('zh-CN');
  const list = filterTimelineTasks(tasks, state).filter(task => !search || [task.title, task.id, task.description, ownerName(task.ownerId)].some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(search))).sort((a, b) => (parseDay(a.startDate) ?? Infinity) - (parseDay(b.startDate) ?? Infinity) || String(a.title).localeCompare(String(b.title), 'zh-CN'));
  const scheduled = list.filter(taskInterval);
  const missing = list.length - scheduled.length, late = list.filter(task => isOverdue(task, todayDay)).length;
  const milestones = (project.milestones || []).filter(item => parseDay(item.date) !== null).sort((a, b) => a.date.localeCompare(b.date));
  const ownerIds = [...new Set(activeTasks(tasks).map(task => task.ownerId).filter(Boolean))];
  const owners = ownerIds.map(id => ({ id: String(id), name: ownerName(id) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const todayInside = todayDay !== null && todayDay >= extent.startDay && todayDay <= extent.endDay;
  const currentFilters = state.owner !== 'all' || state.status !== 'all' || Boolean(search);
  const taskState = task => badge(statusClass(task), statusLabel(task));
  const custom = state.mode === 'custom' ? resolveTimelineRange(state, { today, project, tasks }) : null;
  const dateForm = timelineDateForm(state);
  const metrics = [['已排期', scheduled.length, `筛选后共 ${list.length} 个任务`, 'normal'], ['逾期未完成', late, '按全部筛选结果统计', late ? 'danger' : 'normal'], ['待完善日期', missing, '缺少日期或日期顺序有误', missing ? 'amber' : 'normal'], ['里程碑', milestones.length, extent.empty ? '项目尚无排期日期' : `排期跨度 ${extent.dataDays} 天`, 'normal']];
  const zoomControls = timelineZoomControls(state, zoom, scale, px), presets = '';
  const header = timelineAxis(scale, todayDay, px, '任务 / 负责人');
  const gridlines = timelineGridlines(scale, todayInside, x(todayDay + .5));
  const milestoneRow = milestones.length ? `<div class="schedule-row schedule-milestone-row"><div class="schedule-name"><strong>项目里程碑</strong><small>${milestones.length} 个节点</small></div><div class="schedule-track">${milestones.map((item, index) => { const name = item.name || item.label || '未命名里程碑', left = (parseDay(item.date) + .5 - extent.startDay) * px, next = milestones[index + 1], room = next ? (parseDay(next.date) + .5 - extent.startDay) * px - left : zoom.trackWidth - left; return `<span class="schedule-milestone" style="left:${number(left)}px" title="${escape(name)} · ${item.date}" role="img" aria-label="${escape(name)}，${item.date}">◆${room >= labelWidth(name) + 18 ? `<em>${escape(name)}</em>` : !next && left >= labelWidth(name) + 6 && (index === 0 || left - (parseDay(milestones[index - 1].date) + .5 - extent.startDay) * px >= labelWidth(name) * 2 + 12) ? `<em class="is-before">${escape(name)}</em>` : ''}</span>`; }).join('')}</div></div>` : '';
  const rows = scheduled.map(task => {
    const interval = taskInterval(task), overdue = isOverdue(task, todayDay);
    const left = (interval.startDay - extent.startDay) * px, width = Math.max(6, (interval.endDay - interval.startDay + 1) * px), need = labelWidth(task.title);
    const inside = width >= need, after = left + width + 8 + need <= zoom.trackWidth;
    const outside = inside ? '' : `<span class="schedule-bar-label${after ? '' : ' is-before'}" style="left:${number(after ? left + width + 8 : Math.max(0, left - 8 - need))}px" aria-hidden="true">${escape(task.title)}</span>`;
    return `<div class="schedule-row"><div class="schedule-name"><button class="schedule-task-name" data-task="${escape(task.id)}">${escape(task.title)}</button><small>${escape(ownerName(task.ownerId))}<span>·</span>${escape(statusLabel(task))}${overdue ? '<span class="schedule-late-label">已逾期</span>' : ''}</small></div><div class="schedule-track"><button data-task="${escape(task.id)}" class="schedule-bar schedule-bar-${statusClass(task)}${overdue ? ' is-overdue' : ''}${inside ? '' : ' is-compact'}" style="left:${number(left)}px;width:${number(width)}px" title="${escape(task.title)} · ${task.startDate} — ${task.dueDate}" aria-label="${escape(task.title)}，${escape(statusLabel(task))}，${task.startDate} 至 ${task.dueDate}${overdue ? '，已逾期' : ''}">${inside ? `<span>${escape(task.title)}</span>` : ''}</button>${outside}</div></div>`;
  }).join('');
  const empty = !scheduled.length ? `<div class="schedule-chart-empty"><strong>${currentFilters ? '没有符合筛选条件的已排期任务' : '暂无已排期任务'}</strong><span>为任务填写开始和截止日期后，会显示在时间线上；待完善日期的任务保留在下方列表。</span></div>` : '';
  const chartAttrs = timelineChartAttrs(extent, zoom, px, todayInside, todayDay);
  const chart = `<div class="schedule-scroll${zoom.isFit ? ' is-fit' : ''}" role="region" aria-label="交付排期图。按住拖动查看，⌘ 或 Ctrl 加滚轮缩放" tabindex="0"><div class="schedule-chart" ${chartAttrs} style="--track:${number(zoom.trackWidth)}px">${gridlines}${header}${milestoneRow}${rows}${empty}</div></div>`;
  const spanText = extent.empty ? '项目还没有排期日期，暂显示当前月份。' : `排期跨度 ${extent.dataStart} — ${extent.dataEnd}，共 ${extent.dataDays} 天。${zoom.isFit ? '当前为全局视图，放大后可拖动查看。' : '按住图表拖动查看，⌘/Ctrl + 滚轮缩放。'}`;
  return `<div class="schedule-workspace"><section class="panel schedule-panel"><div class="schedule-controls">${zoomControls}${presets}<div class="schedule-filters"><label><span>负责人</span><select data-timeline-filter="owner" aria-label="按排期负责人筛选"><option value="all"${selected('all', state.owner)}>全部负责人</option><option value=""${selected('', state.owner)}>未分配</option>${owners.map(owner => `<option value="${escape(owner.id)}"${selected(owner.id, state.owner)}>${escape(owner.name)}</option>`).join('')}</select></label><label><span>状态</span><select data-timeline-filter="status" aria-label="按排期状态筛选"><option value="all"${selected('all', state.status)}>全部状态</option>${Object.entries(STATUS).map(([value, label]) => `<option value="${value}"${selected(value, stage(state.status))}>${label}</option>`).join('')}</select></label>${currentFilters ? '<button type="button" class="schedule-reset" data-action="timeline-reset">清除筛选</button>' : ''}</div></div>${dateForm}<div class="schedule-range"><div class="schedule-range-copy"><h2 data-timeline-visible>${extent.start} <span>—</span> ${extent.end}</h2><p>${spanText}</p></div>${timelineNavigation(state, extent, zoom, todayInside)}</div>${custom?.error ? `<p class="schedule-error" role="alert">${escape(custom.error)}</p>` : ''}</section><div class="schedule-metrics">${metrics.map(([label, value, detail, tone]) => `<section class="schedule-metric schedule-metric-${tone}"><span>${label}</span><strong>${value}<small>${label === '已排期' ? '个任务' : '项'}</small></strong><p>${detail}</p></section>`).join('')}</div><section class="panel schedule-panel"><div class="schedule-chart-heading"><h2>交付时间线</h2><span>${scale.label}显示${zoom.isFit ? ' · 全局' : ''}</span><div class="schedule-legend"><span><i class="schedule-legend-active"></i>进行中</span><span><i class="schedule-legend-done"></i>已完成</span><span><i class="schedule-legend-late"></i>已逾期</span>${todayInside ? '<span><i class="schedule-legend-today"></i>今天</span>' : ''}</div></div>${chart}</section><section class="panel schedule-panel"><div class="schedule-list-heading"><div><h2>完整排期列表</h2><p>包含全部已排期及待完善日期的任务。</p></div><span>${list.length} 个任务 · ${scheduled.length} 已排期 · ${missing} 待完善</span></div>${list.length ? `<div class="schedule-table-wrap"><table class="schedule-table"><thead><tr><th>任务名称</th><th>负责人</th><th>状态</th><th>开始日期</th><th>截止日期</th></tr></thead><tbody>${list.map(task => `<tr><td><button class="schedule-task-name" data-task="${escape(task.id)}">${escape(task.title)}</button>${!taskInterval(task) ? '<small class="schedule-date-hint">日期待完善</small>' : ''}</td><td>${escape(ownerName(task.ownerId))}</td><td>${taskState(task)}</td><td>${displayedDate(task.startDate)}</td><td${isOverdue(task, todayDay) ? ' class="schedule-late-date"' : ''}>${displayedDate(task.dueDate)}${isOverdue(task, todayDay) ? '<small>已逾期</small>' : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="schedule-empty"><strong>${currentFilters ? '没有符合筛选条件的任务' : '项目还没有任务'}</strong><p>${currentFilters ? '调整负责人或状态后再次查看。' : '创建任务并填写日期后，交付安排会显示在这里。'}</p></div>`}</section></div>`;
}
