# ADR 0044：iOS Simulator readiness 覆盖应用服务

- 状态：已接受
- 接受日期：2026-08-13
- 修订：[ADR 0043](0043-layered-ios-simulator-readiness.md) 中 guest 健康门禁的语义
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

SpringBoard service 处于运行态不能证明负责应用目录与安装的系统服务已经可响应。只验证 SpringBoard 会让这类 guest 失活延迟到 App 安装阶段，表现为没有业务意义的长时间卡死。

## 决策

- iOS guest 健康门禁先要求应用服务返回非空的已安装应用 catalog，再要求 SpringBoard service 处于 running 并具有有效 PID；两个只读探针共享一个有界 deadline。
- 应用 catalog 原文可能包含宿主私人路径，不持久化为诊断证据。门禁和失败诊断只保留执行状态、输出字节数与有界错误元数据。
- [ADR 0043](0043-layered-ios-simulator-readiness.md) 的其余决策保持不变：门禁失败即终止，不重启设备、不重复输入、不 retry，且不替代安装与 fixture 之后的 UI 语义 readiness。

## 影响与代价

- App 安装前可以独立识别应用服务失活，不再把它归为安装、Maestro 或业务 flow 失败。
- 每次 iOS L4 增加一个只读系统探针，但不增加设备生命周期或恢复分支；两个 guest 探针共用一个独立、有界的健康门禁预算。
- 原始 catalog 不进入 artifact，牺牲路径级细节以维持失败证据的隐私边界。
