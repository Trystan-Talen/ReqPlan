// Living style guide: every sample is rendered by the real ui-kit functions and design CSS.
// When you add a component or token, add a sample here in the same change.
import { esc, icon, BRAND_MARK, STATUS_TONES, TONES, badge, toneBadge, priority, accountStatus, countLabel, avatarMark, personChip, button, segmented, switchToggle, heading, sectionHeading, workbenchWelcome, metric, metricStrip, panel, empty, loading, notice, detailList, progress, field, input, select, area, options, REQUIRED } from './ui-kit.js';

import { renderRequirementTaskGroups } from './task-groups.js';
import { requirementContentFields, renderDeliveryWorkflow, renderProposalList, renderProposalDetails } from './requirements-ui.js';
import { renderDocumentsPage, renderDocumentReader, renderDocumentVersions } from './documents-ui.js';
import { renderDocumentPreview } from './document-preview.js';
import { parseSections } from './doc-sections.js';
import { renderBaseline } from './review-ui.js';
import { createTimelineState, renderTimeline } from './timeline.js';
import { renderProjectTable } from './project-directory.js';
import { renderWorkbenchContent, syncWorkbenchOrder } from './workbench-ui.js';

const code = text => `<pre class="sg-code">${esc(text)}</pre>`;
const block = (title, demoHtml, snippet = '', variant = '') => `<div class="sg-block"><h3>${esc(title)}</h3><div class="sg-demo${variant ? ' ' + variant : ''}">${demoHtml}</div>${snippet ? code(snippet) : ''}</div>`;
const section = (id, title, intro, body) => `<section class="sg-section" id="${id}"><h2>${esc(title)}</h2><p>${esc(intro)}</p>${body}</section>`;
const swatch = name => `<div class="sg-swatch"><i style="--swatch:var(${name})"></i><div><code>${name}</code><small data-token="${name}"></small></div></div>`;
const swatches = names => `<div class="sg-swatches">${names.map(swatch).join('')}</div>`;
const workbenchSample = {
  date: '2026-10-16', windowEnd: '2026-10-22',
  metrics: { projectCount: 2, requirementCount: 8, targetPast: 1, overdue: 3, dueSoon: 2, actionable: 1 },
  projects: [
    { project: { id: 'sg-resource', name: '资源平台（样例）', status: '进行中', targetDate: '2026-10-09' },
      stageCounts: { 已排期: 3, 已完成: 1 }, completedTasks: 2, totalTasks: 5, waitingTasks: 3, developTasks: 0, testTasks: 0,
      targetPastDays: 7, overdueTasks: [{ id: 'sg-task' }, {}, {}], dueSoonTasks: [], unassignedTasks: [], preparation: [], commitmentOverdue: [], planConflicts: [] },
    { project: { id: 'sg-gateway', name: '协议网关（样例）', status: '进行中' },
      stageCounts: { 已确定: 1, 已排期: 3 }, completedTasks: 0, totalTasks: 5, waitingTasks: 3, developTasks: 2, testTasks: 0,
      nextMilestone: { label: '文本主链路打通', date: '2026-10-16' }, targetPastDays: 0, overdueTasks: [], dueSoonTasks: [{}, {}], unassignedTasks: [{ id: 'sg-unassigned' }], preparation: [], commitmentOverdue: [], planConflicts: [] }
  ],
  todos: [{ entityType: 'task', entityId: 'sg-task', projectId: 'sg-resource', title: '核对资源同步接口', date: '2026-10-15', reasons: ['任务已逾期 1 天', '我的开发中任务'], kind: 'task' }],
  activation: null
};
const busyWorkbenchSample = {
  ...workbenchSample,
  metrics: { ...workbenchSample.metrics, overdue: 6, dueSoon: 6, actionable: 12 },
  projects: workbenchSample.projects.map((item, index) => ({
    ...item,
    project: { ...item.project, name: index ? '协议网关与跨区域容灾恢复联调验证项目（长项目名样例）' : '跨项目资源同步与异常恢复治理平台（长项目名样例）' },
    stageCounts: { 开发中: 4 }, completedTasks: 0, totalTasks: 10, waitingTasks: 6, developTasks: 4,
    overdueTasks: [{}, {}, {}], dueSoonTasks: [{}, {}, {}], unassignedTasks: [],
    nextMilestone: index ? item.nextMilestone : { label: '资源同步与异常恢复联调', date: '2026-10-20' }
  })),
  todos: Array.from({ length: 12 }, (_, index) => ({
    entityType: 'task', entityId: `sg-busy-task-${index}`, projectId: workbenchSample.projects[index % 2].project.id,
    title: `${index + 1}. 核对跨项目资源同步、断线重连、重复事件幂等与异常恢复链路，补充接口边界条件和完整回归验证记录（长标题样例）`,
    date: index < 6 ? '2026-10-15' : '2026-10-20',
    reasons: [index < 6 ? '任务已逾期 1 天' : '任务将在 2026-10-20 截止', '我的待开始任务'], kind: 'task'
  }))
};
const emptyWorkbenchSample = { ...workbenchSample, metrics: { ...workbenchSample.metrics, actionable: 0 }, todos: [] };
const longProjectSampleName = '跨项目资源同步与异常恢复联调工作区ResourceSynchronizationCompatibility（资源同步兼容项目）';
const longRequirementSampleTitle = '核对ResourceSynchronizationCompatibility（资源同步兼容）接口字段映射与资源同步异常重试，整理跨项目联调记录及验收依据';
const requirementPageSample = {
  id: 'sg-phone-requirement', title: longRequirementSampleTitle, projectId: 'sg-phone-project',
  status: '开发中', priority: 'P1', ownerId: 'u-product', assigneeId: 'u-dev', deliveryWorkflow: true,
  description: '为跨项目资源同步补充接口字段兼容、异常重试和回归验证，长标题与正文完整阅读。',
  acceptance: '日期分别保留完整年月日；标题和详情入口可触达，未排期任务仍在完整列表中展示。',
  planStart: '2026-10-29', planEnd: '2026-11-03',
  baseline: { planStart: '2026-10-27', planEnd: '2026-11-01', capturedAt: '2026-10-25T08:00:00Z' }, rescheduleCount: 2
};
const requirementPageTasks = [
  { id: 'sg-phone-scheduled', requirementId: requirementPageSample.id, projectId: requirementPageSample.projectId,
    title: `跨项目接口校验：${'GetResourceSynchronizationProtocolCompatibility'.padEnd(80, 'X')}（资源同步协议兼容）`,
    status: 'develop', ownerId: 'u-dev', estimateHours: 8, startDate: '2026-10-29', dueDate: '2026-11-04' },
  { id: 'sg-phone-unscheduled', requirementId: requirementPageSample.id, projectId: requirementPageSample.projectId,
    title: '补充资源同步异常重试、字段兼容与跨项目联调的回归记录（长标题与未排期样例）',
    status: 'wait', ownerId: 'u-dev', estimateHours: 8, startDate: '', dueDate: '' }
];
const requirementPageUsers = [{ id: 'u-product', name: '林小满' }, { id: 'u-dev', name: '赵一' }];
const documentSampleName = 'ResourceSynchronizationProtocolCompatibility'.padEnd(100, 'X') + '.md';
const documentSampleText = `# 跨项目资源同步说明（样例）\n\n## 资源同步、字段兼容与异常恢复的完整章节${'ResourceSynchronizationCompatibility'.padEnd(80, 'X')}（资源同步兼容） 〔SYNC-1〕\n\n${'ResourceSynchronizationProtocolCompatibility'.padEnd(100, 'X')}（资源同步协议兼容）\n\n检查字段映射、协议版本和失败后的恢复过程，正文保持完整。\n\n## 历史规则与交付检查 〔SYNC-2〕\n\n保留历史说明，记录本版补充的交付检查条件。\n`;
const documentPageSample = { id: 'sg-reader-document', projectId: 'sg-phone-project', name: documentSampleName,
  title: '跨项目资源同步、字段兼容与异常恢复完整协作规范' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X') + '（资源同步兼容）',
  type: 'PRD', primary: true, version: 2, versionCreatedAt: '2026-11-04T08:00:00Z', versionCreatedBy: 'u-product', sections: parseSections(documentSampleName, documentSampleText) };
const documentSampleVersions = [
  { version: 2, createdAt: '2026-11-04T08:00:00Z', createdBy: 'u-product', source: 'upload', sections: documentPageSample.sections, changedSections: ['SYNC-2'],
    note: '补充资源同步的异常恢复、字段兼容和完整交付检查，保留旧版本独立阅读与下载入口。'.repeat(3) + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X') + '（资源同步兼容）' },
  { version: 1, createdAt: '2026-10-29T08:00:00Z', createdBy: 'u-product', source: 'upload', sections: documentPageSample.sections, changedSections: [], note: '初始版本，保留跨月完整日期。' }
];
const documentSampleRequirement = { ...requirementPageSample, docRefs: [{ document: documentSampleName, type: 'PRD', sections: [] }] };
const proposalPageSample = { id: 'sg-phone-proposal', projectId: documentPageSample.projectId, title: '补充跨项目资源同步、字段兼容和异常恢复的验收依据' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X') + '（资源同步兼容）',
  status: '待补充', priority: 'P1', createdBy: 'u-dev', proposerName: '赵一（跨项目联调提出人）', source: '跨项目联调反馈' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X') + '（资源同步兼容）',
  description: '补充资源标识映射、协议兼容和失败后的恢复说明，长正文在手机上完整阅读。'.repeat(3), acceptance: '能核对资源一致性、接口兼容边界与完整回归记录。',
  createdAt: '2026-10-29T08:00:00Z', updatedAt: '2026-11-04T08:00:00Z', decisionReason: '请补充异常恢复步骤、字段映射规则与可以复核的验收材料。'.repeat(4),
  docRefs: [{ document: documentSampleName, type: 'PRD', sections: ['SYNC-1'] }] };
const proposalPageSamples = [
  { ...proposalPageSample, id: 'sg-pending-proposal', status: '待评估', decisionReason: '' }, proposalPageSample,
  { ...proposalPageSample, id: 'sg-converted-proposal', status: '已转需求', requirementId: documentSampleRequirement.id, decisionReason: '评估通过，原提议保留并关联已确认需求。' }
];
const documentPageSamples = [documentPageSample,
  { ...documentPageSample, id: 'sg-technical-document', name: '联调技术方案.md', title: '资源同步联调技术方案（未确认关联样例）', type: '技术方案', primary: false, version: 1, sections: [{ code: '§1', title: '接口兼容与异常恢复', level: 2 }] },
  { ...documentPageSample, id: 'sg-unlinked-document', name: '调研资料.md', title: '尚未关联的调研资料（样例）', type: '其他', primary: false, version: 1, sections: [] }
];
const documentSampleProposals = [...proposalPageSamples, { ...proposalPageSample, id: 'sg-technical-proposal', docRefs: [{ document: '联调技术方案.md', type: '技术方案', sections: ['§1'] }] }];
const documentSampleReader = context => renderDocumentReader({ document: documentPageSample, version: documentSampleVersions[0], contentHtml: renderDocumentPreview(documentSampleText, { toc: false }),
  requirements: [documentSampleRequirement], proposals: documentSampleProposals, nameOf: id => requirementPageUsers.find(user => user.id === id)?.name || '未记录', canUpload: false, versionCount: 2, ...context });
const proposalReaderSample = documentSampleReader({ fromProposal: proposalPageSample });
const requirementReaderSample = documentSampleReader({ fromRequirement: documentSampleRequirement });
const workbenchNarrow = matchMedia('(max-width: 560px)');

function syncWorkbenchSamples() {
  for (const layout of document.querySelectorAll('#styleguide .team-layout')) syncWorkbenchOrder(layout, workbenchNarrow.matches);
}

const sections = [
  ['rules', '三条硬规则', '所有新增页面与模块都必须满足；违反时 npm test 中的 design-system.test.mjs 会失败。',
    `<div class="sg-rules"><div class="sg-rule"><strong>只用令牌</strong><p>颜色只存在于 design/tokens.css。组件、页面样式和脚本里不写任何颜色值，内联样式只允许几何量和 CSS 自定义属性。</p></div><div class="sg-rule"><strong>先用组件</strong><p>按钮、状态、头像、页头、面板、空状态、表单字段一律调用 ui-kit.js。现有组件不够用时，先扩展组件，再写页面。</p></div><div class="sg-rule"><strong>按模式搭页面</strong><p>页头 → 指标条（可选）→ 面板。详情和编辑用右侧抽屉，确认用居中弹窗，预览用宽弹窗。</p></div></div>`],
  ['color', '色彩令牌', '主题色随浅色/深色切换；夜色区域与数据色与主题无关。右上角可切换主题检查两种效果。',
    block('界面表面与文字', swatches(['--bg', '--surface', '--surface-2', '--surface-3', '--border', '--border-strong', '--text', '--text-2', '--text-3', '--ink', '--accent', '--accent-soft']), '', 'is-plain')
    + block('星引靛蓝（标志固定，交互适配主题）', swatches(['--brand-primary', '--brand-on-dark', '--accent', '--accent-strong', '--accent-soft', '--accent-ring', '--on-accent']), '', 'is-plain')
    + block('语义色调（状态标签的唯一来源）', swatches(['--c-slate', '--c-violet', '--c-blue', '--c-amber', '--c-green', '--c-gray', '--c-red', '--c-orange']), '', 'is-plain')
    + block('夜色区域（侧栏 / 首页横幅 / 登录页）', swatches(['--night-bg', '--night-surface', '--on-night', '--on-night-2', '--brand-from', '--brand-to', '--glow-violet', '--glow-cyan']), '', 'is-plain')
    + block('导航选中（浅靛标记、柔和底色与白字）', swatches(['--sidebar', '--sidebar-active', '--sidebar-active-border', '--sidebar-active-rail', '--sidebar-active-icon', '--sidebar-active-text']), '', 'is-plain')
    + block('小星欢迎横幅', swatches(['--hero-fill', '--hero-border', '--hero-secondary', '--hero-accent', '--mascot-shadow']), '', 'is-plain')
    + block('数据可视化与项目色', swatches(['--bar-wait', '--bar-develop', '--bar-test', '--bar-done', '--bar-overdue', '--project-1', '--project-2', '--project-3', '--project-4', '--project-5', '--project-6']), '', 'is-plain')],
  ['type', '排版与间距', '中文界面以 14px 为正文基准；数字使用等宽数字（tabular-nums）便于对齐；间距遵循 4px 网格。',
    block('字号刻度', `<div class="sg-type">${[['--text-display', '42', 680], ['--text-3xl', '页面标题 h1', 700], ['--text-2xl', '抽屉实体标题', 700], ['--text-xl', '分区标题', 650], ['--text-lg', '面板标题', 650], ['--text-md', '正文 body', 500], ['--text-base', '控件与列表标题', 560], ['--text-sm', '次要正文 / 标签', 500], ['--text-xs', '表头 / 元信息', 600], ['--text-2xs', '刻度副标', 500]].map(([token, sample, weight]) => `<div class="sg-type-row"><code>${token}</code><span style="--size:var(${token});--weight:${weight}">${esc(sample)}</span></div>`).join('')}</div>`, '', 'is-stack')
    + block('间距刻度', `<div class="sg-scale">${[1, 2, 3, 4, 5, 6, 7, 8].map(step => `<span><i style="width:var(--space-${step});height:var(--space-${step})"></i>--space-${step}</span>`).join('')}</div>`)],
  ['buttons', '按钮', '每个区域最多一个主按钮（墨色），放在操作组最右侧；破坏性操作用红色文字按钮并二次确认。',
    block('变体', button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' }) + button({ label: '批量调整排期' }) + button({ label: '强调操作', variant: 'accent' }) + button({ label: '刷新', size: 'small' }) + button({ label: '查看详情', variant: 'text' }) + button({ label: '移出项目', variant: 'danger-text' }) + button({ variant: 'icon', iconName: 'edit', ariaLabel: '编辑' }) + button({ label: '不可用', variant: 'primary', disabled: true }),
      "button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' })\nbutton({ label: '批量调整排期' })                         // secondary\nbutton({ label: '刷新', size: 'small' })\nbutton({ label: '查看详情', variant: 'text', data: { requirement: id } })\nbutton({ label: '移出项目', variant: 'danger-text' })\nbutton({ variant: 'icon', iconName: 'edit', ariaLabel: '编辑' })")
    + block('手机触摸文字按钮：至少 44px 点击高度', button({ label: '查看全部 12 项', variant: 'text', size: 'touch' }) + button({ label: '核对跨项目同步、断线恢复与重复事件幂等处理的完整回归结果（长标题样例）', variant: 'text', size: 'touch' }),
      "button({ label: '查看全部 12 项', variant: 'text', size: 'touch' })\n// 560px 以下点击高度至少 44px，字号 13.5px；桌面保持原尺寸。")
    + block('手机触摸按钮：保留桌面小按钮尺寸', button({ label: '新建任务', variant: 'primary', size: 'small', touch: true, iconName: 'plus' }) + button({ label: '编辑项目', size: 'small', touch: true, iconName: 'edit' }),
      "button({ label: '新建任务', variant: 'primary', size: 'small', touch: true, iconName: 'plus' })\n// touch（触摸目标）只在 560px 以下增加至少 44px 点击高度，可与 size: 'small'（小尺寸）并用。")
    + block('视图切换与开关', segmented([{ value: 'board', label: '看板', icon: 'board' }, { value: 'list', label: '列表', icon: 'list' }], 'board', 'layout') + switchToggle('sg-archive', '查看归档', true),
      "segmented([{ value: 'board', label: '看板', icon: 'board' }, { value: 'list', label: '列表', icon: 'list' }], ui.taskLayout, 'layout')\nswitchToggle('archive-filter', '查看归档', ui.archived)")],
  ['status', '状态与标签', '业务状态到色调的映射只在 ui-kit.js 的 STATUS_TONES 维护；新增状态必须登记，否则测试失败。',
    block('任务阶段', ['wait', 'develop', 'test', 'done', 'terminated'].map(value => badge(value)).join(''), "badge(task.status)   // 中英文状态均可")
    + block('需求提议', ['待评估', '评估中', '待补充', '暂缓', '不采纳', '已转需求'].map(value => badge(value)).join(''))
    + block('需求流转', ['未确定', '待评审', '已确定', '待排期', '已排期', '开发中', '测试中', '已完成', '已终止'].map(value => badge(value)).join(''))
    + block('账号 / 项目 / 语义', ['active', 'pending', 'disabled'].map(accountStatus).join('') + badge('进行中') + badge('规划中') + toneBadge('danger', '已逾期') + toneBadge('plain', '已归档', { plain: true }), "accountStatus(person.status)\ntoneBadge('danger', '已逾期')")
    + block('优先级与计数', priority('P0') + priority('P1') + priority('P2') + priority('P0', true) + countLabel(29, '项'), "priority(item.priority)          // 表格里\npriority(item.priority, true)    // 详情里带中文说明\ncountLabel(list.length, '项')")
    + block('全部色调', TONES.map(tone => toneBadge(tone, tone)).join(''), `STATUS_TONES = ${JSON.stringify(STATUS_TONES).slice(0, 160)}…`)],
  ['people', '人员', '头像颜色由人员编号散列，同一个人在所有页面颜色一致；禁止手工指定头像颜色。',
    block('头像与人员胶囊', avatarMark('u-manager', '顾远', 'lg') + avatarMark('u-product', '林小满') + avatarMark('u-dev', '赵一', 'xs') + personChip('u-dev', '赵一') + personChip('u-test', '沈知') + personChip('', '未分配'),
      "// app.js 中的包装：avatar(id, size) / person(id) 会自动取人员姓名\navatarMark(user.id, user.name, 'lg')\npersonChip(task.ownerId, nameOf(task.ownerId))")],
  ['forms', '表单', '表单放在右侧抽屉里：两列网格，标签在上，说明文字在控件下方；长文本与多选占满整行。',
    block('字段', `<div class="form-grid">${field('需求标题' + REQUIRED, 'sg-title', input('sg-title', '服务质量履约口径与指标', 'maxlength="200"'), true)}${field('优先级', 'sg-priority', select('sg-priority', options(['P0', 'P1', 'P2'], 'P1')))}${field('计划截止', 'sg-end', input('sg-end', '2026-09-30', 'type="date"'))}${field('背景与目标', 'sg-desc', area('sg-desc', '', 'rows="3" placeholder="说明为什么要做"'), true, '提交评审前必须填写。')}<fieldset class="form-field full-width collaborator-field"><legend>协作成员</legend><div class="checklist"><label><input type="checkbox" checked><span>林小满</span></label><label><input type="checkbox"><span>赵一</span></label><label><input type="checkbox"><span>沈知</span></label></div></fieldset></div><div class="form-error">两次输入的密码不一致。</div>`,
      "field('需求标题' + REQUIRED, 'title', input('title', item?.title || '', 'required maxlength=\"200\"'), true)\nfield('优先级', 'priority', select('priority', options(['P0','P1','P2'], item?.priority)))\nfield('背景与目标', 'description', area('description', value, 'rows=\"3\"'), true, '确认需求前必须填写。')", 'is-stack')
    + block('提议与需求共用内容', `<div class="form-grid">${requirementContentFields({ projectId: 'sg-project', title: '控制台用量导出', priority: 'P1', source: '客户反馈', description: '按所选时间范围导出用量，便于核对账单。', acceptance: '导出范围和页面统计一致。', docRefs: [{ document: '用量需求.md', type: 'PRD', sections: ['EXPORT-1'] }] }, { confirmed: true, documents: [{ id: 'sg-document', projectId: 'sg-project', name: '用量需求.md', title: '用量导出需求说明', type: 'PRD', sections: [{ code: 'EXPORT-1', title: '导出范围与格式' }, { code: 'EXPORT-2', title: '下载记录' }] }] })}</div>`,
      'requirementContentFields(item, { confirmed, documents })\n// 提议与需求共用布局；确认时背景与验收必填。\n// 关联范围明确区分不关联、全文、指定章节，选择器不打开文档。', 'is-stack')],
  ['feedback', '反馈', '成功 → toast；页面级错误 → #page-alert 里的提示条；表单内错误 → .form-error；空数据 → 空状态并给出下一步。',
    block('提示条', notice('提醒会在打开页面或点击刷新时更新。') + notice('内容已被其他成员更新，请重新载入。', 'danger'), "notice('说明文字')\nnotice('错误说明', 'danger')", 'is-stack')
    + block('Toast', `<div class="toast">${icon('check')}<span>修改已保存。</span></div><div class="toast error">${icon('alert')}<span>无法连接服务器，请检查网络后重试。</span></div>`, "toast('修改已保存。')          // app.js\ntoast('失败原因', true)", 'is-stack')
    + block('空状态与加载', `<div class="panel">${empty('没有符合条件的需求', '尝试清除搜索或调整状态筛选。', 'new-requirement', '新建需求')}</div><div class="panel">${loading()}</div>`, "empty('没有符合条件的需求', '尝试清除搜索或调整状态筛选。', 'new-requirement', '新建需求')\nloading()", 'is-stack')
    + block('紧凑空状态', panel({ bodyHtml: empty('暂无待处理事项', '团队风险可在项目推进中查看。', '', '', { compact: true }) }), "empty('暂无待处理事项', '团队风险可在项目推进中查看。', '', '', { compact: true })", 'is-stack')],
  ['containers', '容器与数据', '内容一律放进面板；关键数字用指标条；键值信息用 detailList；列表用 data-table。',
    block('指标条', metricStrip([metric('需求总数', 29, '2 项待确认', 'inbox', 'purple'), metric('进行中任务', 2, '开发中 + 测试中', 'board', 'blue'), metric('任务完成', 7, '共 41 个任务', 'check', 'green'), metric('逾期任务', 3, '截止日期早于今天', 'clock', 'amber', true)]),
      "metricStrip([\n  metric('需求总数', reqs.length, '2 项待确认', 'inbox', 'purple'),\n  metric('逾期任务', late, '截止日期早于今天', 'clock', 'amber', late > 0)\n])", 'is-plain')
    + block('工作台手机紧凑指标：多位数字与完整日期（样例数据）', metricStrip([
      metric('项目目标已过', 123, '目标日期已过且仍有未完成事项', 'flag', 'purple', true),
      metric('逾期任务', 1234, '已过截止日；不含完成、终止和归档', 'alert', 'amber', true),
      metric('未来 7 天到期', 128, '2026-10-29 — 2026-11-04，含今天', 'calendar', 'blue', false, { keepDates: true }),
      metric('待我处理', 125, '按职责统计；同一事项只计一次', 'check', 'green')
    ], { mobileCompact: true }),
      "metricStrip(cards, { mobileCompact: true }) // 手机紧凑，桌面保留原排版\nmetric('未来 7 天到期', 128, '2026-10-29 — 2026-11-04，含今天', 'calendar', 'blue', false, { keepDates: true })\n// 320px、375px、430px：统计说明完整换行；两个日期分别不拆开。", 'is-plain')
    + block('面板 + 列表', panel({ title: '团队账号', count: 3, actionsHtml: button({ label: '创建账号', variant: 'primary', size: 'small', iconName: 'plus' }), bodyHtml: `<div class="table-wrap"><table class="data-table"><thead><tr><th>姓名 / 账号</th><th>状态</th><th>负责任务</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${[['u-manager', '顾远', 'admin', 'active', 12], ['u-product', '林小满', 'product', 'pending', 5], ['u-dev', '赵一', 'zhao', 'disabled', 0]].map(([id, name, username, status, count]) => `<tr><td><span class="person">${avatarMark(id, name)}<span><strong class="member-title">${esc(name)}</strong><span class="item-meta"><code>${esc(username)}</code></span></span></span></td><td>${accountStatus(status)}</td><td class="num-cell">${count}</td><td class="action-cell">${button({ label: '编辑', variant: 'text' })}</td></tr>`).join('')}</tbody></table></div>`, noteHtml: `${icon('document')}面板备注用于解释统计口径。` }),
      "panel({ title: '团队账号', count: people.length, actionsHtml: button({...}), bodyHtml: tableHtml, noteHtml: '统计口径说明' })", 'is-plain')
    + block('项目目录列表：长项目名与完整日期', `<div class="stack"><div class="project-directory-controls">${switchToggle('sg-project-archive','查看归档项目')}${segmented([{value:'card',label:'卡片',icon:'dashboard'},{value:'list',label:'列表',icon:'list'}],'list','sg-project-layout','项目显示方式')}</div>${panel({bodyHtml:renderProjectTable([{id:'sg-project',name:longProjectSampleName,description:'项目目录用于浏览和比较项目。手机保留表格横向滚动，标题与日期完整展示，最右侧保留进入项目入口。',status:'进行中',ownerId:'u-product',targetDate:'2026-11-04'}],{summaryOf:()=>({reqs:[{},{}],tasks:[{},{},{}],eligible:[{},{}],completed:1,percent:50}),nameOf:()=> '林小满',roleOf:()=> '产品经理',projectPath:()=> '#patterns'})})}</div>`, 'renderProjectTable(projects, { summaryOf, nameOf, roleOf, projectPath })\n// 手机显示横向滚动提示；表格容器可聚焦，左右滚动查看完整列，不挤压日期。', 'is-plain')
    + block('按需求组织研发任务', renderRequirementTaskGroups({
      requirements: [{ id: 'sg-requirement', title: '控制台用量导出', status: '开发中', assigneeId: 'u-dev', description: '按需求集中查看拆分后的工作。', acceptance: '导出的范围和账单保持一致。', planEnd: '2026-10-12' }],
      tasks: [{ id: 'sg-task-1', requirementId: 'sg-requirement', title: '实现明细导出', ownerId: 'u-dev', estimateHours: 8, status: 'develop', startDate: '2026-10-01', dueDate: '2026-10-10' }],
      users: [{ id: 'u-dev', name: '赵一' }], role: 'lead', expandedIds: ['sg-requirement']
    }), 'renderRequirementTaskGroups({ requirements, tasks, users, role, renderTask, canManage, canSplit, expandedIds })', 'is-plain')
    + block('手机项目与研发任务：长标题、完整日期及触摸入口', heading('研发任务', '样例数据：长项目名和长需求名完整换行；连续英文接口名也应留在内容宽度内。', '', longProjectSampleName) + renderRequirementTaskGroups({
      requirements: [{ id: 'sg-long-requirement', title: longRequirementSampleTitle, status: '开发中', assigneeId: 'u-dev', description: '检查跨项目资源同步、断线重连、重复事件幂等和异常恢复链路，保留完整背景与验收内容。', acceptance: '项目、需求与任务标题可完整阅读；日期不拆开，原详情和任务操作入口均可触达。', planEnd: '2026-10-31' }],
      tasks: [{ id: 'sg-long-task', requirementId: 'sg-long-requirement', title: 'GetResourceSynchronizationProtocolCompatibility'.padEnd(80, 'X'), ownerId: 'u-dev', estimateHours: 8, status: 'develop', startDate: '2026-10-29', dueDate: '2026-11-04' }],
      users: [{ id: 'u-dev', name: '赵一' }], role: 'lead', expandedIds: ['sg-long-requirement']
    }), "renderRequirementTaskGroups({ requirements, tasks, users, role: 'lead', expandedIds })\n// 复用真实需求组：长标题完整换行，日期各自保留 YYYY-MM-DD（年-月-日）全文。\n// 手机需求进度另起一行，研发设置、新建任务及更多操作保持至少 44px 点击高度。", 'is-plain')
    + block('键值与进度', `<div class="sg-grid-2">${detailList([['负责人', personChip('u-product', '林小满'), true], ['需求点数', 5], ['计划开始', '2026-08-24'], ['计划截止', '2026-09-11'] ], { columns: 2 })}<div class="panel panel-pad"><div class="project-progress-label"><span>任务完成率</span><strong>17% · 7 / 41</strong></div>${progress(17, '任务完成率')}</div></div>`,
      "detailList([['负责人', person(item.ownerId), true], ['需求点数', item.estimatePoints]], { columns: 2 })\nprogress(percent, '任务完成率')", 'is-plain')],
  ['requirements-mobile', '手机需求与交付排期', '以下为样例数据。保留需求池表格、详情抽屉和交付排期骨架；长标题自然换行，日期分别完整显示。表格在自身容器内横向滚动，手机入口保留至少 44px 点击高度。样例复用真实流程、历史基线与排期渲染函数，不另行计算业务阶段或排期统计。',
    block('需求池：长标题、完整日期与触摸入口', heading('需求池', '已确认需求继续使用原表格；手机横向滑动查看状态和日期。', button({ label: '新建需求', variant: 'primary', iconName: 'plus', touch: true }), longProjectSampleName)
      + panel({ bodyHtml: `<div class="requirement-pool"><div class="table-toolbar table-toolbar-mobile-touch"><div class="table-filters"><label>状态<select aria-label="样例需求状态"><option>全部状态</option><option>开发中</option></select></label>${switchToggle('sg-requirement-archive', '查看归档')}</div><span class="table-toolbar-meta">共 1 项</span></div><div class="table-wrap" tabindex="0" role="region" aria-label="需求池样例表格，可横向滚动"><p class="table-scroll-hint">左右滑动查看优先级、负责人、状态和完整日期；点击需求标题查看详情。</p><table class="data-table"><thead><tr><th>需求</th><th>优先级</th><th>负责人</th><th>状态</th><th>研发周期 / 承诺截止</th><th>点数</th><th>操作</th></tr></thead><tbody><tr><td class="title-cell"><button class="item-title">${esc(requirementPageSample.title)}</button><div class="item-meta"><code>${esc(requirementPageSample.id)}</code><span>跨项目联调（样例来源）</span></div></td><td>${priority('P1')}</td><td>${personChip('u-dev', '赵一')}</td><td>${badge('开发中')}</td><td><time datetime="2026-10-29">2026-10-29</time> — <time datetime="2026-11-04">2026-11-04</time><div class="item-meta">承诺截止 <time datetime="2026-11-03">2026-11-03</time></div></td><td class="num-cell">8</td><td class="action-cell">${button({ label: '详情', variant: 'text', touch: true })}${button({ label: '编辑', variant: 'text', touch: true })}</td></tr></tbody></table></div></div>` }),
      "button({ label: '新建需求', variant: 'primary', touch: true })\n// 需求池保留原表格、筛选和分页；手机显示横向滚动提示，不隐藏日期列。", 'is-plain')
    + block('需求详情：交付流程、跨月日期与历史基线', panel({ bodyHtml: `<div class="dialog-body" data-detail-id="sg-phone-requirement"><div class="detail-hero"><span class="detail-hero-id">${esc(requirementPageSample.id)}</span><h3>${esc(requirementPageSample.title)}</h3><div class="detail-summary">${badge('开发中')}${priority('P1', true)}</div></div>${renderDeliveryWorkflow(requirementPageSample, { tasks: requirementPageTasks, role: 'product' })}${renderBaseline(requirementPageSample, { mobileReadable: true })}<section class="detail-section"><h3>关联研发任务</h3><div class="linked-tasks">${requirementPageTasks.map(task => `<div class="linked-task"><div class="person">${avatarMark('u-dev', '赵一', 'xs')}<button class="item-title">${esc(task.title)}</button></div>${badge(task.status)}</div>`).join('')}</div></section><div class="detail-actions">${button({ label: '关闭', touch: true })}${button({ label: '编辑需求', variant: 'primary', iconName: 'edit', touch: true })}</div></div>` }),
      "renderDeliveryWorkflow(requirement, { tasks, dependencies, role })\nrenderBaseline(requirement, { mobileReadable: true })\n// mobileReadable（手机阅读）提供横滑提示和可聚焦区域；需求详情及编辑表单启用。\n// 关联任务标题完整换行；日期、编辑和原有详情入口保持可读、可触达。", 'is-plain')
    + block('历史基线默认样式', renderBaseline(requirementPageSample), 'renderBaseline(requirement) // 默认调用保留原结构，不显示手机横滑提示。', 'is-plain')
    + block('交付排期：长标题、跨月日期、长里程碑与未排期任务', renderTimeline({
      state: createTimelineState('2026-10-30'), today: '2026-10-30',
      project: { id: requirementPageSample.projectId, name: longProjectSampleName, startDate: '2026-10-27', targetDate: '2026-11-08', milestones: [{ label: '跨项目ResourceSynchronizationCompatibility（资源同步兼容）接口异常重试与完整交付检查（长里程碑样例）', date: '2026-11-02', kind: 'checkpoint' }] },
      tasks: requirementPageTasks, users: requirementPageUsers
    }), 'renderTimeline({ state, project, tasks, users, today, viewportWidth })\n// 真实函数显示 1 个已排期、1 个待完善日期任务；完整列表保留两项。\n// 手机里程碑明细默认收起，展开后可读完整名称和日期；图表和表格各自横向滚动。', 'is-plain')],
  ['documents-mobile', '手机文档与需求提议', '以下为合成样例，复用真实文档页、阅读器、版本和提议渲染函数。长标题、文件名、章节与备注完整换行，单个日期不拆断；桌面保留原排版，手机操作入口至少 44px。',
    block('项目文档：长标题与文件名、分类和完整日期', heading('项目文档', '保留主文档卡片、自动分类与表格；手机横向查看完整日期和原操作。', button({ label: '上传文档', variant: 'primary', iconName: 'plus', touch: true }), longProjectSampleName)
      + `<div class="stack">${renderDocumentsPage({ documents: documentPageSamples, requirements: [documentSampleRequirement], proposals: documentSampleProposals, canUpload: true, nameOf: () => '林小满' })}</div>`,
      'renderDocumentsPage({ documents, requirements, proposals, confirmation, canUpload, nameOf })\n// 全文参考只计关联；已转需求的提议不重复计数。长文件名与日期在原区域内阅读。', 'is-plain')
    + block('阅读器：长章节、版本说明与返回提议', panel({ title: '文档阅读器（提议来源样例）', bodyHtml: proposalReaderSample.body + `<div class="dialog-footer">${proposalReaderSample.footer}</div>` }),
      'renderDocumentReader({ document, version, contentHtml, requirements, proposals, fromProposal })\n// fromProposal（来源提议）保留原详情上下文；正文使用真实文档预览函数，章节入口至少 44px。', 'is-plain')
    + block('历史版本：长备注、完整日期与原提议上下文', panel({ title: '文档版本（提议来源样例）', bodyHtml: renderDocumentVersions(documentPageSample, documentSampleVersions, () => '林小满', { fromProposal: proposalPageSample.id }) }),
      'renderDocumentVersions(document, versions, nameOf, { fromProposal })\n// 历史版本的查看入口携带来源提议；版本说明完整换行，查看与下载在手机上另行排列。', 'is-plain')
    + block('阅读器：返回原需求', panel({ title: '文档阅读器（需求来源样例）', bodyHtml: requirementReaderSample.body + `<div class="dialog-footer">${requirementReaderSample.footer}</div>` }),
      'renderDocumentReader({ document, version, contentHtml, fromRequirement })\n// fromRequirement（来源需求）使用同一阅读器；返回需求与下载入口保留原行为。', 'is-plain')
    + block('需求提议：长标题、三种真实状态与完整日期', heading('需求提议', '想法确认采纳后进入需求池，原提议保留评估记录。', button({ label: '提出需求', variant: 'primary', iconName: 'plus', touch: true }), longProjectSampleName)
      + panel({ bodyHtml: `<div class="proposal-pool">${renderProposalList({ items: proposalPageSamples, users: requirementPageUsers })}</div>` }),
      'renderProposalList({ items, users })\n// 手机表格在自身容器内横向滚动，标题仍是原详情入口，日期保持完整。', 'is-plain')
    + block('提议详情：长来源、评估说明、关联文档与已确认需求', panel({ title: '提议详情（已转需求样例）', bodyHtml: renderProposalDetails(proposalPageSamples[2], { users: requirementPageUsers, documents: documentPageSamples }) + `<div class="dialog-footer">${button({ label: '关闭', touch: true })}</div>` }),
      'renderProposalDetails(proposal, { users, documents })\n// 原提议及关联需求均保留；评估与编辑入口继续由调用方按权限提供，不在样例中模拟授权。', 'is-plain')],
  ['workbench', '工作台：进展、风险与待办', '以下为样例数据。保留原四指标和桌面主副栏骨架；560px 及以下欢迎区与四指标收紧留白，统计说明完整换行、日期不拆开，随后按个人待办、项目推进、近期计划节点的顺序阅读，零待办、读取中或失败也保持该顺序。项目摘要优先展示风险，进展明细可折叠。有效个人待办超过五项时，近期计划节点默认收起；其他状态保持展开。项目搜索不改变指标或个人待办，里程碑日期不代表完成状态。',
    block('项目推进与个人职责', renderWorkbenchContent(workbenchSample, { canPrepare: () => false }), 'renderWorkbenchContent(model, { projectPath, projectColor, canPrepare, visibleProjectIds, search, workError })', 'is-stack')
    + block('多待办与长标题：十二项仅预览五项，计划节点可展开', renderWorkbenchContent(busyWorkbenchSample, { canPrepare: () => false }), '桌面标题最多两行，手机最多三行；手机项目名与截止日期分行、日期不拆开。标题及查看全部入口至少 44px 点击高度。完整清单与详情保留全文，不限制标题行数。', 'is-stack')
    + block('零待办：紧凑提示，近期计划节点保持展开', renderWorkbenchContent(emptyWorkbenchSample, { canPrepare: () => false }), '零待办不会把团队节点计入个人职责；读取中和失败仍显示未知。', 'is-stack')],
  ['patterns', '页面模式', '新页面按下面的结构组合，不要发明新的页面骨架。弹窗通过 openDialog(title, body, footer, variant) 打开。',
    block('页头', heading('需求池', '记录问题、明确验收标准，再将需求拆解为可交付的任务。', button({ label: '新建需求', variant: 'primary', iconName: 'plus' }), '自研 API 聚合平台') + sectionHeading('可访问项目', { count: 3 }),
      "heading('需求池', '一句话说明页面用途', canEdit() ? button({ label: '新建需求', variant: 'primary', iconName: 'plus', action: 'new-requirement' }) : '', projectOf().name)", 'is-stack')
    + block('区块间距与并排布局', `<div class="stack"><div class="split" style="--aside:260px"><section class="section-block">${sectionHeading('可访问项目', { count: '4 个项目' })}<div class="panel panel-pad"><p class="muted small">主栏：分区标题 + 内容</p></div></section><section class="section-block">${sectionHeading('我的待办', { count: 1 })}<div class="panel panel-pad"><p class="muted small">侧栏：同样以分区标题开头，栏顶自然对齐</p></div></section></div>${panel({ title: '下一个区块', bodyHtml: '<div class="panel-pad"><p class="muted small">与上方的间距来自 .stack 的 gap（--gap-block），面板自身不带外边距。</p></div>' })}</div>`,
      "// #view 已是纵向栈：页头、指标条、面板、网格直接拼接即可\n`<div class=\"split\">`                    // 主栏 + 侧栏，侧栏宽度 style=\"--aside:360px\"\n  + `<section class=\"section-block\">${sectionHeading('可访问项目', { count })}${grid}</section>`\n  + `<section class=\"section-block\">${sectionHeading('我的待办', { count })}<div class=\"panel\">…</div></section>`\n+ `</div>`\n// 禁止 .panel + .panel { margin-top } 这类相邻选择器间距", 'is-plain')
    + block('三种弹窗', `<div class="sg-grid-2"><div><div class="sg-mock-dialog"><div class="dialog-header"><h2>编辑需求</h2><button class="dialog-close" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><div class="form-grid">${field('需求标题', 'sg-d1', input('sg-d1', '控制台用量导出'), true)}</div></div><div class="dialog-footer"><div class="footer-buttons">${button({ label: '取消' })}${button({ label: '保存', variant: 'primary' })}</div></div></div><p class="sg-mock-caption">drawer（默认）：详情、新建、编辑、批量操作</p></div><div><div class="sg-mock-dialog"><div class="dialog-header"><h2>移出项目成员</h2><button class="dialog-close" aria-label="关闭">${icon('close')}</button></div><div class="dialog-body"><p>将「林小满」移出当前项目。此操作不会删除团队账号。</p></div><div class="dialog-footer">${button({ label: '取消' })}${button({ label: '确认', variant: 'primary' })}</div></div><p class="sg-mock-caption">center：确认、账号信息、一次性链接；wide：文档预览、版本对照</p></div></div>`,
      "openDialog('编辑需求', formHtml)                              // 右侧抽屉\nopenDialog('移出项目成员', bodyHtml, footerHtml, 'center')     // 居中确认\nopenDialog(file.name, previewHtml, footerHtml, 'wide')        // 宽预览", 'is-plain')
    + block('夜色横幅（仅团队工作台）', workbenchWelcome({scope:'团队工作台 · 9月17日 星期四',title:'下午好，顾远',summaryHtml:'你有 <strong>3</strong> 项待办。这里汇总你可访问项目的进展与待办。',actionsHtml:button({ label:'新建项目',variant:'primary',iconName:'plus' })}), '', 'is-plain')]
];

function render() {
  document.getElementById('styleguide').innerHTML = `<div class="sg-shell"><nav class="sg-nav" aria-label="设计系统目录"><a class="brand" href="/"><span class="brand-mark">${BRAND_MARK}</span><span><strong>星引设计系统</strong><small>夜航 · 设计系统</small></span></a>${sections.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav><main class="sg-main">${`<div class="sg-topline"><span class="scope-pill">DESIGN.md · design/ · ui-kit.js</span>${button({ variant: 'icon', iconName: 'moon', action: 'theme', ariaLabel: '切换浅色或深色主题' })}</div>`}${heading('星引设计系统', '本页的每个样例都由 ui-kit.js 与 design/ 下的真实样式渲染。修改组件或令牌后打开本页，确认浅色与深色两种主题下都正确。')}${sections.map(([id, title, intro, body]) => section(id, title, intro, body)).join('')}</main></div>`;
  syncWorkbenchSamples();
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
workbenchNarrow.addEventListener('change', syncWorkbenchSamples);
render();
