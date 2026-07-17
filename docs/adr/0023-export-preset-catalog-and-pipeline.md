# ADR 0023：深化导出预设 catalog 与导出管线

- 状态：已接受（2026-07-17）
- 修订：ADR 0007、0008、0011
- 关联：ADR 0003、0009、[F04](../specs/F04-export.md)

## 背景

导出预设是 App bundled catalog 中持续演进的产品策略，而不是随草稿冻结的完整导出配置。`PlogDocument` 只保存稳定的 `ExportPresetId` 与用户明确选择的覆盖项，不复制尺寸、质量或后处理参数；每次导出都从当前 catalog 解析完整策略，因此 App 更新预设后，历史草稿未来的导出也使用新规则。已导出的文件是不可变产物，但草稿不承诺跨 App 版本生成逐字节相同的文件。

现有 preset 知识分散在 document parser、UI 与 export planning；render/encode 的名义 seam 又暴露了 Skia 中间产物。如果 caller 还必须先解析 policy 再调用 pipeline，真实导出的能力校验和失败语义仍然没有 locality。

## 决策

导出预设 catalog module 拥有预设声明、身份合法性、呈现 key、尺寸规则、编码质量、后处理与能力约束，并提供统一的策略解析；document parser、UI 与 export planning 不再分别维护 preset ID 或能力列表。metadata policy 是独立于导出预设的用户隐私选择，由全局设置提供默认值并由草稿保存明确选择；catalog resolver 负责校验格式与 metadata policy 的组合，例如当前 PNG 不能保留基础 EXIF，UI 不再自行硬编码该规则。

每个导出预设通过 `allowedFormats` 与 `defaultFormat` 声明格式策略；只允许一种格式即表示固定格式，允许多种格式时 UI 才提供相应选择。`PlogDocument` 只在用户偏离预设默认值时保存可选 `formatOverride`，catalog resolver 负责解析并校验最终格式。未来增加格式只扩展 catalog 数据与对应编码能力，不在 UI、document parser 或 export planning 增加新的 preset 分支。

切换导出预设时始终清除原预设的 `formatOverride`，直接使用新预设的 `defaultFormat`；格式覆盖不跨预设继承。metadata policy 作为用户隐私选择原则上保留，但若新预设的默认格式不支持当前 policy，则在同一次编辑提交中安全降级为 `strip`。之后切换到重新支持 metadata 的格式时不自动恢复旧选择，避免隐式增加输出 metadata。预设切换与这些归一化共同形成一次原子编辑提交，不由 UI caller 编排。

导出预设可以面向通用场景或特定目标平台，统一表达 HDR 保留策略、Live Photo 保留策略、短边与长边尺寸上限，以及是否执行面向上传的预压缩；不为面向平台的预设建立独立领域类型或 module。MVP catalog 仍只产生 SDR 静态图片；这些字段用于让未来能力沿既有 catalog 与导出 seam 扩展，而不是提前实现 ADR 0009 延后的 HDR 或 Live Photo 导出。

导出预设 catalog 的运行时表示是经过完整校验的 immutable `ExportPresetCatalogSnapshot`。当前版本只从 bundled declaration 同步建立一个 snapshot，不引入 class、依赖注入、loader interface 或 adapter。export policy module 对 caller 只提供三个能力：`listPresetOptions()` 从当前 snapshot 向 UI 投影 ID、呈现 key 与可选格式；`parseExportSettings(input)` 只结构化校验 opaque `ExportPresetId`、format override 与 metadata policy，不要求当前 snapshot 包含该 ID；`resolveExportPolicy(settings, sourceFacts, capabilities)` 从同一 snapshot 为导出规划产生完整且已校验的尺寸、动态范围、动态照片、格式、质量、预压缩、metadata 与后处理策略。raw catalog 声明属于 implementation，不再导出 `EXPORT_PRESETS` 或 `getExportPreset()` 让 caller 自行解释；`ExportPresetId` 是经结构校验产生的 opaque branded string，不是 `document.ts` 手写或从 bundled declaration 推导的 literal union。

测试以这三个能力为 surface，覆盖 catalog declaration 的不变量、文档结构解析、UI option projection、resolved policy 与 unavailable preset；删除 document parser、UI 与 export planning 中针对 preset 列表和能力规则的重复测试。i18n 仍负责实际翻译文本，UI 只翻译 catalog 返回的呈现 key。当前 snapshot 不包含文档引用的 ID 时，草稿仍能打开与编辑，resolver 返回 typed `preset-unavailable` 并只阻止导出，直到来源恢复或用户选择其他预设。

版本标志分为两层：catalog 顶层的 `catalogSchemaVersion` 只在声明结构变化时提升；每项预设的 `presetRevision` 在尺寸、质量、动态范围、动态照片、预压缩、格式或其他影响输出的策略参数变化时提升。两者都不写入 `PlogDocument`。`ResolvedExportPolicy`、`ExportPlan` 以及已经解析到预设的导出结果和类型化错误上下文必须携带 `presetId`、`presetRevision` 与 `catalogSchemaVersion`；`preset-unavailable` 无法取得 revision，只携带请求的 `presetId` 与当前 `catalogSchemaVersion`。这些内部标志仅供开发者诊断，不写入导出图片 metadata 或文件名。

`ExportPresetId` 表示预设稳定的用户语义，`presetRevision` 表示该预设当前策略修订。同一目标与含义下调整参数保留 ID 并提升 revision；改变目标平台或用户语义时创建新 ID，绝不复用旧 ID。产品发布前本次重构直接建立新 baseline，不实现占位 ID 兼容或迁移；产品发布后，删除或重命名已发布 ID 时再明确设计迁移或退役策略，不提前保留 hidden preset。

未来若确有磁盘、网络或用户文件来源，各来源 loader 只负责将输入校验并转换为同一种 snapshot，再在 bootstrap 或更新点原子替换；已经开始的导出持有一次解析完成的 `ResolvedExportPolicy`，不受中途更新影响。当前仍遵守产品无网络调用的硬边界，不实现这些 loader。该 snapshot 形状可作为未来花字等 catalog 的设计模式，但现在不抽取 generic catalog、通用 loader 或共享 adapter；第二个真实 catalog 出现后，才根据实际重复提取 manifest envelope、snapshot replacement 或完整性校验等基础设施，各领域 resolver 保持独立。

导出的稳定 external seam 位于 `ExportPipeline` 与其 backend，而不是 render 与 encoder 之间的中立 pixel interface。`ExportPipeline.run()` 接收统一文档中的导出设置与草稿资产，在每次运行开始时使用当前 immutable catalog snapshot、源素材事实与 backend capabilities 调用 policy resolver，并在该次运行内持有一份 immutable `ResolvedExportPolicy`。UI 可以调用同一 resolver 预检，但 pipeline 对真实导出结果负责，不信任预检时的结果仍然有效。backend 只接收 resolved policy；pipeline 还负责 orchestration、destination、typed result 与诊断上下文。backend 内部仍保持 render 与 encode 两项清晰职责，但二者共享 backend-private 的 owned 中间产物，并由 backend 保证释放、色彩、格式和编码不变量。当前 Skia backend 可以直接使用 `SkImage` 完成 SDR 静态图渲染与编码，不为制造 seam 将 64MP 图像回读成额外 RGBA buffer。

未来 HDR backend 可以使用原生 pixel buffer 与 gain map，Live Photo backend 可以使用帧序列及 AVFoundation 资源，而无需扩张一个所有 encoder 都必须理解的 `RenderedPixels` union。本决策删除 `RenderedPixels.encode()` 和名义上可独立替换、实际仍委托 Skia artifact 的浅 encode stage；它取代 ADR 0007 中“只替换 encoder implementation”的过强假设，但保留 document → render → encode → destination 的责任顺序与从文档渲染而非截屏的硬约束。

导出预设与 `ResolvedExportPolicy` 只表达输出语义，不保存 `skia`、`native-ios` 等 backend ID。backend 暴露 immutable `ExportCapabilities`，`resolveExportPolicy(settings, sourceFacts, capabilities)` 结合预设、源素材事实与当前 capabilities 生成 resolved policy；无法满足时返回 typed `unsupported-policy`，UI 消费同一结果呈现不可用原因，不自行维护能力判断。除非预设明确声明允许降级，否则 pipeline 不把“保留 HDR”等需求静默降级为较弱产物。

当前只有 Skia backend，pipeline 直接使用它，不实现 backend registry、优先级、fallback 或 feature flag。等第二个真实 backend 出现后，再根据 capabilities 增加选择机制；catalog 与统一文档不因 backend 增加而改变。

`ExportPipeline.run()` 以 discriminated typed result 表达 `success`、用户主动 `cancelled` 与预期 `failure`。稳定 failure code 至少区分 `preset-unavailable`、`unsupported-policy`、`asset-unavailable`、`render-failed`、`encode-failed`、`permission-denied` 与 `destination-failed`，并记录发生 phase；UI 只按 code 映射本地化提示，不解析或直接展示底层异常文本。backend contract 违例、重复释放等编程错误才抛异常。

success 与已经解析到预设的 failure 诊断上下文携带 `presetId`、`presetRevision`、`catalogSchemaVersion` 以及 backend identity/revision；`preset-unavailable` 按前述规则不虚构 revision。这些值不进入用户产物。pipeline 对 success、cancelled、expected failure 和 thrown programming error 路径都保证释放 backend-private 中间资源，测试通过 pipeline interface 验证 cleanup，不测试 backend-private artifact。

系统相册中的资源是产品唯一的最终导出产物。backend 将编码结果写入 pipeline-owned 的临时 `PreparedExport`，Photos destination 只负责将它发布到系统相册；成功结果返回相册 `assetId` 与诊断上下文，不返回具有持久语义的本地 `fileUri`，也不建立应用内导出历史。当前静态图片的 `PreparedExport` 是单个临时文件；未来 Live Photo backend 可以在不改变所有权规则的前提下扩展为临时照片与视频资源对。

每次导出在专用 cache staging root 下拥有唯一 operation 目录。pipeline 在所有进程内可观察的 success、cancelled、expected failure 与 thrown error 路径中执行幂等即时清理；App 冷启动时恢复性清扫该 staging root 中的遗留 operation。清理失败不把已经成功写入系统相册的结果改判为失败，而是保留为可在后续冷启动重试的临时垃圾；临时产物不进入 documents 目录，也不具有持久性语义。系统相册写入不提供 exactly-once transaction：若资源已创建但进程在收到 `assetId` 前终止，用户重试可能产生重复照片；不为这一低概率窗口保留沙盒副本或扫描相册执行推测性回滚。

## 影响与代价

- Policy resolver 仍可供 UI 预检，但真实导出的解析、backend 调用、Photos 发布与清理集中在 pipeline interface 后，caller 不掌握关键顺序。
- Export Policy 必须先建立新的 document export settings baseline；Draft aggregate 随后作为本轮最终 document schema baseline，`ExportPipeline` 再依赖 Draft aggregate 提供稳定资产。
- 以 backend 为真实 adapter seam 避免为单一 Skia 产物制造浅层 encoder interface，但也意味着未来引入原生 HDR 或 Live Photo backend 时需在各 backend implementation 内分别保持 render/encode 不变量。
- Photos 发布不具备 exactly-once；用户在极窄的崩溃窗口后重试可能得到重复照片，这是不引入持久化导出历史与推测回滚所接受的代价。
