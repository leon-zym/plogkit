# F06 会话自动保存与恢复

- 状态：已确认
- 关联：[ADR 0003](../adr/0003-document-driven-architecture.md)、[ADR 0004](../adr/0004-state-management-undo.md)、[ADR 0006](../adr/0006-image-import-pipeline.md)

## 概述

当前编辑会话自动持久化为沙盒内的 `document.json` 与资产目录，意外退出后可恢复。不是完整草稿列表。

## 范围

- 每次文档提交点触发自动保存调度。
- 启动时检测并恢复未完成会话。
- 文档带 `schemaVersion`，升级时执行迁移。

## 非目标

- 多项目/草稿列表、云备份、跨设备同步。

## 需求与场景

### 需求 1：自动保存

#### Scenario: 提交即持久化

- GIVEN 用户完成一次编辑提交（如添加文本）
- WHEN 自动保存调度完成
- THEN 沙盒 `projects/current/document.json` 反映最新文档状态

（注：该文件同时是 E2E 测试断言应用状态的观测点，见 [ADR 0011](../adr/0011-testing-strategy.md)。）

### 需求 2：恢复

#### Scenario: 杀进程后恢复会话

- GIVEN 用户处于编辑中且已有提交，应用被系统或用户强制终止
- WHEN 用户重新启动应用
- THEN 应用提示或直接恢复上次编辑会话，画布内容与终止前一致

#### Scenario: 后台切换不丢失

- GIVEN 用户处于编辑中
- WHEN 应用进入后台超过数分钟后返回
- THEN 编辑状态完整保留

#### Scenario: 损坏文档降级

- GIVEN 沙盒中的 `document.json` 无法解析（损坏或来自不兼容的未来版本且无迁移路径）
- WHEN 用户启动应用
- THEN 应用进入新会话并提示恢复失败，不崩溃
- AND 损坏文件被移至备份位置而非直接删除

### 需求 3：schema 迁移

#### Scenario: 旧版本文档升级

- GIVEN 沙盒中存在低 `schemaVersion` 的有效文档
- WHEN 新版本应用启动并恢复会话
- THEN 文档被迁移到当前 schema 后正常打开
