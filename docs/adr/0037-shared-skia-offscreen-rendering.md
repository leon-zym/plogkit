# ADR 0037：共享 Skia 离屏构图使用具体目标批次与内部资源所有权

- 状态：已接受
- 接受日期：2026-07-27
- 关联：ADR 0018、0023、0024、0035、[F04](../specs/F04-export.md)、[F08](../specs/F08-draft-library.md)

## 背景

当前 SDR/sRGB 静态 Skia 路径包含无头 golden、Skia 导出 backend 与草稿缩略图三类 caller。它们使用同一种 `RenderScene` 和文字布局语义，却分别编排 surface、场景变换、original asset 读取与解码、绘制顺序、snapshot、编码和资源释放。原有绘制 module 只封装背景、单图和文字三个 primitive，caller 仍需掌握完整构图与所有权；草稿缩略图还会为正方形和原比例表示重复文字排版及高分辨率素材解码。

导出的稳定 external seam 已由 ADR 0023 固定在 `ExportPipeline → ExportBackend`。未来原生 HDR 或 Live Photo backend 需要不同的像素、色彩空间和产物形状，因此共享当前 Skia 实现不能演变为所有 backend 必须采用的中立像素或编码 interface。

## 决策

在 `src/render/` 内建立 concrete、internal 的 Skia offscreen scene renderer module，供当前 headless CanvasKit、Skia export backend 与草稿 Thumbnail adapter 复用。它只实现当前 SDR/sRGB 静态图片路径，不进入 `ExportBackend` 的稳定 external seam，也不服务 React/Skia declarative Preview。

Renderer interface 接受 immutable `RenderScene`、只提供 original 表示的资产来源、一个 concrete target 或 two-target batch，以及可选 `AbortSignal`。每个 target 只声明唯一 ID、正整数输出尺寸、轴对齐的 `scaleX`、`scaleY`、`translateX`、`translateY` 变换，以及 PNG 或带合法 quality 的 JPEG 编码。Export preset、metadata policy、Thumbnail profile、crop/contain 语义、destination 和文件写入不进入该 interface；caller 先按自身领域契约投影 concrete target。

Two-target batch 只服务当前 Thumbnail pair。每个 target 的长边不得超过 720px，两个 target 的 output pixels 总和不得超过 648000；renderer 在建立文字布局或创建任何 surface 前校验这些上限。单 target 不受 Thumbnail batch 上限约束，因此 export 继续按 `ResolvedExportPolicy` 使用单个目标，但任何 caller 都不能通过 batch 同时持有两个 export-sized surface。

Renderer implementation 统一拥有以下顺序和资源：

1. 校验 target、变换和编码参数，并一次创建 `TextLayoutSnapshot`。
2. 为全部 target 创建 surface，应用明确的 scene-to-output transform。
3. 严格按背景、`scene.images` 顺序、`scene.texts` 顺序绘制完整场景。
4. 只解析 original asset；一次读取并解码一个素材，将同一个 `SkImage` 依次绘制到 batch 的全部 surface 后立即释放，不预载全部高分辨率素材。
5. flush、snapshot、静态编码并拒绝空输出；batch 只有全部 target 成功才返回按 target ID 关联的普通 `Uint8Array`。
6. 在 success、typed failure、cancelled 和 thrown programming error 路径释放全部 paint、`SkData`、`SkImage`、surface、snapshot 与 `TextLayoutSnapshot`。

Renderer 返回 target validation、original asset unavailable/load/decode、text layout、surface/draw、encode 和 cancellation phase 等内部技术结果。Export backend 将其映射为稳定的 `asset-unavailable`、`render-failed`、`encode-failed` 与 phase；Thumbnail 和 headless harness 保留各自错误语义。Caller 借出 scene、asset source、targets 与 signal 直到调用完成，永远不取得或释放 Skia artifact。

运行时差异位于两个真实 local-substitutable adapter：

- Device adapter 使用 RN Skia、device text layout environment 和 original asset URI。
- Headless adapter 使用 CanvasKit、bundled-font text layout environment 和 encoded fixture map。

两者穿过同一个 renderer interface。内部 adapter seam 不提升为 runtime registry，也不向 caller 暴露成组 Skia primitive。

Skia export backend 继续拥有 `ResolvedExportPolicy`、capabilities、metadata 后处理、稳定错误映射、`PreparedExport` staging 与 backend identity。Thumbnail adapter 继续拥有 `DraftThumbnailProfile`、正方形 cover 与原比例 long-edge/no-upscale geometry、generation 文件写入及 pair publication。Headless harness 继续拥有 fixture、bundled fonts、golden comparison、RGBA diff 与 diff PNG。

不得由本 module 恢复 `RenderedPixels`、neutral RGBA buffer、外露 `SkImage`、standalone encoder 或 backend registry。未来 iOS HDR backend 可以使用原生 pixel buffer、色彩空间、gain map 与 encoder；未来 Live Photo backend 可以使用照片/视频资源对与 AVFoundation。二者都可以完全绕过本 renderer，并按 ADR 0023 在真实需求出现时扩展 backend 与 `PreparedExport`。

未来 Live Photo 能力只适用于该能力上线后新导入、并按届时资产契约保留照片／视频资源对的素材。现有草稿继续遵循 F07 与 ADR 0009 的静帧语义，不补录、推测恢复或迁移已经丢弃的 paired video。本决策不修改统一文档 schema、catalog schema、Thumbnail `profileVersion` 或任何持久数据。

## 影响与代价

- 三条离屏路径通过更小 interface 获得完整构图、batch 复用和一致资源释放；修复绘制或 lifecycle 问题只需修改一处。
- Thumbnail pair 只建立一次文字布局，并对每个 original asset 只解码一次；代价是生成当前两个小尺寸表示时同时持有两个 output surface。
- 测试以 renderer interface 验证完整像素构图、batch 原子性、typed failure、取消和资源所有权；caller contract tests 只验证领域投影与错误映射，不保留低级 primitive 调用顺序测试。
- 当前 golden、导出格式/质量/metadata、Thumbnail profile/geometry、持久 schema、Preview 和 F04/F08 用户可观察行为保持不变，因此无需数据迁移或 spec 修改。
- Device Skia 与 CanvasKit 仍可能有运行时实现差异；差异由各自 adapter 吸收。若未来差异无法由薄 adapter 表达，应保留高层 renderer interface 并允许 adapter 采用不同 implementation，而不是向 caller 泄漏 Skia orchestration。
