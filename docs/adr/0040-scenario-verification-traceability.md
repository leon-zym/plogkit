# ADR 0040：Scenario 验证证据采用跨层多对多映射

- 状态：已接受
- 接受日期：2026-08-09
- 修订：[ADR 0011](0011-testing-strategy.md) 与 [ADR 0012](0012-e2e-tooling-maestro.md) 中 Scenario 和 Maestro flow、行为测试一一对应的约束，[ADR 0013](0013-doc-system.md) 与 [ADR 0038](0038-document-ownership-contracts.md) 中不使用仓库校验器的约束
- 关联：[Issue #77](https://github.com/leon-zym/plogkit/issues/77)、[测试策略](../guides/testing-strategy.md)、[Spec 规范](../specs/README.md)

## 背景

F01–F09 的 Spec 以 GIVEN / WHEN / THEN 描述用户可观察行为，验证证据则分布在 L2 单元与组件测试、L3 无头渲染和 L4 Maestro E2E。一个设备 flow 可以覆盖多个 Scenario，一个 Scenario 也可能需要跨层组合才能同时证明交互、持久化和输出结果。

原有“一一对应”约束不能表达这种关系。Spec 标题也没有稳定标识，维护者无法从 Scenario 定位测试证据，删除或重构测试后也不会发现引用失效。功能已交付、拥有自动化证据和经过 L4 验证是三个不同事实，不能继续由一个 Spec 状态或功能编号相近的 flow 名称代替。

引入 Cucumber、Gherkin 运行时或 `.feature` 文件会把现有 Jest、CanvasKit 与 Maestro 强行包装成同一执行模型，并不能证明测试覆盖了 Scenario 的用户可观察结果。需要的是静态可追踪性，不是新的测试运行时。

## 决策

- 每个 Spec Scenario 在 Markdown 标题中使用仓库唯一且不随标题变化的 `FNN-SNN` 标识。标识一经分配不复用。
- `docs/specs/verification-map.json` 是 Scenario 到验证证据或自动化例外映射的唯一事实来源；Fxx Spec 继续拥有行为、标识和交付状态。
- 验证证据采用跨 L2、L3、L4 的多对多关系。一个 Scenario 可以引用多项证据，一项测试也可以支撑多个 Scenario。有效证据必须覆盖关键 GIVEN / WHEN / THEN，尤其是用户可观察的 THEN；文件名相近不构成证据。
- 已实现 Scenario 必须声明至少一项证据，或声明带明确理由和开放后续 Issue 的自动化例外。例外可以补充人工验证方式，补测完成后改为证据。尚未实现的交付例外不强制建立验证映射。
- 仓库提供静态校验器和 `pnpm verify:specs` 命令，检查 Scenario 标题与 ID、ID 唯一性、已实现 Scenario 的映射、映射结构、证据层级、文件存在性和悬空映射；`pnpm verify` 运行该校验。
- 校验器不解析测试实现、不验证可选测试名称，也不联网判断 Issue 状态。证据是否完整覆盖行为、Issue 是否仍开放和层级选择是否合理继续由人工语义审查负责。
- 继续使用 Markdown Spec 和现有测试运行器，不引入 Cucumber、Gherkin 工具链或 `.feature` 迁移。

## 迁移与兼容

F01–F09 的 103 个既有 Scenario 一次性获得稳定标识。102 个已实现 Scenario 建立初始映射，其中能够确认的 78 个记录自动化证据，其余 24 个记录自动化例外并关联 Issue #79–#85；F07-S08 仍为未实现的交付例外，不要求映射。

本决策只增加文档治理数据和静态校验，不改变 App 用户行为、持久数据格式或测试执行语义。

## 影响与代价

- Spec 或测试文件新增、删除和移动时，失配会在本地与 CI 中直接失败。
- 维护者可以区分已交付、已有自动化证据和已有 L4 证据，不再以顶层 flow 数量推断行为覆盖。
- 初始映射暴露的真实缺口有明确后续入口，不需要在本次治理变更中扩张为补齐全部测试。
- 映射需要随行为和测试重构维护；静态校验只能保证引用完整，不能替代对测试语义的审查。
