# 架构决策记录（ADR）

本目录记录 PlogKit 长期有效的架构与工程治理决策。文档职责见 [`docs/README.md`](../README.md)。

## 什么需要 ADR

决策需要长期保留背景和取舍，并至少影响以下一项时建立 ADR：

- 跨 module 的职责边界。
- interface 或 seam 的建立或变更。
- 持久数据兼容性、迁移或分阶段替换。
- 难以逆转的技术选择。
- 长期工程治理约束。

判断一个决策是否值得记录时，可以再检查三点：以后撤销是否昂贵，结果是否会让不知情的维护者意外，是否存在真实替代方案与代价。单项功能需求、局部实现细节和容易撤销的选择不单独建立 ADR。

## 文件结构

- 每个决策一份文件，命名为 `NNNN-slug.md`。编号递增且永不复用。
- 标题、状态、接受日期、背景、决策、影响与代价为必选内容。接受日期使用独立的 `YYYY-MM-DD` 字段。
- “影响与代价”记录新增约束和接受的成本，不复述决策；需要比较方案时，再说明放弃的替代方案。
- 涉及持久格式、公开 interface、数据迁移或分阶段替换时，必须说明迁移与兼容。

## 状态

- `已接受`：整份决策仍是现行规则。
- `部分修订`：后续 ADR 只修改了部分结论，未被修改的部分继续有效。
- `已取代`：后续 ADR 已完整替换原决策，原 ADR 不再作为现行规则。

状态只表示决策的效力，不表示实现进度。Issue 是否关闭也不影响 ADR 效力。

## 决策演进与字段

决策变化时新增 ADR，不改写原 ADR 的背景、决策或影响。只更新原 ADR 的状态、`后继`字段和索引：

- `修订`：写在新 ADR 中，指向被局部修改的旧 ADR。
- `取代`：写在新 ADR 中，指向被完整替换的旧 ADR。
- `后继`：写在旧 ADR 中，指向修改或替换它的新 ADR。
- `关联`：只链接理解当前决策所需的直接上下文或依赖，不表示演进，不改变状态，也不要求反向链接。

`修订`或`取代`必须与旧 ADR 的`后继`双向一致。没有对应关系时省略字段。

## 内容边界

ADR 可以保留形成决策的 Issue 链接。标题与正文保留决策发生时的阶段语境，当前阶段以[产品范围](../product/product-scope.md)为准，决策的当前效力以本索引和后继 ADR 为准。

## 索引

| 编号                                                      | 标题                                                           | 状态     | 后继 ADR                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-core-stack-rn-skia.md)                        | 核心技术栈：React Native + Skia + TypeScript                   | 已接受   | 无                                                                                                                                                                                                                                          |
| [0002](0002-expo-foundation.md)                           | 工程底座：Expo SDK（56/57）+ CNG + dev client + pnpm，iOS 先行 | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)                                                                                                                                                                                                  |
| [0003](0003-document-driven-architecture.md)              | 文档驱动的编辑器架构与统一文档模型                             | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)                                                                                                                                                                                     |
| [0004](0004-state-management-undo.md)                     | 状态管理与撤销重做：Zustand + 有界快照栈                       | 已接受   | 无                                                                                                                                                                                                                                          |
| [0005](0005-text-editing-model.md)                        | 文本编辑模型：原生输入提交 + Skia Paragraph 渲染               | 已接受   | 无                                                                                                                                                                                                                                          |
| [0006](0006-image-import-pipeline.md)                     | 图片导入管线：沙盒拷贝 + 降采样预览                            | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)、[0040](0040-system-photo-picker-batch-boundary.md)                                                                                                                                 |
| [0007](0007-export-pipeline.md)                           | 导出管线：渲染/编码两段式与尺寸上限                            | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                                                                                                                          |
| [0008](0008-export-presets-data-driven.md)                | 导出预设数据驱动与 EXIF 策略                                   | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                                                                                                                          |
| [0009](0009-sdr-export-live-photo-still.md)               | MVP 导出 SDR、Live Photo 取静帧                                | 已接受   | 无                                                                                                                                                                                                                                          |
| [0010](0010-color-management.md)                          | 色彩管理：P3 保真 spike 优先                                   | 已取代   | [0018](0018-mvp-srgb-color-strategy.md)                                                                                                                                                                                                     |
| [0011](0011-testing-strategy.md)                          | 测试策略：五层金字塔与 BDD 方法论                              | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)、[0020](0020-ci-lifecycle-and-main-ruleset.md)、[0023](0023-export-preset-catalog-and-pipeline.md)、[0026](0026-test-runners-by-runtime.md)、[0041](0041-scenario-verification-traceability.md)  |
| [0012](0012-e2e-tooling-maestro.md)                       | E2E 工具：Maestro 模拟器主力 + Device Hub 真机手动冒烟         | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)、[0041](0041-scenario-verification-traceability.md)                                                                                                                                              |
| [0013](0013-doc-system.md)                                | 文档体系：ADR + specs + guides，暂不引入 OpenSpec              | 部分修订 | [0038](0038-document-ownership-contracts.md)、[0041](0041-scenario-verification-traceability.md)                                                                                                                                            |
| [0014](0014-language-policy.md)                           | 语言策略：中文权威文档 + 英文代码与提交                        | 已接受   | 无                                                                                                                                                                                                                                          |
| [0015](0015-license-gpl3-cla.md)                          | 许可证：GPL-3.0 + CLA，资产许可纪律                            | 已接受   | 无                                                                                                                                                                                                                                          |
| [0016](0016-git-workflow.md)                              | Git 工作流：Conventional Commits + PR 门禁                     | 已接受   | 无                                                                                                                                                                                                                                          |
| [0017](0017-share-extension-deferred.md)                  | 暂缓 Share Extension，保留来源无关的图片入口                   | 已接受   | 无                                                                                                                                                                                                                                          |
| [0018](0018-mvp-srgb-color-strategy.md)                   | MVP 色彩策略：Skia 离屏导出统一为 sRGB                         | 已接受   | 无                                                                                                                                                                                                                                          |
| [0019](0019-cross-platform-maestro-e2e.md)                | Maestro E2E 扩展到 iOS 与 Android 模拟设备                     | 部分修订 | [0020](0020-ci-lifecycle-and-main-ruleset.md)、[0042](0042-controlled-standalone-simulator-e2e.md)                                                                                                                                          |
| [0020](0020-ci-lifecycle-and-main-ruleset.md)             | CI 生命周期与 main 分支门禁                                    | 已接受   | 无                                                                                                                                                                                                                                          |
| [0021](0021-edit-commit-module.md)                        | 以类型化编辑意图深化编辑提交模块                               | 已接受   | 无                                                                                                                                                                                                                                          |
| [0022](0022-draft-aggregate-current-editing-session.md)   | 以草稿 aggregate 深化持久化与当前编辑会话                      | 部分修订 | [0028](0028-draft-deletion-tombstone.md)、[0029](0029-draft-library-pre-release-baseline-reset.md)、[0030](0030-draft-library-enumeration-snapshot.md)、[0031](0031-draft-publication-record.md)、[0033](0033-per-draft-deletion-marker.md) |
| [0023](0023-export-preset-catalog-and-pipeline.md)        | 深化导出预设 catalog 与导出管线                                | 已接受   | 无                                                                                                                                                                                                                                          |
| [0024](0024-text-block-layout-geometry.md)                | 以实际排版深化文本块布局与交互几何                             | 已接受   | 无                                                                                                                                                                                                                                          |
| [0025](0025-recoverable-draft-persistence-maintenance.md) | 草稿持久化采用可恢复替换与显式非活跃维护                       | 部分修订 | [0028](0028-draft-deletion-tombstone.md)、[0030](0030-draft-library-enumeration-snapshot.md)、[0031](0031-draft-publication-record.md)                                                                                                      |
| [0026](0026-test-runners-by-runtime.md)                   | 验证层级与测试运行器边界                                       | 部分修订 | [0039](0039-native-node-orchestration-tests.md)                                                                                                                                                                                             |
| [0027](0027-draft-root-record.md)                         | 草稿身份、元数据与统一文档共用可恢复根记录                     | 部分修订 | [0031](0031-draft-publication-record.md)、[0034](0034-draft-content-revision.md)、[0035](0035-draft-thumbnail-generation.md)                                                                                                                |
| [0028](0028-draft-deletion-tombstone.md)                  | 草稿删除先提交待删除标记再异步清理                             | 部分修订 | [0033](0033-per-draft-deletion-marker.md)                                                                                                                                                                                                   |
| [0029](0029-draft-library-pre-release-baseline-reset.md)  | 草稿库产品化再次建立发布前持久化基线                           | 已接受   | 无                                                                                                                                                                                                                                          |
| [0030](0030-draft-library-enumeration-snapshot.md)        | 草稿库以冷启动枚举构建进程内权威快照                           | 部分修订 | [0031](0031-draft-publication-record.md)、[0032](0032-draft-library-load-barrier.md)                                                                                                                                                        |
| [0031](0031-draft-publication-record.md)                  | 草稿创建以不可变发布记录作为提交点                             | 已接受   | 无                                                                                                                                                                                                                                          |
| [0032](0032-draft-library-load-barrier.md)                | 草稿库以可重试加载屏障线性化权威快照                           | 已接受   | 无                                                                                                                                                                                                                                          |
| [0033](0033-per-draft-deletion-marker.md)                 | 草稿删除使用独立外部标记并由当前编辑会话协调                   | 已接受   | 无                                                                                                                                                                                                                                          |
| [0034](0034-draft-content-revision.md)                    | 草稿根记录以内容修订标识持久内容代际                           | 已接受   | 无                                                                                                                                                                                                                                          |
| [0035](0035-draft-thumbnail-generation.md)                | 草稿缩略图按内容修订成对生成与提交                             | 已接受   | 无                                                                                                                                                                                                                                          |
| [0036](0036-authoritative-durable-app-settings.md)        | 应用设置由进程级 module 权威持有并采用 durable-first 更新      | 已接受   | 无                                                                                                                                                                                                                                          |
| [0037](0037-shared-skia-offscreen-rendering.md)           | 共享 Skia 离屏构图使用具体目标批次与内部资源所有权             | 已接受   | 无                                                                                                                                                                                                                                          |
| [0038](0038-document-ownership-contracts.md)              | 以 ownership map 深化文档体系                                  | 部分修订 | [0041](0041-scenario-verification-traceability.md)                                                                                                                                                                                          |
| [0039](0039-native-node-orchestration-tests.md)           | 原生 Node 宿主编排器的测试运行器边界                           | 已接受   | 无                                                                                                                                                                                                                                          |
| [0040](0040-system-photo-picker-batch-boundary.md)        | 系统照片选择器以整批结果交付导入候选                           | 已接受   | 无                                                                                                                                                                                                                                          |
| [0041](0041-scenario-verification-traceability.md)        | Scenario 验证证据由原生测试声明                                | 已接受   | 无                                                                                                                                                                                                                                          |
| [0042](0042-controlled-standalone-simulator-e2e.md)       | 受控的 standalone 模拟器 E2E                                   | 已接受   | 无                                                                                                                                                                                                                                          |
