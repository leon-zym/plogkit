# ADR 0035：草稿缩略图按内容修订成对生成与提交

- 状态：已接受（2026-07-22）
- 修订：ADR 0027
- 关联：ADR 0025、0030、0033、0034、[F08](../specs/F08-draft-library.md)、[Issue #9](https://github.com/leon-zym/plogkit/issues/9)

## 背景

草稿库同时需要正方形铺满和完整原始比例两种展示。若只把超长作品降采样成一张原比例图片，正方形 `cover` 会放大很窄的像素区域并显著模糊。缩略图又在根记录保存后异步生成；连续保存、生成失败和删除可能让旧任务晚到，不能让派生文件覆盖较新的内容或复活已删除草稿。

## 决策

- 每个已提交 Thumbnail Pair 包含正方形专用表示、保持完整构图比例的表示、同一个 `contentRevision` 与内部 `profileVersion`。两种表示都从统一文档的完整构图渲染，包含图片、拼接、背景与文字，不使用第一张原图代替。
- 两份 generation 文件使用不可变、revision-scoped 的身份。只有两份文件都完整生成并通过解码、尺寸与 profile 校验后，才通过一个小型可恢复 pair record 一次切换当前 pair；Grid 不观察混合 revision 的表示。
- `ThumbnailProfile` 是代码内单一参数源，拥有正方形尺寸、原始比例长边上限、codec、质量、色彩与 metadata 策略，并由 adapter contract tests 约束。参数变化提升 `profileVersion`；旧 profile 的完整 pair 可以暂时展示并异步重建，不需要修改草稿根记录或迁移文档。
- 新 revision 生成期间或生成失败后继续展示旧完整 pair，不显示过期或损坏警告；没有旧 pair 时展示中性静态占位图。缩略图缺失、残缺或无法解码不构成损坏草稿。
- 同一草稿最多保留一个运行中的生成任务和一个最新待生成 revision；连续保存时合并中间 revision。每个 revision 在同一进程内最多自动尝试一次，失败后只在产生新 revision 或下次冷启动时重试，不进行无界循环。
- 大型渲染不长期占用同草稿持久操作队列；最终 pair 提交进入该队列，并重新确认根记录仍是目标 `contentRevision`、profile 仍受支持且没有有效删除标记。任一条件变化都丢弃本次结果，不发布陈旧 pair。
- pair revision 小于根记录 revision 是允许展示的旧派生结果；大于恢复后根记录 revision 的结果被忽略。未被当前 pair record 引用的 generation 文件由 best-effort maintenance 清理。
- 冷启动列表构建只检查派生文件存在性，不解码或重建缩略图；可见 item 加载失败时整对降级并按本 ADR 调度重建。

## 影响与代价

- 每个内容修订可能短暂保留两组派生文件和一个小型 pair record，换取两种显示方式清晰、成对切换及旧图降级。
- 精确编码参数不进入产品 spec 或 ADR 常量，避免设备密度和编码器调整被误当作 schema 迁移；profile version 与契约测试仍使持久派生文件可判定、可重建。
- 缩略图生成与文档保存解耦，保存成功不依赖渲染；代价是 Grid 可以暂时显示旧图或占位图。
