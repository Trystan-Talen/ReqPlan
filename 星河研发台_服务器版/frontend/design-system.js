// Living style guide: every sample is rendered by the real ui-kit functions and design CSS.
// When you add a component or token, add a sample here in the same change.
import { esc, icon, BRAND_MARK, STATUS_TONES, TONES, badge, toneBadge, priority, accountStatus, countLabel, avatarMark, personChip, button, segmented, switchToggle, heading, sectionHeading, metric, metricStrip, panel, empty, loading, notice, detailList, progress, field, input, select, area, options, REQUIRED } from './ui-kit.js';

const code = text => `<pre class="sg-code">${esc(text)}</pre>`;
const block = (title, demoHtml, snippet = '', variant = '') => `<div class="sg-block"><h3>${esc(title)}</h3><div class="sg-demo${variant ? ' ' + variant : ''}">${demoHtml}</div>${snippet ? code(snippet) : ''}</div>`;
const section = (id, title, intro, body) => `<section class="sg-section" id="${id}"><h2>${esc(title)}</h2><p>${esc(intro)}</p>${body}</section>`;
const swatch = name => `<div class="sg-swatch"><i style="--swatch:var(${name})"></i><div><code>${name}</code><small data-token="${name}"></small></div></div>`;
const swatches = names => `<div class="sg-swatches">${names.map(swatch).join('')}</div>`;

const sections = [
  ['rules', '三条硬规则', '所有新增页面与模块都必须满足；违反时 npm test 中的 design-system.test.mjs 会失败。',
    `<div class="sg-rules"><div class="sg-rule"><strong>只用令牌</strong><p>颜色只存在于 design/tokens.css。组件、页面样式和脚本里不写任何颜色值，内联样式只允许几何量和 CSS 自定义属性。</p></div><div class="sg-rule"><strong>先用组件</strong><p>按钮、状态、头像、页头、面板、空状态、表单字段一律调用 ui-kit.js。现有组件不够用时，先扩展组件，再写页面。</p></div><div class="sg-rule"><strong>按模式搭页面</strong><p>页头 → 指标条（可选）→ 面板。详情和编辑用右侧抽屉，确认用居中弹窗，预览用宽弹窗。</p></div></div>`],
  ['color', '色彩令牌', '主题色随浅色/深色切换；夜色区域与数据色与主题无关。右上角可切换主题检查两种效果。',
    block('界面表面与文字', swatches(['--bg', '--surface', '--surface-2', '--surface-3', '--border', '--border-strong', '--text', '--text-2', '--text-3', '--ink', '--accent', '--accent-soft']), '', 'is-plain')
    + block('语义色调（状态标签的唯一来源）', swatches(['--c-slate', '--c-violet', '--c-blue', '--c-amber', '--c-green', '--c-gray', '--c-red', '--c-orange']), '', 'is-plain')
    + block('夜色区域（侧栏 / 首页横幅 / 登录页）', swatches(['--night-bg', '--night-surface', '--on-night', '--on-night-2', '--brand-from', '--brand-to', '--glow-violet', '--glow-cyan']), '', 'is-plain')
    + block('数据可视化与项目色', swatches(['--bar-wait', '--bar-develop', '--bar-test', '--bar-done', '--bar-overdue', '--project-1', '--project-2', '--project-3', '--project-4', '--project-5', '--project-6']), '', 'is-plain')],
  ['type', '排版与间距', '中文界面以 14px 为正文基准；数字使用等宽数字（tabular-nums）便于对齐；间距遵循 4px 网格。',
    block('字号刻度', `<div class="sg-type">${[['--text-display', '42', 680], ['--text-3xl', '页面标题 h1', 700], ['--text-2xl', '抽屉实体标题', 700], ['--text-xl', '分区标题', 650], ['--text-lg', '面板标题', 650], ['--text-md', '正文 body', 500], ['--text-base', '控件与列表标题', 560], ['--text-sm', '次要正文 / 标签', 500], ['--text-xs', '表头 / 元信息', 600], ['--text-2xs', '刻度副标', 500]].map(([token, sample, weight]) => `<div class="sg-type-row"><code>${token}</code><span style="--size:var(${token});--weight:${weight}">${esc(sample)}</span></div>`).join('')}</div>`, '', 'is-stack')
    + block('间距刻度', `<div class="sg-scale">${[1, 2, 3, 4, 5, 6, 7, 8].map(step => `<span><i style="width:var(--space-${step});height:var(--space-${step})"></i>--space-${step}</span>`).join('')}</div>`)],
  ['buttons', '按钮', '每个区域最多一个主按钮（墨色），放在操作组最右侧；破坏性操作用红色文字按钮并二次确认。',
    block('变体', button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' }) + button({ label: '批量调整排期' }) + button({ label: '强调操作', variant: 'accent' }) + button({ label: '刷新', size: 'small' }) + button({ label: '查看详情', variant: 'text' }) + button({ label: '移出项目', variant: 'danger-text' }) + button({ variant: 'icon', iconName: 'edit', ariaLabel: '编辑' }) + button({ label: '不可用', variant: 'primary', disabled: true }),
      "button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' })\nbutton({ label: '批量调整排期' })                         // secondary\nbutton({ label: '刷新', size: 'small' })\nbutton({ label: '查看详情', variant: 'text', data: { requirement: id } })\nbutton({ label: '移出项目', variant: 'danger-text' })\nbutton({ variant: 'icon', iconName: 'edit', ariaLabel: '编辑' })")
    + block('视图切换与开关', segmented([{ value: 'board', label: '看板', icon: 'board' }, { value: 'list', label: '列表', icon: 'list' }], 'board', 'layout') + switchToggle('sg-archive', '查看归档', true),
      "segmented([{ value: 'board', label: '看板', icon: 'board' }, { value: 'list', label: '列表', icon: 'list' }], ui.taskLayout, 'layout')\nswitchToggle('archive-filter', '查看归档', ui.archived)")],
  ['status', '状态与标签', '业务状态到色调的映射只在 ui-kit.js 的 STATUS_TONES 维护；新增状态必须登记，否则测试失败。',
    block('任务阶段', ['wait', 'develop', 'test', 'done', 'terminated'].map(value => badge(value)).join(''), "badge(task.status)   // 中英文状态均可")
    + block('需求流转', ['未确定', '待评审', '已确定', '待排期', '已排期', '开发中', '测试中', '已完成', '已终止'].map(value => badge(value)).join(''))
    + block('账号 / 项目 / 语义', ['active', 'pending', 'disabled'].map(accountStatus).join('') + badge('进行中') + badge('规划中') + toneBadge('danger', '已逾期') + toneBadge('plain', '已归档', { plain: true }), "accountStatus(person.status)\ntoneBadge('danger', '已逾期')")
    + block('优先级与计数', priority('P0') + priority('P1') + priority('P2') + priority('P0', true) + countLabel(29, '项'), "priority(item.priority)          // 表格里\npriority(item.priority, true)    // 详情里带中文说明\ncountLabel(list.length, '项')")
    + block('全部色调', TONES.map(tone => toneBadge(tone, tone)).join(''), `STATUS_TONES = ${JSON.stringify(STATUS_TONES).slice(0, 160)}…`)],
  ['people', '人员', '头像颜色由人员编号散列，同一个人在所有页面颜色一致；禁止手工指定头像颜色。',
    block('头像与人员胶囊', avatarMark('u-manager', '顾远', 'lg') + avatarMark('u-product', '林小满') + avatarMark('u-dev', '赵一', 'xs') + personChip('u-dev', '赵一') + personChip('u-test', '沈知') + personChip('', '未分配'),
      "// app.js 中的包装：avatar(id, size) / person(id) 会自动取人员姓名\navatarMark(user.id, user.name, 'lg')\npersonChip(task.ownerId, nameOf(task.ownerId))")],
  ['forms', '表单', '表单放在右侧抽屉里：两列网格，标签在上，说明文字在控件下方；长文本与多选占满整行。',
    block('字段', `<div class="form-grid">${field('需求标题' + REQUIRED, 'sg-title', input('sg-title', '服务质量履约口径与指标', 'maxlength="200"'), true)}${field('优先级', 'sg-priority', select('sg-priority', options(['P0', 'P1', 'P2'], 'P1')))}${field('计划截止', 'sg-end', input('sg-end', '2026-09-30', 'type="date"'))}${field('背景与目标', 'sg-desc', area('sg-desc', '', 'rows="3" placeholder="说明为什么要做"'), true, '提交评审前必须填写。')}<fieldset class="form-field full-width collaborator-field"><legend>协作成员</legend><div class="checklist"><label><input type="checkbox" checked><span>林小满</span></label><label><input type="checkbox"><span>赵一</span></label><label><input type="checkbox"><span>沈知</span></label></div></fieldset></div><div class="form-error">两次输入的密码不一致。</div>`,
      "field('需求标题' + REQUIRED, 'title', input('title', item?.title || '', 'required maxlength=\"200\"'), true)\nfield('优先级', 'priority', select('priority', options(['P0','P1','P2'], item?.priority)))\nfield('背景与目标', 'description', area('description', value, 'rows=\"3\"'), true, '提交评审前必须填写。')", 'is-stack')],
  ['feedback', '反馈', '成功 → toast；页面级错误 → #page-alert 里的提示条；表单内错误 → .form-error；空数据 → 空状态并给出下一步。',
    block('提示条', notice('提醒会在打开页面或点击刷新时更新。') + notice('内容已被其他成员更新，请重新载入。', 'danger'), "notice('说明文字')\nnotice('错误说明', 'danger')", 'is-stack')
    + block('Toast', `<div class="toast">${icon('check')}<span>修改已保存。</span></div><div class="toast error">${icon('alert')}<span>无法连接服务器，请检查网络后重试。</span></div>`, "toast('修改已保存。')          // app.js\ntoast('失败原因', true)", 'is-stack')
    + block('空状态与加载', `<div class="panel">${empty('没有符合条件的需求', '尝试清除搜索或调整状态筛选。', 'new-requirement', '新建需求')}</div><div class="panel">${loading()}</div>`, "empty('没有符合条件的需求', '尝试清除搜索或调整状态筛选。', 'new-requirement', '新建需求')\nloading()", 'is-stack')],
  ['containers', '容器与数据', '内容一律放进面板；关键数字用指标条；键值信息用 detailList；列表用 data-table。',
    block('指标条', metricStrip([metric('需求总数', 29, '2 项待确认', 'inbox', 'purple'), metric('进行中任务', 2, '开发中 + 测试中', 'board', 'blue'), metric('任务完成', 7, '共 41 个任务', 'check', 'green'), metric('逾期任务', 3, '截止日期早于今天', 'clock', 'amber', true)]),
      "metricStrip([\n  metric('需求总数', reqs.length, '2 项待确认', 'inbox', 'purple'),\n  metric('逾期任务', late, '截止日期早于今天', 'clock', 'amber', late > 0)\n])", 'is-plain')
    + block('面板 + 列表', panel({ title: '团队账号', count: 3, actionsHtml: button({ label: '创建账号', variant: 'primary', size: 'small', iconName: 'plus' }), bodyHtml: `<div class="table-wrap"><table class="data-table"><thead><tr><th>姓名 / 账号</th><th>状态</th><th>负责任务</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${[['u-manager', '顾远', 'admin', 'active', 12], ['u-product', '林小满', 'product', 'pending', 5], ['u-dev', '赵一', 'zhao', 'disabled', 0]].map(([id, name, username, status, count]) => `<tr><td><span class="person">${avatarMark(id, name)}<span><strong class="member-title">${esc(name)}</strong><span class="item-meta"><code>${esc(username)}</code></span></span></span></td><td>${accountStatus(status)}</td><td class="num-cell">${count}</td><td class="action-cell">${button({ label: '编辑', variant: 'text' })}</td></tr>`).join('')}</tbody></table></div>`, noteHtml: `${icon('document')}面板备注用于解释统计口径。` }),
      "panel({ title: '团队账号', count: people.length, actionsHtml: button({...}), bodyHtml: tableHtml, noteHtml: '统计口径说明' })", 'is-plain')
    + block('键值与进度', `<div class="sg-grid-2">${detailList([['负责人', personChip('u-product', '林小满'), true], ['需求点数', 5], ['计划开始', '2026-08-24'], ['计划截止', '2026-09-11']])}<div class="panel panel-pad"><div class="project-progress-label"><span>任务完成率</span><strong>17% · 7 / 41</strong></div>${progress(17, '任务完成率')}</div></div>`,
      "detailList([['负责人', person(item.ownerId), true], ['需求点数', item.estimatePoints]])\nprogress(percent, '任务完成率')", 'is-plain')],
  ['patterns', '页面模式', '新页面按下面的结构组合，不要发明新的页面骨架。弹窗通过 openDialog(title, body, footer, variant) 打开。',
    block('页头', heading('需求池', '记录问题、明确验收标准，再将需求拆解为可交付的任务。', button({ label: '新建需求', variant: 'primary', iconName: 'plus' }), '自研 API 聚合平台') + sectionHeading('可访问项目', { count: 3 }),
      "heading('需求池', '一句话说明页面用途', canEdit() ? button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' }) : '', projectOf().name)", 'is-stack')
    + block('区块间距与并排布局', `<div class="stack"><div class="split" style="--aside:260px"><section class="section-block">${sectionHeading('可访问项目', { count: '4 个项目' })}<div class="panel panel-pad"><p class="muted small">主栏：分区标题 + 内容</p></div></section><section class="section-block">${sectionHeading('我的待办', { count: 1 })}<div class="panel panel-pad"><p class="muted small">侧栏：同样以分区标题开头，栏顶自然对齐</p></div></section></div>${panel({ title: '下一个区块', bodyHtml: '<div class="panel-pad"><p class="muted small">与上方的间距来自 .stack 的 gap（--gap-block），面板自身不带外边距。</p></div>' })}</div>`,
      "// #view 已是纵向栈：页头、指标条、面板、网格直接拼接即可\n`<div class=\"split\">`                    // 主栏 + 侧栏，侧栏宽度 style=\"--aside:360px\"\n  + `<section class=\"section-block\">${sectionHeading('可访问项目', { count })}${grid}</section>`\n  + `<section class=\"section-block\">${sectionHeading('我的待办', { count })}<div class=\"panel\">…</div></section>`\n+ `</div>`\n// 禁止 .panel + .panel { margin-top } 这类相邻选择器间距", 'is-plain')
    + block('三种弹窗', `<div class="sg-grid-2"><div><div class="sg-mock-dialog"><div class="dialog-header"><h2>编辑需求</h2><button class="dialog-close" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><div class="form-grid">${field('需求标题', 'sg-d1', input('sg-d1', '控制台用量导出'), true)}</div></div><div class="dialog-footer"><div class="footer-buttons">${button({ label: '取消' })}${button({ label: '保存', variant: 'primary' })}</div></div></div><p class="sg-mock-caption">drawer（默认）：详情、新建、编辑、批量操作</p></div><div><div class="sg-mock-dialog"><div class="dialog-header"><h2>移出项目成员</h2><button class="dialog-close" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><p>将「林小满」移出当前项目。此操作不会删除团队账号。</p></div><div class="dialog-footer">${button({ label: '取消' })}${button({ label: '确认', variant: 'primary' })}</div></div><p class="sg-mock-caption">center：确认、账号信息、一次性链接；wide：文档预览、版本对照</p></div></div>`,
      "openDialog('编辑需求', formHtml)                              // 右侧抽屉\nopenDialog('移出项目成员', bodyHtml, footerHtml, 'center')     // 居中确认\nopenDialog(file.name, previewHtml, footerHtml, 'wide')        // 宽预览", 'is-plain')
    + block('夜色横幅（仅团队工作台）', `<section class="hero"><div><span class="scope-pill">团队工作台 · 9月17日 星期四</span><h1>下午好，顾远</h1><p>你有 <strong>3</strong> 项待办。这里汇总你可访问项目的进展与待办。</p></div><div class="page-actions">${button({ label: '新建项目', variant: 'primary', iconName: 'plus' })}</div></section>`, '', 'is-plain')]
];

function render() {
  document.getElementById('styleguide').innerHTML = `<div class="sg-shell"><nav class="sg-nav" aria-label="设计系统目录"><a class="brand" href="/"><span class="brand-mark">${BRAND_MARK}</span><span><strong>星河设计系统</strong><small>夜航 · Design System</small></span></a>${sections.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav><main class="sg-main">${`<div class="sg-topline"><span class="scope-pill">DESIGN.md · design/ · ui-kit.js</span>${button({ variant: 'icon', iconName: 'moon', action: 'theme', ariaLabel: '切换浅色或深色主题' })}</div>`}${heading('星河设计系统', '本页的每个样例都由 ui-kit.js 与 design/ 下的真实样式渲染。修改组件或令牌后打开本页，确认浅色与深色两种主题下都正确。')}${sections.map(([id, title, intro, body]) => section(id, title, intro, body)).join('')}</main></div>`;
  const styles = getComputedStyle(document.documentElement);
  for (const node of document.querySelectorAll('[data-token]')) node.textContent = styles.getPropertyValue(node.dataset.token).trim();
}

document.addEventListener('click', event => {
  if (!event.target.closest('[data-action="theme"]')) return;
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('xinghe:theme', root.dataset.theme); } catch (_) {}
  render();
});
render();
