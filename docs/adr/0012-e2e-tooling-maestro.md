# ADR 0012：E2E 工具：Maestro 模拟器主力 + Device Hub 真机手动冒烟

- 状态：已接受（2026-07-02）
- 关联：ADR 0011

## 背景

iOS 平台一切第三方 UI 自动化（Appium、Maestro、Detox）底层均为 Apple XCUITest。候选现状（2026-07 核实）：

- Maestro：YAML 声明式、无障碍树驱动、内置智能等待、无需植入 SDK；官方仅支持 iOS 模拟器，不支持 iOS 真机。
- Appium（XCUITest driver）：行业标准、真机支持一流；但对新系统支持滞后（iOS 26 支持至 driver 9.5.0 才修齐），iOS 27 beta 现阶段大概率踩生态未填之坑。
- Detox：官方不支持 iOS 真机，且 RN 官方兼容目前止于 0.84（本项目为 0.86），排除。
- Device Hub（Xcode 27 新工具）：真机/模拟器统一管理与远程操控，是人工调试与设备编排工具，不暴露手势自动化 API。

本应用 E2E 规模有限（十余条主干流程），核心正确性已由单元层与无头渲染层兜住。

## 决策

- 自动化 E2E 由 Maestro 在 iOS 模拟器上承担全部职责。
- 真机验证使用 Device Hub 远程操控做人工冒烟，配合 `devicectl` 做脚本化设备编排（装包、启动、截图、诊断采集）。
- iOS 27 正式发布、生态跟进后，重新评估真机自动化（Appium 或届时的 Maestro 官方真机支持），届时新增 ADR。

## 影响与代价

- 真机维度（性能、手感、真实相册行为）在当前阶段依赖人工冒烟，接受该缺口。
- Maestro flow 与 `docs/specs/` 场景一一对应，是 BDD 验收层的执行载体。
