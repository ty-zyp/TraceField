# TraceField

离线桌面查看器，支持 Windows 和 macOS，可查看 LDS 激光路径、三维网格和点云。Windows 用户解压 Windows x64 ZIP 后，运行其中的 `TraceField.exe`；macOS 用户可打开 DMG 并将 TraceField 拖入 Applications，或解压 ZIP 后打开 `TraceField.app`。打开或拖入 G-code、NC、TAP、NGC、GLB、OBJ、PLY 或 PCD 文件。

G-code 默认使用 XY 顶视，可切换到三维视角。进度条按累计路径长度定位，包含快移和关光移动。1× 将完整路径播放约 15 秒。XYZ 以毫米显示，初始程序位置设为 (0, 0, 0)。遇到超出首版支持范围的指令时，查看器显示出错行以及之前已解析的路径。

使用 `G25` 的内雕点文件默认以三维视角打开，播放按内雕点和移动指令的顺序推进。带 LDS 水晶文件头时，Z 显示折射率校正后的层高。无水晶文件头的点文件使用程序中的 Z 坐标。点击「功率灰度」可以按 `S` 值查看相对亮度。

GLB 使用内嵌资源，OBJ 使用文件中的几何与点。首版对单个三维模型设置 512 MiB 的读取保护上限，对 G-code 设置 200 万渲染线段的保护上限。加载表现取决于几何复杂度和电脑配置。

## 开发与验证

需要 Node.js 22.13+ 和 pnpm 11。首次在项目目录安装依赖。

```powershell
pnpm install --frozen-lockfile
```

之后在项目目录启动开发版。

```powershell
pnpm dev
```

首次启动会自动准备 Electron 运行时，然后打开开发窗口。Vue、CSS 和渲染端代码保存后会热更新或刷新页面，主进程代码改动后会自动重启 Electron。终端按 `Ctrl+C` 可停止开发环境。

运行测试、生成 Windows x64 ZIP 或生成 macOS x64/arm64 的 DMG 和 ZIP 时，分别使用以下命令。

```powershell
pnpm test
pnpm dist
pnpm dist:mac
```

版本 `0.1.2` 的 macOS 产物如下：

```text
release/TraceField-0.1.2-mac-arm64.dmg
release/TraceField-0.1.2-mac-arm64.zip
release/TraceField-0.1.2-mac-x64.dmg
release/TraceField-0.1.2-mac-x64.zip
```

如需使用 Developer ID Application 证书签名，可在运行 macOS 打包命令前设置以下环境变量：

```bash
export CSC_LINK='/path/to/DeveloperIDApplication.p12'
export CSC_KEY_PASSWORD='certificate-password'
pnpm dist:mac
```

不得将证书、密码或其他秘密提交到版本库。此配置不会执行 Apple 公证；未签名或未经公证的安装包在其他 Mac 上可能被 Gatekeeper 阻止。

发布文件在 `release`。以下命令额外运行 LDS 样本测试，并在打包程序上验证播放、导入和记录性能。将路径替换为本机 LDS 仓库的样本目录。

```powershell
$env:LDS_FIXTURE_ROOT = 'C:\code\lds-desktop-turbo\docs\fixtures'
pnpm test
node tests/desktop-smoke.mjs
```

本机 Windows x64 打包版实测，18.5 MB 的 LDS 栅格样本（941,240 段）约 1.52 秒可查看，100 万点的二进制 PCD（12 MB）约 0.17 秒可查看。拖动旋转确认视角变化，浏览器在拖动期间的动画帧回调约 165 次/秒。整个测试中各 Electron 进程各自的峰值工作集之和约 770 MiB。以上是该次样本实测，512 MiB 和 200 万段是保护阈值。
