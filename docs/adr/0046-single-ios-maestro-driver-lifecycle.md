# ADR 0046：iOS E2E 使用单一 Maestro driver 生命周期

- 状态：已接受
- 接受日期：2026-08-13
- 修订：[ADR 0042](0042-controlled-standalone-simulator-e2e.md) 与 [ADR 0043](0043-layered-ios-simulator-readiness.md) 中 iOS 安装后的 UI readiness 决策
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

iOS runner 在业务套件前单独执行 hierarchy 会启动一次 Maestro/XCUITest driver，随后业务套件又启动另一次。前一次启动不能证明后一次 driver 仍可用，反而增加 fresh Simulator 上的系统服务转换和独立失效面。guest 应用服务与 SpringBoard 门禁已经在安装前证明系统健康，安装后的验收应直接证明实际受测 App 与业务套件使用的 UI 通道。

## 决策

- iOS 安装 App 和注入 fixture 后只启动一个 Maestro test 进程；该进程共同负责有界的 driver 建链、App 前台启动、UI hierarchy 与业务 flow，不再运行独立的 Maestro hierarchy readiness。
- 每条顶层 flow 的首个有效动作必须进入共享启动路径，并以 App 根界面的语义节点完成 UI readiness。完整套件与定向 flow 使用同一契约。
- 安装前的 iOS guest 门禁、一次设备生命周期和 fail-closed 规则保持不变；任一 driver、UI readiness 或业务失败都终止套件，不重启、不 retry。Android 的独立系统 launcher readiness 保持不变。

## 影响与代价

- 每次 iOS L4 少一次 XCUITest driver 启动和一套跨进程状态依赖，UI readiness 与业务操作共享同一真实通道。
- iOS 不再在业务套件前单独保存 SpringBoard launcher hierarchy；系统健康由 guest 门禁与失败诊断证明，App UI readiness 由 Maestro 原生套件证据证明。
- driver 建链与 App readiness 共用同一进程，故障分类依赖该进程的受控输出和 flow 证据，而不是额外启动一个诊断 driver。
