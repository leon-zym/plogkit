# 测试策略

测试层级与执行节奏的决策依据见 [ADR 0011](../adr/0011-testing-strategy.md)、[ADR 0012](../adr/0012-e2e-tooling-maestro.md)、[ADR 0019](../adr/0019-cross-platform-maestro-e2e.md)、[ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md) 和 [ADR 0026](../adr/0026-test-runners-by-runtime.md)；导出验收的产物边界见 [ADR 0023](../adr/0023-export-preset-catalog-and-pipeline.md)。本文记录当前可执行的测试层级、命令和贡献要求。

## 设计原则

- 验收场景先写入 `docs/specs/`，测试名称描述用户可观察的行为。BDD 是方法，不引入 Cucumber 或 Gherkin 工具链。
- `src/core` 保持纯 TypeScript，不依赖 React 或 React Native，并采用先写失败测试、再实现和重构的 TDD 循环。
- 可序列化文档是渲染、持久化和导出的数据源，使核心行为能在设备外验证。
- 不设置覆盖率百分比门槛。测试应覆盖行为和边界条件，避免为数字指标编写无意义断言。

## 四层验证

### L1 静态检查

TypeScript strict 和 ESLint 提供最快反馈。代码格式遵循 Prettier 输出。

### L2 单元与组件测试

- App 单元/组件测试使用 jest-expo；E2E runner 的纯 Node 逻辑使用 Node 内置测试运行器。
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

Maestro 在 iOS Simulator 和 Android Emulator 上驱动 PlogKit development build，JS bundle 由 Metro 提供。CI 使用固定的 Maestro CLI 基线，本地工具要求见[开发环境](dev-environment.md)。runner 不自动改变开发机环境。

- `e2e/flows/f01-*.yaml` 至 `f07-*.yaml` 对应 `docs/specs/` 中的功能场景；`f00-settings.yaml` 覆盖全局设置。
- `e2e/subflows/` 存放复用步骤。业务步骤跨平台共享，系统照片选择器等差异用 `platform` 条件进入 iOS 或 Android 子流程，禁止复制完整业务 flow。
- `e2e/fixtures/` 存放确定性测试照片；runner 每次擦除专用设备后只注入一组 fixture。
- flow 通过 `testID`、`accessibilityLabel` 和可见文案定位界面并断言行为。
- 同一场景在 Android 与 iOS 使用相同的 Unicode 测试数据，包括中文与 emoji；不得以 ASCII fallback 降低平台验收范围。
- `clearState` 会重置应用数据。dev menu 的自动界面由项目 config plugin 禁用，避免干扰业务元素定位。
- 本地与 CI 共用同一编排入口。具体命令行为和环境要求见[开发环境](dev-environment.md)。

当可见界面不足以证明持久化结果时，通过 `simctl` 或 `adb` 读取 App 沙盒内的草稿文档。导出 E2E 在 iOS 系统相册或 Android MediaStore 中断言新资源，不依赖 App 沙盒中的最终副本；像素、格式、尺寸与 metadata 由 backend contract 和无头渲染层断言。不应向生产代码添加测试后门；设备状态断言必须纳入共享 runner 或 flow，避免本地与 CI 分叉。

### 设备 readiness 与 flow 隔离

设备进入业务 flow 前必须证明 launcher 与 UI hierarchy 可响应且不存在系统 ANR；boot flag、服务注册或固定等待不能单独视为 ready。每个业务 flow 隔离运行，单个设备或 driver 故障不得污染后续 flow。失败时须保留足以区分产品、Metro、driver 与设备层的 artifacts，具体探针、分类和采集命令由 runner 及其测试定义。

## CI 门禁

| 触发                     | Runner                   | 内容                                                      |
| ------------------------ | ------------------------ | --------------------------------------------------------- |
| push 到 `main` / 任意 PR | Ubuntu                   | `pnpm verify`，覆盖 L1、L2 和 L3                          |
| ready / 正式 PR 的新提交 | macOS + Ubuntu（并行）   | iOS Simulator Debug 与 Android arm64 Debug 原生集成编译   |
| 每周一 02:30（北京时间） | macOS + Ubuntu（并行）   | iOS Simulator 与 Android Emulator 的完整 Maestro 验收套件 |
| 手动                     | macOS / Ubuntu（按选择） | 完整双端套件，或指定平台和 flow 的诊断运行                |

Draft PR 的每次提交只运行 `pnpm verify`。转为 ready 时触发双端编译检查，此后正式 PR 的每次新提交重新运行全部三项检查。`main` ruleset 要求 PR 和这三项检查全部通过后才能合并，见 [ADR 0016](../adr/0016-git-workflow.md) 和 [ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md)。

## 命令

| 命令                   | 作用                                       |
| ---------------------- | ------------------------------------------ |
| `pnpm check`           | 类型检查和 lint                            |
| `pnpm test`            | App、核心逻辑和组件测试                    |
| `pnpm test:e2e-runner` | E2E runner 的纯 Node 逻辑测试              |
| `pnpm test:render`     | L3 golden 测试                             |
| `pnpm e2e`             | 重置专用双端设备并运行两端完整 L4          |
| `pnpm e2e:ios`         | 重置专用 iOS Simulator 并运行完整 L4       |
| `pnpm e2e:android`     | 重置专用 Android Emulator 并运行完整 L4    |
| `pnpm verify`          | 聚合静态、Node、App 和渲染验证，提交前运行 |

E2E 失败但原因不明时，先在相同条件下重跑受影响的平台和 flow，确认能否复现；不得用 retry、sleep 或盲目延长 timeout 掩盖偶发失败。修复后先做同范围验证，再按变更风险决定是否扩大到单平台或双端完整套件。具体诊断命令见[开发环境](dev-environment.md)。

## 验证时机

行为变化先更新对应 spec；架构决策变化先新增 ADR。验证强度随风险递增，不把完整 E2E 绑定到每次提交。

| 时机                 | 验证方式                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| 变更过程中           | 运行受影响的 Jest 或 Node runner 测试；需要完整静态反馈时运行 `pnpm check`                           |
| 提交前               | 运行 `pnpm verify`；渲染变化必须检查实际图片和 diff 后再更新 golden                                  |
| 设备敏感变更的 PR 前 | 系统 UI 或单平台行为变化运行对应平台完整 L4；关键跨端流程、原生配置、持久化或导出变化运行完整双端 L4 |
| 里程碑或发布候选版本 | 运行完整双端 L4 和手动 CI E2E，并完成双端真机冒烟                                                    |
