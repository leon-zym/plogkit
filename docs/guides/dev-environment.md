# 开发环境

主力开发机（macOS）的环境事实与使用约定。环境变化时更新本文。

## 工具链现状（2026-07-11 核查）

| 项目                           | 状态                                     | 说明                                                                              |
| ------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Xcode 27.0 beta                | 已安装，`xcode-select` 当前指向          | build 27A5194q；仅在必须验证 beta 工具链时使用                                    |
| Xcode 26.6 稳定版              | 已安装（`/Applications/Xcode.app`）      | build 17F113；日常模拟器构建首选                                                  |
| iOS 模拟器 runtime             | iOS 26.5（23F77）已安装                  | iPhone 17 Pro 全流程与 iPhone SE 窄屏冒烟通过（2026-07-11）                       |
| 真机                           | 当前未连接，不可用于本轮开发             | 仅使用模拟器调试与测试                                                            |
| Node.js                        | v26.5.0（`/opt/homebrew/bin/node`）      | 满足 Expo SDK 57 要求（≥ 22.13）                                                  |
| pnpm                           | 11.11.0（`/opt/homebrew/bin/pnpm`）      | 本项目唯一包管理器                                                                |
| CocoaPods / watchman / Maestro | 1.17.0 / 2026.07.06.00 / 2.6.1           | 经 Homebrew 安装                                                                  |
| Java                           | Zulu OpenJDK 17.0.19                     | `JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home`           |
| Android Studio                 | 2026.1（AI-261.23567.138.2611.15646644） | 已安装于 `/Applications/Android Studio.app`                                       |
| Android SDK 基础工具           | 已安装于 `~/Library/Android/sdk`         | adb 37.0.0、emulator 36.6.11、Command-line Tools 21.0、Build Tools 35.0.0/36.0.0  |
| Android 构建/模拟器            | 本地构建、启动、导入、文字与导出冒烟通过 | API 36 Platform、完整 NDK 27.1、CMake 3.22.1/3.30.5 与 `plogkit-api35` AVD 已安装 |

## 双 Xcode 使用约定

- 日常模拟器构建使用稳定版：`xcode-select` 若指向 beta，可用环境变量覆盖单次命令：

```bash
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer <command>
```

- 将来若恢复 iOS 27 beta 真机部署，必须使用 Xcode 27 beta 工具链；当前不尝试真机。
- beta 工具链构建 RN 出现异常时，先回到稳定版复现，确认是否 beta 特有问题。

## 真机冒烟（当前不可用）

- 当前没有连接真机，本轮所有调试、测试和截图只使用模拟器。
- 将来恢复真机验证时，Device Hub（随 Xcode 27）可从 Mac 远程操控真机屏幕。
- 脚本化编排用 `devicectl`（真机与模拟器统一接口，`--json-output` 供解析）：

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <udid> <path.app>
xcrun devicectl device process launch --device <udid> <bundleId>
```

- 当前 beta 阶段 `devicectl` 的部分模拟器子命令尚不可用，模拟器操作仍以 `simctl` 为准。

## E2E 依赖

- 模拟器种子照片：`xcrun simctl addmedia booted e2e/fixtures/*.jpg`
- 读取应用沙盒：`xcrun simctl get_app_container booted <bundleId> data`
- Maestro flow 运行：`maestro test e2e/flows/`（详见 [testing-strategy](testing-strategy.md)）

## Android 现状与使用约定

Android Studio、JDK 17、SDK、adb 与 emulator 已存在，`ANDROID_HOME` 指向
`~/Library/Android/sdk`。Expo SDK 57 / RN 0.86 构建所需的基础 `android-36`、NDK
`27.1.12297006` 与 CMake `3.22.1`/`3.30.5` 已于 2026-07-11 安装。已有 API 35 Google APIs ARM64
system image，Hypervisor.Framework 加速可用，并已创建 `plogkit-api35` AVD。首次 NDK 安装仅有
188 MB 且缺失 `source.properties`，重装后恢复为完整 r27b（约 2.4 GB）。

组件安装命令记录如下，供重建环境时复用：

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  "platforms;android-36" \
  "ndk;27.1.12297006" \
  "cmake;3.30.5"
```

使用现有 ARM64 image 创建模拟器：

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name plogkit-api35 \
  --package "system-images;android-35;google_apis;arm64-v8a" \
  --device pixel_8
```

启动与验证时只保留一个模拟器实例，并用 `adb -e` 明确限制到 emulator，再运行
`pnpm android`。原生编译、渲染测试与 E2E 串行执行，避免在主力开发机上叠加持续高负载。

本地编译验收命令（只构建 AVD 所需 arm64 ABI）：

```bash
pnpm expo prebuild --clean --platform android
cd android
./gradlew app:assembleDebug --no-daemon --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a
```

2026-07-11 验收结果：Debug APK 构建成功；API 35 AVD 上系统照片选择器只授予选中照片，
两图导入、Skia 标题文字和 `1024 × 2048` RGB JPEG 导出均通过，导出文件已进入 MediaStore。

## 已知风险

- Xcode 27 beta + RN 0.86 的组合未经官方验证（Expo SDK 57 官方支持 Xcode 26.4+），工具链报错优先用稳定版隔离定位。已观测：Expo CLI 对 beta `devicectl` 的 JSON 版本输出有告警（不影响模拟器流程）。
- Android Debug 包仍包含 Metro 所需的 `INTERNET` 与开发菜单所需的 `SYSTEM_ALERT_WINDOW`；最终发布包应再次审计 merged manifest，应用业务代码不得发起网络请求。
- 当前真机不可用且代码签名未配置；本轮不把真机冒烟作为完成条件。
