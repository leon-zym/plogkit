# 功能需求 Specs

本目录以 BDD 风格固化各功能的需求边界与验收场景，是 Maestro E2E flow、组件测试命名与 Agent 开发验收的共同蓝本（见 [ADR 0011](../adr/0011-testing-strategy.md)、[ADR 0013](../adr/0013-doc-system.md)）。

## 规范

- 每个功能一份文件，命名 `FNN-slug.md`。
- 场景采用 `#### Scenario:` 标题 + GIVEN / WHEN / THEN 列表（与 OpenSpec 格式亲和）。
- 场景描述**行为**而非实现；实现约束引用对应 ADR。
- spec 是活文档：需求变化时先改 spec 再改实现；开发时先写对应失败测试再实现。
- 状态标注：`草拟` → `已确认` → `已实现`。场景级别可单独标注。

## 索引

| 编号                              | 功能               | 状态                     |
| --------------------------------- | ------------------ | ------------------------ |
| [F01](F01-add-text.md)            | 为图片加字         | 已确认                   |
| [F02](F02-background.md)          | 背景               | 已确认                   |
| [F03](F03-stitch-images.md)       | 多图拼接           | 已确认                   |
| [F04](F04-export.md)              | 导出与压缩预设     | 已确认（平台参数待定义） |
| [F05](F05-undo-redo.md)           | 撤销与重做         | 已确认                   |
| [F06](F06-session-persistence.md) | 会话自动保存与恢复 | 已确认                   |
| [F07](F07-image-import.md)        | 图片导入与资产管理 | 已确认                   |
