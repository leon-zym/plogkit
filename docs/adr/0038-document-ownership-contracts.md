# ADR 0038：以 ownership map 与 repo-local verifier 深化文档体系

- 状态：已接受
- 接受日期：2026-07-27
- 修订：[ADR 0013](0013-doc-system.md)
- 关联：[ADR 0014](0014-language-policy.md)、[Issue #50](https://github.com/leon-zym/plogkit/issues/50)

## 背景

ADR 0013 建立了 ADR、specs、guides 与 product 的文档分层，但没有定义各 module 的完整 ownership interface，也把结构完整性完全交给人工评审。随着功能与决定增加，同一可变事实被多个浅层摘要共同维护，功能状态、当前产品范围、视觉说明与仓库导航会在不同修改中分离。

文档需要更强的 locality：维护者应能从事实类型直接找到唯一 owner，并让稳定、可判定的结构错误在本地验证阶段暴露。同时，自然语言语义、翻译一致性与产品判断仍不能可靠地交给简单脚本。

## 决策

- [`docs/README.md`](../README.md) 是文档体系的 canonical 导航与 ownership map。它定义每个正式文档 module 拥有和不拥有的事实、允许的受控投影及更新触发条件。
- 其他文档只保留完成自身职责所需的最小投影并链接 canonical owner，不维护第二份功能状态、Roadmap、决策编号或工程规则台账。
- ADR 只接纳长期有效、跨 module 或难逆转，并改变 interface、seam、数据兼容性或工程约束的决定：
  - 状态仅为`已接受`、`部分修订`或`已取代`，与接受日期分开。
  - predecessor 与 successor 双向关联；演进通过新增 ADR 完成，不改写历史决定正文。
  - 背景、决策、影响与代价为必选内容；决策边界、替代方案、迁移与参考仅在该决定需要时出现，不写空章节。
- Fxx spec 是用户可观察行为与功能交付状态的 owner：
  - 整体状态仅为`草拟`、`已确认`或`已实现`。
  - Scenario 使用 `#### Scenario:` 与 GIVEN / WHEN / THEN；未标状态时继承整体状态。
  - 与整体不同的未实现 Scenario 必须直接关联开放 Issue；实现后删除例外状态和已关闭 Issue 的实施历史。
- 增加无第三方依赖的纯 Node 文档 verifier，并通过 `pnpm test:docs` 纳入 `pnpm verify`。它只检查文件、index、元数据、Scenario 最小结构、前后继关系、README 导航与 repo-local Markdown 链接等稳定不变量。
- verifier 是 in-process implementation，不引入外部 adapter seam、完整 Markdown parser、网络查询或文档管理框架。自然语言语义、外部链接可用性、Issue 实时状态和中英文等价性继续由评审负责。

## 决策边界

- 不通过 prose snapshot、固定段落顺序或逐字格式约束自然语言写作。
- verifier 不要求 README 双语对在每个 diff 中共同修改；共同变更不能证明翻译语义一致，双语维护规则与语义一致性仍由评审负责。
- 不把 Issue、PR、故障调查、spike 日志或实施进度迁入长期文档。
- 不改变 App 用户行为、持久数据、运行时架构或测试行为。

## 迁移与兼容

现有 ADR 只归一化标题、状态、接受日期、前后继关系、链接和 index，历史背景、决策与影响正文保持原貌。现有 specs 删除继承状态下的重复标注和实施历史，将仍有效的用户行为保留在正式 Scenario、范围或非目标中。

根 README、guides 与 `AGENTS.md` 收窄为受控投影并链接 ownership map。结构稳定后由 repo-local verifier 建立回归保护；该检查不需要迁移 App 数据或调整运行时依赖。

## 影响与代价

- 每类事实拥有单一修改位置，减少跨文档搜索和漏改，评审也能从 owner 检查投影是否仍准确。
- ADR、spec 和 index 的稳定最小结构为导航与自动检查提供可靠 interface。
- 维护者仍需评审语义、翻译与事实正确性；verifier 不能代替产品或架构判断。
- 新增正式文档 module 或改变结构契约时，需要同步更新 ownership map 与 verifier，形成少量明确维护成本。
