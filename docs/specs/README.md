# 功能需求 Specs

本目录是用户可观察行为、验收 Scenario 与功能交付状态的 canonical owner，也是 Maestro E2E flow、组件测试命名与自动化验收的共同蓝本。完整文档 ownership 见 [`docs/README.md`](../README.md)，BDD 与测试约束见 [ADR 0011](../adr/0011-testing-strategy.md)，结构契约见 [ADR 0038](../adr/0038-document-ownership-contracts.md)。

## 规范

- 每个功能一份文件，命名 `FNN-slug.md`。
- 每份 spec 必须包含标题、整体状态、非空概述及“需求与场景”；范围与非目标只在 inclusion test 需要时保留。
- 场景采用 `#### Scenario:` 标题，每个 Scenario 至少包含一个 GIVEN、WHEN 和 THEN；AND 可选。
- 场景描述**行为**而非实现；实现约束引用对应 ADR。
- spec 是活文档：需求变化时先改 spec 再改实现；开发时先写对应失败测试再实现。
- 整体状态只使用`草拟`、`已确认`或`已实现`，并作为功能交付状态的 canonical fact。
- Scenario 默认继承整体状态，不重复标注。只有状态与整体不同时才写独立的`状态`和`Issue`字段；未实现例外必须关联开放 Issue。
- 当前基线尚未完整交付时，整体保持`已确认`。已交付功能的未来扩展可以作为例外 Scenario；实现后删除例外状态，不保留已关闭 Issue 的实施历史。
- 不设置固定的实施跟踪、已解决问题、后续观察或开放问题章节；实施过程归 Issue 或 PR，架构理由归 ADR。

## 索引

| 编号                              | 功能               | 状态   |
| --------------------------------- | ------------------ | ------ |
| [F01](F01-add-text.md)            | 为图片加字         | 已实现 |
| [F02](F02-background.md)          | 背景               | 已实现 |
| [F03](F03-stitch-images.md)       | 多图拼接           | 已实现 |
| [F04](F04-export.md)              | 导出与压缩预设     | 已实现 |
| [F05](F05-undo-redo.md)           | 撤销与重做         | 已实现 |
| [F06](F06-session-persistence.md) | 会话自动保存与恢复 | 已实现 |
| [F07](F07-image-import.md)        | 图片导入与资产管理 | 已实现 |
| [F08](F08-draft-library.md)       | 本地草稿库         | 已实现 |
