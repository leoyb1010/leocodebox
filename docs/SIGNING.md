# macOS 代码签名与公证

让 leocodebox 能在别人的 Apple 芯片 Mac 上双击直接运行（不被 Gatekeeper 拦、不用敲 `xattr`），需要用 **Developer ID Application** 证书签名并经 Apple **公证**。

无签名环境变量时，`npm run desktop:dist:mac` 仍产出可自用的 adhoc DMG（行为不变）。

## 一次性准备

1. **加入 Apple Developer Program**（个人 99 美元/年）。
2. **创建 Developer ID Application 证书**（Xcode 不会自动建）：
   Xcode → Settings → Accounts → 选中团队 → **Manage Certificates** → 左下 `+` → **Developer ID Application**。
   验证：
   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   记下完整名字，形如 `Developer ID Application: 你的名字 (TEAMID)`。
3. **存公证凭据到钥匙串**（密码只输入在你自己的终端，不进仓库、不经过任何工具）：
   ```bash
   xcrun notarytool store-credentials "leocodebox" \
     --apple-id "你的appleid@邮箱" \
     --team-id  "TEAMID" \
     --password "app专用密码"   # appleid.apple.com 生成
   ```

## 每次出正式版

```bash
export LEOCODEBOX_SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
npm run desktop:dist:mac:signed        # 用 Developer ID 签名并打包 DMG
npm run desktop:notarize:mac           # notarytool 公证 + stapler 钉章（用钥匙串 profile）
```

## 验证

```bash
codesign -dv --verbose=4 "release/desktop/mac-arm64/leocodebox.app"   # 应显示 Developer ID，非 adhoc
spctl -a -vvv --type install "release/desktop/leocodebox-1.36.1-mac-arm64.dmg"  # 应 accepted / Notarized
```

两条通过后，别人下载双击即可运行。

## 相关文件

- `build/entitlements.mac.plist` — hardened runtime 下 Electron/子进程所需 entitlement。
- `scripts/release/prepare-desktop-app.js` — `resolveMacBuildConfig()` 在设了 `LEOCODEBOX_SIGN_IDENTITY` 时注入签名配置。
- `scripts/release/notarize-mac.sh` — 公证 + 钉章（`desktop:notarize:mac`）。
