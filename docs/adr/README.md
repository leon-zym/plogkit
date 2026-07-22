# 架构决策记录（ADR）

本目录以 ADR（Architecture Decision Record）形式记录 PlogKit 的所有重要决策。

## 规范

- 每个决策一份文件，命名为 `NNNN-slug.md`，编号递增、永不复用。
- 固定结构：状态 / 背景 / 决策 / 影响与代价。
- 状态取值：`已接受`、`部分修订（见 NNNN）`、`已取代（被 NNNN 取代）`。
  - `已接受`：整份决策仍是现行规则。
  - `部分修订`：未被点名调整的结论继续有效；原 ADR 的状态与索引链接到后续 ADR，后续 ADR 以“修订”列出 predecessor 并承载当前结论。
  - `已取代`：原决策不再作为现行规则；原 ADR 的状态与索引链接到 successor，successor 以“取代”列出 predecessor。
- 决策演进时新增 ADR，不改写 predecessor 的背景、决策或影响；只更新其状态元数据、前后继链接与索引，保持历史可追溯。
- ADR 标题与正文保留决策发生时的阶段语境，包括历史上的 MVP 表述；当前产品阶段与仍生效的规则以产品范围、决策台账及后续 ADR 为准。
- 本目录以中文为权威版本（见 ADR 0014）。

## 索引

| 编号                                                      | 标题                                                           | 状态     | 后继 ADR                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-core-stack-rn-skia.md)                        | 核心技术栈：React Native + Skia + TypeScript                   | 已接受   | —                                                                                                                                                                                      |
| [0002](0002-expo-foundation.md)                           | 工程底座：Expo SDK（56/57）+ CNG + dev client + pnpm，iOS 先行 | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)                                                                                                                                             |
| [0003](0003-document-driven-architecture.md)              | 文档驱动的编辑器架构与统一文档模型                             | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)                                                                                                                                |
| [0004](0004-state-management-undo.md)                     | 状态管理与撤销重做：Zustand + 有界快照栈                       | 已接受   | —                                                                                                                                                                                      |
| [0005](0005-text-editing-model.md)                        | 文本编辑模型：原生输入提交 + Skia Paragraph 渲染               | 已接受   | —                                                                                                                                                                                      |
| [0006](0006-image-import-pipeline.md)                     | 图片导入管线：沙盒拷贝 + 降采样预览                            | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)                                                                                                                                |
| [0007](0007-export-pipeline.md)                           | 导出管线：渲染/编码两段式与尺寸上限                            | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                                                                     |
| [0008](0008-export-presets-data-driven.md)                | 导出预设数据驱动与 EXIF 策略                                   | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                                                                     |
| [0009](0009-sdr-export-live-photo-still.md)               | MVP 导出 SDR、Live Photo 取静帧                                | 已接受   | —                                                                                                                                                                                      |
| [0010](0010-color-management.md)                          | 色彩管理：P3 保真 spike 优先                                   | 已取代   | [0018](0018-mvp-srgb-color-strategy.md)                                                                                                                                                |
| [0011](0011-testing-strategy.md)                          | 测试策略：五层金字塔与 BDD 方法论                              | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)、[0020](0020-ci-lifecycle-and-main-ruleset.md)、[0023](0023-export-preset-catalog-and-pipeline.md)、[0026](0026-test-runners-by-runtime.md) |
| [0012](0012-e2e-tooling-maestro.md)                       | E2E 工具：Maestro 模拟器主力 + Device Hub 真机手动冒烟         | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)                                                                                                                                             |
| [0013](0013-doc-system.md)                                | 文档体系：ADR + specs + guides，暂不引入 OpenSpec              | 已接受   | —                                                                                                                                                                                      |
| [0014](0014-language-policy.md)                           | 语言策略：中文权威文档 + 英文代码与提交                        | 已接受   | —                                                                                                                                                                                      |
| [0015](0015-license-gpl3-cla.md)                          | 许可证：GPL-3.0 + CLA，资产许可纪律                            | 已接受   | —                                                                                                                                                                                      |
| [0016](0016-git-workflow.md)                              | Git 工作流：Conventional Commits + PR 门禁                     | 已接受   | —                                                                                                                                                                                      |
| [0017](0017-share-extension-deferred.md)                  | Share Extension 延后至 v1.1，预留外部图片入口                  | 已接受   | —                                                                                                                                                                                      |
| [0018](0018-mvp-srgb-color-strategy.md)                   | MVP 色彩策略：Skia 离屏导出统一为 sRGB                         | 已接受   | —                                                                                                                                                                                      |
| [0019](0019-cross-platform-maestro-e2e.md)                | Maestro E2E 扩展到 iOS 与 Android 模拟设备                     | 部分修订 | [0020](0020-ci-lifecycle-and-main-ruleset.md)                                                                                                                                          |
| [0020](0020-ci-lifecycle-and-main-ruleset.md)             | CI 生命周期与 main 分支门禁                                    | 已接受   | —                                                                                                                                                                                      |
| [0021](0021-edit-commit-module.md)                        | 以类型化编辑意图深化编辑提交模块                               | 已接受   | —                                                                                                                                                                                      |
| [0022](0022-draft-aggregate-current-editing-session.md)   | 以草稿 aggregate 深化持久化与当前编辑会话                      | 部分修订 | [0028](0028-draft-deletion-tombstone.md)、[0029](0029-draft-library-pre-release-baseline-reset.md)、[0030](0030-draft-library-enumeration-snapshot.md)、[0031](0031-draft-publication-record.md)、[0033](0033-per-draft-deletion-marker.md) |
| [0023](0023-export-preset-catalog-and-pipeline.md)        | 深化导出预设 catalog 与导出管线                                | 已接受   | —                                                                                                                                                                                      |
| [0024](0024-text-block-layout-geometry.md)                | 以实际排版深化文本块布局与交互几何                             | 已接受   | —                                                                                                                                                                                      |
| [0025](0025-recoverable-draft-persistence-maintenance.md) | 草稿持久化采用可恢复替换与显式非活跃维护                       | 部分修订 | [0028](0028-draft-deletion-tombstone.md)、[0030](0030-draft-library-enumeration-snapshot.md)、[0031](0031-draft-publication-record.md)                                                 |
| [0026](0026-test-runners-by-runtime.md)                   | 验证层级与测试运行器边界                                       | 已接受   | —                                                                                                                                                                                      |
| [0027](0027-draft-root-record.md)                         | 草稿身份、元数据与统一文档共用可恢复根记录                     | 部分修订 | [0031](0031-draft-publication-record.md)、[0034](0034-draft-content-revision.md)、[0035](0035-draft-thumbnail-generation.md)                                                           |
| [0028](0028-draft-deletion-tombstone.md)                  | 草稿删除先提交待删除标记再异步清理                             | 部分修订 | [0033](0033-per-draft-deletion-marker.md)                                                                                                                                              |
| [0029](0029-draft-library-pre-release-baseline-reset.md)  | 草稿库产品化再次建立发布前持久化基线                           | 已接受   | —                                                                                                                                                                                      |
| [0030](0030-draft-library-enumeration-snapshot.md)        | 草稿库以冷启动枚举构建进程内权威快照                           | 部分修订 | [0031](0031-draft-publication-record.md)、[0032](0032-draft-library-load-barrier.md)                                                                                                   |
| [0031](0031-draft-publication-record.md)                  | 草稿创建以不可变发布记录作为提交点                             | 已接受   | —                                                                                                                                                                                      |
| [0032](0032-draft-library-load-barrier.md)                | 草稿库以可重试加载屏障线性化权威快照                           | 已接受   | —                                                                                                                                                                                      |
| [0033](0033-per-draft-deletion-marker.md)                 | 草稿删除使用独立外部标记并由当前编辑会话协调                   | 已接受   | —                                                                                                                                                                                      |
| [0034](0034-draft-content-revision.md)                    | 草稿根记录以内容修订标识持久内容代际                           | 已接受   | —                                                                                                                                                                                      |
| [0035](0035-draft-thumbnail-generation.md)                | 草稿缩略图按内容修订成对生成与提交                             | 已接受   | —                                                                                                                                                                                      |

## 决策台账

决策编号（D 编号）与 ADR 的对应关系：

| 台账 | 内容                                                                                                          | 对应 ADR                                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| D01  | iOS 先行，跨端纪律 + CI 编译检查                                                                              | 0002                                     |
| D02  | 导出预设数据驱动；元数据默认剥离；当前导出 SDR 静态图、Live Photo 取静帧                                      | 0008、0009、0023                         |
| D03  | Share Extension 进 v1.1，预留外部图片入口                                                                     | 0017                                     |
| D04  | Expo SDK 57 + CNG + dev client + pnpm                                                                         | 0002                                     |
| D05  | UI 中英双语，i18n 从第一天建立                                                                                | 0014                                     |
| D06  | E2E：Maestro 双端模拟设备自动化 + 真机手动冒烟                                                                | 0012、0019                               |
| D07  | GPL-3.0 + CLA；字体/资产仅用可商用闭源许可                                                                    | 0015                                     |
| D08  | ADR + specs + guides 体系；OpenSpec 暂不引入                                                                  | 0013                                     |
| D09  | specs/ADR/guides 中文权威，README 双语，代码/commit 英文                                                      | 0014                                     |
| D10  | 技术默认包（Zustand、Expo Router、按运行时选择测试运行器、导出上限等）；当前 SDR/sRGB，广色域后续重评估       | 0004、0007、0011、0018、0026             |
| D11  | Git：PR + Actions 绿灯合并（脚手架建立后启用）                                                                | 0016                                     |
| D12  | Draft 快速验证、正式 PR 双端编译、每周 E2E、main ruleset 门禁                                                 | 0016、0020                               |
| D13  | 类型化编辑意图 + 稳定编辑提交 interface；快照 history 不跨重启                                                | 0003、0004、0021                         |
| D14  | 草稿库拥有持久化草稿 aggregate；发布记录确认用户草稿；加载屏障线性化进程内快照                               | 0003、0006、0021、0022、0025、0027、0030、0031、0032 |
| D15  | Export Policy 统一预设语义；Pipeline 在 backend seam 内解析并发布 Photos                                      | 0007、0008、0011、0023                   |
| D16  | Text Block Layout 以 Paragraph snapshot 统一渲染与交互几何                                                    | 0003、0005、0011、0024                   |
| D17  | 草稿删除以每草稿独立外部标记为 commit point，由当前编辑会话协调并异步清理                                     | 0022、0025、0028、0033                   |
| D18  | 草稿根记录以内容修订标识持久代际；缩略图按修订成对生成并允许旧图降级                                           | 0027、0034、0035                         |
