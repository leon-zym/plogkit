# ADR 0024：以实际排版深化文本块布局与交互几何

- 状态：已接受（2026-07-17）
- 关联：ADR 0003、0005、0011、0021、0023

## 背景

当前 Skia Paragraph 按真实字体 fallback、中文换行、对齐与行高渲染文本，但 `TextGestureOverlay` 另以 `fontSize × 0.72` 和字符数估算高度。同一个文本块因此具有两套几何知识，短文本会占据整段排版宽度的空白命中区域，中文、emoji、fallback 或显式换行也会让渲染、选中框与拖动区域发生漂移。现有测试只 mock ParagraphBuilder 并断言调用顺序，不能证明实际排版与交互一致。

## 决策

- 文本块运行时最终几何的唯一事实源是 `src/render/` 中的 text block layout module。统一文档只保存内容、排版约束、样式选择与放置意图，不保存测量高度、line metrics、visual bounds 或 touch bounds；删除 `estimatedTextHeight()` 及其他字符宽度 heuristic。
- Skia Paragraph 是当前基础排版几何来源，不是永远完整的最终边界。MVP 的 `visualBounds` 由实际 line metrics 并集与 Paragraph 高度产生；未来描边、阴影或其他花字效果由同一 module 在基础边界上加入 effect outsets，不允许 UI 另建效果命中公式。
- 排版产生相对文本原点的 local geometry，场景 composition 再应用 placement。当前 placement 只有平移；不提前增加 transform schema 或矩阵抽象。未来自由画布增加缩放、旋转等变换时，不需要重写文本基础排版。
- `text.width` 只表示换行约束，不等于可见或可交互宽度。选中框使用 `visualBounds`；UI 在映射到屏幕坐标后，仅为命中将其扩展到至少 44×44pt 的 `touchBounds`，不得用扩展后的区域绘制选中框。
- `textElements` 数组顺序同时定义当前文本块之间的绘制与命中顺序：越靠后的文本越位于上层，并在 touch bounds 重叠时优先命中。选中和拖动不隐式重排；未来置顶、置底或层级调整必须通过明确、可撤销的 Edit Intent 改变顺序。
- 上述顺序只定义 MVP 文本块彼此之间的层叠，不是未来异构自由画布的永久全局图层 schema。自由画布可以由 compositor 统一排序图片放置元素与文本块，并按文本 ID 取得既有布局；当前不增加 `zIndex`、generic `CanvasElement` union 或图层 registry。

text block layout module 接受显式、immutable 的 `TextLayoutEnvironment`，其中包含 Skia API、font provider 和逻辑字体 ID 的解析。设备预览与当前 Skia export backend 使用同一套设备字体 registry；headless CanvasKit 使用注册随包固定字体的独立 environment。module 不在内部调用 `FontMgr.System()`、读取文件或加载 catalog，CanvasKit 与设备原生 Skia 也不承诺系统字体逐像素一致。

`createTextLayoutSnapshot(environment, texts)` 保持同步，只接受已经就绪的 environment，并原子产生 owned、immutable 的 `TextLayoutSnapshot`。Snapshot 统一拥有全部 Paragraph 与最终 geometry；渲染 adapter 只能借用已经 layout 的 Paragraph，gesture UI 只获得只读 geometry projection。caller 不单独重新 layout 或释放 Paragraph；Snapshot 提供幂等 `dispose()`，创建中途失败时释放已创建资源，设备端只在新 Snapshot 提交后释放旧 Snapshot，headless 端始终在 `finally` 中释放。

字体文件读取、未来磁盘或网络 resource pack 加载不进入同步 layout interface。未来 loader 必须先异步构建并完整校验新 environment，再原子替换；已开始使用的 Snapshot 保持有效直到释放。当前不实现 environment 热更新、loader、资源引用计数或 layout registry。预期的 environment/font unavailable 返回 typed layout failure，不退回估算 geometry 或静默替换字体；module invariant、释放后继续使用等编程错误才抛异常。

未来 TextStyle Catalog 与 TextStyleResourcePack 在上游把稳定样式身份解析成 layout/render 所需输入，text block layout module 不拥有 catalog 身份、来源或资源加载。当前 Skia implementation 可同时服务设备预览、headless 测试与 Skia export backend，但不进入 `ExportPipeline` external seam，也不要求未来原生 HDR backend 复用 Skia Paragraph。

## 影响与代价

- `DocumentCanvas` 与 `TextGestureOverlay` 的共同上游创建同一份 Snapshot；Canvas 消费渲染产物，Overlay 消费 geometry projection，不通过异步测量 callback 或各自创建 Paragraph。
- device environment 与 headless CanvasKit environment 是两个真实 adapter，共用同一 layout interface；当前不增加通用 adapter framework。内部未来可以按文本 ID 或 revision 增量复用布局，但缓存策略不进入 interface。
- L2 纯测试覆盖 visual-to-touch bounds 扩展、坐标缩放和文本层叠命中；L3 使用真实 CanvasKit 与随包字体覆盖中文换行、显式换行、对齐、行高、fallback、geometry 和 golden；生命周期测试覆盖部分创建失败、幂等释放与 Snapshot 替换；双端 E2E 点击并拖动实际可见文本，证明设备渲染与交互一致。
- 删除只断言 ParagraphBuilder、`layout()` 调用与样式传参的浅 mock 测试；测试以 `createTextLayoutSnapshot()` 的 geometry、绘制结果和资源生命周期为 surface。CanvasKit golden 不替代设备验收，也不要求与设备逐像素相同。
