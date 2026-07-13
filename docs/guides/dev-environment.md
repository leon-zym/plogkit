# 开发环境

本文说明 PlogKit 在 macOS 上进行 iOS 和 Android 开发所需的环境、首次构建会自动补齐的组件，以及当前验证通过的开发环境基线。版本判断以项目锁定的 Expo SDK 57、React Native 0.86 和实际原生构建为准，不合并套用裸 React Native 教程中的版本清单。

## 已验证基线

以下环境于 2026-07-12 完成双端构建和模拟器验证。

| 项目                  | 当前版本或配置                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| macOS                 | 27.0，Apple Silicon                                                           |
| Node.js / pnpm        | 26.5.0 / 11.11.0；Expo SDK 57 要求 Node.js >= 22.13                           |
| Expo / React Native   | Expo 57.0.1 / React Native 0.86.0，New Architecture                           |
| Xcode                 | 27.0 beta，build 27A5194q；`xcode-select` 指向 `/Applications/Xcode-beta.app` |
| iOS 模拟器            | iOS 26.5，iPhone 17 Pro                                                       |
| CocoaPods / Maestro   | 1.17.0 / 2.6.1                                                                |
| Java / Android Studio | Zulu OpenJDK 17.0.19 / Android Studio 2026.1                                  |
| Android SDK           | Platform 36、Build Tools 36.0.0 和 35.0.0、NDK 27.1.12297006、CMake 3.22.1    |
| Android 模拟器        | API 36 AOSP ARM64 system image，Pixel 9 AVD，名称为 `Pixel_9`                 |

当前没有连接 iOS 或 Android 真机。本文的结论只覆盖模拟器开发、调试和测试，不包含真机签名、App Store archive 或 Google Play release 构建。

## 开发者需要提前安装

### 通用工具

- Node.js 22.13 或更高版本，以及 pnpm。
- 项目依赖：在仓库根目录运行 `pnpm install`。
- Maestro，仅在本地运行 E2E 时需要。

Expo SDK 56 及以上版本不再要求 Watchman，本项目也没有启用 `resolver.useWatchman`，因此无需安装。

### iOS

- 完整版 Xcode，而不是只有 Command Line Tools。Xcode 中至少安装一个与测试设备匹配的 iOS Simulator runtime。
- 通过 `xcode-select` 选择要使用的 Xcode：

```bash
sudo xcode-select --switch /Applications/Xcode-beta.app/Contents/Developer
```

- CocoaPods。`expo run:ios` 会执行依赖解析和 `pod install`，但本机仍需先有可用的 CocoaPods 命令。

### Android

- Android Studio、JDK 17、Android SDK Command-line Tools、Platform Tools 和 Android Emulator。
- Apple Silicon 使用 API 36 AOSP `arm64-v8a` system image，并创建一个常见手机规格的 AVD。当前基线是 Pixel 9；设备型号只影响屏幕、密度、内存和传感器配置，不是项目构建依赖。
- 配置环境变量：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"
```

- 接受 Android SDK 许可证，Gradle 才能在首次构建时安装缺失组件：

```bash
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
```

项目不依赖 Google Play services，API 36 AOSP image 已通过系统照片选择器和 MediaStore 导出验证。`Sources for Android 36` 只改善 Android Studio 的源码跳转和平台调试，不参与应用编译，可以不安装。

## 首次原生构建会自动完成什么

`ios/` 和 `android/` 是 Expo Continuous Native Generation 生成目录，不作为需要手工维护的环境前提。目录不存在时，`expo run:ios` 和 `expo run:android` 会先生成对应原生工程。

本项目按 ADR 0002 使用 `expo-dev-client`，因此 Debug 原生 App 是 Expo 定义的 development build，不使用 Expo Go。首次构建、新增或升级原生依赖、修改 app config 后，需要重新生成原生工程并构建 App：

```bash
pnpm prebuild
pnpm ios # 或 pnpm android
```

| 命令           | 自动完成                                                           | 仍需提前具备                                                                 |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm ios`     | 生成 iOS 工程、解析 Pods、编译、安装并启动 App                     | Xcode、Simulator runtime、CocoaPods、已启动或可用的模拟器                    |
| `pnpm android` | 生成 Android 工程、下载 Gradle 与 Maven 依赖、编译、安装并启动 App | Android Studio/SDK、JDK 17、adb、emulator、已创建的 AVD、已接受的 SDK 许可证 |

Android Gradle Plugin 会按生成工程的版本声明安装缺失的 Platform、Build Tools、NDK 和 CMake。当前构建实际需要：

- Platform 36 和 Build Tools 36.0.0，用于 Android 36 的编译、打包和签名工具。
- Build Tools 35.0.0，已确认由 AGP 在构建时自动安装。虽然根工程使用 36.0.0，当前依赖解析仍会请求 35.0.0，因此保留。
- NDK 27.1.12297006 和 CMake 3.22.1，用于编译 New Architecture、Skia、Reanimated、Worklets 等依赖中的 C/C++ 和 JNI 代码。

这些版本由项目生成的原生构建配置决定，不需要开发者根据通用教程逐项预装。离线构建或受限网络环境除外，此时应提前用 SDK Manager 安装上述精确版本。

## 日常开发

已安装过当前原生依赖对应的 development build，且只修改 JavaScript/TypeScript 时，无需重新编译原生 App：

```bash
pnpm start
```

该命令显式以 dev-client 模式启动 Metro。在终端按 `i` 或 `a` 可打开已安装的 PlogKit development build；不应切换到 Expo Go。项目的本地 config plugin 会关闭 dev menu 的自动弹出、一次性 onboarding 和悬浮按钮，避免覆盖右上角业务按钮；仍可通过模拟器快捷键或摇一摇打开 dev menu。

### iOS 模拟器

Xcode 27 beta 当前可以完成本项目的生成、Pods 安装、Debug 编译、安装、Metro 调试和 Maestro E2E。Expo CLI 对 beta `devicectl` 的输出仍会给出兼容性警告；冷启动时显式传入 `--device` 也可能把模拟器误判为需要签名的设备。先启动模拟器，再运行标准命令最稳定：

```bash
xcrun simctl boot "iPhone 17 Pro"
xcrun simctl bootstatus "iPhone 17 Pro" -b
pnpm ios
```

设备已经启动时，第一条命令提示已启动可以忽略。不要据此声称 beta Xcode 已覆盖真机签名和发布归档，这两条链路尚未验证。

### Android 模拟器

可从 Android Studio Device Manager 启动 `Pixel_9`，也可使用命令行：

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 -no-snapshot-save
pnpm android
```

API 36 Platform 与 API 36 system image 是两份不同组件：前者供编译使用，后者是 AVD 的只读操作系统。一个 system image 可以供多个 AVD 使用，每个 AVD 仍会产生独立的用户数据。日常只保留一个 iOS 或 Android 模拟器运行，并串行执行原生构建和 E2E，避免主机持续高负载。

## 验证命令与当前结果

```bash
pnpm verify
pnpm e2e
```

`pnpm verify` 覆盖类型检查、lint、111 个 Jest 测试和 headless Skia golden。`pnpm e2e` 需要已启动的 iOS 模拟器、已安装的 PlogKit development build 和正在运行的 Metro；可先运行 `pnpm ios`，或分别运行 `pnpm start` 与 `pnpm e2e`。具体测试约定见[测试策略](testing-strategy.md)。

当前没有配置 App Store Archive、Android App Bundle 签名或 EAS Build 生产 profile。Development build 只用于开发和测试，不能作为发布包；正式打包需要单独建立 Release/Archive 工作流。

2026-07-12 的实测结果：

- iOS：Xcode 27 beta clean build 成功，App 安装和 Metro 启动成功，Maestro 全套 8/8 通过。
- Android：API 36 AOSP/Pixel 9 上 clean build、安装和启动成功；设置流程通过；系统照片选择器完成两图导入，MediaStore 导出成功。
- 静态检查、单元/组件测试和渲染 golden 全部通过。

参考：[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)、[Expo Android Emulator](https://docs.expo.dev/workflow/android-studio-emulator/)、[Android NDK 与 CMake](https://developer.android.com/studio/projects/install-ndk)、[Android AVD](https://developer.android.com/studio/run/managing-avds)。
