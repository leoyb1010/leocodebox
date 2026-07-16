# leocodebox 1.49.5

热修复:打包应用里「本机智能体」读不出状态(spawn EBADF),以及 Grok 图标用了占位花括号。

## 修了什么

**[严重] 本机智能体状态读取失败:`spawn EBADF`**
- 现象:设置 →「本机智能体」顶部红字「无法读取本机智能体状态: spawn EBADF」,各 CLI 的安装/版本/登录状态全读不出来。
- 根因:CLI 探针的共享函数 `runCliCommand` 用 `execFile` 且**继承默认的 stdin 管道**。从访达/Dock 启动的打包 GUI 应用**没有真正的 stdin**,libuv 给子进程建 stdin 管道时失败 → `spawn EBADF`。从终端启动有 stdin 就正常,所以这个 bug 只在双击启动的正式包里出现(单测/终端跑都测不出)。对照:其它同类探针(taskmaster、cli-version)早就用 `stdio: ['ignore','pipe','pipe']`,从不报错。
- 修复:把 `runCliCommand` 改写为 `spawn` + `stdio: ['ignore','pipe','pipe']`(stdin 走 /dev/null)+ 手动收集输出/超时,和其它探针对齐。真机(双击启动的正式包)验证:`/api/leocodebox/cli/status` 由 `spawn EBADF` 变为正常返回各 CLI 状态。

**Grok 图标换成官方标识**
- `GrokLogo` 之前是占位的花括号 `{}`(lucide Braces)。换成 xAI Grok 官方双弧标识 SVG,用 `currentColor` 适配明暗主题,并移除源 SVG 里重复的 `id`。

## 验证

- 门禁全绿:客户端/服务端 typecheck、ESLint 0 警告、生产构建通过;测试 366(desktop 27 + client 70 + server 269)。
- 真机双击启动正式包:「本机智能体」状态正常读出(claude/codex/cursor/opencode/grok 安装与版本);Grok 图标显示为官方标识。

## 下载校验

- DMG SHA-256:`<DMG_SHA>`
- ZIP SHA-256:`<ZIP_SHA>`
- `latest-mac.yml` SHA-256:`<YML_SHA>`
