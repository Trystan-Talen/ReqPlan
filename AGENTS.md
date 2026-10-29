# 工作区约定

当前维护的源码位于 `星河研发台_服务器版/`。在该目录下工作前，先阅读：

- [星河研发台_服务器版/AGENTS.md](星河研发台_服务器版/AGENTS.md)：项目约定（数据保留、界面设计系统强制规则）
- [星河研发台_服务器版/DESIGN.md](星河研发台_服务器版/DESIGN.md)：界面设计规范

根目录下的 `public/`、`server.js`、`index.html`、`legacy-prototype.html` 是旧版本，仅供回溯，不要在其中新增功能或样式。

## 分支工作流（main / dev）

本项目采用 `main` / `dev` 分支工作流，所有 agent 与协作者必须遵守以下规则：

1. **`main` 是稳定分支**，日常开发不得直接在 `main` 上提交或推送。
2. **日常开发默认在 `dev` 上进行**。开始工作前先检查当前分支、远程仓库状态和已有未提交改动，**不得丢弃、覆盖或回退已有工作**（禁止用 `git checkout -- .`、`git reset --hard`、`git clean -fd` 等破坏性操作）。
3. 用户只说 **“push” / “上传代码”** 时，默认**仅推送到远程 `dev`**，不表示允许合并 `main`，也不表示允许发布上线。
4. **只有用户明确要求“合并 main”时**，才发起 `dev → main` 的 PR；必须检查通过并完成验收后，才允许合并。
5. **不得擅自强制推送**（`push --force`）、**不得删除 `main` / `dev` 分支**，不得修改或绕过分支保护规则。遇到阻碍应**报告原因**，不得自行绕过。
6. 推送认证：本机无全局 gh CLI，token 存放于 macOS 钥匙串 `gh:github.com`；需要推送时临时将 token 写入 remote URL，**推完立即恢复为不含 token 的干净 URL**。

### 常用命令

```bash
# 开工前检查
git branch --show-current && git status && git fetch origin

# 日常提交与推送（仅 dev）
git add -A && git commit -m "..." && git push origin dev

# 合并到稳定分支（仅在用户明确要求时执行）
git checkout main && git merge dev && git push origin main

# 或发起 PR：dev → main
```
