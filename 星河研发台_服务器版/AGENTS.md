# 项目约定

## 数据保留

界面与架构优化必须复用用户确认的真实项目内容；迁移时保留原编号和关联，并核对项目、需求、任务及附件，不得用演示数据替换。

## 界面设计系统（强制）

修改或新增任何界面（页面、模块、组件、弹窗、样式）之前，必须先阅读 [DESIGN.md](DESIGN.md)。设计系统的实现位于：

- `frontend/design/tokens.css`：设计令牌，**唯一**允许出现颜色值的文件
- `frontend/design/{base,components,layout}.css` 与 `frontend/design/pages/*.css`：分层样式
- `frontend/ui-kit.js`：组件生成函数（按钮、状态标签、头像、页头、指标、面板、空状态、提示、表单字段）
- `frontend/design-system.html`：活样式指南（启动服务后访问 `/design-system.html`，无需登录）
- `backend/tests/design-system.test.mjs`：设计守卫测试

必须遵守：

1. **只用令牌。** 不在 `tokens.css` 之外写颜色字面量；内联 `style` 只允许 `left/right/top/width/height/flex` 和 `--自定义属性`。需要新颜色时先加令牌并在 DESIGN.md 登记。
2. **先用组件。** 按钮、状态、优先级、头像、页头、指标条、面板、空状态、提示、表单字段一律使用 `ui-kit.js`，不要手写同类结构或复制旧模板里的 HTML。业务状态的颜色只通过 `STATUS_TONES` 映射。
3. **按模式搭页面。** 页头 → 指标条（可选）→ 面板；详情与编辑用右侧抽屉 `openDialog(..., 'drawer')`，确认用 `'center'`，预览用 `'wide'`；每个区域最多一个主按钮。
4. **样式放对层级。** 可复用组件进 `components.css`（并在 ui-kit 和样式指南中补样例）；页面专属样式新建 `design/pages/<页面>.css`，同时在 `index.html` 和 `design-system.html` 中引入。不要新增全局 CSS 文件，不要在页面样式里覆盖组件外观。
5. **不要削弱守卫测试。** `design-system.test.mjs` 失败时修改代码，而不是放宽测试；确需结构钩子类时登记到 `HOOK_CLASSES` 并写明原因。
6. **交付前检查。** 运行 `npm test`；在浅色 / 深色主题、1440px / 375px 宽度下检查改动页面，并打开样式指南确认现有组件未受影响。
