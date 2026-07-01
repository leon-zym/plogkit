# ADR 0009：MVP 导出 SDR、Live Photo 取静帧

- 状态：已接受（2026-07-02）
- 关联：ADR 0001、0006、0007

## 背景

维护者希望保留原图的 HDR 效果并支持 Live Photo。技术现实：

- iPhone 的 HDR 照片为"SDR 基图 + 增益图（gain map，ISO 21496-1）"结构，显示时动态合成。不理解增益图的管线导出即退化 SDR。Skia / React Native Skia 生态目前没有增益图编解码支持；成熟的读写能力在平台原生侧（Core Image / ImageIO）。
- Live Photo 为"照片 + 短视频"配对资产。编辑后保留 Live 意味着对视频轨施加同样的合成变换，属 AVFoundation 视频合成领域，与 MVP 不做视频的边界冲突。

两者若作为 MVP 硬需求，将动摇"纯 Skia 导出"（ADR 0001）的根基。

## 决策

- MVP 导出统一为 SDR。
- Live Photo 导入时取封面静帧（key photo）参与编辑。
- 两者列入 vNext 重评估：届时基于导出编码段接口（ADR 0007）评估引入平台原生编码实现（渲染主体保持 Skia），HDR 优先于 Live Photo。
- 在产品文档与用户可见的适当位置如实表述该限制，不做含糊承诺。

## 影响与代价

- HDR 用户的照片在 PlogKit 导出后观感变暗/变平，这是当前架构的已知妥协。
- vNext 引入原生编码段时，"拒绝原生管线"的原决策（ADR 0001）将被部分修正——本 ADR 即为该修正的预告与边界。
