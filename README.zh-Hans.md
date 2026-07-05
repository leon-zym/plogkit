# PlogKit

**系统相册之外的轻量 plog 工具箱。**

[English](README.md)

PlogKit 是一款面向 plog 创作者的轻量移动应用。它不试图替代系统相册或重型修图工具：修图与调色交给系统相册，PlogKit 补齐 plog 创作的必要需求——加字、加背景、多图拼接，以及预设多社交平台智能优化压缩的导出。

## 状态

开发前期。产品范围、架构决策与验收 spec 已固化，工程脚手架初始化中。

## 产品定位

PlogKit 是系统相册的伴侣，不是完整的图片编辑器。它是一个小巧、快速、local-first 的工具箱——无账户、无网络请求——帮助用户在系统相册完成选图修图后，快速完成 plog 创作的最后一环。

## MVP 范围

- 为图片加字：干净克制的样式，长文（中文优先）排版支持。
- 背景色。
- 多图竖向或网格拼接。
- 为多社交平台智能优化的预设压缩导出。
- 撤销重做、编辑会话自动保存、导出后可继续编辑。

明确不做：美颜修饰、滤镜、AI 编辑、视频、云同步、账户与模板市场。完整边界见 `docs/product/`。

## 技术栈

React Native（Expo，New Architecture）+ Skia + TypeScript。编辑器为文档驱动架构：可序列化文档是唯一事实源，由 Skia 在设备端渲染，也可在 CI 中无头渲染做像素级回归测试。

## 文档

项目权威文档位于 [`docs/`](docs/)，以中文书写（见 ADR 0014）：

- [`docs/product/`](docs/product/) —— 定位、MVP 范围、命名。
- [`docs/adr/`](docs/adr/) —— 架构决策记录与决策台账。
- [`docs/specs/`](docs/specs/) —— 各功能的 BDD 验收 spec（Given/When/Then）。
- [`docs/guides/`](docs/guides/) —— 测试策略与开发环境。

在本仓库工作的 AI Agent 必须遵循 [`AGENTS.md`](AGENTS.md)。

## 许可证

[GPL-3.0-only](LICENSE)。随包字体与资产采用允许商业闭源嵌入的宽松许可（OFL、MIT/Apache-2.0/CC-BY）。
