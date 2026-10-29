# 星河命令行工具

供人工智能助手或团队成员查询项目、评估需求提议、录入已确认需求、创建任务、调整排期。0.4.0 适配当前平台的提议与需求分流、研发阶段自动同步、承诺排期独立保留等流程。独立调用现有平台后端，不直接访问数据库，不修改网页或服务器代码。没有内置平台地址或固定端口。

## 安装

需要 Node.js（运行环境）22.23 或以上版本。没有第三方依赖。在本工具目录执行：

```sh
npm install --global .
xinghe --help
```

也可以免安装使用 `node bin/xinghe.mjs --help`，后续命令中的 `xinghe` 替换为 `node bin/xinghe.mjs`。工具必须安装在助手能够执行命令的环境中。

## 本机连接

把下方地址替换成启动器当前显示的网页地址；端口变化后重新配置。

```sh
xinghe config set-url http://127.0.0.1:51617 --profile local
xinghe health --profile local
xinghe auth login --username admin --profile local
xinghe project list --profile local
```

`local`（本机环境）是自定义名称。地址指向平台网页入口，网页代理会转发 `/api`（后端接口）请求。本机地址只有在工具与平台位于同一台机器时才指向该平台。

登录时由用户在自己的终端输入密码，输入不显示，密码不保存。不要把密码交给助手对话或放进命令参数。工具不会读取浏览器登录状态；本版没有浏览器授权回调。`--password-stdin`（从标准输入读取密码）仅用于受控的自动化秘密输入通道，不要把密码字面量写进脚本或命令历史。

## 部署后切换地址

```sh
xinghe config set-url https://your-platform.example.com --profile production
xinghe auth login --username your-account --profile production
xinghe project list --profile production
```

`production`（正式环境）与 `local`（本机环境）分开配置，地址和账号均需替换成实际值。非本机地址必须使用 HTTPS（加密连接）。平台支持子路径部署时，可以配置包含子路径的入口地址。工具不会自动跟随重定向，请填写最终入口地址。

地址优先级：`--url`（本次地址）＞`XINGHE_URL`（地址环境变量）＞`--profile`（所选环境）中保存的地址。默认环境名是 `default`（默认环境）；使用命名环境时每次携带 `--profile`。可用 `config show`（查看配置）检查生效地址。

凭证同时按环境名和完整入口地址隔离。换端口、域名或路径后必须单独登录，旧凭证不会自动转发。返回原地址时，原会话若仍有效可继续使用。永久迁移前建议先在旧地址执行 `auth logout`（退出账号）。

## 给助手使用

先查询项目及成员，使用返回的真实编号，不能猜测编号：

```sh
xinghe project list --profile local
xinghe project members p-exec --profile local
xinghe proposal list --project p-exec --query 导出 --profile local
xinghe requirement list --project p-exec --query 导出 --profile local
xinghe proposal create --project p-exec --title "增加需求导出功能" --priority P1 --profile local
```

其中项目编号只是原项目的示例，执行前需确认目标。尚待评估的内容使用 `proposal`（需求提议）创建，默认进入“待评估”；`requirement create`（创建需求）直接进入“已确定”，必须填写背景与目标、验收标准。查询可以辅助人工检查重复，但单条创建没有幂等键，不保证重复请求去重。

复杂内容通过 JSON（结构化数据）文件输入。例如 `requirement.json`（需求数据文件）：

```json
{
  "projectId": "p-exec",
  "title": "增加需求导出功能",
  "description": "支持按当前筛选条件导出需求。",
  "acceptance": "导出条数与筛选结果一致。",
  "priority": "P1"
}
```

字段含义：`projectId`（项目编号）、`title`（标题）、`description`（背景与目标）、`acceptance`（验收标准）、`priority`（优先级）。

```sh
xinghe requirement create --data-file requirement.json --dry-run --profile local
xinghe requirement create --data-file requirement.json --profile local
xinghe schema
```

`--dry-run`（请求预览）不写入数据；单条操作只显示请求，批量导入会先查询项目、同名记录与文档。预览不代表服务器校验通过。`schema`（字段说明）列出提议、需求和任务支持的字段。文件与参数重复指定同一字段会被拒绝，避免静默覆盖。

### 提议评估与确认

```sh
xinghe proposal get q-实际编号 --profile local
xinghe proposal history q-实际编号 --profile local
xinghe proposal update q-实际编号 --version 当前版本 --status 评估中 --profile local
xinghe proposal approve q-实际编号 --version 当前版本 --profile local
```

每次修改前重新查询实际版本号。评估状态包括“待评估、评估中、待补充、暂缓、不采纳”；改为“待补充、暂缓、不采纳”时，通过 `--data`（内联数据）或 `--data-file`（数据文件）提供 `decisionReason`（评估说明）。只有产品经理或管理员可以评估和确认。`proposal approve`（确认转需求）要求背景与目标、验收标准完整，保留提议记录和文档关联，返回关联的“已确定”需求；不会删除原提议。历史“未确定 / 待评审”内容也从提议入口评估，确认时保留原需求编号。

## 任务与排期

```sh
xinghe task create --project p-exec --requirement r-实际编号 --title "实现导出接口" --hours 8 --profile local
xinghe task get t-实际编号 --profile local
xinghe task history t-实际编号 --profile local
xinghe task schedule t-实际编号 --version 1 --start 2026-09-21 --end 2026-09-23 --profile local
xinghe schedule list --project p-exec --from 2026-09-01 --to 2026-12-31 --profile local
```

`--hours`（估算工时）仅限任务；`--version`（记录版本号）必须使用刚查询的实际值，示例中的 1 不是固定值。被他人修改后，后端会拒绝旧版本；工具不会自动刷新版本后强行覆盖。`task history`（任务历史）可以核对修改记录。需求承诺排期使用 `requirement schedule`（调整需求承诺排期），日期映射为 `planStart`（承诺开始日期）与 `planEnd`（承诺结束日期）。任务日期汇总出的研发区间与承诺区间独立保留。

`schedule list`（排期查询）默认按日期区间相交返回任务，日期缺失或反向的记录单列；加 `--kind requirement`（需求类型）后，默认按有效任务汇总的研发区间筛选，没有任务日期时才退回承诺区间，并输出日期来源及承诺信息。加 `--basis commitment`（按承诺日期）可单独查询承诺区间。不带 `--project`（项目）时查询全部可见项目。复杂更新使用 `update`（修改）配合数据文件。

### 按当前平台流程拆分与排期

平台的流程是：提议评估并确认 → “已确定”需求 → 主开发拆分任务、指定主责和负责人、填写工时及任务日期 → 后端按准备条件和任务进度自动同步研发阶段。禁止通过需求更新手动推进“待排期、已排期、开发中、测试中”等研发阶段；最终验收仍由人工确认。`xinghe schema`（字段与规则说明）列出状态和角色规则。

```sh
# 主开发批量拆分：整包校验，要么全部创建要么不创建
xinghe task batch --requirement r-实际编号 --version 需求当前版本 --data-file tasks.json --profile local
```

`tasks.json`（任务数组）每项字段同 `task create`，例如 `[{"title":"实现导出接口","ownerId":"u-成员编号","estimateHours":8,"startDate":"2026-09-21","dueDate":"2026-09-22"}]`。命令输出 `requestId`（提交编号）；网络中断时用同一个 `--request-id` 重试，平台返回首次结果，不会重复创建。

```sh
# 需求批量改期：先预览，再用同一文件和预览令牌提交
xinghe schedule preview --project p-实际编号 --data-file changes.json --profile local
xinghe schedule apply --project p-实际编号 --data-file changes.json --token 预览令牌 --reason "改期原因" --profile local
```

`changes.json`（改期数据文件）每项为 `{"requirementId":"…","version":当前版本,"planStart":"YYYY-MM-DD","planEnd":"YYYY-MM-DD"}`。字段分别表示需求编号、当前版本、承诺开始日期、承诺结束日期；日期格式为年-月-日。承诺超出项目目标日期时预览会提示，确认后 `apply`（应用改期）加 `--force`（接受超期）。这类操作明确修改承诺区间，首次承诺按平台规则建立基线。

验收退回与重新打开使用专用动作，并提供原因：

```sh
xinghe requirement return r-实际编号 --version 当前版本 --reason "导出结果缺少必要字段" --data '{"taskIds":["t-实际编号"]}' --profile local
xinghe requirement reopen r-实际编号 --version 当前版本 --reason "补充已确认的修复工作" --profile local
```

`return`（退回研发）中的 `taskIds`（需返工的任务编号）应来自当前需求；`reopen`（重新打开）保留原记录及关联。可用 `requirement history`（需求历史）核对流转结果。动作的适用阶段和权限由后端检查。

归档与恢复：`requirement archive|restore <编号> --version <版本号>`、`task archive|restore …`。个人待办与站内提醒：`xinghe work`。

### 项目文档

```sh
xinghe document list --project p-实际编号 --profile local
xinghe document versions d-实际编号 --profile local
xinghe document download d-实际编号 --profile local                 # 内容直接输出在 data.content
xinghe document download d-实际编号 --doc-version 1 --output prd-v1.md --profile local
xinghe document upload --project p-实际编号 --file PRD.md --type PRD --note "评审后修订" --profile local
xinghe document upload --project p-实际编号 --document d-实际编号 --file PRD.md --note "补充重试规则" --profile local
```

文档支持 Markdown、文本、`.feature`、HTML 和 JSON，UTF-8 编码，单个不超过 2 兆字节。`--output` 不会覆盖已有文件。上传新版本时带 `--document`，工具会先查询当前版本号，别人刚上传过新版本时平台拒绝，避免覆盖。需求详情（`requirement get`）中的 `docRefs` 给出关联的文档与章节编号。

## 从 PRD（产品需求文档）拆需求、任务并排期

`skills/xinghe-prd-planning/SKILL.md`（需求规划技能文件）是给助手用的技能：把产品需求文档体系交给助手，它会用本工具上传文档、拆出提议或已确认需求并按章节关联、拆 2～3 天粒度的研发任务、按工作日历与人员产能排期，关键决策点先问你。安装到 Claude Code（克劳德编程助手）：

```sh
mkdir -p ~/.claude/skills && cp -R skills/xinghe-prd-planning ~/.claude/skills/
```

其他助手按各自的技能目录放置同一文件夹即可。技能使用的主要命令：

```sh
# 尚未确认的清单导入为提议，后续评估并确认
xinghe proposal import --project p-实际编号 --data-file proposals.json --dry-run --profile local
xinghe proposal import --project p-实际编号 --data-file proposals.json --profile local

# 已确认的清单直接导入需求，背景与目标、验收标准必填
xinghe requirement import --project p-实际编号 --data-file reqs.json --dry-run --profile local
xinghe requirement import --project p-实际编号 --data-file reqs.json --profile local

# 自动排期：按阶段与顺序把任务放进每个人的工作日历，默认接在其已有未完成任务之后
xinghe plan preview --project p-实际编号 --data-file plan.json --profile local
xinghe plan apply --project p-实际编号 --data-file plan.json --profile local   # 主开发或管理员账号；晚于目标或承诺需明确接受冲突
```

计划文件与需求文件的完整示例见 `skills/xinghe-prd-planning/references/`（技能示例目录）。两种导入都只按当前项目内同类型的已有同名记录跳过，不更新同名内容；导入需求时若发现同名待评估提议，会提示先确认提议以保留关联。它们也不保证并发导入幂等；网络中断后先查询核对，再决定是否重跑。导入预检会检查 `docRefs`（关联文档章节）与 `acceptanceCases`（验收用例编号）的引用。

`plan apply`（应用任务规划）只对已确认且未结束的需求批量创建任务、设置主责开发与协作人，研发阶段由后端自动同步。它保留已有承诺日期和基线；即使没有承诺，也只输出建议日期，不自动写入承诺。需要承诺交付日期时，另用 `requirement schedule`（调整需求承诺排期）或 `schedule preview/apply`（批量承诺改期预览 / 应用）。建议交付晚于项目目标、研发结束晚于现有承诺或阶段结束晚于节点时需加 `--force`（接受冲突），该选项不修改承诺。已有其他任务的需求会跳过；即使任务全部归档，无法确认来源时也不会重建。重跑同一计划不会重复创建任务，也不会重写已完成的规划或覆盖人工改期。任务批量创建使用稳定的提交编号；整份多需求计划并非单一事务，部分失败后先核对已完成项再重跑。

## 登录凭证与输出

- 默认配置目录 `~/.config/xinghe`；可通过 `XINGHE_CONFIG_DIR`（配置目录环境变量）更改，给不同助手使用独立目录。
- 本机目录权限 0700、文件权限 0600。保存会话凭证及防跨站请求令牌，不保存密码；本地文件不是加密保险库，不应共享或打包。
- 权限与登录账号一致，由服务器检查。本版复用现有账号会话，默认 12 小时过期，没有另外增加只读令牌或项目范围授权页面。可用已有项目角色限制助手权限。
- `auth me`（查看当前账号）输出安全账号信息；`auth logout`（退出账号）撤销当前会话并移除本地凭证。账号停用、改密等现有后端规则仍生效。
- 成功在标准输出返回 `{ "ok": true, "server": "…", "profile": "…", "data": {} }`；失败在标准错误输出错误对象，退出码为 1。帮助输出为纯文本。
- 输出中的 `server`（实际平台地址）、`profile`（环境名）、`data`（业务结果）、`code`（错误码）、`requestId`（请求编号）供助手核对。
- 写操作不自动重试。网络断开时服务器可能已保存，必须先查询核对；不要直接重试创建造成重复需求。

## 测试与分发

```sh
npm test
npm pack
```

源码中的测试复用相邻服务器项目（`../../星河研发台_服务器版`，或 `XINGHE_SERVER_ROOT` 指定）的真实业务及请求处理逻辑，使用内存数据库；不修改现有业务数据库，不占用端口。服务器升级后先在这里跑 `npm test`，确认命令仍与后端接口一致。分发包仅包含命令入口、源代码和说明，不包含登录凭证、服务器数据库、测试或原始项目数据。尚未发布到公共软件仓库。
