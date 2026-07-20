# F07 图片导入与资产管理

- 状态：已实现
- 关联：[ADR 0006](../adr/0006-image-import-pipeline.md)、[ADR 0009](../adr/0009-sdr-export-live-photo-still.md)、[ADR 0017](../adr/0017-share-extension-deferred.md)、[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)、[ADR 0025](../adr/0025-recoverable-draft-persistence-maintenance.md)
- 实施跟踪：[Issue #14](https://github.com/leon-zym/plogkit/issues/14)、[Issue #15](https://github.com/leon-zym/plogkit/issues/15)

## 概述

从系统相册选择图片进入编辑，源图拷贝入沙盒并生成预览副本。导入通道与图片来源解耦（为 v1.1 Share Extension 预留）。

## 范围

- 系统照片选择器（PHPicker 类，无需完整相册权限）。
- 多选（当前上限与拼接上限一致）。
- 沙盒拷贝 + 降采样预览副本生成。
- Live Photo 取封面静帧。
- iCloud 资产下载等待与超时提示。

## 非目标

- 应用内相册浏览器、相机拍摄、非图片资产。

## 需求与场景

### 需求 1：选图与导入

#### Scenario: 多选导入

- 状态：已实现
- GIVEN 用户在首页点击选图
- WHEN 用户在系统选择器中选中 3 张有效且本地可读取的照片并确认
- THEN 应用创建草稿，并在 Editor 中展示全部 3 张图片

#### Scenario: 部分失败保留同批次成功图片

- 状态：已实现
- GIVEN 用户选择的 3 张图片中有 1 张在导入时失败
- WHEN 另外 2 张图片导入成功
- THEN 应用创建只包含 2 张成功图片的草稿并进入 Editor
- AND 应用明确提示失败项，不丢弃同批次中已经成功的图片

#### Scenario: 取消或全部失败不创建草稿

- 状态：已实现
- GIVEN 用户开始从外部图片候选创建草稿
- WHEN 用户取消，或所有候选均导入失败
- THEN 应用不创建或展示一个残缺草稿

#### Scenario: 预览使用降采样副本

- GIVEN 导入了一张 24MP 原图
- WHEN 编辑画布渲染该图片
- THEN 画布加载的是长边 ≤ 2048 的预览副本（内存受控）
- AND 导出时使用沙盒原图（见 F04）

### 需求 2：特殊资产

#### Scenario: Live Photo 取静帧

- GIVEN 用户选中一张 Live Photo
- WHEN 导入完成
- THEN 沙盒中保存的是其封面静帧，编辑与导出按普通图片处理

#### Scenario: iCloud 资产等待下载

- GIVEN 用户选中一张仅存于 iCloud 的照片
- WHEN 导入开始
- THEN 界面显示下载进行中，下载完成后继续导入流程
- AND 下载超时或失败时给出明确提示，已成功的图片不受影响

#### Scenario: 替换图片可以在当前会话撤销

- 状态：已确认（当前会话语义已由 [Issue #15](https://github.com/leon-zym/plogkit/issues/15) 实现，待用户入口）
- GIVEN 当前编辑会话中的文档包含一张图片
- WHEN 用户替换该图片后执行撤销
- THEN 原图片重新出现在文档与预览中

### 需求 3：来源解耦

#### Scenario: 原图删除不影响再编辑

- GIVEN 一个已保存的编辑会话
- WHEN 用户在系统相册中删除了原始照片后重新打开应用
- THEN 会话恢复正常，编辑与导出不受影响（使用沙盒拷贝）

### 需求 4：孤立文件恢复性清理

#### Scenario: 删除失败后由后续维护重试

- GIVEN 非活跃草稿已成功提交移除无引用资产的 catalog，但对应文件删除失败
- WHEN 后续对该非活跃草稿执行维护
- THEN 当前 catalog 无法到达的 owned 直属文件被再次清理
- AND 仍被 catalog 引用的原图、预览与 metadata 保留

#### Scenario: 导入或预览中断残留被清理

- GIVEN 导入在 catalog 提交前终止，或预览重建在替换前终止
- WHEN 后续对完整且非活跃的草稿执行维护
- THEN 未被当前 catalog 到达的发布文件与临时文件被清理

#### Scenario: 损坏 catalog 禁止破坏性清扫

- GIVEN 草稿 catalog 损坏或持久文档引用无法安全验证
- WHEN 草稿库尝试维护该草稿
- THEN 不执行资产可达性清扫
- AND 草稿继续以 typed recovery failure 报告损坏

## 已解决与后续问题

- 多选上限与 F03 统一为 9 张。
- 草稿资产的身份、不可变原图、会话内 undo 保留与安全压缩由 ADR 0022 定义，不在本 feature spec 重复内部顺序。
