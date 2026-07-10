# leocodebox

![version](https://img.shields.io/badge/version-1.36.1-blue)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)
![signed](https://img.shields.io/badge/signed-Developer%20ID%20%2B%20Notarized-brightgreen)
![license](https://img.shields.io/badge/license-AGPL--3.0-orange)

**leocodebox** 是一个本地优先的 macOS 桌面应用，用来在一个界面里统一管理本机的 AI 编码 Agent CLI —— Claude Code、Codex、Cursor、OpenCode。无需注册、无需云端账号，打开即用。

> English: leocodebox is a local-only macOS desktop app that unifies the management of local coding-agent CLIs (Claude Code, Codex, Cursor, OpenCode) — projects, sessions, skills, MCP servers, and provider configuration — with no cloud account required.

---

## ✨ 特性

- **本地优先，零云端**：打开 App 自动在 `127.0.0.1:38473` 启动本地服务，退出即停止并释放端口。数据存本机 `~/.leocodebox/`，不上传云端。
- **多 Agent 统一管理**：在一个界面里管理 Claude Code / Codex / Cursor / OpenCode 的认证、模型、权限模式、会话、Skills 和 MCP。
- **实时 CLI 版本与一键更新**：设置页显示每个 CLI 的实时版本，检测 npm 上的新版本，并支持一键自更新（`claude update` / `codex update` / `opencode upgrade` / `cursor-agent update`）。
- **模型列表自动跟随 CLI**：模型目录随本机 CLI 更新自动刷新（例如 Codex 升级后自动出现新一代模型），带源文件指纹失效机制。
- **CC Switch 内置整合**：Provider 配置切换器内置在应用内（不跳外部 App），支持新增/编辑/应用/删除 Provider、连通性与延迟测试、备份恢复，并可从原生 CC Switch 数据库(`~/.cc-switch/cc-switch.db`)一键导入。
- **项目按 Agent 分类**：侧边栏项目列表按 Claude / Codex / OpenCode / Cursor / Gemini 显示彩色会话计数徽章，并过滤一次性/临时目录，只留真实项目。
- **简体中文默认**，深色/浅色/跟随系统主题。
- **单用户本地账号**：桌面模式免登录；也支持用户名/密码登录（bcrypt + JWT）。
- **签名 + 公证发布**：提供 Apple Developer ID 签名并经 Apple 公证的 DMG，别人下载双击即可运行，无 Gatekeeper 警告。

## 🖥️ 支持的 Agent

| Agent | 说明 | 认证方式 |
|---|---|---|
| **Claude Code** | Anthropic 官方 CLI | `claude /login` / API Key / settings.json |
| **Codex** | OpenAI Codex CLI | ChatGPT 登录 / `OPENAI_API_KEY` |
| **Cursor** | Cursor Agent CLI | `cursor-agent login` |
| **OpenCode** | OpenCode CLI | OAuth / Provider API Key |

> Agent CLI 本身不打包在应用内——leocodebox 检测并驱动本机已安装的 CLI。

## 🏗️ 架构

```
┌─────────────────────────────────────────────┐
│  Electron 外壳 (electron/)                    │
│  · 启动台 launcher + 多 Tab (BrowserView)     │
│  · 生命周期：启动拉起服务 / 退出停止服务         │
└───────────────┬─────────────────────────────┘
                │ 本地 HTTP 127.0.0.1:38473
┌───────────────▼─────────────────────────────┐
│  本地服务 (server/) — Node + Express          │
│  · Providers / Projects / Sessions / MCP      │
│  · Skills / Git / CC Switch / Agent API       │
│  · SQLite  ~/.leocodebox/auth.db               │
└───────────────┬─────────────────────────────┘
                │ 静态托管
┌───────────────▼─────────────────────────────┐
│  前端 (src/ → dist/) — React + Vite           │
│  · Tailwind + shadcn/ui · react-i18next        │
│  · CodeMirror 编辑器 · xterm 终端              │
└─────────────────────────────────────────────┘
```

- **技术栈**：Electron · Node/Express · SQLite(better-sqlite3) · React 18 · Vite · TypeScript · Tailwind CSS · react-i18next
- **平台**：macOS **arm64**（Apple 芯片）

## 📦 安装

从 Releases 下载已签名并公证的 DMG（macOS Apple 芯片）：

1. 双击 DMG，把 **leocodebox** 拖入「应用程序」。
2. 双击运行——已 Developer ID 签名 + Apple 公证，无需 `xattr` 去隔离。
3. 首次打开自动启动本地服务，直接进入界面。

## 🔧 从源码构建

```bash
# 依赖
npm install

# 开发（前端 + 服务并行）
npm run dev

# 桌面开发（Electron 指向本地服务）
npm run desktop:dev

# 完整构建（前端 + 服务）
npm run build

# 打包桌面 DMG（自用 adhoc 签名）
npm run desktop:dist:mac
```

质量检查：`npm run typecheck` · `npm run lint`

> 注意：运行时原生依赖（better-sqlite3 等）按 Electron ABI 编译，服务端脚本需用 Electron 的 Node 运行。

## 🖊️ 签名与公证（对外分发）

要产出别人下载双击即可运行的 DMG，需要 Apple Developer ID 证书 + 公证。完整步骤见 **[docs/SIGNING.md](docs/SIGNING.md)**：

```bash
# 一次性：Xcode 创建 Developer ID Application 证书 + 存公证凭据
xcrun notarytool store-credentials leocodebox --apple-id <id> --team-id <TEAMID> --password <app专用密码>

# 每次出正式版
export LEOCODEBOX_SIGN_IDENTITY="Developer ID Application: <名字> (<TEAMID>)"
npm run desktop:dist:mac:signed     # 签名并打包 DMG
npm run desktop:notarize:mac        # 提交 Apple 公证 + 钉章
```

## 📁 项目结构

```
electron/        Electron 主进程、启动台、窗口/Tab 管理、本地服务生命周期
server/          本地 Node/Express 服务：providers / projects / sessions / mcp / git / cc-switch
src/             React 前端（组件、hooks、i18n、状态）
shared/          前后端共享工具
build/           签名 entitlements
scripts/release/ 构建、暂存、签名、公证脚本
docs/            SIGNING.md 等文档
dist/ dist-server/  构建产物（不入库）
```

## 🔒 本地与隐私

- 服务绑定 `127.0.0.1`，桌面模式用每次启动生成的本地能力 token。
- 云账号、托管环境、Web Push、远程下载在本构建中禁用。
- 所有配置与凭据存本机 `~/.leocodebox/`，不外发。

## 📄 许可与归属

leocodebox 以 **AGPL-3.0-or-later** 分发。

本项目基于 CloudCLI UI（`https://github.com/siteboon/claudecodeui`），并在 `LICENSE` 与 `NOTICE` 中保留所需的法律声明与第三方归属。请勿移除这些声明。
