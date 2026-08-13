# ADR 0043：iOS Simulator 使用分层 readiness 与单一 Maestro 生命周期

- 状态：已接受
- 接受日期：2026-08-13
- 修订：[ADR 0042](0042-controlled-standalone-simulator-e2e.md) 中 iOS 设备 boot、安装后 UI readiness 与 Maestro 生命周期的决策
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

fresh iOS Simulator 的 `bootstatus` 只证明最小 boot 边界，SpringBoard 处于运行态也不能单独证明应用目录与安装服务已经可响应。若把系统健康、App UI readiness 与业务套件分别交给多个 Maestro 进程，前一个 driver 的成功不能证明后一个仍可用，反而增加 XCUITest 建链与系统服务转换的失效面。iOS L4 需要在一次设备生命周期中分层证明系统与 UI 语义，同时保持 fail-closed。

## 决策

- iOS Simulator 完成唯一一次 boot 后、安装 App 和注入 fixture 前，runner 执行一次有界 guest 健康门禁：应用服务必须返回非空的应用 catalog，随后 SpringBoard service 必须处于 running 并具有有效 PID；两个只读探针共享一个 deadline。catalog 原文不持久化，只保留有界执行元数据。
- 安装 App 和注入 fixture 后只启动一个 Maestro test 进程。每条顶层 flow 的首个有效动作必须进入共享启动路径，并以 App 根界面的语义节点证明前台 UI 与 hierarchy 可响应；完整套件与定向 flow 使用同一通道。
- 系统照片选择器等系统 UI 在各自子流程内使用语义 readiness：选择前必须证明所需 fixture cell 可交互，完成操作必须使用可访问性语义；不得用坐标、固定 sleep 或全局 timeout 替代系统边界。
- 任一系统、driver、App readiness 或业务失败都保留有界证据并终止，不重启设备、不重复输入、不关闭错误界面、不 retry。Android 的设备准备、独立 launcher readiness 与 Maestro 顺序不变。

## 影响与代价

- 照片注入前可以区分应用服务、SpringBoard 与后续 Maestro/XCUITest 失活，代价是每次 iOS L4 增加两个共享预算的只读系统探针。
- 每次 iOS L4 少一次独立 XCUITest driver 启动；App readiness 与业务操作共享真实受测通道，但 driver 与 App 的细分归因依赖 Maestro 原生证据。
- 系统 UI readiness 只扩大对应子流程的局部有界等待，不改变全局 deadline。设备仍只 boot 一次，也不新增恢复分支或第二个设备生命周期。
