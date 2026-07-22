# ADR 0025：草稿持久化采用可恢复替换与显式非活跃维护

- 状态：部分修订（2026-07-20 接受；见 [ADR 0028](0028-draft-deletion-tombstone.md)、[ADR 0030](0030-draft-library-enumeration-snapshot.md)、[ADR 0031](0031-draft-publication-record.md)）
- 关联：ADR 0022、0023、[F04](../specs/F04-export.md)、[F06](../specs/F06-session-persistence.md)、[F07](../specs/F07-image-import.md)、[Issue #10](https://github.com/leon-zym/plogkit/issues/10)

## 背景

Expo SDK 57 的文件覆盖移动会先删除已有目标；Android 在原生移动失败时还可能退化为复制后删除。因此，临时文件覆盖 `document.json`、`catalog.json`、预览或最近草稿定位器并不构成原子替换：目标删除后若移动失败或进程终止，原值与新值都可能不可读。现有内存文件 adapter 将移动建模为单次 Map 更新，无法覆盖该故障窗口。

草稿压缩按 catalog-first 顺序解除资产引用后，再 best-effort 删除对应文件。这个顺序保护仍被引用的资产，但删除一旦失败，下一次已无法从 catalog 条目推导该孤立文件。导入在 catalog 提交前中断、预览重建留下临时文件时也有同类问题。草稿文件 adapter 目前不能枚举 owned 目录的直属文件。

草稿库还把 staging 枚举清扫与必需目录初始化放在同一失败路径，并在普通 `read` 中隐式执行压缩。前者会让维护故障遮蔽有效主 transaction，后者无法供未来草稿列表安全读取活跃草稿。导出 staging 则永久缓存首次初始化失败，使瞬时存储错误毒化整个进程。

## 决策

- 持久事实与派生预览的替换使用同目录 `current`、`backup`、`temp` 三状态恢复协议，但这三个角色是恢复不变量而非固定命名框架：移动均不得覆盖已有目标；每次访问先验证并收敛遗留状态，再开始新替换。
- 恢复时，合法 `current` 表示替换已提交并优先保留；`current` 缺失或非法时，合法 `backup` 表示旧值尚未被新值提交并优先恢复；只有旧值不可恢复时才提升合法 `temp`。任何候选在成为 `current` 并通过领域校验前都不得删除最后一个合法副本。
- 文档与 catalog 通过既有 parser 校验，最近草稿定位器校验其结构与 `DraftId`，预览通过预览 adapter 校验。协议只增加可清理的临时 sidecar，不改变 `PlogDocument`、catalog declaration 或稳定草稿 aggregate schema，因此不提升 schema version，也不迁移既有完整草稿。
- 草稿 aggregate 发布继续使用唯一 staging operation 与 opaque `DraftId`。移动失败必须 best-effort 移除可能出现的部分目标；任何未来列表只能展示通过完整 aggregate 校验的草稿，不把目录存在等同于发布成功。当前不增加持久 commit marker 或新的列表 schema。
- 草稿库文件 adapter 增加 owned 目录直属文件枚举。只有统一文档、catalog、所有文档引用及原图均通过校验后，才能按当前 catalog 计算 `assets/`、`previews/` 与 `metadata/` 的可达文件集合并清理其余直属文件。不得递归越过这三个目录，不跟随未知路径，不在损坏 aggregate 或活跃草稿上执行可达性清扫。
- 普通 `read` 只读取和校验，不压缩、不清扫。草稿库提供明确命名的 inactive-Draft maintenance capability；当前编辑会话只在目标草稿尚未激活前及旧草稿成功失活后调用它。返回草稿库并保留当前会话时不得调用。
- 同一 `DraftId` 的 read、save、ingest、preview rebuild 与 inactive maintenance 在草稿库内部串行执行。不同草稿不建立跨进程锁，也不引入全局 cleanup module。
- 必需目录创建与 best-effort maintenance 分离。staging 枚举或删除失败不得改变有效 create/read/save/ingest/export 的结果；恢复性清扫跳过当前进程已登记的活跃 operation，后续安全入口重试遗留清理。
- 导出 staging 的必需初始化失败不得永久缓存；后续 `initialize` 或 `createOperation` 在同进程重试。枚举与删除仍是 best-effort，不能阻止新 operation。
- 草稿删除 transaction 继续由草稿库拥有，但本 ADR 不新增删除 interface。其实现与 active session barrier、陈旧 handle、最近草稿定位器和 trash 恢复必须在 Issue #9 首个真实删除 caller 出现时同批完成，避免无 caller 的占位 interface。

## 影响与代价

- 覆盖移动从依赖平台原子性改为依赖可验证、可重复的恢复状态；故障注入测试可以覆盖目标已移除后的失败与进程重启。
- catalog reachability 成为孤立文件清理的唯一事实来源；不会引入引用计数、tombstone 或通用 `CleanupManager`。
- 显式 inactive maintenance 使普通草稿检查与未来列表保持非破坏性，同时让 session switch 的压缩边界可直接测试。
- 每 Draft 串行化牺牲同一草稿内部少量并发度，换取固定恢复 sidecar 与文档、catalog、素材提交之间的确定顺序；不同草稿仍可并行。
- Expo 目录移动仍不被视为原子发布保证；当前以完整 aggregate 校验和失败清理约束其可见性，若未来需要持久发布标志，必须另行决策其布局与迁移语义。
