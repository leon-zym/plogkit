# 开发环境

本文说明在 macOS 上开发 PlogKit 所需的工具，以及 development build、Metro 和模拟器的常用工作流。项目基于 Expo SDK 57、React Native 0.86 和 Continuous Native Generation（CNG）；版本选择以 `package.json`、Expo 配置和 CI 为准。

## 环境要求

### 通用工具

- Node.js 22 和 pnpm 11，与 CI 使用的主版本一致。
- Git。
- Maestro，仅在本地运行 iOS 或 Android 端到端测试时需要。

安装项目依赖：

```bash
pnpm install
```

### iOS

- macOS 和完整安装的 Xcode。
- 至少一个可用的 iOS Simulator runtime。
- CocoaPods。

用以下命令确认当前选择的 Xcode：

```bash
xcode-select -p
xcodebuild -version
```

如果安装了多个 Xcode，可通过 `xcode-select --switch` 选择对应的 `Developer` 目录。

### Android

- Android Studio。
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

Android 模拟器通过 `10.0.2.2` 访问主机上的 Metro，iOS 模拟器直接使用 `localhost`。这两个地址通过 `app.json` 中 `expo-dev-client` 的平台级 `defaultLaunchURL` 编译进 development build；即使 Maestro 清除 App 数据，启动器仍会自动连接对应地址，连接失败时才回到 launcher。真机开发时应让设备和开发机处于可互通网络，并通过 Expo CLI 提供的 development build URL 连接，不应沿用模拟器专用地址。

## 验证

提交前运行：

```bash
pnpm verify
```

该命令执行类型检查、lint、Jest 单元与组件测试，以及 headless Skia golden 测试。

本地 E2E 由统一 runner 完成 clean prebuild、原生构建、设备准备、fixture 注入、Metro 管理和 Maestro 执行。macOS 上运行双端完整套件：

```bash
pnpm e2e
```

也可以只运行一个平台：

```bash
pnpm e2e:ios
pnpm e2e:android
```

runner 固定使用 `PlogKit E2E` iOS Simulator 和 `PlogKit_E2E` Android AVD，不会修改日常开发设备。每次运行前擦除目标设备并注入一组 fixture，因此测试状态和照片不会跨次累积。Android AVD 使用 API 36 `default` system image；缺少时，错误信息会列出所需 SDK package。

完整运行会顺序构建两端、并行准备设备、串行预热，再并行执行两端业务 flow。runner 在成功、失败或中断时只停止本轮拥有的 Metro 和设备实例，不删除专用设备。

E2E Metro 仅监听本机 IPv4。8081 已被占用时 runner 会立即失败，且不会复用或终止未知进程。日常真机开发仍使用支持 LAN 的 `pnpm start`。

一次双端 clean E2E 通常需要 15–25 分钟；首次下载或解析原生依赖可能更久。它适合手动验收、定时测试以及原生配置、系统 UI 或关键用户流程变更后的验证，不适合作为每次保存或提交的即时反馈。

GitHub Actions 在 PR 中执行 Android Debug 原生集成编译，并按计划或手动并行运行双端 E2E。测试层级和适用场景见[测试策略](testing-strategy.md)，编排决策见 [ADR 0019](../adr/0019-cross-platform-maestro-e2e.md)。

## 发布构建边界

Development build 只用于开发和测试，不能作为商店发布包。仓库当前没有配置生产签名、App Store Archive、Android App Bundle 或 EAS Build production profile。建立发布流程时应单独配置 Release 构建、签名、版本号和商店提交步骤。

参考：[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)、[Expo DevClient](https://docs.expo.dev/versions/v57.0.0/sdk/dev-client/)、[Expo CLI](https://docs.expo.dev/more/expo-cli/)、[本地 App 开发](https://docs.expo.dev/guides/local-app-development/)、[Android Emulator 网络地址](https://developer.android.com/studio/run/emulator-networking-address)、[Node.js DNS](https://nodejs.org/api/dns.html)、[Android NDK 与 CMake](https://developer.android.com/studio/projects/install-ndk)。
