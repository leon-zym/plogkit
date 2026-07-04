# 开发环境

主力开发机（macOS）的环境事实与使用约定。环境变化时更新本文。

## 工具链现状（2026-07-02 核查）

| 项目 | 状态 | 说明 |
|---|---|---|
| Xcode 27.0 beta | 已安装，`xcode-select` 当前指向 | 供 iOS 27 beta 真机部署调试 |
| Xcode 26.5 稳定版 | 已安装（`/Applications/Xcode.app`） | 日常模拟器构建首选 |
| iOS 模拟器 runtime | iOS 26.5（23F77）已安装 | 首次冒烟：iPhone 17 Pro 模拟器构建/启动/渲染通过（2026-07-02） |
| 真机 | iPhone 15 Pro，iOS 27.0 beta，Device Hub 已配对 | 人工冒烟用，UDID 见 `xcrun devicectl list devices` |
| Node.js | v26.4.0 | 满足 RN 0.85 要求（≥ 20.19.4） |
| pnpm | 11.9.0 | 本项目唯一包管理器 |
| CocoaPods / watchman / Maestro | 经 Homebrew 安装 | |
| Android 环境 | **不存在**（Java 8，无 SDK/adb） | 见下文 Android 待办 |

## 双 Xcode 使用约定

- 日常模拟器构建使用稳定版：`xcode-select` 若指向 beta，可用环境变量覆盖单次命令：

```bash
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer <command>
```

- 真机（iOS 27 beta）部署必须使用 Xcode 27 beta 工具链。
- beta 工具链构建 RN 出现异常时，先回到稳定版复现，确认是否 beta 特有问题。

## 真机冒烟

- Device Hub（随 Xcode 27）可从 Mac 远程操控真机屏幕，人工冒烟无需拿起手机。
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

## Android 待办（环境就绪后执行）

1. `brew install --cask temurin@21`（RN 0.85 要求 JDK 17+）。
2. 安装 Android Studio 与 SDK（API 36）、配置 `ANDROID_HOME`。
3. 创建模拟器并跑通 `pnpm android`。
4. 将本文与 CI 中的 Android 检查从"仅编译"升级为可运行验证。

## 已知风险

- Xcode 27 beta + RN 0.86 的组合未经官方验证（Expo SDK 57 官方支持 Xcode 26.4+），真机构建遇到工具链报错属预期内风险，优先用稳定版隔离定位。已观测：Expo CLI 对 beta `devicectl` 的 JSON 版本输出有告警（不影响模拟器流程）。
- 真机系统为 beta，行为异常时先在模拟器（稳定 runtime）交叉验证。
- 真机部署尚未配置代码签名（`expo run:ios --device` 报 "No code signing certificates"）：需在 Xcode 中登录 Apple ID 并为 target 选择开发团队后重试，属一次性人工配置。
