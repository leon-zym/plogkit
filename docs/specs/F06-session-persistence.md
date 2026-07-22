# F06 会话自动保存与恢复

- 状态：已实现
- 关联：[ADR 0003](../adr/0003-document-driven-architecture.md)、[ADR 0004](../adr/0004-state-management-undo.md)、[ADR 0006](../adr/0006-image-import-pipeline.md)、[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)、[ADR 0025](../adr/0025-recoverable-draft-persistence-maintenance.md)、[ADR 0027](../adr/0027-draft-root-record.md)、[ADR 0029](../adr/0029-draft-library-pre-release-baseline-reset.md)、[ADR 0033](../adr/0033-per-draft-deletion-marker.md)、[ADR 0034](../adr/0034-draft-content-revision.md)
- 实施跟踪：[Issue #9](https://github.com/leon-zym/plogkit/issues/9)、[Issue #14](https://github.com/leon-zym/plogkit/issues/14)、[Issue #15](https://github.com/leon-zym/plogkit/issues/15)

## 概述

当前编辑会话绑定一个 `DraftId`，自动保存其草稿根记录，并在打开、切换、返回草稿库或进入后台时保持明确的 flush 与 dirty/retry 语义。

## 范围

- 每次文档提交点触发自动保存调度。
- 按 `DraftId` 幂等打开，切换时先保存当前草稿再原子切换。
- 文档带 `schemaVersion`。草稿库产品化按 ADR 0029 再次建立发布前 baseline，不保留旧数据；此后升级恢复迁移纪律。

## 非目标

- 草稿库 Grid、排序、缩略图、删除和损坏条目交互由 [F08](F08-draft-library.md) 验收，不在本 feature 重复。
- 云备份与跨设备同步不属于当前范围。

## 需求与场景

### 需求 1：自动保存

#### Scenario: 提交即持久化

- 状态：已实现
- GIVEN 用户完成一次编辑提交（如添加文本）
- WHEN 自动保存调度完成
- THEN 当前 `DraftId` 的持久化统一文档反映最新文档状态

（注：当可见界面不足以证明持久化结果时，持久化草稿文件可作为 E2E 状态断言的观测点，见 [ADR 0011](../adr/0011-testing-strategy.md)。）

#### Scenario: 不同内容与排序时间作为同一修订提交

- 状态：已实现
- GIVEN 当前草稿已有一个成功保存的内容修订
- WHEN 不同的统一文档保存成功
- THEN 文档、内容修订号与最近编辑时间作为同一个完整根记录提交
- AND 相同文档重复保存或保存失败不增加修订号，也不改变最近编辑时间

### 需求 2：打开与切换

#### Scenario: 打开有效草稿

- 状态：已实现
- GIVEN 一个持久化内容完整的草稿
- WHEN 用户打开该草稿
- THEN 应用进入 Editor 并展示草稿内容
- AND 预览缺失或损坏时自动重建，可选拍摄信息缺失时仍可编辑

#### Scenario: 从草稿库继续终止前的草稿

- 状态：已实现
- GIVEN 当前草稿的最新编辑已持久化，应用被系统或用户强制终止
- WHEN 用户重新启动应用
- THEN 应用先展示草稿库，且该草稿仍可被发现，不自动进入 Editor
- WHEN 用户从 Grid 打开该草稿
- THEN 应用进入 Editor，画布内容与终止前一致
- AND 新的当前编辑会话不保留上个进程的 undo/redo history

#### Scenario: 损坏的持久事实拒绝打开

- 状态：已实现
- GIVEN 草稿的原图或编辑内容损坏，无法安全恢复
- WHEN 用户打开该草稿
- THEN 应用提示该草稿无法安全打开，不以残缺状态进入 Editor

#### Scenario: 草稿切换原子化

- 状态：已实现
- GIVEN 当前草稿有一个活跃会话
- WHEN 用户打开另一个草稿
- THEN 应用先保存当前最新修改，确认目标草稿可用后再进入其 Editor
- AND 保存或打开失败时不进入目标 Editor，原当前编辑会话保持不变

#### Scenario: 后台切换不丢失

- GIVEN 用户处于编辑中
- WHEN 应用进入后台超过数分钟后返回
- THEN 编辑状态完整保留

#### Scenario: 返回草稿库保留同进程 history

- 状态：已实现
- GIVEN 用户正在编辑一个草稿
- WHEN 用户返回草稿库后再次打开同一 `DraftId`
- THEN 返回时只 flush 而不结束当前编辑会话
- AND 同进程内的 undo/redo history 保留；切换草稿、删除所绑定的草稿或进程终止才结束会话

#### Scenario: 主动离开时 flush 失败

- 状态：已实现
- GIVEN 当前草稿有 dirty 修改
- WHEN 用户主动离开 Editor 且 flush 失败
- THEN 阻止导航并保留未保存修改，允许用户重试
- AND 若后台保存失败，同样不丢弃未保存修改

### 需求 3：持久化恢复与非破坏性检查

#### Scenario: 替换持久事实中断后恢复完整版本

- GIVEN 草稿已有一个可读取的持久版本
- WHEN 保存新版本时进程在旧目标移除后、替换完成前终止
- THEN 应用下次读取该草稿时恢复旧版本或已经完整提交的新版本
- AND 不以缺失或部分写入的文档进入 Editor

#### Scenario: 检查活跃草稿不压缩会话资产

- GIVEN 当前草稿有活跃编辑会话，undo history 仍引用持久文档未引用的导入资产
- WHEN 草稿库普通读取或未来列表检查该草稿
- THEN 不压缩 catalog 或删除该资产
- AND 只有草稿成功失活后的明确维护流程可以按最新持久文档执行压缩

#### Scenario: 维护故障不遮蔽有效草稿

- GIVEN 草稿 aggregate 完整可读，但 staging 枚举或遗留文件删除暂时失败
- WHEN 用户打开、保存或继续编辑该草稿
- THEN 主 transaction 仍按 aggregate 本身的结果完成
- AND 后续安全维护入口重试遗留清理
