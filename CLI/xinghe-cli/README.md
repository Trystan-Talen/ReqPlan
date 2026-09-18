# 星河命令行工具

供人工智能助手或团队成员查询项目、录入需求、创建任务、调整排期。独立调用现有平台后端，不直接访问数据库，不修改网页或服务器代码。没有内置平台地址或固定端口。

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
xinghe requirement list --project p-exec --query 导出 --profile local
xinghe requirement create --project p-exec --title "增加需求导出功能" --priority P1 --profile local
```

其中项目编号只是原项目的示例，执行前需确认目标。创建需求默认进入“未确定”，后续状态流转遵守后端评审规则。查询可以辅助人工检查重复，但当前后端没有创建幂等键，不保证重复请求去重。

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

字段含义：`projectId`（项目编号）、`title`（标题）、`description`（描述）、`acceptance`（验收标准）、`priority`（优先级）。

```sh
xinghe requirement create --data-file requirement.json --dry-run --profile local
xinghe requirement create --data-file requirement.json --profile local
xinghe schema
```

`--dry-run`（请求预览）只显示将要发送的内容，不发送、不保存，也不代表服务器校验通过。`schema`（字段说明）列出需求和任务支持的字段。文件与参数重复指定同一字段会被拒绝，避免静默覆盖。

## 任务与排期

```sh
xinghe task create --project p-exec --requirement r-实际编号 --title "实现导出接口" --hours 8 --profile local
xinghe task get t-实际编号 --profile local
xinghe task schedule t-实际编号 --version 1 --start 2026-09-21 --end 2026-09-23 --profile local
xinghe schedule list --project p-exec --from 2026-09-01 --to 2026-12-31 --profile local
```

`--hours`（估算工时）仅限任务；`--version`（记录版本号）必须使用刚查询的实际值，示例中的 1 不是固定值。被他人修改后，后端会拒绝旧版本；工具不会自动刷新版本后强行覆盖。需求排期使用 `requirement schedule`（调整需求排期），日期字段会映射为需求的计划日期。

`schedule list`（排期查询）按日期区间相交返回任务，日期缺失或反向的记录单列。没有固定两周限制。本版不提供批量原子提交、人员负荷计算、依赖关系推算或自动排程。复杂更新使用 `update`（修改）配合数据文件。

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

源码中的测试复用相邻服务器项目的真实业务及请求处理逻辑，使用内存数据库；不修改现有业务数据库，不占用端口。分发包仅包含命令入口、源代码和说明，不包含登录凭证、服务器数据库、测试或原始项目数据。尚未发布到公共软件仓库。
