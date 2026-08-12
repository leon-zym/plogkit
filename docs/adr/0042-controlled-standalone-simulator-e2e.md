# ADR 0042：受控的 standalone 模拟器 E2E

- 状态：部分修订
- 接受日期：2026-08-11
- 修订：[ADR 0019](0019-cross-platform-maestro-e2e.md) 中 development build、Metro 与设备生命周期的决策
- 后继：[ADR 0043](0043-layered-ios-simulator-readiness.md)、[ADR 0045](0045-sanitized-e2e-diagnostic-evidence.md)、[ADR 0046](0046-single-ios-maestro-driver-lifecycle.md)、[ADR 0047](0047-sanitized-ios-e2e-artifact-publication.md)
- 关联：[ADR 0020](0020-ci-lifecycle-and-main-ruleset.md)、[ADR 0039](0039-native-node-orchestration-tests.md)、[ADR 0041](0041-scenario-verification-traceability.md)

## 背景

完整 L4 验收原先在两端安装 development build，并在测试阶段启动 Metro。这会把开发启动器、宿主网络、bundle transformer 和流式传输加入产品验收路径；它们可以在 App 与业务逻辑正常时独立失败。Android CI 又曾由第三方 Action 先启动设备，导致本地与 CI 的设备参数、readiness 和失败证据不同。

最终门禁应验证用户实际运行的 production bundle 和跨端业务语义，而不是验证开发服务器的生命周期。同时，模拟设备的创建、安装、验收与清理必须属于同一个项目 runner，否则无法建立可复核的状态边界。

## 决策

- iOS Simulator 与 Android Emulator 的 L4 都使用 clean Release standalone 产物；production Hermes bundle 在构建时嵌入。测试阶段不启动 Metro，不经过 development launcher，也不依赖宿主网络。日常开发仍使用标准 development build 与 Metro。
- 项目 runner 每次创建唯一临时设备，并独占完整的创建、boot、locale、安装、fixture、readiness、Maestro 和删除生命周期。CI 只提供宿主、KVM、SDK 安装与 artifact 上传，不把外部 Action 启动的设备传给 runner。
- 仓库版本文件、workflow 与 runner 共同定义宿主工具链和设备参数。本地与 CI 共用一个入口、受控子进程环境与验收语义；宿主架构要求的 Android guest ABI 是唯一主动允许的 device-profile 差异。版本漂移必须 fail closed，并由独立变更重新验证；当前精确版本由[开发环境](../guides/dev-environment.md)负责。
- 设备准备只等待平台的最小 boot 边界。安装 App 与 fixture 后，runner 执行一次语义 readiness：真实 Home launcher 必须响应、处于前台、hierarchy 可读，且不存在系统故障。失败即保留证据并终止，不重复输入、不关闭错误对话框、不重启设备、不 retry。
- 完整平台套件由一个 Maestro workspace 进程按显式顺序执行。每条 flow 显式建立 App 与所需系统状态边界；任一失败都立即终止平台套件。timeout 只有界终止失控的进程组，不用于失败恢复。
- 每次运行在同一进程内完成 clean prebuild、Release 构建、受测产物与诊断 sidecar 的不可变快照，随后只安装和上传该快照。构建与快照期间仓库输入变化必须失败；快照完成后的工作树变化不影响已冻结的本次验收。不对外暴露可跳过构建的 phase 或跨进程 manifest 协议。
- 失败时，runner 在共享 deadline 和总字节上限内保存附加的原始平台日志与 crash/ANR report；Maestro artifacts 和与受测产物绑定的 Release 符号则完整保留。诊断证据不改写原始失败，也不参与“是否继续”的控制决策。

## 迁移与兼容

旧 `--phase`、`--device` 和跨进程 manifest 接口不保留兼容别名。调用者迁移到 `pnpm e2e`、`pnpm e2e:ios` 或 `pnpm e2e:android`；定向 flow 通过平台命令的 `--flow` 参数选择。所有入口都执行完整构建、快照和设备生命周期。

## 影响与代价

- L4 更接近用户实际获得的 `__DEV__ = false` 产物，并删除 Metro、dev launcher 与 bundle 网络传输这一类非产品故障。代价是 JavaScript 变化也需要重新构建嵌入 bundle。
- full-UI Android image 比删除 System UI 的 ATD 更昂贵，但能保留项目依赖的照片选择器、MediaStore 与窗口语义。ATD 只能作为诊断对照，不能成为最终验收基线。
- 部分 Android SDK 工具只能从上游 stable package path 安装，不能回放任意历史二进制；实际版本偏离基线时必须 fail closed，并通过独立升级重新验证。
- 模拟器 E2E 产物仅用于验收：iOS Simulator build 关闭签名，Android APK 使用模拟器测试证书；它们不建立商店发布或生产签名流程。
