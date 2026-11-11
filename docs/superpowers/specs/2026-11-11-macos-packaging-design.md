# TraceField macOS 打包设计

## 目标

在 macOS 上通过一个命令分别生成 Apple Silicon（arm64）和 Intel（x64）的 DMG 安装包与 ZIP 应用包，同时保持现有 Windows 打包行为兼容。

## 配置方案

- 在 `package.json` 中新增 `dist:mac`，构建应用后调用 `electron-builder` 的 macOS 目标，并同时指定 arm64 与 x64。
- 新增 `dist:win`，承载当前 Windows x64 ZIP 打包命令。
- 保留 `dist` 作为 `dist:win` 的兼容别名，避免改变已有发布流程。
- 在 `build.mac` 中配置 `dmg` 和 `zip` 两种目标。
- 使用包含平台和架构的产物名称，确保四个 macOS 产物不会相互覆盖。
- 本次使用 Electron 默认应用图标；项目后续提供 `.icns` 文件后可单独替换。

## 签名与分发

本次不写入证书或 Apple 账户信息。`electron-builder` 可以在构建环境提供 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 时使用 Developer ID 证书签名。未提供证书时仍允许生成本地测试包。

Apple 公证需要额外的账户凭据、联网步骤和发布约束，本次不强制启用。README 会明确：未签名、未公证的包在其他 Mac 上可能被 Gatekeeper 拦截；正式外部分发前应补充公证流程。

## 文档

README 增加：

- macOS 双架构打包命令。
- arm64/x64 的 DMG 与 ZIP 预期产物。
- 可选签名环境变量。
- 未公证包的 Gatekeeper 限制。

## 验证

1. 运行 TypeScript 类型检查。
2. 运行现有测试。
3. 在当前 Mac 上执行双架构 macOS 打包。
4. 检查 `release` 中四种预期产物均存在且架构名称明确。

Windows 打包不在 Mac 上交叉验证，但通过保留原命令参数避免改变其行为。
