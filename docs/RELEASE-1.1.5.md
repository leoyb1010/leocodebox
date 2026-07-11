# leocodebox 1.1.5

发布日期：2026-07-11

## 重点修复

- 封堵已保存 Provider API Key 可被模型发现接口发送到任意 Base URL 的高危漏洞。
- 模型发现缓存升级为带密钥指纹的 v2 格式，并使用并发安全的 read-merge-write，避免重启后静默丢项。
- Provider 保存后的模型发现移到后台执行，不再阻塞 apply、rollback、delete 等配置事务。
- CLI 安装和更新增加同工具并发互斥，未知安装来源拒绝自动更新，避免 shadow 全局安装。
- 普通 HTTP/SSE 搜索认证改用 Authorization header，不再把 token 写入 URL。
- Provider 模板迁移为类型安全的 TypeScript 单一事实源，并强化 Registry 双向一致性校验。

## 性能与工程

- Markdown 语法高亮、工作区面板、设置、登录终端按需加载。
- 翻译资源按语言和 namespace 动态加载。
- 首屏入口 JS 从约 1.56 MB 降至约 585 KB，首屏不再 preload syntax、CodeMirror、xterm、KaTeX 等重型模块。
- 客户端测试改为递归发现；ESLint 覆盖 renderer、server、Electron 和 release scripts，门禁为零 warning。
- Husky pre-commit 与 commit-msg hooks 正式落地。

## 从 1.37.x 迁移

产品版本统一重置为 `1.1.5`。为了让已经安装 `1.37.0` 的用户收到该版本，`1.1.5` 的 macOS 更新元数据临时使用合成版本 `1.37.1`；应用安装后显示真实产品版本 `1.1.5`，并忽略该合成 feed 条目，后续继续按 `1.1.x` 正常升级。

正式发布仍必须经过 Developer ID 签名、公证、staple、重新下载验证后才能更新正式 feed。

## Workspace 2.0 架构升级

- `server/index.js` 中的文件系统 API 已迁移到 `server/modules/files/`，并增加路径穿越及符号链接逃逸测试。
- Claude、Codex、Cursor、OpenCode Runtime 已归入各自 Provider 模块；Agent、Git、TaskMaster、Leoapi 路由统一归入 `server/modules/`。
- Leoapi CLI 管理已拆为独立子路由，Git 前端请求统一经过 `apiRequest` / `ApiError`。
- Chat Composer、Projects、Sidebar Conversation Search、Git Panel 已开始按职责拆分，并补充状态转换、SSE、附件及 API 错误测试。
- Provider 卡片增加健康、降级、失败、未验证状态，以及经过用户确认并自动备份的备用 Provider 切换。
- CLI 版本漂移检查使用 24 小时 Registry 缓存，手动刷新和安装/更新后可强制重新检查。
- CLI 状态界面已覆盖全部 10 种支持语言。

## 已完成的本地产物验证

2026-07-11 已完成以下未签名本地交付验证：

- `npm run desktop:pack` 成功，打包应用可使用隔离 profile 启动。
- 打包应用健康接口返回产品版本 `1.1.5`，Provider 控制面返回 4 个 Runtime、8 个 Manifest 和 16 个模板。
- `better-sqlite3` 原生模块可在 Electron 运行时加载，应用退出后后端端口正常释放。
- `npm run desktop:dist:mac` 成功生成并通过 `hdiutil verify`：
  - `release/desktop/leocodebox-1.1.5-mac-arm64-unsigned.dmg`
- 从 DMG 重新挂载检查确认：
  - `CFBundleShortVersionString = 1.1.5`
  - `CFBundleVersion = 1.37.1`
  - 应用内 `package.json version = 1.1.5`
  - `app-update.yml` 存在
  - 深度代码签名结构校验通过（本地 ad-hoc 签名）
- 未签名构建不会生成 updater ZIP 或 `latest-mac.yml`，避免被误上传为正式更新。

上述验证不替代正式 Developer ID 签名、公证、staple、Gatekeeper 和真实下载更新验证。
