# ADR 0041：Scenario 验证证据由原生测试声明

- 状态：已接受
- 接受日期：2026-08-09
- 修订：[ADR 0011](0011-testing-strategy.md) 与 [ADR 0012](0012-e2e-tooling-maestro.md) 中 Scenario 和 Maestro flow、行为测试一一对应的约束，[ADR 0013](0013-doc-system.md) 与 [ADR 0038](0038-document-ownership-contracts.md) 中不使用仓库校验器的约束
- 关联：[Issue #77](https://github.com/leon-zym/plogkit/issues/77)、[测试策略](../guides/testing-strategy.md)、[Spec 规范](../specs/README.md)

## 背景

F01–F09 的 Spec 以 GIVEN / WHEN / THEN 描述用户可观察行为，验证证据分布在 L2 单元与组件测试、L3 无头渲染和 L4 Maestro E2E。一个设备 flow 可以覆盖多个 Scenario，一个 Scenario 也可能需要跨层组合才能同时证明交互、持久化和输出结果。

原有“一一对应”约束不能表达这种关系。Spec 标题也没有稳定标识，维护者无法从 Scenario 定位测试证据，删除或重构测试后不会发现验收行为失去覆盖。功能已交付、拥有自动化证据和经过 L4 验证是三个不同事实，不能由一个 Spec 状态或功能编号相近的 flow 名称代替。

单独维护 Scenario 到文件路径和测试名称的 JSON 清单会在 Spec 与测试之外增加第三个同步修改点。清单不拥有独立产品或测试事实，也不能证明测试断言满足 Scenario；当所有已实现行为都必须拥有自动化测试时，清单中的例外模型同样没有长期职责。

引入 Cucumber、Gherkin 运行时或 `.feature` 文件会把现有 Jest、CanvasKit 与 Maestro 强行包装成同一执行模型，并不能提高断言的语义真实性。需要的是原生测试可追踪性，不是新的测试运行时。

## 决策

- 每个 Spec Scenario 在 Markdown 标题中使用仓库唯一且不随标题变化的 `FNN-SNN` 标识。标识一经分配不复用。
- 验证证据由原生测试自身声明，不提交独立映射文件：
  - L2/L3 的 `it`、`test` 与 `it.each` 标题以一个或多个 `[FNN-SNN]` 开头。
  - L4 顶层 Maestro Flow 在配置区的 `tags` 中列出一个或多个 `FNN-SNN`；subflow 不独立作为证据。
  - 证据层级由测试文件路径推导。
- 验证证据采用跨 L2、L3、L4 的多对多关系。一个 Scenario 可以由多项测试组合证明，一项测试也可以支撑多个 Scenario。有效证据必须覆盖关键 GIVEN / WHEN / THEN，尤其是用户可观察的 THEN。
- 每个`已实现` Scenario 必须拥有至少一项启用的自动化测试绑定，不设自动化例外。尚未实现的 Scenario 不强制绑定；实现行为、测试和状态更新必须在同一变更中完成。
- 仓库提供静态校验器和 `pnpm verify:specs` 命令，检查 Scenario 标题与 ID、ID 唯一性、原生测试标题、Maestro tags、已实现 Scenario 的绑定完整性及悬空声明；`pnpm verify` 运行该校验。
- 校验器使用仓库现有 TypeScript 依赖解析测试声明，不增加测试 wrapper、运行时、生成文件或第三方依赖。校验器不解析断言语义；证据是否完整覆盖行为继续由评审负责。
- 继续使用 Markdown Spec 和现有测试运行器，不引入 Cucumber、Gherkin 工具链或 `.feature` 迁移。

## 迁移与兼容

F01–F09 的 103 个既有 Scenario 一次性获得稳定标识。102 个已实现 Scenario 在原生测试中建立 168 项初始绑定；F07-S08 仍为尚未实现的交付项，不要求测试绑定。此前审计发现的缺口已由 Issue #79–#85 及后续测试变更补齐。

本决策只增加测试名称、Flow tags 和静态校验，不改变 App 用户行为、持久数据格式或测试执行语义。不存在需要迁移的用户数据，删除本机制也只需移除测试侧 ID 和校验命令。

## 影响与代价

- 新增已实现 Scenario 而未增加测试绑定、删除最后一项证据或留下未知 ID 时，本地与 CI 会直接失败。
- 测试移动或重命名时 ID 随测试保留，不需要同步修改第三份清单；失败报告也直接显示 Scenario ID。
- 维护者可以从测试路径区分 L2、L3、L4 证据，不再以顶层 flow 数量推断行为覆盖。
- 测试标题和 Flow tags 增加少量治理元数据。初始迁移涉及多处测试名称，但后续维护只发生在本来就必须同步变更的 Spec 与测试中。
- 静态校验只能保证声明完整，不能判断断言语义或强迫有意义的测试修改；Spec 行为变化仍需通过 TDD 和评审确认对应测试发生实质变化。
