# F06 会话自动保存与恢复

- 状态：已实现
- 关联：[ADR 0004](../adr/0004-state-management-undo.md)、[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)、[ADR 0025](../adr/0025-recoverable-draft-persistence-maintenance.md)、[F08](F08-draft-library.md)

## 概述

应用自动保存当前草稿。用户打开或切换草稿、返回草稿库、进入后台或重新启动应用后，不会得到半保存或无法确认的编辑结果。

## 非目标

- 草稿库的浏览与管理行为由 [F08](F08-draft-library.md) 验收。
- 不支持跨设备恢复。

## 需求与场景

### 需求 1：自动保存

#### Scenario: 提交即持久化

- GIVEN 用户完成一次编辑，如添加文本
- WHEN 应用完成自动保存
- THEN 用户重新打开该草稿时可以看到最新编辑

### 需求 2：打开与切换

#### Scenario: 打开有效草稿

- GIVEN 一个持久化内容完整的草稿
- WHEN 用户打开该草稿
- THEN 应用进入 Editor 并展示草稿内容

#### Scenario: 从草稿库继续终止前的草稿

- GIVEN 当前草稿的最新编辑已持久化，应用被系统或用户强制终止
- WHEN 用户重新启动应用
- THEN 应用先展示草稿库，且该草稿仍可被发现，不自动进入 Editor
- WHEN 用户从 Grid 打开该草稿
- THEN 应用进入 Editor，画布内容与终止前一致
- AND 新进程不保留终止前的撤销与重做记录

#### Scenario: 损坏的持久事实拒绝打开

- GIVEN 草稿的原图或编辑内容损坏，无法安全恢复
- WHEN 用户打开该草稿
- THEN 应用提示该草稿无法安全打开，不以残缺状态进入 Editor

#### Scenario: 切换失败不丢失当前草稿

- GIVEN 当前草稿有一个活跃会话
- WHEN 用户打开另一个草稿
- THEN 应用先保存当前最新修改，确认目标草稿可用后再进入其 Editor
- AND 保存或打开失败时不进入目标 Editor，原当前编辑会话保持不变

#### Scenario: 后台切换不丢失

- GIVEN 用户处于编辑中
- WHEN 应用进入后台超过数分钟后返回
- THEN 编辑状态完整保留

#### Scenario: 返回草稿库保留同进程撤销记录

- GIVEN 用户正在编辑一个草稿
- WHEN 用户返回草稿库后，在同一进程内再次打开该草稿
- THEN 之前的撤销与重做记录仍然可用

#### Scenario: 成功切换草稿后重置撤销记录

- GIVEN 用户在草稿 A 中完成了可撤销的编辑
- WHEN 用户成功切换到草稿 B，随后重新打开草稿 A
- THEN 草稿 A 保留已经保存的编辑结果
- AND 之前的撤销与重做记录不再可用

#### Scenario: 主动离开时保存失败

- GIVEN 当前草稿有尚未保存的修改
- WHEN 用户主动离开 Editor，但保存失败
- THEN 阻止导航并保留未保存修改，允许用户重试
- AND 若后台保存失败，同样不丢弃未保存修改

### 需求 3：保存中断后的恢复

#### Scenario: 保存中断后恢复完整版本

- GIVEN 草稿已有一个可读取的持久版本
- WHEN 应用在保存新版本的过程中终止
- THEN 应用下次读取该草稿时恢复旧版本或已经完整提交的新版本
- AND 不以缺失或部分写入的文档进入 Editor
