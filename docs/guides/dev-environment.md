# 开发环境

本文说明在 macOS 上开发 PlogKit 所需的工具，以及 development build、Metro 和模拟器的常用工作流。项目基于 Expo SDK 57、React Native 0.86 和 Continuous Native Generation（CNG）。依赖版本以 `package.json` 和 lockfile 为准，宿主工具的当前基线见本页和 CI 配置。

## 环境要求

### 通用工具

- Node.js 22 和 pnpm 11，与 CI 使用的主版本一致。
- Git。
- Maestro 2.7.0 或更新版本，仅在本地运行 iOS 或 Android 端到端测试时需要；CI 固定使用 2.7.0 作为可复现基线。

安装并确认版本：

```bash
export MAESTRO_VERSION=2.7.0
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="${PATH}:${HOME}/.maestro/bin"
maestro --version
```

E2E runner 在构建或测试前校验 Maestro 版本；缺失或低于 2.7.0 时立即报告环境错误，高于 CI 基线时提示偏差并继续，不会自动安装、升级或降级。升级最低版本或 CI 基线时必须在同一次变更中同步文档与 CI 安装版本，并在双端验证现有 flow。

安装项目依赖：

```bash
pnpm install
```

### iOS

- macOS 和完整安装的 Xcode。
- 普通开发至少需要一个兼容的 iOS Simulator runtime；项目 E2E 还需要下文指定的 runtime 和设备类型。
- CocoaPods。

用以下命令确认当前选择的 Xcode：

```bash
xcode-select -p
xcodebuild -version
```

如果安装了多个 Xcode，可通过 `xcode-select --switch` 选择对应的 `Developer` 目录。

### Android

- Android Studio，或等价的 Android SDK command-line tools 安装。
- JDK 17。
- Android SDK Command-line Tools、Platform Tools 和 Android Emulator。
- Android SDK Platform 36，以及与本机架构匹配的模拟器 system image。

在 macOS 上配置 Android SDK 环境变量：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"
```

首次构建前接受 Android SDK 许可证：

```bash
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
```

Gradle 会根据生成的原生工程下载缺失的 Build Tools、NDK 和 CMake。离线或受限网络环境需要提前通过 Android Studio SDK Manager 安装构建日志中要求的版本。

## 生成和构建原生 App

`ios/` 和 `android/` 由 Expo CNG 生成，不应手工修改。首次构建、修改 Expo app config 或增删原生依赖后，重新生成原生工程：

```bash
pnpm prebuild
```

然后构建并安装对应平台的 development build：

```bash
pnpm ios
pnpm android
```

如果生成目录不存在，这两个命令会先生成原生工程，再解析依赖、编译并安装 App，最后启动 Metro。修改 Expo 配置或原生依赖后仍应显式运行 `pnpm prebuild`，避免旧的生成文件残留。

PlogKit 使用 `expo-dev-client`，因此开发和 E2E 运行的是包含项目实际原生依赖的 development build，不使用 Expo Go。项目配置会关闭 dev menu 的自动弹出、首次引导和悬浮按钮，避免遮挡业务界面；仍可通过模拟器快捷键或摇一摇打开 dev menu。

## 日常开发

只修改 JavaScript、TypeScript 或资源文件时，无需重新编译已安装的 development build。启动 Metro：

```bash
pnpm start
```

在 Expo CLI 中按 `i` 或 `a` 可打开对应模拟器中已安装的 development build。原生侧发生变化后，需要重新生成并构建 App。

### iOS 模拟器

可先从 Xcode 或 Simulator App 启动任意兼容设备，再运行：

```bash
pnpm ios
```

也可以用 `simctl` 启动已创建的模拟器：

```bash
xcrun simctl boot "<simulator-name>"
xcrun simctl bootstatus "<simulator-name>" -b
pnpm ios
```

### Android 模拟器

可从 Android Studio Device Manager 启动 AVD，也可以使用命令行：

```bash
"$ANDROID_HOME/emulator/emulator" -avd <avd-name> -no-snapshot-save
pnpm android
```

Android 模拟器通过 `10.0.2.2` 访问主机上的 Metro，iOS 模拟器直接使用 `localhost`。真机开发时应让设备和开发机处于可互通网络，并通过 Expo CLI 提供的 development build URL 连接，不应沿用模拟器专用地址。

## 验证

提交前运行：

```bash
pnpm verify
```

该命令执行类型检查、lint、E2E runner 的 Node 单元测试、Jest 单元与组件测试，以及 headless Skia golden 测试。

本地 E2E 的公开命令由统一 runner 完成 clean prebuild、原生构建、设备准备、fixture 注入、Metro 管理和 Maestro 执行。macOS 上运行双端完整套件：

```bash
pnpm e2e
```

也可以只运行一个平台：

```bash
pnpm e2e:ios
pnpm e2e:android
```

上述三个命令都会执行 clean prebuild 和对应平台的原生构建，不复用旧 development build。仅修改不影响原生二进制的 JavaScript、TypeScript、运行时资源或 Maestro flow，且现有构建仍对应当前原生依赖和 Expo 配置时，可以跳过构建并重跑单个平台完整套件：

```bash
node scripts/e2e/run.mjs ios --phase test
```

定位已知失败时可进一步只运行一条 flow：

```bash
node scripts/e2e/run.mjs ios --phase test --flow f06-session-persistence
```

`--phase test` 仍会重置专用设备、注入 fixture、启动 Metro 并执行 warmup。原生依赖、Expo 配置或 runner 构建逻辑变化后必须重新运行对应的 `pnpm e2e:*`，不能复用旧构建。

runner 默认使用 iPhone 17 Pro / iOS 26.5 的 `PlogKit E2E` Simulator，以及 Pixel 7 Pro / API 36 `default` system image 的 `PlogKit_E2E` Android AVD。缺少所需 runtime、device type 或 system image 时，测试会在业务 flow 前失败。每次测试擦除专用设备并注入 fixture，不使用或修改日常开发设备。失败 artifact 的目录会打印到终端；readiness、flow 隔离和诊断要求见[测试策略](testing-strategy.md)。

E2E 独占本机 IPv4 端口 8081；端口已被占用时立即失败，不复用或终止未知进程。日常真机开发仍使用支持 LAN 的 `pnpm start`。

CI 触发条件和验证时机见[测试策略](testing-strategy.md)。E2E 编排决策见 [ADR 0019](../adr/0019-cross-platform-maestro-e2e.md)，CI 生命周期和 `main` 门禁见 [ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md)。

## 发布构建边界

Development build 只用于开发和测试，不能作为商店发布包。仓库当前没有配置生产签名、App Store Archive、Android App Bundle 或 EAS Build production profile。建立发布流程时应单独配置 Release 构建、签名、版本号和商店提交步骤。

参考：[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)、[Expo DevClient](https://docs.expo.dev/versions/v57.0.0/sdk/dev-client/)、[Expo CLI](https://docs.expo.dev/more/expo-cli/)、[本地 App 开发](https://docs.expo.dev/guides/local-app-development/)、[Android Emulator 网络地址](https://developer.android.com/studio/run/emulator-networking-address)、[Node.js DNS](https://nodejs.org/api/dns.html)、[Android NDK 与 CMake](https://developer.android.com/studio/projects/install-ndk)。
