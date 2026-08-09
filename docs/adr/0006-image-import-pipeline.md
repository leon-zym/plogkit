# ADR 0006：图片导入管线：沙盒拷贝 + 降采样预览

- 状态：部分修订
- 接受日期：2026-07-02
- 后继：[ADR 0022](0022-draft-aggregate-current-editing-session.md)、[ADR 0040](0040-system-photo-picker-batch-boundary.md)
- 关联：[ADR 0003](0003-document-driven-architecture.md)、[ADR 0007](0007-export-pipeline.md)、[ADR 0009](0009-sdr-export-live-photo-still.md)、[ADR 0017](0017-share-extension-deferred.md)、[F07](../specs/F07-image-import.md)

## 背景

系统相册资产引用不稳定：iCloud 照片可能不在本地、原图可能被删除或修改，再编辑需要稳定的源素材。同时，iPhone 原图（24MP+）直接进入预览画布会带来内存与纹理尺寸风险，多图拼接场景尤甚。

## 决策

- 导入即拷贝：选图后立即将原图复制到应用沙盒的项目资产目录，文档模型只引用沙盒内资产，绝不假设外部引用长期有效。
- 同时生成降采样预览副本（长边 ≤ 2048）；预览画布只使用预览副本。
- 导出时按需逐张解码沙盒原图，绘制后立即释放，避免同时持有多张全分辨率位图。
- Live Photo 在导入时取封面静帧（key photo）作为源素材（ADR 0009）。
- iCloud 未下载资产：导入时请求下载并等待，超时向用户提示。
- 导入入口抽象为“外部图片进入编辑流程”的来源无关通道，新增来源不改变导入管线的职责（ADR 0017）。

## 影响与代价

- 沙盒同时保存原图与预览，会增加存储占用，并需要明确的资产生命周期与清理策略。
- 草稿身份、目录和资产所有权已由 [ADR 0022](0022-draft-aggregate-current-editing-session.md) 进一步定义。
