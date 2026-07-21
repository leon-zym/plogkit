# ADR 0011：测试策略：五层金字塔与 BDD 方法论

- 状态：部分修订（2026-07-02 接受；见 [ADR 0019](0019-cross-platform-maestro-e2e.md)、[ADR 0020](0020-ci-lifecycle-and-main-ruleset.md)、[ADR 0023](0023-export-preset-catalog-and-pipeline.md)、[ADR 0026](0026-test-runners-by-runtime.md)）
- 关联：ADR 0003、0012、0013；详见 [guides/testing-strategy.md](../guides/testing-strategy.md)

## 背景

调试与测试需要流水线自动化、最少人工干预、可模拟真实手势、可反馈应用状态。文档驱动架构（ADR 0003）使核心链路（文档 → 渲染 → 像素）可完全脱离设备验证。项目倾向 BDD 范式。

## 决策

采用五层测试金字塔：

1. 静态检查：TypeScript strict + ESLint + Prettier。
2. 单元/组件测试：jest-expo 单一运行器 + React Native Testing Library；核心纯逻辑（文档模型、布局数学、撤销栈、预设计算）以 TDD 循环开发。
3. 渲染回归：React Native Skia 无头渲染（Node + CanvasKit）将文档渲染为 PNG，与 golden 快照像素比对。golden 仅使用随包固定字体保证确定性；无头代码必须显式 dispose surface/image。
4. 端到端：Maestro 驱动 iOS 模拟器（ADR 0012）；以 `simctl addmedia` 注入种子照片，通过读取沙盒内自动保存的 `document.json` 与导出产物断言应用状态，导出产物与无头渲染结果比对闭环。
5. CI：GitHub Actions。ubuntu 跑 1–3 层（每次 push），macOS 跑模拟器 E2E（nightly/按需），附 Android 编译检查。

方法论：

- BDD 作为方法论，不引入 Cucumber/Gherkin 工具链。验收标准以 Given/When/Then 写入 `docs/specs/`，与 Maestro flow、行为命名的组件测试一一对应。
- TDD 用于 core 纯逻辑：先写失败测试再实现。
- 不设覆盖率红线；`src/core` 要求接近全覆盖。
- 所有可交互控件自第一天起必须携带 `testID` 与合理的 `accessibilityLabel`。

## 影响与代价

- 无头渲染与设备原生 Skia 存在细微抗锯齿差异，golden 只保证自洽；跨端一致性由 E2E 层的导出比对抽查。
- 单一 Jest 运行器牺牲少量速度换取工具链简单，符合单命令验证的需要。
