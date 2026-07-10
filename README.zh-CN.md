# leocodebox

leocodebox 是一个本地优先的 macOS 桌面应用，用来控制本机 coding agents。

打开应用时，macOS 壳会自动启动内置本地服务；退出应用时会自动停止服务。不需要账号登录，也不连接托管云端环境。

## 本地模式

- 默认只绑定 `127.0.0.1`。
- 桌面壳会向自己的本地 WebView 注入一次性本地能力 token。
- 云端账号和托管环境入口在这个构建中关闭。
- Web push 和远程服务下载在这个构建中关闭。

## Provider Switch

leocodebox 内置本地 Provider Switch，可保存并应用多套 agent 配置：

- Claude Code
- Codex
- Gemini CLI
- OpenCode
- Hermes Agent
- Cursor 状态记录

写入配置前会自动备份原文件；API 返回会脱敏密钥。

## 许可证与声明

leocodebox 以 AGPL-3.0-or-later 分发。

本分发版基于 CloudCLI UI，并保留 `LICENSE` 与 `NOTICE` 中要求的第三方声明。
