# F07 图片导入

- 状态：已实现
- 关联：[ADR 0006](../adr/0006-image-import-pipeline.md)、[ADR 0009](../adr/0009-sdr-export-live-photo-still.md)、[ADR 0022](../adr/0022-draft-aggregate-current-editing-session.md)

## 概述

用户从系统相册选择图片创建草稿。导入完成后，即使系统相册中的原图被删除，草稿仍可继续编辑和导出。

## 非目标

- 应用内相册浏览器、相机拍摄、非图片资产。

## 需求与场景

### 需求 1：选图与导入

#### Scenario F07-S01: 多选导入

- GIVEN 用户在首页点击选图
- WHEN 用户在系统选择器中选中 3 张有效且本地可读取的照片并确认
- THEN 应用创建草稿，并在 Editor 中展示全部 3 张图片

#### Scenario F07-S02: 一次最多选择九张图片

- GIVEN 用户从首页打开系统照片选择器
- WHEN 用户选择图片
- THEN 一次最多可以确认 9 张图片

#### Scenario F07-S03: 系统照片选择器不要求完整相册权限

- GIVEN 应用未获得完整相册访问权限
- WHEN 用户从首页打开系统照片选择器并选择照片
- THEN 用户仍可确认选中的照片并完成导入

#### Scenario F07-S04: 部分失败保留同批次成功图片

- GIVEN 用户选择的 3 张图片中有 1 张在导入时失败
- WHEN 另外 2 张图片导入成功
- THEN 应用创建只包含 2 张成功图片的草稿并进入 Editor
- AND 应用明确提示失败项，不丢弃同批次中已经成功的图片

#### Scenario F07-S05: 取消或全部失败不创建草稿

- GIVEN 用户开始从外部图片候选创建草稿
- WHEN 用户取消，或所有候选均导入失败
- THEN 应用不创建或展示一个残缺草稿

### 需求 2：特殊资产

#### Scenario F07-S06: Live Photo 取静帧

- GIVEN 用户选中一张 Live Photo
- WHEN 导入完成
- THEN 编辑与导出使用该 Live Photo 的封面静帧

#### Scenario F07-S07: iCloud 资产等待下载

- GIVEN 用户选中一张仅存于 iCloud 的照片
- WHEN 导入开始
- THEN 界面显示下载进行中，下载完成后继续导入流程
- AND 下载超时或失败时给出明确提示，已成功的图片不受影响

#### Scenario F07-S08: 替换图片可以在当前会话撤销

- 状态：已确认
- Issue：[Issue #53](https://github.com/leon-zym/plogkit/issues/53)
- GIVEN 画布中已有一张图片
- WHEN 用户替换该图片后执行撤销
- THEN 原图片重新出现在画布中

### 需求 3：来源解耦

#### Scenario F07-S09: 原图删除不影响再编辑

- GIVEN 一个已保存的编辑会话
- WHEN 用户在系统相册中删除了原始照片后重新打开应用
- THEN 草稿恢复正常，编辑与导出不受影响
