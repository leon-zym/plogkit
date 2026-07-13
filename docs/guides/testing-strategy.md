# 测试策略

决策依据见 [ADR 0011](../adr/0011-testing-strategy.md) 和 [ADR 0012](../adr/0012-e2e-tooling-maestro.md)。本文记录当前可执行的测试层级、命令和贡献要求。

## 设计原则

- 验收场景先写入 `docs/specs/`，测试名称描述用户可观察的行为。BDD 是方法，不引入 Cucumber 或 Gherkin 工具链。
- `src/core` 保持纯 TypeScript，不依赖 React 或 React Native，并采用先写失败测试、再实现和重构的 TDD 循环。
- 可序列化文档是渲染、持久化和导出的数据源，使核心行为能在设备外验证。
- 不设置覆盖率百分比门槛。测试应覆盖行为和边界条件，避免为数字指标编写无意义断言。

## 五层测试

### L1 静态检查

TypeScript strict 和 ESLint 提供最快反馈。代码格式遵循 Prettier 输出。

### L2 单元与组件测试

- jest-expo 是唯一测试运行器。
- React Native Testing Library 用于组件交互测试。
- `src/core` 的文档模型、布局计算、撤销栈和预设逻辑不依赖原生环境。
- 服务层通过明确接口隔离文件、相册和编码能力，测试正常路径、失败处理和资源释放。

### L3 Skia 无头渲染回归

React Native Skia 通过 CanvasKit-WASM 在 Node 中创建离屏 surface。设备预览和无头测试共用场景构建逻辑，测试将渲染结果与仓库中的 PNG golden 做 RGBA 像素比较。

修改渲染逻辑后：

1. 运行 `pnpm test:render` 生成比较结果。
2. 如果测试失败，检查输出的实际图片和 diff 图。
3. 只有确认变化符合预期后，才使用 `pnpm test:render -u` 更新 golden。

Golden 必须使用随包字体，不能依赖系统字体。无头渲染代码必须显式释放 Skia surface 和 image。CanvasKit 与设备原生 Skia 可能存在抗锯齿差异，因此 golden 用于检测无头渲染链路自身的回归，不替代设备验收。

### L4 端到端测试

Maestro 在 iOS 模拟器上驱动 PlogKit development build，JS bundle 由 Metro 提供。E2E 不使用 Expo Go。

- `e2e/flows/f01-*.yaml` 至 `f07-*.yaml` 对应 `docs/specs/` 中的功能场景；`f00-settings.yaml` 覆盖全局设置。
- `e2e/subflows/` 存放复用步骤，`e2e/fixtures/` 存放确定性测试照片。
- CI 使用 `xcrun simctl addmedia` 注入照片。
- flow 通过 `testID`、`accessibilityLabel` 和可见文案定位界面并断言行为。
- `clearState` 会重置应用数据。dev menu 的自动界面由项目 config plugin 禁用，避免干扰业务元素定位。

当可见界面不足以证明持久化或导出结果时，应通过 `xcrun simctl get_app_container` 读取 App 沙盒或导出文件，不应向生产代码添加测试后门。新增这类断言时，把脚本和断言纳入 `e2e/` 或 CI，确保本地与自动化环境使用同一实现。

### L5 CI

| 触发        | Runner | 内容                                                         |
| ----------- | ------ | ------------------------------------------------------------ |
| push / PR   | Ubuntu | `pnpm verify`，覆盖 L1、L2 和 L3                             |
| PR          | Ubuntu | Android arm64 Debug development build 原生集成编译           |
| 定时 / 手动 | macOS  | iOS 模拟器 development build 和完整 Maestro acceptance suite |

PR 必须通过所需检查后才能合并，见 [ADR 0016](../adr/0016-git-workflow.md)。

## 命令

| 命令               | 作用                                               |
| ------------------ | -------------------------------------------------- |
| `pnpm check`       | 类型检查和 lint                                    |
| `pnpm test`        | L2 单元与组件测试                                  |
| `pnpm test:render` | L3 golden 测试                                     |
| `pnpm e2e`         | L4 Maestro，需要模拟器、development build 和 Metro |
| `pnpm verify`      | 聚合 L1、L2 和 L3，提交前运行                      |

## 开发循环

1. 行为变化先更新 `docs/specs/` 中对应场景。
2. 为新行为添加失败测试。纯逻辑使用单元测试，交互使用组件测试，渲染变化使用 golden，关键用户流程使用 Maestro。
3. 实现后运行 `pnpm verify`。
4. 涉及渲染变化时，查看图片和 diff 后再更新 golden。
5. 需要设备验收时运行 `pnpm e2e`，然后提交 PR。
