# ADR 0022：以草稿 aggregate 深化持久化与当前编辑会话

- 状态：部分修订（2026-07-16 接受；见 [ADR 0028](0028-draft-deletion-tombstone.md)、[ADR 0029](0029-draft-library-pre-release-baseline-reset.md)、[ADR 0030](0030-draft-library-enumeration-snapshot.md)、[ADR 0031](0031-draft-publication-record.md)、[ADR 0033](0033-per-draft-deletion-marker.md)）
- 修订：ADR 0003、0006
- 关联：ADR 0004、0021、[F06](../specs/F06-session-persistence.md)、[F07](../specs/F07-image-import.md)、[Issue #9](https://github.com/leon-zym/plogkit/issues/9)

## 背景

现有实现只维护 `projects/current`，由 `EditorRuntime` 同时组合恢复、编辑提交、autosave、flush、导入结果和资产读取。Home、Editor 与 Root caller 分别掌握 `get → restore → get`、会话替换和 flush 顺序，当前编辑会话缺少一个可直接测试的 deep module。

产品后续将加入本地草稿库。草稿是可长期保留并重新打开的作品状态；当前编辑会话是打开一个草稿进行编辑的临时活动。若继续围绕单例 current 目录深化，会在草稿库实现时再次推翻身份、存储和 interface。

草稿创建同时涉及身份、统一文档、导入资产、metadata 与失败清理。将草稿库、当前编辑会话和导入资产设计成只共享低层持久化 seam 的并列 module，会迫使 caller 编排跨 module transaction，或把业务 rollback 塞入文件 adapter，无法获得 locality。

## 决策

- 草稿库拥有稳定、opaque 的 `DraftId`。`DraftId` 不是名称或路径，也不写入 `PlogDocument`；复制文档内容创建新草稿时必须生成新的 `DraftId`。
- 草稿库 module 拥有完整的持久化草稿 aggregate：统一文档、导入资产、metadata、预览与缩略图，以及创建、读取、保存和删除 transaction。导入资产生命周期是草稿库 implementation 内部的 deep module，不形成独立 external seam。
- 本决策只确立缩略图与删除 transaction 的唯一 owner。在草稿库产品 UI 实施前，不提前生成无 caller 的缩略图，不实现列表展示、删除 UI 或占位 interface；删除 transaction 的恢复性顺序由 Issue #10 后续补强。
- 每个导入资产只属于一个 `DraftId`。统一文档只保存稳定的 `ImportedAssetId` 与图片固有属性，不保存原图、预览或 metadata URI；草稿库负责解析实际素材并验证所有权。
- `ImportedAssetId` 是 draft-scoped、opaque 的身份，只要求在一个草稿内唯一；它不是文件名、URI、系统相册 ID 或内容哈希。复制草稿时可以在新 `DraftId` 的命名空间内保留 aggregate 中的 `ImportedAssetId`。
- 导入资产的原图一经发布便不可原地替换。替换图片时创建新的 `ImportedAssetId`，再通过一次编辑提交切换统一文档引用；旧资产继续支持 undo，直到会话结束后的压缩。预览是可重建的派生数据，可在不改变资产身份的前提下重新生成。
- 图片来源选择不属于导入资产 lifecycle。系统照片选择器与未来 Share Extension adapter 只产生导入候选，草稿库接收候选并负责校验、沙盒拷贝、预览生成、metadata 提取与持久化。
- 单个候选的导入是原子的；批量导入允许部分成功，并逐项返回失败。创建草稿时，至少一个候选成功才生成草稿；用户取消或全部失败时不创建 `DraftId`。
- 创建草稿使用草稿库内部 staging：先完成成功资产及初始统一文档，再原子发布完整草稿 aggregate。最终发布失败时回滚本次 staging；崩溃残留由草稿库下次加载时清理，草稿列表永远不展示未完整发布的草稿。
- 当前编辑会话 module 与草稿库 module 保持分离，但通过草稿库提供的高层草稿访问 seam 加载、保存和解析一个草稿。当前编辑会话不接触文件路径、目录结构、资产 rollback 或低层持久化 adapter。
- 当前编辑会话 module 的 lifecycle operations 以 `open(draftId)` 与 `flush()` 为目标形状。它不提供 session-level `get`、`read`、`subscribe`、`replace(document)` 或常规导航使用的 `close()`。`open` 返回绑定到该草稿的当前编辑会话 handle；handle 提供编辑提交 module、稳定的 draft-scoped 资产访问 module 与高层资产变更操作，这些能力共同构成 module interface。
- 草稿库在 `open` 时一次性加载并验证统一文档与初始资产 catalog snapshot；成功后，preview 和 export 通过资产访问 module 同步查询 `ImportedAssetId` 对应的本地素材描述。实际图片 bytes 仍由 device/export adapter 按需读取，不在每次 lookup 时访问文件系统。
- 资产访问 module 内部使用 immutable catalog snapshot，但 snapshot 不在整个会话期间固定。会话内资产 transaction 成功发布后，module 原子替换 snapshot；新文档 revision 引用某个资产前，该资产及新版 catalog 必须已经成功发布。若后续文档提交失败，已发布但无引用的资产由会话结束后的压缩流程回收，不要求 caller rollback。
- UI caller 不分别编排资产 ingest 与统一文档提交，纯 `EditCommitModule` 也不承担文件 I/O。当前编辑会话 handle 提供高层资产变更操作，在内部先通过草稿库 staging 并发布成功资产、原子替换 catalog snapshot，再为成功批次执行恰好一次编辑提交。
- 高层资产变更操作逐项返回导入失败与文档提交结果；一次批量添加或单次替换各形成一个 undo step。资产发布后若编辑提交被拒绝，资产保持无引用并等待后续压缩；编辑提交成功但 autosave 失败时，沿用当前编辑会话的 dirty 与重试语义。
- `open(draftId)` 幂等。重复打开当前草稿直接返回现有当前编辑会话 handle；打开其他草稿时，先持久化当前草稿的最新 revision，再加载目标草稿，全部成功后才原子切换。任一步失败都保留原会话，不产生半切换或陈旧 autosave 覆盖。
- `open(draftId)` 只执行低成本结构校验：统一文档与资产 catalog 必须可解析，统一文档引用的每个 `ImportedAssetId` 必须存在于该草稿的 catalog，且对应原图文件必须存在。打开草稿时不逐张完整解码图片。
- 预览文件缺失或损坏不阻止打开草稿，由草稿库在首次读取预览时从原图重新生成；可选 metadata 缺失或损坏时视为不存在。原图缺失、catalog 损坏或文档引用无法解析时，`open` 返回 typed recovery failure，不以残缺状态进入 Editor。切换草稿失败时继续保留原会话。
- 从统一文档移除图片引用时不立即物理删除导入资产。活跃编辑会话期间，资产 catalog 可以保留仅被 undo/redo history 引用的资产；不通过持久化引用计数追踪这些引用。
- 只有最新统一文档已成功 flush，且该草稿不再有活跃编辑会话时，草稿库才能以持久化文档引用的 `ImportedAssetId` 集合作为存活集合执行压缩。安全触发点是成功切换离开草稿后，或下次打开该草稿并建立新会话之前；返回草稿库但仍保留当前会话时不得压缩。
- 压缩时先原子提交移除无引用条目的新资产 catalog，再 best-effort 删除对应原图、预览与 metadata。删除失败只留下可重试清理的孤立文件，不阻止保存、切换或打开；不得先删除文件再更新 catalog。
- 未被资产 catalog 引用的孤立文件不影响打开草稿，由草稿库后续内部维护流程清理。资产引用推导与清理职责不进入当前编辑会话的 external interface。
- 返回草稿库只执行 flush，不结束当前编辑会话；再次打开同一草稿保留当前进程内的 undo/redo history。切换草稿或进程终止才结束会话，重新打开草稿时 history 为空。
- 应用启动先展示草稿库，不自动恢复上次草稿；“继续上次编辑”只是对最近 `DraftId` 的快捷 `open`。该启动与历史草稿导航由 Issue #9 实施；本轮只实施其依赖的 aggregate 与会话 lifecycle。
- 可预期的恢复、读取和持久化失败使用 typed result；module invariant、重入等编程错误才抛异常。后台 flush 失败保留 dirty 文档并允许重试；用户主动离开 Editor 时，flush 失败阻止导航。
- 草稿库 interface 是草稿创建、资产 ingest、读取和保存 transaction 的主要 test surface；删除 transaction 在 Issue #9/#10 实施时继续通过草稿库 interface 验证。当前编辑会话 interface 是 open、切换、autosave 与 flush 的主要 test surface。测试使用内存 adapter，被吸收入 implementation 的 repository、scheduler 与资产文件 module 不保留重复行为测试。
- 当前不跨草稿共享或去重资产，不引入持久化引用计数。只有出现真实存储压力时，才评估在草稿库 implementation 后引入内容寻址存储、跨草稿引用跟踪与垃圾回收，且不得扩大草稿或当前编辑会话的 external interface。
- 实施先建立按 `DraftId` 工作的草稿 aggregate 与草稿访问 seam，再深化当前编辑会话 module，之后补全草稿库 UI。产品尚未发布，本次将新持久化 schema 作为 baseline reset：提升 `schemaVersion`，但不迁移 `projects/current` 或此前未发布 schema 的历史数据，不引入兼容路径、双写阶段或旧 schema 读取；本次 reset 后的未来 schema 变更继续遵守 ADR 0003 的迁移要求。

## 影响与代价

- 当前编辑会话获得稳定的 seam、locality 和 leverage；Home、Editor 与 Root 不再掌握恢复或保存顺序。
- 草稿库吸收草稿创建与删除所需的跨文件 transaction，导入资产 lifecycle 不再向 UI caller 泄漏 rollback 顺序。
- 稳定的资产访问 module 同时保留同步读取性能与会话内增加或替换资产的扩展能力；preview、render 与 export 不需要理解 catalog snapshot 的更新时机。
- 不可变原图使同一个 `ImportedAssetId` 在 undo、autosave 与 export 中始终表示同一内容，避免原地替换导致历史文档静默改变。
- 高层资产变更操作隐藏“资产先发布、文档后引用”的关键顺序，并保持 `EditCommitModule` 为无 I/O 的纯 TypeScript module。
- 草稿身份与统一文档保持分离，草稿库可以增加列表、命名、删除和缩略图而不修改 document schema 或编辑提交 interface。
- 草稿打开不承担完整图片解码成本；可重建的派生预览不会升级为草稿恢复失败，无法安全编辑的原图或引用损坏则不会扩散成渲染、导出模块都需要理解的“残缺资产”状态。
- 无引用资产在活跃会话内会暂时占用额外空间，但避免了引用计数与 undo history 的双向耦合；会话结束后的可达性压缩提供确定且崩溃安全的回收边界。
- 草稿 aggregate 基础成为当前编辑会话重构的 blocking dependency；这扩大了首个实施 ticket，但避免单例兼容 module 和后续二次重构。
- F06 与 F07 的功能级状态保持已实现；本 ADR 新增但尚未落地的目标用户行为在对应场景标记为已确认并关联实施 issue。在重构 ticket 落地前，现有实现仍使用单例恢复与路径引用。
- 草稿列表的具体 UI、命名、排序与删除交互由 Issue #9 后续细化，不在本 ADR 中决定。
