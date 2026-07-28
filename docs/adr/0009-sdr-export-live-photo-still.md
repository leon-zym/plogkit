# ADR 0009：MVP 导出 SDR、Live Photo 取静帧

- 状态：已接受
- 接受日期：2026-07-02
- 关联：[ADR 0001](0001-core-stack-rn-skia.md)、[ADR 0006](0006-image-import-pipeline.md)、[ADR 0007](0007-export-pipeline.md)、[F04](../specs/F04-export.md)、[F07](../specs/F07-image-import.md)

## 背景

PlogKit 的理想目标是保留原图的 HDR 效果并支持 Live Photo。技术现实：

- iPhone 的 HDR 照片为“SDR 基图 + 增益图（gain map，ISO 21496-1）”结构，显示时动态合成。不理解增益图的管线导出即退化 SDR。Skia / React Native Skia 生态目前没有增益图编解码支持；成熟的读写能力在平台原生侧（Core Image / ImageIO）。
- Live Photo 为“照片 + 短视频”配对资产。编辑后保留 Live 意味着对视频轨施加同样的合成变换，属 AVFoundation 视频合成领域，与 MVP 不做视频的边界冲突。

两者若作为 MVP 硬需求，将动摇“纯 Skia 导出”（ADR 0001）的根基。

## 决策

- MVP 导出统一为 SDR。
- Live Photo 导入时取封面静帧（key photo）参与编辑。
- 以后支持 HDR 或 Live Photo 时，基于导出 backend seam 重新评估平台原生实现，并新增 ADR。
- 用户可观察的导入与导出边界分别由 [F07](../specs/F07-image-import.md) 和 [F04](../specs/F04-export.md) 定义。

## 影响与代价

- HDR 用户的照片在 PlogKit 导出后观感变暗/变平，这是当前架构的已知妥协。
- 引入原生 HDR 或 Live Photo backend 时，需要修订 ADR 0001 与当前导出边界。
