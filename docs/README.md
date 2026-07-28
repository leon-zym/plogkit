# 文档导航与 ownership map

本目录的中文文档是 PlogKit 产品、架构、功能验收和工程操作的权威来源。每类可变事实只由一个文档 module 拥有；其他文档只能保留完成自身职责所需的受控投影，并链接 canonical owner。

## Ownership map

| Module                                                                    | Canonical ownership                              | 不负责                                      | 允许的受控投影                                                      | 更新触发条件                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`docs/adr/`](adr/)                                                       | 长期有效的架构与工程治理决定，以及决定的演进关系 | 功能交付状态、实施进度、故障调查、工作清单  | 在调用方附近概述仍生效的约束，并链接对应 ADR                        | 跨 module 职责、interface、seam、数据兼容性、难逆转的技术选择或工程治理约束发生长期变化时新增 ADR |
| [`docs/specs/`](specs/)                                                   | 用户可观察行为、验收 Scenario、功能交付状态      | 实现机制、架构理由、历史排障                | 测试与 guide 可以引用 Scenario，不复制功能状态                      | 用户行为、验收边界或交付状态变化时先更新 spec                                                     |
| [`product-decisions.md`](product/product-decisions.md)                    | 稳定定位、目标用户、产品原则与用户任务           | 逐功能验收或实施状态                        | README 可以保留简短定位摘要并链接本文                               | 定位、目标用户、原则或核心任务改变时                                                              |
| [`product-scope.md`](product/product-scope.md)                            | 当前产品范围、已确认方向与硬边界                 | 详细 Scenario 或 Issue 进度                 | README 与 `AGENTS.md` 可以概述范围并链接本文                        | 当前范围、已确认方向或产品硬边界改变时                                                            |
| [`naming-and-slogan.md`](product/naming-and-slogan.md)                    | 发布前品牌选择；名称确定后只保留最终品牌契约     | 候选讨论历史                                | README 可以展示当前品牌名与 slogan                                  | 品牌选择落定或最终品牌契约改变时                                                                  |
| [`docs/guides/`](guides/)                                                 | 当前可执行流程、开发操作与视觉规则               | 功能语义或另一份产品状态                    | 可以保留执行操作所需的本地上下文，并链接 spec、ADR 或 product owner | 操作步骤、环境要求或视觉规则改变时                                                                |
| [`README.md`](../README.md) / [`README.zh-Hans.md`](../README.zh-Hans.md) | 面向外部的双语浅入口与文档导航                   | 完整功能台账、技术规则或 Roadmap 状态 owner | 简要介绍当前产品、技术栈和主要能力，并链接本页及 canonical owner    | 外部入口需要反映新的稳定基线时；语义一致性由评审负责                                              |
| [`AGENTS.md`](../AGENTS.md)                                               | 稳定、可执行的 Agent 规则与仓库导航              | 当前功能清单、实施状态或重复的产品硬边界    | 为执行提供短命令、路径和强制规则，并链接本页及 canonical owner      | Agent 执行约束或仓库导航改变时                                                                    |
| [`CONTEXT.md`](../CONTEXT.md)                                             | 项目领域词汇                                     | 架构决策或功能验收                          | ADR、spec、Issue、测试和代码使用其中的统一术语                      | 领域概念或明确排除的同义词改变时                                                                  |
| [`docs/agents/`](agents/)                                                 | 仓库特定的 Agent 和工具 adapter 约定             | 产品、功能或架构状态                        | 可以链接其所服务的 canonical owner，不复制所有权                    | Issue tracker、triage 或领域文档 adapter 约定改变时                                               |

## 受控投影规则

- Ownership 针对具体事实，不针对宽泛主题。同一功能可以由 spec 拥有用户行为、ADR 拥有技术决定、product 文档拥有范围边界。
- 投影只保留当前读者完成本地任务所需的最少上下文，并直接链接 canonical owner。
- 功能交付状态只写在对应 Fxx spec 及其 index；其他文档不得维护第二份状态表。
- ADR index 只导航 ADR 文件、状态与 successor，不建立第二套决策编号或摘要台账。
- README 的功能摘要、guide 的视觉或操作上下文、`AGENTS.md` 的执行提示都不是新的事实 owner。
- Issue、PR、调查 artifact 和测试输出承载实施过程与历史证据，不迁入长期文档。
- 无法可靠归入某个 owner 的内容先留在原处并在 Issue 中确认，不为通过结构检查而删除或改写。

## 变更路径

1. 用户可观察行为或交付状态变化：先更新 [`docs/specs/`](specs/)。
2. 长期 interface、seam、兼容性或工程治理决定变化：新增 ADR，并双向关联 predecessor 与 successor。
3. 产品定位、范围或硬边界变化：更新对应 [`docs/product/`](product/) owner。
4. 当前操作、环境或视觉规则变化：更新 [`docs/guides/`](guides/)；涉及功能时链接对应 spec。
5. 外部入口需要反映稳定基线：同步审阅 README 双语对，并保持两份文件都链接本页。

ADR 与 spec 的具体结构契约分别见 [`docs/adr/README.md`](adr/README.md) 和 [`docs/specs/README.md`](specs/README.md)。文档语言规则见 [ADR 0014](adr/0014-language-policy.md)，ownership contract 见 [ADR 0038](adr/0038-document-ownership-contracts.md)。
