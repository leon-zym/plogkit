# ADR 0038：以 ownership map 深化文档体系

- 状态：部分修订
- 接受日期：2026-07-27
- 后继：[ADR 0041](0041-scenario-verification-traceability.md)
- 修订：[ADR 0013](0013-doc-system.md)
- 关联：[ADR 0014](0014-language-policy.md)、[Issue #50](https://github.com/leon-zym/plogkit/issues/50)

## 背景

ADR 0013 建立了 ADR、specs、guides 与 product 的文档分层，但没有定义各 module 的 ownership interface。随着功能与决定增加，同一可变事实被多个摘要共同维护，功能状态、当前产品范围、视觉说明与仓库导航会在不同修改中分离。

维护者需要从事实类型找到唯一 owner，并能判断其他文档保留多少上下文。结构约定可以辅助评审，但自然语言语义、链接必要性、翻译一致性与产品判断仍需人工负责。

## 决策

- [`docs/README.md`](../README.md) 是文档体系的 canonical 导航与 ownership map。它定义每个正式文档 module 拥有和不拥有的事实、允许的受控投影及更新触发条件。
- 其他文档只保留完成自身职责所需的最小投影并链接 canonical owner，不维护第二份功能状态、Roadmap、决策编号或工程规则台账。
- ADR 只接纳长期有效的架构与工程治理决定，并至少满足一项准入条件：影响跨 module 职责边界；建立或改变 interface、seam；影响持久数据兼容性；采用难以逆转的技术选择；建立长期工程治理约束。
  - 状态仅为`已接受`、`部分修订`或`已取代`，与接受日期分开。
  - predecessor 与 successor 双向关联；演进通过新增 ADR 完成，不改写历史决定正文。
  - 背景、决策、影响与代价为必选内容；决策边界、替代方案、迁移与参考仅在该决定需要时出现，不写空章节。
- Fxx spec 是用户可观察行为与功能交付状态的 owner：
  - 整体状态仅为`草拟`、`已确认`或`已实现`。
  - Scenario 使用 `#### Scenario:` 与 GIVEN / WHEN / THEN；未标状态时继承整体状态。
  - 与整体不同的未实现 Scenario 必须直接关联开放 Issue；实现后删除例外状态和已关闭 Issue 的实施历史。
- 文档契约只通过 `docs/README.md`、ADR/Spec 目录规范、`AGENTS.md` 与 PR 评审进行软约束，不引入 repo-local verifier。

## 决策边界

- 不通过 prose snapshot、固定段落顺序或逐字格式约束自然语言写作。
- 不以自动检查代替链接必要性、Issue 状态、产品判断或中英文语义一致性评审。
- 不把 Issue、PR、故障调查、spike 日志或实施进度迁入长期文档。
- 不改变 App 用户行为、持久数据、运行时架构或测试行为。

## 迁移与兼容

本次迁移经维护者授权，可以一次性重组和删减现有 ADR 正文，移出用户验收、实施进度、过期待办和重复投影，但必须保留决定发生时的背景、结论与代价。真实决定变化仍通过新增 successor 表达，不借迁移改写历史。

现有 specs 删除继承状态下的重复标注和实施历史，将仍有效的用户行为保留在正式 Scenario、范围或非目标中。根 README、guides 与 `AGENTS.md` 收窄为受控投影并链接 ownership map。本次迁移不调整 App 数据或运行时依赖。

## 影响与代价

- 每类事实拥有单一修改位置，减少跨文档搜索和漏改，评审也能从 owner 检查投影是否仍准确。
- ADR、spec 和 index 的稳定最小结构为写作和评审提供共同依据。
- 维护者仍需人工检查语义、链接、翻译与事实正确性，文档治理成本不会由脚本消除。
- 新增正式文档 module 或改变结构契约时，需要同步更新 ownership map。
