# ADR 0043：iOS Simulator 使用分层 readiness

- 状态：部分修订
- 接受日期：2026-08-13
- 修订：[ADR 0042](0042-controlled-standalone-simulator-e2e.md) 中设备 boot 与安装之间的 readiness 决策
- 后继：[ADR 0044](0044-ios-app-service-readiness.md)、[ADR 0046](0046-single-ios-maestro-driver-lifecycle.md)
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

fresh iOS Simulator 的 `bootstatus` 完成只说明平台报告了最小 boot 边界，不能证明 guest 已能稳定执行命令或 SpringBoard 已进入运行态。已观察到 boot 成功后，照片注入或后续 UI hierarchy 仍可能失活。若只保留安装与 fixture 之后的 UI readiness，照片注入本身没有独立的前置系统健康边界；若用重启或 retry 恢复，又会破坏一次设备生命周期和 fail-closed 契约。

## 决策

- iOS Simulator 完成唯一一次 boot 后、安装 App 和注入 fixture 前，runner 执行一次有界 guest 健康门禁：guest 必须能返回 SpringBoard service 状态，且 service 必须处于 running 并具有有效 PID。
- guest 门禁不启动 Maestro，不替代安装 App 与 fixture 后的 UI 语义 readiness。后者继续负责 Home launcher、前台窗口、hierarchy 和系统故障契约。
- 任一门禁失败都保留有界证据并终止，不重启设备、不重复输入、不 retry。Android 的设备准备与 readiness 顺序不变。

## 影响与代价

- 照片注入前可以区分 guest/CoreSimulator 失活与 Maestro/XCUITest driver 失活，代价是每次 iOS L4 增加一个有界的只读系统探针。
- guest 门禁是 acceptance-critical 的 fail-closed 边界；宿主或 guest 的瞬时失活会更早终止套件，但不会被伪装成业务 flow 失败。
- 设备仍只 boot 一次，post-install UI readiness 仍只执行一次；本决策不引入恢复分支或第二个设备生命周期。
