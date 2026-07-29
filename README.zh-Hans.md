# PlogKit

**系统相册之外的轻量 plog 工具箱。**

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg" alt="License: GPL-3.0-only" /></a>
  <a href="https://docs.expo.dev/versions/v57.0.0/"><img src="https://img.shields.io/badge/Expo%20SDK-57-000020.svg?logo=expo&logoColor=white" alt="Expo SDK 57" /></a>
  <a href="https://reactnative.dev/"><img src="https://img.shields.io/badge/React%20Native-0.86-61DAFB.svg?logo=react&logoColor=black" alt="React Native 0.86" /></a>
  <a href="https://shopify.github.io/react-native-skia/"><img src="https://img.shields.io/badge/React%20Native%20Skia-2.6-4285F4.svg" alt="React Native Skia 2.6" /></a>
</p>

PlogKit 是一款面向 plog 创作者的轻量移动应用。它补齐系统相册没有覆盖的 plog 发布前整理能力，让创作者更快完成从修好照片到可以发布的最后一步。修图与调色继续交给系统相册，PlogKit 专注于轻量、直接的收尾体验。

## 项目状态

PlogKit 仍处于发布前开发阶段。当前版本可在 iOS 和 Android 模拟器 development build 中运行；生产签名、真机发布验收和商店分发尚未配置。

## 主要能力

当前主要能力包括：

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

请先阅读 [`docs/README.md`](docs/README.md)，其中提供权威的文档导航与职责划分。`docs/` 下的项目权威文档以中文书写。

## 开发

PlogKit 当前的开发基线为 macOS、Node.js 22、pnpm 11 及目标平台的原生工具链。

```bash
pnpm install
pnpm ios # 或 pnpm android
pnpm verify
```

完整的环境配置与验证说明见[开发环境](docs/guides/dev-environment.md)和[测试策略](docs/guides/testing-strategy.md)。项目目录结构、开发流程与规范见 [`AGENTS.md`](AGENTS.md)。

## 许可证

[GPL-3.0-only](LICENSE)。第三方字体与资产必须遵循 [ADR 0015](docs/adr/0015-license-gpl3-cla.md) 中的宽松许可策略。
