# 测试策略

决策依据见 [ADR 0011](../adr/0011-testing-strategy.md)、[ADR 0012](../adr/0012-e2e-tooling-maestro.md)。本文是操作层面的完整说明，面向 AI Agent 与人类开发者。

## 设计原则

- 测试面向 AI Agent 流水线：单命令验证、结果机器可读、最少人工干预。
- 文档驱动架构是可测试性的基石：文档是纯 JSON，"文档 → Skia 元素树"是纯函数，核心链路可完全脱离设备验证。
- BDD 作为方法论：验收标准先行（`docs/specs/`），测试命名描述行为；不引入 Cucumber/Gherkin 工具链。
- TDD 用于 `src/core` 纯逻辑：先写失败测试，再实现，后重构。
- 不设覆盖率红线（数字指标诱导垃圾测试）；`src/core` 要求接近全覆盖。

## 五层金字塔

### L1 静态检查

TypeScript strict（禁 `any`）+ ESLint + Prettier。Agent 每轮改动的第一道反馈。

### L2 单元与组件测试

- 运行器：jest-expo（单一运行器，不引入 Vitest 双栈）。
- 组件测试：React Native Testing Library，测试命名描述行为（如 `adds text block when user commits non-empty input`）。
- `src/core`（文档模型、拼接布局数学、撤销栈、预设计算）必须是无 React/RN 依赖的纯 TS，测试不需要 mock 原生层。

### L3 Skia 无头渲染回归（golden 测试）

- 原理：React Native Skia 支持在 Node 上通过 CanvasKit-WASM 无头渲染（`makeOffscreenSurface` + `drawOffscreen`）。设备与 Node 共用同一个"文档 → Skia 元素树"函数，任意文档状态可在无设备环境渲染为 PNG，与 golden 快照做像素比对（pixelmatch）。
- Agent 工作流：改动渲染相关代码后，渲染受影响的文档夹具 → 输出 PNG 与 diff 图 → **必须实际查看图片**确认符合预期 → 更新 golden 并在提交说明中记录理由。禁止未经查看批量更新 golden。
- 确定性纪律：golden 渲染只使用随包固定字体（不依赖系统字体）；无头代码必须显式 `dispose()` surface 与 image（CanvasKit 有已知内存泄漏）。
- 已知边界：CanvasKit-WASM 与设备原生 Skia 存在细微抗锯齿差异，golden 只保证自洽；跨端一致性由 L4 的导出比对抽查。

### L4 端到端（Maestro，iOS 模拟器）

- flow 存放于 `e2e/flows/`，与 `docs/specs/` 场景一一对应命名（如 `f01-add-text.yaml`）。
- 种子数据：用 `xcrun simctl addmedia <udid> <图片>` 向模拟器相册注入已知测试照片。
- 应用状态断言（零测试专用代码）：
  - 自动保存的 `projects/current/document.json` 就是状态观测点，通过 `xcrun simctl get_app_container <udid> <bundleId> data` 定位沙盒后直接读取断言。
  - 导出产物从沙盒/相册取出，与 L3 无头渲染同一文档的结果做像素比对，闭合"设备渲染 ↔ CI 渲染"一致性环。
- 全部可交互控件必须携带 `testID` 与合理 `accessibilityLabel`（同时即真实无障碍适配），这是 Maestro 稳定定位的前提。
- 真机：不做自动化（见 ADR 0012）。用 Device Hub 远程操控做人工冒烟，`devicectl` 负责装包/启动/截图等编排。

### L5 CI（GitHub Actions）

| 触发 | Runner | 内容 |
|---|---|---|
| 每次 push / PR | ubuntu | L1 + L2 + L3（CanvasKit 在 Linux Node 正常运行）|
| PR | ubuntu | Android `assembleDebug` 编译检查（防腐，本地无 Android 环境）|
| nightly / 手动 | macOS | 模拟器 Maestro E2E |

PR 必须绿灯方可合并（ADR 0016）。

## 命令约定

脚手架建立后固化到 `package.json`，保持下表与实际一致：

| 命令 | 作用 |
|---|---|
| `pnpm check` | 类型检查 + lint |
| `pnpm test` | L2 单元与组件测试 |
| `pnpm test:render` | L3 golden 测试（`-u` 更新 golden，须先人工/Agent 查看 diff）|
| `pnpm e2e` | L4 Maestro（需已启动模拟器）|
| `pnpm verify` | L1+L2+L3 聚合，提交前必跑 |

## Agent 开发循环

1. 读取/更新 `docs/specs/` 中对应场景（需求变化先改 spec）。
2. 为新行为写失败测试（core 用单元测试，交互用组件测试，渲染用 golden 夹具，主干流程补 Maestro flow）。
3. 实现至全绿：`pnpm verify`。
4. 涉及渲染改动：查看 golden diff 图并记录理由。
5. 提交 PR，CI 绿灯合并。
