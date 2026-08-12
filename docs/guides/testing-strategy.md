# 测试策略

测试层级与执行节奏的决策依据见 [ADR 0011](../adr/0011-testing-strategy.md)、[ADR 0012](../adr/0012-e2e-tooling-maestro.md)、[ADR 0019](../adr/0019-cross-platform-maestro-e2e.md)、[ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md)、[ADR 0026](../adr/0026-test-runners-by-runtime.md)、[ADR 0039](../adr/0039-native-node-orchestration-tests.md)、[ADR 0041](../adr/0041-scenario-verification-traceability.md) 和 [ADR 0042](../adr/0042-controlled-standalone-simulator-e2e.md)；导出验收的产物边界见 [ADR 0023](../adr/0023-export-preset-catalog-and-pipeline.md)，手动性能测量协议见[导出与缩略图性能基线](render-performance-baseline.md)。本文记录当前可执行的测试层级、命令和贡献要求。

## 设计原则

- 验收场景先写入 `docs/specs/`，提供证据的原生测试在名称或 Flow tags 中声明稳定 Scenario ID。BDD 是方法，不引入 Cucumber 或 Gherkin 工具链。
- `src/core` 保持纯 TypeScript，不依赖 React 或 React Native，并采用先写失败测试、再实现和重构的 TDD 循环。
- 可序列化文档是渲染、持久化和导出的数据源，使核心行为能在设备外验证。
- 不设置覆盖率百分比门槛。测试应覆盖行为和边界条件，避免为数字指标编写无意义断言。

## 四层验证

### L1 静态检查

TypeScript strict 和 ESLint 提供最快反馈。代码格式遵循 Prettier 输出。

### L2 单元与组件测试

- App、core、services、组件和无头渲染的功能行为使用现有 Jest 配置；仅宿主 Node CLI、环境、子进程、文件系统、探针和 artifact 编排使用 Node 内置测试运行器。编排器测试不构成新的验证层级。
- React Native Testing Library 用于组件交互测试。
- `src/core` 的文档模型、布局计算、撤销栈和预设逻辑不依赖原生环境。
- 服务层通过明确接口隔离文件、相册和编码能力，测试正常路径、失败处理和资源释放。
- Draft Library 与 Current Editing Session 的确定性故障注入、可靠性 profile 和结论边界见[草稿可靠性 Soak 执行协议](reliability-soak.md)。

### L3 Skia 无头渲染回归

React Native Skia 通过 CanvasKit-WASM 在 Node 中创建离屏 surface。设备预览和无头测试共用场景构建逻辑，测试将渲染结果与仓库中的 PNG golden 做 RGBA 像素比较。

修改渲染逻辑后：

1. 运行 `pnpm test:render` 生成比较结果。
2. 如果测试失败，检查输出的实际图片和 diff 图。
3. 只有确认变化符合预期后，才使用 `pnpm test:render -u` 更新 golden。

Golden 必须使用随包字体，不能依赖系统字体。无头渲染代码必须显式释放 Skia surface 和 image。CanvasKit 与设备原生 Skia 可能存在抗锯齿差异，因此 golden 用于检测无头渲染链路自身的回归，不替代设备验收。

### L4 端到端测试

Maestro 在 iOS Simulator 和 Android Emulator 上驱动 clean Release standalone 产物。production Hermes bundle 在构建阶段嵌入 App，测试阶段不启动 Metro、不经过 development launcher，也不依赖宿主网络。CI 与本地使用相同的入口和工具链契约，具体要求见[开发环境](dev-environment.md)。runner 只校验环境，不自动改变开发机工具。

- `e2e/flows/*.yaml` 对关键跨端路径进行 L4 抽样；具体覆盖的 Scenario 由 Flow 配置区的 tags 声明，不以功能编号相同推定完整覆盖。
- `e2e/subflows/` 存放复用步骤。业务步骤跨平台共享，系统照片选择器等差异用 `platform` 条件进入 iOS 或 Android 子流程，禁止复制完整业务 flow。
- `e2e/fixtures/` 存放确定性测试照片；runner 每次创建唯一临时设备后只注入一组 fixture。
- flow 通过 `testID`、`accessibilityLabel` 和可见文案定位界面并断言行为。
- 同一场景在 Android 与 iOS 使用相同的 Unicode 测试数据，包括中文与 emoji；不得以 ASCII fallback 降低平台验收范围。
- Maestro 的 `launchApp` 默认允许全部权限。每条顶层 flow 的首次启动必须同时使用 `clearState: true` 和 `permissions.all: unset`，重置 App 数据并建立未决定的系统权限边界；同一 flow 内验证生命周期的 relaunch 不清数据，并以 `permissions: {}` 保留当前权限。需要验证首次授权的场景还要断言系统授权界面和授权后的业务结果。
- 本地与 CI 共用同一编排入口。具体命令行为和环境要求见[开发环境](dev-environment.md)。

当可见界面不足以验证实现契约时，可以通过 `simctl` 或 `adb` 读取 App 沙盒内的草稿文档。这类白盒检查不把内部事实转化为 Spec 行为，也不能替代受支持交互上的黑盒验收。导出 E2E 在每次成功反馈后通过共享 runner 在 iOS 系统相册或 Android MediaStore 中断言恰好一个新资源，不依赖 App 沙盒中的最终副本；像素、格式、尺寸与 metadata 由 backend contract 和无头渲染层断言。不应向生产代码添加测试后门；设备状态断言必须纳入共享 runner 或 flow，避免本地与 CI 分叉。

### 设备 readiness 与 flow 隔离

项目 runner 必须拥有唯一临时模拟设备从创建到删除的完整生命周期；CI Action 不得先启动设备或绕过项目 readiness。最小 boot 边界之后只允许执行有界、无恢复的系统健康门禁；安装 App 和注入 fixture 后，runner 仍须证明真实 Home launcher、前台窗口和 UI hierarchy 可响应且不存在系统故障。boot flag、健康门禁或固定等待都不能单独替代 UI readiness。失败立即终止，不通过重启、重复输入或关闭错误界面恢复。

每个平台只构建并冻结一份 Release 产物，随后在一个临时设备和一个 Maestro workspace 中串行执行 `e2e/config.yaml` 配置的顶层 flows。每条 flow 按 Maestro 的平台语义清空 App 数据，但不重新构建或更换受测产物；同一 flow 内可以保留数据验证生命周期。系统相册等设备级状态跨 flow 保留，因此 fixture 只注入一次，会改变系统状态的 Export 固定最后执行。任一 flow 失败都立即终止；timeout 只负责有界结束失控进程，不承担失败恢复。

## Scenario 可追踪性

已实现 Scenario 必须由 L2/L3 原生测试标题或 L4 Maestro Flow tags 声明至少一项自动化证据，具体格式见 [Spec 规范](../specs/README.md)。绑定是跨层多对多关系，不要求每个 Scenario 拥有独立 Maestro flow，也不维护独立映射清单。

选择证据层级时：

- 确定性业务规则、服务 contract 和组件可观察交互优先使用 L2。
- 像素构图、实际编码、尺寸、格式和 metadata 输出使用 L3；需要时与 L2 policy 测试组合。
- 系统选择器、系统相册、应用生命周期和关键跨端主路径使用 L4 抽样，不把可在设备外稳定证明的全部边界塞入 E2E。
- 单层能够完整覆盖关键 GIVEN / WHEN / THEN 时不重复堆叠层级；交互与最终产物位于不同 seam 时组合多项证据。

L2/L3 层级由测试文件路径推导，L4 由顶层 Flow 路径确定。`pnpm verify:specs` 使用 TypeScript 语法树读取启用的 `it`、`test` 和 `it.each` 标题，并读取 Maestro tags；它拒绝缺失、悬空、重复、格式错误、禁用测试上的声明以及可能跳过同文件其他证据的聚焦声明。静态校验不解析断言语义，评审者仍须确认每项证据覆盖 Scenario 的用户可观察 THEN。

## CI 门禁

| 触发                     | Runner                   | 内容                                                    |
| ------------------------ | ------------------------ | ------------------------------------------------------- |
| push 到 `main` / 任意 PR | Ubuntu                   | `pnpm verify`，覆盖 L1、L2 和 L3                        |
| ready / 正式 PR 的新提交 | macOS + Ubuntu（并行）   | iOS Simulator Debug 与 Android arm64 Debug 原生集成编译 |
| 每周一 02:30（北京时间） | macOS + Ubuntu（并行）   | 双端 Release standalone 的完整 Maestro 验收套件         |
| 手动                     | macOS / Ubuntu（按选择） | 完整双端或指定平台 / flow                               |

Draft PR 的每次提交只运行 `pnpm verify`。转为 ready 时触发双端编译检查，此后正式 PR 的每次新提交重新运行全部三项检查。`main` ruleset 要求 PR 和这三项检查全部通过后才能合并，见 [ADR 0016](../adr/0016-git-workflow.md) 和 [ADR 0020](../adr/0020-ci-lifecycle-and-main-ruleset.md)。

## 命令

| 命令                      | 作用                                                 |
| ------------------------- | ---------------------------------------------------- |
| `pnpm check`              | 类型检查和 lint                                      |
| `pnpm test`               | App、核心逻辑和组件测试                              |
| `pnpm test:orchestration` | 宿主 Node 编排器的纯 Node 逻辑测试                   |
| `pnpm verify:specs`       | 静态校验 Scenario ID、测试标题与 Maestro Flow tags   |
| `pnpm test:render`        | L3 golden 测试                                       |
| `pnpm measure:render`     | 先验证 L3，再生成资格门禁的 Mac / CanvasKit 工程测量 |
| `pnpm e2e`                | 创建临时双端设备并运行两端完整 L4                    |
| `pnpm e2e:ios`            | 创建临时 iOS Simulator 并运行完整 L4                 |
| `pnpm e2e:android`        | 创建临时 Android Emulator 并运行完整 L4              |
| `pnpm verify`             | 聚合静态、Scenario 绑定、Node、App 和渲染验证        |

可靠性 profile 使用以下独立命令；固定输入、artifact 与结论边界见[草稿可靠性 Soak 执行协议](reliability-soak.md)。

| 命令                                                  | 作用                                                  |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `pnpm test:reliability-soak`                          | 固定 1,000 个状态机步骤的快速可靠性回归               |
| `pnpm test:reliability-soak:evidence`                 | 运行并重放 25,000 个状态机步骤，生成 ignored artifact |
| `pnpm test:reliability-soak:replay -- <seed> [steps]` | 重放一条确定性可靠性轨迹                              |

Draft Library、Current Editing Session、recoverable persistence 或相关 adapter 变更必须运行 quick。高风险持久化/并发改动合并前及 release candidate 验收时运行 evidence，并将 ignored artifact 附到对应 Issue 或 CI run。

E2E 失败但原因不明时，先检查该次运行保存的日志、hierarchy、截图和系统诊断，在最小受影响 seam 上提出可证伪假设；不要以重跑完整套件代替诊断。不得用 retry、sleep、关闭错误界面或盲目延长 timeout 掩盖失败。修复后先做定向红绿验证，再按风险扩大到单平台或双端完整套件。一次性诊断 harness 和样本证据留在 Issue/PR，不固化为常驻 E2E 接口。

## 验证时机

行为变化先更新对应 Spec，架构决策变化先新增 ADR。开发中运行能证伪当前改动的最小层级；代码和配置提交前运行 `pnpm verify`。L4 按设备语义风险升级，不按 diff 大小机械触发。原生编译是跨层集成门禁，不是第五个测试层。

| 变更类型                                           | 开发中                                                 | PR 前升级                                                                 |
| -------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| 文档、注释或非运行时元数据                         | 检查链接、格式和负责文档                               | 运行受影响的文档契约；不跑 L4                                             |
| 纯 TypeScript 规则、service、普通组件或 UI         | 定向 L1/L2                                             | `pnpm verify`；未跨系统或生命周期 seam 时不跑 L4                          |
| 普通用户需求                                       | 更新 Spec，定向 L2；视觉变化增加 L3                    | 关键设备路径才运行定向 L4；跨端共享主路径运行双端                         |
| Skia、render、export 或 thumbnail                  | L2 policy + L3；人工检查 actual/diff 后再更新 golden   | 影响设备预览、原生编码或系统相册时运行受影响平台 L4；共享语义运行双端     |
| 持久化、App 生命周期、picker、权限或系统相册       | L2，必要时运行 reliability profile                     | 运行受影响平台完整 L4；两端系统契约变化时运行双端                         |
| Expo app config、config plugin、原生依赖或原生代码 | clean prebuild + 受影响平台原生编译                    | 平台专属变化运行该端 L4；共享配置、依赖或启动变化运行双端 L4              |
| Maestro flow 或 subflow                            | 语法、宿主配置契约和定向 flow                          | 共享 flow 双端定向；顺序、权限或设备状态边界变化运行双端完整 L4           |
| E2E runner、workflow、工具链或设备 profile         | Node 编排测试 + clean build + 对应平台定向             | 单平台变化运行该端完整 L4；共享契约运行双端 GitHub L4                     |
| 大需求或大重构                                     | 按 seam 持续运行 L1-L3，在稳定检查点运行 `pnpm verify` | 按所涉 seam 组合前述验证；只有跨系统、生命周期或关键设备主路径时才升级 L4 |
| 里程碑或发布候选                                   | 全部自动层                                             | 双端完整 CI L4 + 双端真机人工冒烟                                         |

render / export / thumbnail policy、Skia runtime、measurement fixture 或 toolchain 变更后，变更负责人运行 `PLOGKIT_RENDER_MEASUREMENT_PROFILE=smoke pnpm measure:render`。高风险图像链路改动或 release candidate 前，在 clean、isolated、交流电宿主机运行 full profile。measurement artifacts 保持 Git ignored；需要跨人或异步复核时附到对应 Issue 或 CI job artifact。该协议是手动工程测量，不属于自动 CI 性能门禁。
