# F06 会话自动保存与恢复

- 状态：部分实现（Draft Aggregate/Current Editing Session 架构重构待实施）
- 关联：[ADR 0003](../adr/0003-document-driven-architecture.md)、[ADR 0004](../adr/0004-state-management-undo.md)、[ADR 0006](../adr/0006-image-import-pipeline.md)、[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)

## 概述

当前编辑会话绑定一个 `DraftId`，自动保存其统一文档，并在打开、切换、返回草稿库或进入后台时保持明确的 flush 与 dirty/retry 语义。

## 范围

- 每次文档提交点触发自动保存调度。
- 按 `DraftId` 幂等打开，切换时先保存当前草稿再原子切换。
- 文档带 `schemaVersion`。本次产品发布前 baseline reset 不保留旧数据；此后升级恢复迁移纪律。

## 非目标

- 草稿列表的命名、排序、缩略图、删除交互，云备份与跨设备同步。

## 需求与场景

### 需求 1：自动保存

#### Scenario: 提交即持久化

- GIVEN 用户完成一次编辑提交（如添加文本）
- WHEN 自动保存调度完成
- THEN 当前 `DraftId` 的持久化统一文档反映最新文档状态

（注：当可见界面不足以证明持久化结果时，持久化草稿文件可作为 E2E 状态断言的观测点，见 [ADR 0011](../adr/0011-testing-strategy.md)。）

### 需求 2：打开与切换

#### Scenario: 打开有效草稿

- GIVEN 一个持久化内容完整的草稿
- WHEN 用户打开该草稿
- THEN 应用进入 Editor 并展示草稿内容
- AND 预览缺失或损坏时自动重建，可选拍摄信息缺失时仍可编辑

#### Scenario: 损坏的持久事实拒绝打开

- GIVEN 草稿的原图或编辑内容损坏，无法安全恢复
- WHEN 用户打开该草稿
- THEN 应用提示该草稿无法安全打开，不以残缺状态进入 Editor

#### Scenario: 草稿切换原子化

- GIVEN 当前草稿有一个活跃会话
- WHEN 用户打开另一个草稿
- THEN 应用先保存当前最新修改，确认目标草稿可用后再显示它
- AND 保存或打开失败时继续显示原草稿

#### Scenario: 后台切换不丢失

- GIVEN 用户处于编辑中
- WHEN 应用进入后台超过数分钟后返回
- THEN 编辑状态完整保留

#### Scenario: 返回草稿库保留同进程 history

- GIVEN 用户正在编辑一个草稿
- WHEN 用户返回草稿库后再次打开同一 `DraftId`
- THEN 返回时只 flush 而不结束当前编辑会话
- AND 同进程内的 undo/redo history 保留；切换草稿或进程终止才结束会话

#### Scenario: 主动离开时 flush 失败

- GIVEN 当前草稿有 dirty 修改
- WHEN 用户主动离开 Editor 且 flush 失败
- THEN 阻止导航并保留未保存修改，允许用户重试
- AND 若后台保存失败，同样不丢弃未保存修改
