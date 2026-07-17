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

| 编号                                                    | 标题                                                           | 状态     | 后继 ADR                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-core-stack-rn-skia.md)                      | 核心技术栈：React Native + Skia + TypeScript                   | 已接受   | —                                                                                                                                             |
| [0002](0002-expo-foundation.md)                         | 工程底座：Expo SDK（56/57）+ CNG + dev client + pnpm，iOS 先行 | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)                                                                                                    |
| [0003](0003-document-driven-architecture.md)            | 文档驱动的编辑器架构与统一文档模型                             | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)                                                                                       |
| [0004](0004-state-management-undo.md)                   | 状态管理与撤销重做：Zustand + 有界快照栈                       | 已接受   | —                                                                                                                                             |
| [0005](0005-text-editing-model.md)                      | 文本编辑模型：原生输入提交 + Skia Paragraph 渲染               | 已接受   | —                                                                                                                                             |
| [0006](0006-image-import-pipeline.md)                   | 图片导入管线：沙盒拷贝 + 降采样预览                            | 部分修订 | [0022](0022-draft-aggregate-current-editing-session.md)                                                                                       |
| [0007](0007-export-pipeline.md)                         | 导出管线：渲染/编码两段式与尺寸上限                            | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                            |
| [0008](0008-export-presets-data-driven.md)              | 导出预设数据驱动与 EXIF 策略                                   | 部分修订 | [0023](0023-export-preset-catalog-and-pipeline.md)                                                                                            |
| [0009](0009-sdr-export-live-photo-still.md)             | MVP 导出 SDR、Live Photo 取静帧                                | 已接受   | —                                                                                                                                             |
| [0010](0010-color-management.md)                        | 色彩管理：P3 保真 spike 优先                                   | 已取代   | [0018](0018-mvp-srgb-color-strategy.md)                                                                                                       |
| [0011](0011-testing-strategy.md)                        | 测试策略：五层金字塔与 BDD 方法论                              | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)、[0020](0020-ci-lifecycle-and-main-ruleset.md)、[0023](0023-export-preset-catalog-and-pipeline.md) |
| [0012](0012-e2e-tooling-maestro.md)                     | E2E 工具：Maestro 模拟器主力 + Device Hub 真机手动冒烟         | 部分修订 | [0019](0019-cross-platform-maestro-e2e.md)                                                                                                    |
| [0013](0013-doc-system.md)                              | 文档体系：ADR + specs + guides，暂不引入 OpenSpec              | 已接受   | —                                                                                                                                             |
| [0014](0014-language-policy.md)                         | 语言策略：中文权威文档 + 英文代码与提交                        | 已接受   | —                                                                                                                                             |
| [0015](0015-license-gpl3-cla.md)                        | 许可证：GPL-3.0 + CLA，资产许可纪律                            | 已接受   | —                                                                                                                                             |
| [0016](0016-git-workflow.md)                            | Git 工作流：Conventional Commits + PR 门禁                     | 已接受   | —                                                                                                                                             |
| [0017](0017-share-extension-deferred.md)                | Share Extension 延后至 v1.1，预留外部图片入口                  | 已接受   | —                                                                                                                                             |
| [0018](0018-mvp-srgb-color-strategy.md)                 | MVP 色彩策略：Skia 离屏导出统一为 sRGB                         | 已接受   | —                                                                                                                                             |
| [0019](0019-cross-platform-maestro-e2e.md)              | Maestro E2E 扩展到 iOS 与 Android 模拟设备                     | 部分修订 | [0020](0020-ci-lifecycle-and-main-ruleset.md)                                                                                                 |
| [0020](0020-ci-lifecycle-and-main-ruleset.md)           | CI 生命周期与 main 分支门禁                                    | 已接受   | —                                                                                                                                             |
| [0021](0021-edit-commit-module.md)                      | 以类型化编辑意图深化编辑提交模块                               | 已接受   | —                                                                                                                                             |
| [0022](0022-draft-aggregate-current-editing-session.md) | 以草稿 aggregate 深化持久化与当前编辑会话                      | 已接受   | —                                                                                                                                             |
| [0023](0023-export-preset-catalog-and-pipeline.md)      | 深化导出预设 catalog 与导出管线                                | 已接受   | —                                                                                                                                             |
| [0024](0024-text-block-layout-geometry.md)              | 以实际排版深化文本块布局与交互几何                             | 已接受   | —                                                                                                                                             |

## 决策台账

决策编号（D 编号）与 ADR 的对应关系：

| 台账 | 内容                                                                                  | 对应 ADR               |
| ---- | ------------------------------------------------------------------------------------- | ---------------------- |
| D01  | iOS 先行，跨端纪律 + CI 编译检查                                                      | 0002                   |
| D02  | 导出预设数据驱动；元数据默认剥离；当前导出 SDR 静态图、Live Photo 取静帧              | 0008、0009、0023       |
| D03  | Share Extension 进 v1.1，预留外部图片入口                                             | 0017                   |
| D04  | Expo SDK 57 + CNG + dev client + pnpm                                                 | 0002                   |
| D05  | UI 中英双语，i18n 从第一天建立                                                        | 0014                   |
| D06  | E2E：Maestro 双端模拟设备自动化 + 真机手动冒烟                                        | 0012、0019             |
| D07  | GPL-3.0 + CLA；字体/资产仅用可商用闭源许可                                            | 0015                   |
| D08  | ADR + specs + guides 体系；OpenSpec 暂不引入                                          | 0013                   |
| D09  | specs/ADR/guides 中文权威，README 双语，代码/commit 英文                              | 0014                   |
| D10  | 技术默认包（Zustand、Expo Router、Jest、导出上限等）；当前 SDR/sRGB，广色域后续重评估 | 0004、0007、0011、0018 |
| D11  | Git：PR + Actions 绿灯合并（脚手架建立后启用）                                        | 0016                   |
| D12  | Draft 快速验证、正式 PR 双端编译、每周 E2E、main ruleset 门禁                         | 0016、0020             |
| D13  | 类型化编辑意图 + 稳定编辑提交 interface；快照 history 不跨重启                        | 0003、0004、0021       |
| D14  | 草稿库拥有持久化草稿 aggregate；当前编辑会话按 DraftId 原子打开                       | 0003、0006、0021、0022 |
| D15  | Export Policy 统一预设语义；Pipeline 在 backend seam 内解析并发布 Photos              | 0007、0008、0011、0023 |
| D16  | Text Block Layout 以 Paragraph snapshot 统一渲染与交互几何                            | 0003、0005、0011、0024 |
