# 星河研发台 · 设计系统（夜航）

本文件是界面设计的**唯一规范**。任何人或 agent 新增页面、模块、组件，或修改现有界面前，都必须先读完「三条硬规则」和「新增页面步骤」。
样例页面：启动服务后打开 `/design-system.html`（无需登录），所有样例都由真实组件渲染。

---

## 1. 三条硬规则（有自动测试把关）

| 规则 | 要求 | 由谁检查 |
| --- | --- | --- |
| **只用令牌** | 颜色只能出现在 `frontend/design/tokens.css`。其他 CSS、JS 模板里不写 `#hex`、`rgb()`、`hsl()`；内联 `style` 只允许几何量（`left/right/top/width/height/flex`）和 CSS 自定义属性（`--xxx`）。 | `backend/tests/design-system.test.mjs` |
| **先用组件** | 按钮、状态标签、优先级、头像、页头、指标、面板、空状态、提示、表单字段一律调用 `frontend/ui-kit.js`。模板里出现的每个类名都必须有样式定义。 | 同上 + 代码评审 |
| **按模式搭页面** | 页面骨架只用第 5 节的模式：页头 → 指标条（可选）→ 面板。详情和编辑用右侧抽屉，确认用居中弹窗，预览用宽弹窗。 | 代码评审 + 样式指南对照 |

`npm test` 失败信息会指出违规的文件、行号和修复方向。**不要为了让测试通过而修改测试的判定条件**；确需新增结构钩子类时，登记到测试中的 `HOOK_CLASSES` 并写明原因。

---

## 2. 文件地图

```text
frontend/
├── design/                     样式，按层级加载，顺序不可调换
│   ├── tokens.css              ① 设计令牌：颜色、字号、间距、圆角、阴影、动效、层级
│   ├── base.css                ② 元素重置、工具类、共享动画、品牌标志
│   ├── components.css          ③ 跨页面组件（按钮、表单、标签、头像、面板、表格、弹窗…）
│   ├── layout.css              ④ 应用外壳（侧栏、顶栏、内容区）与登录页
│   └── pages/                  ⑤ 页面专属样式，一个页面（或一组紧密相关页面）一个文件
│       ├── dashboard.css       团队工作台、项目目录、项目概览
│       ├── tasks.css           研发任务看板
│       ├── members.css         项目成员、账号管理
│       ├── work.css            我的工作、站内提醒、交付报表
│       ├── timeline.css        交付排期（甘特图）
│       ├── document.css        附件文档预览
│       └── styleguide.css      样式指南页面自身的排版
├── ui-kit.js                   组件生成函数（纯函数，返回 HTML 字符串）
├── design-system.html/.js      活样式指南
├── index.html                  应用入口；引入全部样式层
└── app.js / work-ui.js / timeline.js / …   视图与交互
```

样式层的职责边界：

- **tokens** 只定义变量，不写选择器规则（深色主题重定义除外）。
- **base** 只写元素选择器、工具类（`.muted`、`.sr-only`…）和 `@keyframes`。
- **components** 写可在两个以上页面复用的组件。一个组件只在一个页面用到时，放到对应的 `pages/*.css`。
- **layout** 只管外壳。页面内容渲染进 `#view`，新页面**不需要**修改 layout。
- **pages** 只写该页面特有的结构；不得重新定义组件的外观（例如不要在页面里改 `.btn` 的颜色）。

---

## 3. 设计原则

1. **明暗对比出辨识度**：深墨色侧栏（夜色区域）+ 暖白纸面画布。品牌渐变只出现在标志、登录页和首页横幅，不要扩散到业务组件。
2. **一个强调色**：主按钮是墨色（`--ink`），强调色「星河蓝」（`--accent`）只用于焦点、选中、链接和进度。不要新增第二个强调色。
3. **状态用色点，不用大色块**：状态标签是「小圆点 + 浅底 + 同色文字」；大面积彩色只用于数据可视化（甘特条、进度环）。
4. **数字要对齐**：指标、日期、工时、编号使用等宽数字；编号使用 `--font-mono`。
5. **信息密度适中**：列表行高约 48px，面板内边距 16–20px，页面区块间距 18px。宁可分面板，不要堆砌分割线。
6. **上下文不丢失**：看详情、编辑都从右侧抽屉打开，背后列表保持可见。

---

## 4. 令牌

### 4.1 颜色

| 令牌 | 用途 |
| --- | --- |
| `--bg` / `--bg-grain` | 页面画布（外壳背景） |
| `--surface` | 面板、卡片、输入框、抽屉背景 |
| `--surface-2` | 表头、面板备注、次级区块 |
| `--surface-3` | 分段控件底、计数胶囊、空状态图标底 |
| `--surface-hover` | 行、列表项悬停 |
| `--border` / `--border-strong` | 默认边框 / 悬停或强调边框 |
| `--text` / `--text-2` / `--text-3` | 主文字 / 次要文字 / 辅助说明与占位 |
| `--ink` / `--ink-text` | 主按钮底色与文字（深色主题下自动反转） |
| `--accent` / `--accent-strong` / `--accent-soft` / `--accent-ring` | 链接与焦点 / 悬停 / 选中浅底 / 聚焦光圈 |
| `--c-{slate,violet,blue,amber,green,gray,red,orange}` + `-bg` | 语义色调，**状态标签、提醒、风险的唯一颜色来源** |
| `--shadow-{xs,sm,md,lg}` | 层级阴影：静止卡片 sm，悬停 md，抽屉与弹窗 lg |
| `--sidebar*` | 侧栏（夜色区域） |
| `--night-*` / `--on-night-*` / `--brand-*` / `--glow-*` / `--starfield` | 夜色区域：侧栏、首页横幅、登录页左侧。**只能用在深色背景上** |
| `--bar-*` | 甘特条颜色（与任务阶段一一对应） |
| `--project-1…6` / `--project-none` | 项目识别色，由 `projectColor(id)` 按项目顺序分配 |
| `--toast-*` / `--code-*` / `--backdrop` / `--preview-canvas` | 提示气泡、代码块、弹窗遮罩、原型预览画布 |

深色主题：`tokens.css` 里有两处深色定义（`:root[data-theme="dark"]` 和 `prefers-color-scheme: dark`），**必须同步修改**，测试会比对。夜色区域、数据色、项目色与主题无关，不要在深色块里重定义。

新增颜色的流程：①确认现有令牌确实无法表达 → ②在 `tokens.css` 对应分组加令牌（主题色需同时补两处深色值）→ ③在本表登记用途 → ④在 `design-system.js` 的色板里加样例。

### 4.2 状态色调（业务状态 → 视觉）

映射只在 `ui-kit.js` 的 `STATUS_TONES` 维护，对应 CSS 类 `.status-<tone>`。`workflow.js` 新增状态而未登记色调时，测试会失败。

| tone | 颜色 | 业务含义 | 状态 |
| --- | --- | --- | --- |
| `plan` | 灰蓝 | 已计划、尚未动工 | 待开始、已确定、待排期、已排期、规划中 |
| `review` | 紫 | 需要讨论或确认 | 未确定、待评审 |
| `progress` | 蓝（带光圈） | 正在进行 | 开发中、进行中 |
| `test` | 琥珀 | 验证中 | 测试中 |
| `done` | 绿（对勾） | 完成、可用 | 已完成、账号已启用 |
| `terminated` | 灰 | 终止、停用 | 已终止、账号已禁用 |
| `pending` | 橙 | 等待他人动作 | 账号待激活 |
| `danger` | 红 | 风险 | 逾期等（用 `toneBadge('danger', …)`） |

逾期统一用红色文字 `.overdue-text`，或在卡片左侧加红边（`.task-card.is-overdue`）。不要把逾期做成整块红底。

### 4.3 排版

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--text-display` | 34px | 指标大数字、进度环数字 |
| `--text-3xl` | 30px | 页面标题 h1、首页问候 |
| `--text-2xl` | 21px | 抽屉内实体标题 |
| `--text-xl` | 17px | 分区标题 |
| `--text-lg` | 15px | 面板标题、弹窗标题 |
| `--text-md` | 14px | 正文（body 默认） |
| `--text-base` | 13.5px | 按钮、输入框、列表标题 |
| `--text-sm` | 12.5px | 次要正文、表单标签、小按钮 |
| `--text-xs` | 11.5px | 表头、元信息、计数 |
| `--text-2xs` | 10.5px | 甘特刻度副标 |

字重：正文 500，强调 560–600，标题 650–700。标题使用 `--font-display` 并带轻微负字距；编号、日期区间使用 `--font-mono`。

### 4.4 间距、圆角、动效、层级

- 间距 `--space-1…8` = 4 / 8 / 12 / 16 / 20 / 24 / 32 / 44px。间距令牌只用于 margin、padding、gap，**不要拿来当字号或圆角**。
- 布局节奏只有三档：`--gap-block` 18px（页面区块之间、并排栏之间）· `--gap-section` 12px（分区标题与内容）· `--gap-card` 14px（卡片网格）。
- 圆角：`--radius-xs` 6（小标签）· `--radius-sm` 8（小按钮）· 10px（按钮、输入框）· `--radius` 12（卡片内块）· `--radius-lg` 16（面板、卡片）· `--radius-xl` 22（首页横幅）· `--radius-pill`（胶囊）。
- 动效：`--duration-fast` 用于悬停，`--duration-base` 用于遮罩，`--duration-slow` 用于入场；缓动统一 `--ease`。页面入场动画用 `rise`，弹窗用 `drawer-in` / `pop-in`。已全局支持「减少动态效果」。
- 层级：`--z-sticky` < `--z-topbar` < `--z-sidebar-shade` < `--z-sidebar` < `--z-skip-link` < `--z-toast`。原生 `<dialog>` 处于顶层，不需要 z-index。

---

## 5. 页面模式

### 5.1 页面骨架

```js
function exampleView() {
  return heading('页面标题', '一句话说明这个页面帮用户做什么。', actionsHtml, '范围（项目名 / 团队空间 / 系统管理）')
    + readonly()                                   // 只读或受限权限时的说明（项目内页面）
    + metricStrip([...])                           // 可选：最多 4 个关键数字
    + panel({ title: '…', bodyHtml: … });          // 内容一律在面板里
}
```

- 在 `renderView()` 的路由表里注册视图，在 `renderShell()` 的导航里加入口（团队功能放 `main-nav`，项目功能放 `project-nav-links`，管理功能放 `admin-nav`）。
- 页面主操作放在 `heading()` 的 actions 中，**只放一个** `primary` 按钮，放在最右侧；次要操作用 `secondary`。
- 需要搜索时，在 `renderShell()` 的 `searchLabel` 映射中登记；页面内不要再放搜索框。

### 5.1a 区块间距与并排布局（有自动测试把关）

区块之间的距离**只由容器决定**，组件自己不带外边距：

- `#view` 是纵向栈（`display:flex; gap: var(--gap-block)`），页头、指标条、面板、网格直接放进去即可，不需要也不允许再写 `margin-top`。
- 需要并排时用布局原语：`.split`（主栏 + 侧栏，侧栏宽度用 `--aside` 调整，默认 340px，1080px 以下自动单栏）或页面自己的网格（用 `gap`，并写 `align-items: start` 或保持等高）。
- 分区标题 + 内容用 `.section-block` 包起来：`sectionHeading(...)` + 卡片网格 / 面板。**并排的每一栏结构要一致**——一栏以分区标题开头，另一栏也要以分区标题开头，这样栏顶天然对齐。不要一栏是“标题 + 卡片”、另一栏是“带标题的面板”。
- 容器内还需要纵向堆叠时用 `.stack`。
- **禁止**用相邻选择器（`.panel + .panel`、`.x + section`）给区块加外边距：它在网格里会把第二栏整体往下推，这正是之前成员页、工作台、项目概览栏顶错位的原因。

### 5.2 列表页

```text
panel
├── .table-toolbar   左：筛选下拉 + switchToggle('archive-filter', '查看归档')   右：计数 + segmented()
├── .table-wrap > table.data-table
│     第一列 .title-cell：item-title 按钮 + .item-meta（<code>编号</code> · 来源）
│     人员列：person(id)    状态列：badge(status)    数字列：.num-cell    最后一列：.action-cell 文字按钮
└── .table-footer    分页（每页 25 条）
```

看板页使用 `.board > .board-column[data-stage] > .task-card`，列头显示 `badge(stage)` 和数量。

### 5.3 弹窗：`openDialog(title, bodyHtml, footerHtml = '', variant = 'drawer')`

| variant | 用途 | 内容结构 |
| --- | --- | --- |
| `drawer`（默认） | 实体详情、新建、编辑、批量操作 | 详情：`.detail-hero`（编号 · 项目 / 标题 / 标签）→ `detailList` → `.detail-section` 分节；表单：`form#entity-form > .dialog-body > .form-grid` + `.dialog-footer` |
| `center` | 二次确认、账号信息、一次性链接、密码修改 | 一段说明文字 + 「取消 / 确认」 |
| `wide` | 文档、原型预览，版本对照 | 预览内容 + 「关闭 / 下载」 |

- 破坏性操作（归档、移出、重置）必须经过 `confirmAction()`（居中弹窗），确认按钮文案写明动作。
- 表单底部：左侧放归档等危险文字按钮，右侧 `.footer-buttons` 放「取消 / 保存」。
- 表单字段 id 统一 `field-<name>`，用 `field()/input()/select()/area()` 生成；必填在标签后拼接 `REQUIRED`。

### 5.4 状态与反馈

| 场景 | 做法 |
| --- | --- |
| 操作成功 | `toast('修改已保存。')` |
| 页面级失败 / 版本冲突 | `presentError(error)` → `#page-alert` 中的 `.notice-danger`，提供「重新载入」 |
| 表单校验失败 | `presentError(error, $('#form-error'))`，错误出现在表单顶部 |
| 数据为空 | `empty(为什么为空, 下一步做什么, action, 按钮文案)`，有权限时才给按钮 |
| 异步读取中 | `loading()`；按钮提交中用 `busy(button, true)`，自动显示转圈 |
| 权限受限 | 页头下方 `readonly()` 说明；不可编辑字段 `disabled`，不要隐藏数据 |

### 5.5 夜色区域

只有三处：侧栏、登录页左侧、团队工作台横幅 `.hero`。**新页面不要新增夜色区域**，也不要在普通面板里使用 `--night-*` 令牌。

---

## 6. 组件目录（`ui-kit.js`）

| 函数 | 输出 | 说明 |
| --- | --- | --- |
| `button({ label, variant, size, iconName, action, data, disabled, ariaLabel })` | `.btn` / `.text-button` / `.icon-button` | variant：`primary`、`secondary`、`accent`、`text`、`danger-text`、`icon`。行为通过 `data-action` 或 `data-*` 交给全局事件委托，不写 `onclick` |
| `segmented(items, current, dataKey)` | `.segmented` | 互斥视图切换 |
| `switchToggle(id, label, checked)` | `.archive-toggle` | 开关 |
| `badge(status, label?)` | `.badge.status-<tone>` | 业务状态标签 |
| `toneBadge(tone, label, { plain })` | `.badge` | 非业务状态的语义标签 |
| `accountStatus(status)` / `priority(level, full)` / `countLabel(n, unit)` | 标签 | 账号状态 / 优先级 / 数量 |
| `avatarMark(seed, name, size)` / `personChip(seed, name, size)` | `.avatar` / `.person` | 在 app.js 中通过 `avatar(id)`、`person(id)` 使用 |
| `heading(title, desc, actionsHtml, scope)` | `.page-heading` | 每个页面第一个元素 |
| `sectionHeading(title, { count, actionsHtml })` | `.section-heading` | 页面内二级标题 |
| `metric(...)` + `metricStrip([...])` | `.metrics-grid` | 关键数字，最多 4 个；tone：purple / blue / green / amber |
| `panel({ title, count, actionsHtml, introHtml, bodyHtml, noteHtml, padded })` | `.panel` | 内容容器 |
| `empty(...)` / `loading()` / `notice(text, tone)` | 反馈 | 见 5.4 |
| `detailList(rows)` / `progress(percent, label)` | 数据展示 | 键值网格 / 进度条 |
| `field` / `input` / `select` / `area` / `options` / `REQUIRED` | 表单 | 见 5.3 |
| `icon(name)` / `icons` / `BRAND_MARK` | 图标 | 24px 线性图标，stroke 1.7，继承 `currentColor` |
| `esc(value)` | 转义 | 所有用户内容进模板前必须转义；参数名带 `Html` 的表示已经是安全 HTML |

图标：新增图标时保持 24×24 画布、1.7 线宽、圆角端点，加入 `icons` 并在样式指南中可见。不要引入图标字体或外部图标库（CSP 只允许同源资源）。

---

## 7. 文案

- 中文界面，句末用中文标点；数字与单位之间空一格：`29 项`、`40 小时`、`共 102 天`。
- 按钮用「动词 + 对象」：新建需求、批量拆分任务、移出项目。不要写「确定」「提交」这类泛化文案（居中确认弹窗除外）。
- 空状态分两句：第一句说明现状，第二句给出下一步。
- 状态词以 `workflow.js` 为准，不要自造同义词（例如不要把「开发中」写成「进行中」）。
- 日期统一 `YYYY-MM-DD`；日期范围用 ` — `。

## 8. 响应式、深色模式与可访问性

- 断点：1240px（双栏变单栏）、1080px（指标条两列、登录页上下排列）、900px（侧栏收起为抽屉、表单单列）、560px（手机）。新页面在 375px 宽度下不能出现横向滚动（表格和甘特图容器内滚动除外）。
- 页面样式必须在浅色和深色下都检查一遍，样式指南右上角可切换主题。
- 所有可点击元素使用 `<button>` 或 `<a>`，图标按钮必须有 `aria-label`；焦点样式由 base 统一提供，不要去掉 outline。
- 颜色不是唯一信息：状态标签带文字，逾期同时显示「已逾期」文字。

---

## 9. 新增页面 / 模块步骤

1. 在 `/design-system.html` 找到最接近的现有模式和组件。
2. 在 `app.js`（或新建视图模块）里用 `heading` + `panel` + ui-kit 组件实现视图，注册路由与导航。
3. 只有现有组件无法满足时：
   - 可复用的新组件 → 在 `ui-kit.js` 加生成函数，在 `components.css` 加样式，在样式指南加样例，在本文件第 6 节登记；
   - 页面专属结构 → 新建 `design/pages/<页面>.css`，**同时**在 `index.html` 和 `design-system.html` 中引入。
4. 新增业务状态 → 在 `STATUS_TONES` 登记色调并更新 4.2 表格。
5. 新增颜色 → 按 4.1 的流程加令牌。
6. 运行 `npm test`（设计守卫测试会检查令牌、类名、内联样式、样式引入和状态色调）。
7. 启动服务，在浅色、深色、1440px 和 375px 下检查新页面，并打开样式指南确认没有影响现有组件。

### 评审自查清单

- [ ] 没有新增颜色字面量；内联样式只有几何量或 `--变量`
- [ ] 按钮、标签、头像、页头、空状态都来自 ui-kit
- [ ] 每个区域最多一个主按钮；破坏性操作有二次确认
- [ ] 详情 / 编辑用抽屉，确认用居中弹窗
- [ ] 空状态、加载中、失败三种状态都有处理
- [ ] 区块间距来自容器（`#view` / `.stack` / `.split` / 网格 gap），并排的栏顶对齐
- [ ] 浅色 / 深色、桌面 / 手机都检查过
- [ ] 用户输入全部经过 `esc()`
- [ ] 新组件、新令牌已同步到样式指南和本文件
