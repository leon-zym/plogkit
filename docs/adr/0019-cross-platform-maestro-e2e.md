# ADR 0019：Maestro E2E 扩展到 iOS 与 Android 模拟设备

- 状态：已接受（2026-07-13）
- 调整：ADR 0011、0012 中仅在 iOS 模拟器运行自动化 E2E 的平台范围

## 背景

PlogKit 已能在 iOS 和 Android development build 中运行。现有 Android CI 只做原生编译检查，无法发现 Android 系统照片选择器、权限、返回行为、应用重启和 MediaStore 导出等设备侧回归。

现有八条 Maestro 主流程通过 React Native `testID`、无障碍标签和可见文案驱动业务界面。实际验证表明，业务步骤可跨平台复用，平台差异主要集中在系统照片选择器、测试照片注入和模拟设备编排。Maestro 2.6.1 可在项目使用的 Android API 36 AOSP 模拟器上运行这些流程。

## 决策

- 自动化 E2E 继续统一使用 Maestro，不引入第二套 E2E 框架。
- 完整验收套件同时运行在 iOS Simulator 和 Android Emulator，作为 nightly 与手动触发的 GitHub Actions 任务；两个平台使用独立 job 并行执行。
- `e2e/flows/` 中的业务主流程保持跨平台共享。系统 UI 存在差异时，在 `e2e/subflows/` 中使用 Maestro 的 `platform` 条件调用平台专用子流程，不复制整条业务流程。
- 两端均测试 development build。每条 flow 清理应用状态后，由 `expo-dev-client` 编译进原生配置的 `defaultLaunchURL` 自动连接 Metro：iOS 使用 `localhost:8081`，Android Emulator 使用 `10.0.2.2:8081`，不依赖开发启动器的历史连接状态或界面操作。
- iOS 使用 `simctl addmedia` 注入照片；Android 使用 `adb push` 和 MediaStore 扫描广播注入照片。设备状态或导出产物断言分别使用 `simctl` 与 `adb` 的平台能力。
- 本地完整验收使用擦除后的专用模拟设备和 clean development build。双端共用一个 Metro，依次完成冷启动预热后并行运行完整业务 flow；原生构建保持顺序执行，避免同一台开发机上的资源争用。
- 本地与 GitHub Actions 复用同一套构建、安装、照片注入、Metro 和 Maestro 执行逻辑；CI 只负责 runner、KVM 和测试产物上传等平台能力。
- PR 继续运行快速的静态、单元、渲染和 Android 编译检查。完整双端 E2E 暂不加入 PR 必需检查，待耗时和稳定性有足够历史数据后再评估。
- 真机自动化仍不在当前范围内。iOS 与 Android 真机继续采用发布前人工冒烟；若未来引入真机自动化，需要新增 ADR。

## 影响与代价

- Android 获得照片导入、编辑、撤销重做、持久化和导出主路径的真实设备环境回归保护。
- 两端共享业务 flow，新增功能通常只需维护一份验收流程；系统 UI 改版仍可能要求分别更新平台子流程。
- Metro 连接不依赖 launcher UI 文案和控件结构，减少 Expo development launcher 改版造成的测试波动。
- nightly 会增加 Android 模拟器的构建和运行时间，但双端 job 并行，不把两端耗时串行叠加。
- Android Photo Picker 节点受系统镜像实现影响，CI 固定 API level、system image 类型和设备 profile；升级镜像时必须先验证平台子流程。
- 现有 Android PR 编译检查与 nightly Android E2E 存在部分重复构建，这是用执行成本换取 PR 快反馈和 nightly 行为覆盖的明确取舍。
