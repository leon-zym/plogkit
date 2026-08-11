# 开发环境

本文说明在 macOS 上开发 PlogKit 所需的工具，以及 development build、Metro 和模拟器的常用工作流。项目基于 Expo SDK 57、React Native 0.86 和 Continuous Native Generation（CNG）。依赖版本以 `package.json` 和 lockfile 为准；L4 E2E 的宿主工具以仓库版本文件和本页的精确契约为准。

## 环境要求

### 通用工具

- Node.js 24.19.0，见 `.node-version`。
- pnpm 11.21.0，见 `package.json` 的 `packageManager`。
- Eclipse Temurin 17.0.20+8，见 `.java-version`。
- Git。
- Maestro 2.8.0，见 `.maestro-version`，仅在本地运行 iOS 或 Android E2E 时需要。

安装并确认版本：

```bash
export MAESTRO_VERSION="$(<.maestro-version)"
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="${PATH}:${HOME}/.maestro/bin"
node --version
pnpm --version
java -XshowSettings:properties -version 2>&1 | grep -E 'java.vendor|java.runtime.version'
maestro --version
```

E2E runner 在构建或测试前精确校验 Node、pnpm、JDK vendor/runtime 与 Maestro；缺失或版本不同都立即报告环境错误，不自动安装、升级、降级或容忍更高版本。升级任一工具时，须在同一次变更中同步版本文件、CI、本文档和双端验证证据。

安装项目依赖：

```bash
pnpm install
```

### iOS

- Apple Silicon macOS 和完整安装的 Xcode。L4 E2E 精确使用 Xcode 26.6（build 17F113），并只构建宿主实际执行的 arm64 Simulator slice；日常开发可使用与 Expo SDK 57 兼容的 Xcode。
- 普通开发至少需要一个兼容的 iOS Simulator runtime；L4 E2E 精确使用 iOS 26.5 runtime 与 iPhone 17 Pro device type。
- CocoaPods 1.17.0。

用以下命令确认当前选择的 Xcode：

```bash
xcode-select -p
xcodebuild -version
```

如果安装了多个 Xcode，可通过 `xcode-select --switch` 选择对应的 `Developer` 目录。运行 L4 前，`xcodebuild -version` 必须输出 `Xcode 26.6` 与 `Build version 17F113`。

### Android

- Android Studio，或等价的 Android SDK command-line tools 安装。
- Eclipse Temurin 17.0.20+8。
- Android SDK Command-line Tools 22.0、Platform Tools 37.0.1（build 15733141）。
- Android Emulator 37.1.11.0（build 15917651）。
- Android SDK Platform 36，以及 revision 2 的 `default` system image。Apple Silicon 本地使用 `arm64-v8a`，GitHub Ubuntu runner 使用 `x86_64`；这是唯一按宿主能力声明的平台差异。

在 macOS 上配置 Android SDK 环境变量：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools"
```

首次运行 L4 前安装并接受精确基线所需的 Android SDK 包：

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
  "cmdline-tools;22.0" \
  "platform-tools" \
  "emulator" \
  "system-images;android-36;default;arm64-v8a"
yes | "$ANDROID_HOME/cmdline-tools/22.0/bin/sdkmanager" --licenses
```

Gradle 会根据生成的原生工程下载缺失的 Build Tools、NDK 和 CMake。离线或受限网络环境需要提前通过 Android Studio SDK Manager 安装构建日志中要求的版本。L4 runner 会精确检查 Command-line Tools、Platform Tools、Emulator build 和 system image revision；SDK Manager 静默升级后必须先审阅并重新验证，不能沿用漂移后的环境。

### L4 工具链选择原则

这组基线不是照抄某台开发机或某次 CI 的当时状态。选择顺序是：项目框架明确兼容、上游稳定渠道仍支持、本地与 CI 可以安装或 fail closed，最后再由本仓库的 clean Release 证据确认。具体版本的选择证据与候选比较保留在 [Issue #97](https://github.com/leon-zym/plogkit/issues/97#issuecomment-5246445301)；本页只维护当前可执行基线与升级规则。

当前设备基线为 Pixel 7 Pro、`swiftshader`、2 个 guest core 与 4096 MB 内存。设备 profile 或资源参数的调整必须作为独立变更，用相同 App 与工具链比较 readiness、ANR 和完整 L4，不能只依据理论像素负载替换基线。workflow 通过 stable package path 安装 Android Platform Tools 与 Emulator，再精确校验实际 build；这是“漂移即失败”，不是可回放任意历史二进制的不变安装。升级任一 L4 工具时，必须作为独立变更同步版本文件、workflow 和本页，并重新运行受影响平台的完整 L4。

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

PlogKit 的日常开发使用包含项目实际原生依赖的标准 `expo-dev-client` development build，不使用 Expo Go。L4 E2E 使用另一条 clean Release standalone 构建路径，不启动 dev client UI 或 Metro；因此产品配置中不再保留为旧 E2E 设置的默认 Metro URL 或 dev-menu 状态。

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

该命令执行类型检查、lint、宿主 Node 编排器测试、Jest 功能行为测试，以及 headless Skia golden 测试。Node 编排器测试只覆盖 CLI、环境、子进程、文件系统和 artifact 等宿主边界，不形成新的验证层级。

本地 E2E 的公开命令由统一 runner 完成 clean prebuild、Release standalone 构建、专用设备创建与 readiness、fixture 注入和 Maestro 执行。测试阶段不启动或依赖 Metro。macOS 上运行双端完整套件：

```bash
pnpm e2e
```

也可以只运行一个平台：

```bash
pnpm e2e:ios
pnpm e2e:android
```

上述三个命令都会在单次 runner 调用中完成 clean prebuild、Release 构建、产物快照、临时设备、安装与验收，不复用 development build 或可变的旧产物。`pnpm e2e` 在一台 Mac 上按 iOS、Android 顺序验收并在平台之间删除设备，避免两套模拟器争抢宿主资源；GitHub 使用两台独立 runner 并行运行相同的平台入口。两端原生构建在本地和 CI 都固定使用 2 个 worker。

定位已知失败时可只运行一条 flow；它仍走完整 Release 构建与设备生命周期：

```bash
node scripts/e2e/run.mjs ios --flow f06-session-persistence
```

runner 每次按上述精确基线创建唯一 iOS Simulator 或临时 Android AVD。两端设备都验证 `en-US`；Android AVD 还固定 Pixel 7 Pro、`swiftshader`、2 个 guest core、4096 MB guest memory 且禁用 snapshot。缺少或不匹配所需工具、runtime、device type、system image 或 locale 时，测试会在业务 flow 前失败。构建与 Maestro 都使用 runner 生成的受控子进程环境：不继承用户的 `JAVA_HOME` 或构建 override，构建不加载本地 `.env*`，Maestro 的 update check、analytics 和 analysis notification 在本地与 CI 一致关闭。Android Gradle 使用仓库专属的 `.e2e-cache/gradle` 缓存目录，拒绝其中的 `gradle.properties` 或 init script，并显式使用已经校验的 Temurin `java.home`；因此默认 `~/.gradle` 不能改变受测 Release 产物。

每次测试创建唯一临时设备并注入 fixture，不寻找、复用或修改日常开发设备。失败 artifact 的目录会打印到终端；readiness、flow 隔离、预算和诊断要求见[测试策略](testing-strategy.md)。

日常模拟器或真机开发仍使用 `pnpm start` 与 Metro；这条开发路径的网络要求不属于 standalone E2E 契约。

CI 触发条件和验证时机见[测试策略](testing-strategy.md)。E2E 平台范围见 [ADR 0019](../adr/0019-cross-platform-maestro-e2e.md)，standalone 环境与生命周期见 [ADR 0042](../adr/0042-controlled-standalone-simulator-e2e.md)，CI 生命周期和 `main` 门禁见 [ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md)。

## 发布构建边界

Development build 只用于日常开发，不能作为商店发布包。L4 虽使用 Release configuration，但其 iOS 产物只面向 Simulator 且关闭签名，Android APK 使用仅适用于 Emulator 验收的 debug certificate；它们同样不是发布包。仓库当前没有配置生产签名、App Store Archive、Android App Bundle 或 EAS Build production profile。建立发布流程时应单独配置 Release 构建、签名、版本号和商店提交步骤。

参考：[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)、[Expo DevClient](https://docs.expo.dev/versions/v57.0.0/sdk/dev-client/)、[Expo CLI](https://docs.expo.dev/more/expo-cli/)、[本地 App 开发](https://docs.expo.dev/guides/local-app-development/)、[Android Emulator 网络地址](https://developer.android.com/studio/run/emulator-networking-address)、[Android NDK 与 CMake](https://developer.android.com/studio/projects/install-ndk)。
