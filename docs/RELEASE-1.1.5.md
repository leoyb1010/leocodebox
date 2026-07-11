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
