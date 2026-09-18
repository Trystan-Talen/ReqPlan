// ============================================================================
// 星河研发台 · UI Kit
// ----------------------------------------------------------------------------
// 所有页面共用的界面片段生成函数。新页面、新模块必须优先使用这里的函数，
// 不要在视图里手写按钮、状态标签、头像、页头、空状态等结构。
// 规则说明见 DESIGN.md，样例见 /design-system.html。
//
// 约定：
// - 纯函数，返回 HTML 字符串；不访问 DOM、不读取业务数据（人员名称等由调用方传入）。
// - 所有文本参数都会经过 esc() 转义；参数名带 Html 后缀的表示「已是安全 HTML」。
// - 颜色只能通过 CSS 类或令牌表达，这里不出现任何颜色值。
// - 本文件没有任何 import，可在浏览器与 Node 测试中直接加载。
// ============================================================================

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const attrs = (map = {}) => Object.entries(map).filter(([, value]) => value !== undefined && value !== null && value !== false).map(([key, value]) => value === true ? ` ${key}` : ` ${key}="${esc(value)}"`).join('');

// ---------------------------------------------------------------------------
// Icons — 24px 线性图标，stroke 1.7，颜色继承 currentColor。新增图标保持同一风格。
// ---------------------------------------------------------------------------
export const icons = Object.freeze({
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.4 5.6A2 2 0 0 1 7.2 4.5h9.6a2 2 0 0 1 1.8 1.1L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16M15 4v16"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14.5a5.5 5.5 0 0 1 3 5.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  document: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7.5V12l3 2"/>',
  alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17h.01"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  chevrons: '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  minus: '<path d="M5 12h14"/>'
});
export const icon = (name, extra = '') => `<svg class="icon${extra ? ' ' + extra : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.folder}</svg>`;

// Brand mark: gradient stops and dots take their colors from CSS (.brand-stop-*, currentColor).
export const BRAND_MARK = '<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="brand-stop-from"/><stop offset="1" class="brand-stop-to"/></linearGradient></defs><path d="M7 21.5c4.2-1.2 8.6-5 11.2-10.6" stroke="url(#brand-gradient)" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle cx="7.4" cy="21.4" r="2.2" fill="currentColor"/><circle cx="18.6" cy="10.6" r="2.6" fill="url(#brand-gradient)"/><circle cx="24.6" cy="18.8" r="1.6" fill="currentColor" opacity=".75"/><path d="M18.6 10.6 24.6 18.8" stroke="currentColor" stroke-opacity=".35" stroke-width="1.2"/></svg>';

// ---------------------------------------------------------------------------
// Status tones — 业务状态 → 视觉色调的唯一映射表。
// 新增业务状态时必须在这里登记，design-system.test.mjs 会检查 workflow.js 的全部状态。
// tone 对应 CSS 类 .status-<tone>：plan 灰 / review 紫 / progress 蓝 / test 琥珀 /
// done 绿 / terminated 灰 / pending 橙 / danger 红
// ---------------------------------------------------------------------------
export const TONES = Object.freeze(['plan', 'review', 'progress', 'test', 'done', 'terminated', 'pending', 'danger']);
export const STATUS_TONES = Object.freeze({
  // task stages (english keys + legacy chinese labels)
  wait: 'plan', develop: 'progress', test: 'test', done: 'done', terminated: 'terminated',
  // requirement workflow
  '未确定': 'review', '待评审': 'review', '已确定': 'plan', '待排期': 'plan', '已排期': 'plan',
  '待开始': 'plan', '开发中': 'progress', '测试中': 'test', '已完成': 'done', '已终止': 'terminated',
  // project status
  '规划中': 'plan', '进行中': 'progress',
  // account status
  active: 'done', disabled: 'terminated', pending: 'pending', invited: 'pending'
});
const STATUS_LABELS = Object.freeze({ wait: '待开始', develop: '开发中', test: '测试中', done: '已完成', terminated: '已终止', active: '已启用', disabled: '已禁用', pending: '待激活', invited: '待激活' });
export const toneOf = value => STATUS_TONES[value] || 'plan';

/** 状态标签：badge('develop') → 蓝色「开发中」。label 可覆盖显示文字。 */
export function badge(value, label) {
  const tone = toneOf(value);
  return `<span class="badge status-${tone}">${esc(label ?? STATUS_LABELS[value] ?? value ?? '未设置')}</span>`;
}
/** 语义色标签（非业务状态）：toneBadge('danger', '已逾期')；plain=true 时不显示圆点。 */
export function toneBadge(tone, label, { plain = false } = {}) {
  return `<span class="badge${plain ? ' plain' : ''}${TONES.includes(tone) ? ` status-${tone}` : ''}">${esc(label)}</span>`;
}
/** 账号状态标签。 */
export const accountStatus = status => badge(status || 'pending', STATUS_LABELS[status] || status || '待激活');
/** 优先级标签：P0 红底白字 / P1 橙 / P2 灰。full=true 时附带中文说明。 */
export function priority(value, full = false) {
  const level = ['P0', 'P1', 'P2'].includes(value) ? value : 'P2';
  const label = { P0: '最高', P1: '高', P2: '普通' }[level];
  return `<span class="badge priority-${level.toLowerCase()}" title="${level} · ${label}">${level}${full ? `<span class="priority-text">· ${label}</span>` : ''}</span>`;
}
/** 计数胶囊：countLabel(12, '项') → 「12 项」 */
export const countLabel = (count, unit = '') => `<span class="count-label">${esc(count)}${unit ? ' ' + esc(unit) : ''}</span>`;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
/** 由编号散列出头像色相（0–359），同一个人在任何页面颜色一致。 */
export function hue(seed) { let value = 0; for (const char of String(seed || '')) value = (value * 31 + char.codePointAt(0)) % 360; return value; }
export function initial(name) { return esc(Array.from(String(name || '').trim())[0] || '?'); }
/** 头像：size 取 ''（32px）/ 'xs'（22px）/ 'lg'（44px）。seed 为空表示未分配。 */
export function avatarMark(seed, name, size = '') {
  return `<span class="avatar${size ? ' ' + size : ''}" style="--hue:${hue(seed)}" aria-hidden="true">${seed ? initial(name) : '?'}</span>`;
}
/** 人员胶囊：头像 + 姓名。 */
export function personChip(seed, name, size = 'xs') {
  return `<span class="person${seed ? '' : ' unassigned'}">${avatarMark(seed, name, size)}<span>${esc(name)}</span></span>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
/**
 * 按钮。variant: primary | secondary | accent | text | danger-text | icon
 * 用 action/data 绑定行为（全局事件委托读取 data-*），不要写 onclick。
 */
export function button({ label = '', variant = 'secondary', size = '', iconName = '', action = '', data = {}, type = 'button', disabled = false, ariaLabel = '', title = '' } = {}) {
  const cls = variant === 'text' ? 'text-button' : variant === 'danger-text' ? 'text-button danger' : variant === 'icon' ? 'icon-button' : `btn btn-${variant}${size === 'small' ? ' btn-small' : ''}`;
  const dataAttrs = Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key.replace(/[A-Z]/g, char => '-' + char.toLowerCase())}`, value]));
  return `<button${attrs({ type, class: cls, 'data-action': action || undefined, ...dataAttrs, disabled, 'aria-label': ariaLabel || undefined, title: title || undefined })}>${iconName ? icon(iconName) : ''}${variant === 'icon' ? '' : `${iconName && label ? ' ' : ''}${esc(label)}`}</button>`;
}
/** 互斥视图切换：segmented([{value:'board',label:'看板',icon:'board'}], 'board', 'layout') */
export function segmented(items, current, dataKey, ariaLabel = '显示方式') {
  return `<div class="segmented" role="group" aria-label="${esc(ariaLabel)}">${items.map(item => `<button type="button" data-${esc(dataKey)}="${esc(item.value)}" aria-pressed="${item.value === current}" class="${item.value === current ? 'active' : ''}">${item.icon ? icon(item.icon) : ''}${esc(item.label)}</button>`).join('')}</div>`;
}
/** 开关（沿用 .archive-toggle 类名）：switchToggle('archive-filter', '查看归档', false) */
export const switchToggle = (id, label, checked) => `<label class="archive-toggle"><input id="${esc(id)}" type="checkbox"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;

// ---------------------------------------------------------------------------
// Page structure
// ---------------------------------------------------------------------------
/** 页头：每个页面第一个元素。actionsHtml 通常是 button() 的结果，主操作放最后。 */
export function heading(title, description, actionsHtml = '', scope = '') {
  return `<section class="page-heading"><div>${scope ? `<span class="scope-pill">${esc(scope)}</span>` : ''}<h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div>${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}</section>`;
}
/** 分区标题（页面内的二级标题）。 */
export function sectionHeading(title, { count, actionsHtml = '' } = {}) {
  return `<div class="section-heading"><div class="section-heading-copy"><h2>${esc(title)}</h2>${count !== undefined ? countLabel(count) : ''}</div>${actionsHtml}</div>`;
}
/** 指标卡；放进 metricStrip()。tone: purple | blue | green | amber；alert=true 数字变红。 */
export function metric(label, value, note, glyph, tone = '', alert = false) {
  return `<article class="metric-card ${esc(tone)}${alert ? ' is-alert' : ''}"><div class="metric-top"><span>${esc(label)}</span><span class="metric-icon">${icon(glyph)}</span></div><div class="metric-value">${esc(value)}</div><div class="metric-note">${esc(note)}</div></article>`;
}
/** 指标条：一行最多 4 个 metric()。 */
export const metricStrip = cardsHtml => `<div class="metrics-grid">${cardsHtml.join('')}</div>`;
/**
 * 面板：panel({ title, count, actionsHtml, introHtml, bodyHtml, noteHtml, padded })
 * bodyHtml 为表格或列表时 padded=false；纯文字内容 padded=true。
 */
export function panel({ title = '', count, actionsHtml = '', introHtml = '', bodyHtml = '', noteHtml = '', padded = false, className = '' } = {}) {
  const head = title ? `<div class="panel-heading"><h2>${esc(title)}${count !== undefined ? ' ' + countLabel(count) : ''}</h2>${actionsHtml}</div>` : '';
  return `<section class="panel${className ? ' ' + esc(className) : ''}">${head}${introHtml ? `<div class="panel-intro">${introHtml}</div>` : ''}${padded ? `<div class="panel-pad">${bodyHtml}</div>` : bodyHtml}${noteHtml ? `<div class="panel-note">${noteHtml}</div>` : ''}</section>`;
}
/** 空状态：说明「为什么是空的」+「下一步做什么」。action 为 data-action 名称。 */
export function empty(title, description, action = '', actionText = '') {
  return `<div class="empty-state"><div class="empty-icon">${icon('inbox')}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action ? `<button class="btn btn-secondary" data-action="${esc(action)}">${esc(actionText)}</button>` : ''}</div>`;
}
/** 加载占位。 */
export const loading = (text = '正在读取最新内容…') => `<div class="work-loading" role="status">${esc(text)}</div>`;
/** 提示条：tone info | danger。 */
export const notice = (text, tone = 'info') => `<div class="notice notice-${tone === 'danger' ? 'danger' : 'info'}"${tone === 'danger' ? ' role="alert"' : ''}><span>${esc(text)}</span></div>`;
/** 键值网格：detailList([['负责人', personHtml, true], ['点数', 5]])，第三项 true 表示值是安全 HTML。 */
export const detailList = rows => `<dl class="detail-kv">${rows.map(([label, value, isHtml]) => `<div><dt>${esc(label)}</dt><dd>${isHtml ? value : esc(value)}</dd></div>`).join('')}</dl>`;
/** 进度条：progress(42, '任务完成率') */
export const progress = (percent, ariaLabel) => `<div class="progress-track" role="progressbar" aria-label="${esc(ariaLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(percent) || 0))}%"></div></div>`;

// ---------------------------------------------------------------------------
// Forms — 表单放在抽屉中：<div class="form-grid">field(...)...</div>
// 控件 id 统一为 field-<name>，便于 label 关联与测试定位。
// ---------------------------------------------------------------------------
export function field(labelHtml, name, controlHtml, full = false, hint = '') {
  return `<div class="form-field${full ? ' full-width' : ''}"><label for="field-${esc(name)}">${labelHtml}</label>${controlHtml}${hint ? `<p class="field-help">${esc(hint)}</p>` : ''}</div>`;
}
export const input = (name, value = '', attrsHtml = '') => `<input id="field-${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrsHtml}>`;
export const select = (name, optionsHtml, attrsHtml = '') => `<select id="field-${esc(name)}" name="${esc(name)}" ${attrsHtml}>${optionsHtml}</select>`;
export const area = (name, value = '', attrsHtml = '') => `<textarea id="field-${esc(name)}" name="${esc(name)}" ${attrsHtml}>${esc(value)}</textarea>`;
export function options(values, current, labels = {}) {
  return values.map(value => `<option value="${esc(value)}"${String(current) === String(value) ? ' selected' : ''}>${esc(labels[value] || value)}</option>`).join('');
}
/** 必填标记，用在 field() 的 labelHtml 里：field('标题' + REQUIRED, ...) */
export const REQUIRED = ' <span class="required">*</span>';
