# PlogKit

**系统相册之外的轻量 plog 工具箱。**

[English](README.md)

PlogKit 是一款面向 plog 创作者的轻量移动应用。它补齐系统相册没有覆盖的 plog 发布前整理能力，让创作者更快完成从修好照片到可以发布的最后一步。修图与调色继续交给系统相册，PlogKit 专注于轻量、直接的收尾体验。

## 状态

PlogKit 仍处于发布前开发阶段。当前版本可在 iOS 和 Android 模拟器 development build 中运行；生产签名、真机发布验收和商店分发尚未配置。

## 已实现功能

当前版本包含：

- 本地草稿库：在设备上创建、浏览、重新打开和删除作品。
- 为图片加字：干净克制的样式，长文（中文优先）排版支持。
- 背景色。
- 多图竖向或网格拼接。
- 使用原始、社交和紧凑预设导出 JPEG 或 PNG。
- 撤销重做、自动保存，以及导出或重启应用后继续编辑。

## 产品范围

当前范围、已确认方向与产品硬边界的权威来源是 [`docs/product/product-scope.md`](docs/product/product-scope.md)。用户可观察行为与功能交付状态由 [`docs/specs/`](docs/specs/) 维护。

## 技术栈

React Native（Expo，New Architecture）+ Skia + TypeScript。编辑器为文档驱动架构：可序列化文档是唯一事实源，由 Skia 在设备端渲染，也可在 CI 中无头渲染做像素级回归测试。

## 文档

请从 canonical [`docs/README.md`](docs/README.md) 文档导航与 ownership map 开始。`docs/` 下的项目权威文档以中文书写（见 ADR 0014）。

在本仓库工作的 AI Agent 必须遵循 [`AGENTS.md`](AGENTS.md)。

## 许可证

[GPL-3.0-only](LICENSE)。第三方字体与资产必须遵循 [ADR 0015](docs/adr/0015-license-gpl3-cla.md) 中的宽松许可策略。
