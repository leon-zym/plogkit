# ADR 0001：核心技术栈：React Native + Skia + TypeScript

- 状态：已接受（2026-07-02）
- 关联：ADR 0002、0007、0009

## 背景

PlogKit 目标是 iOS 与 Android 双端的轻量 plog 工具（加字、背景、拼接、导出）。项目同时承担维护者熟悉 React Native 跨端开发与 Skia 图形开发的练手目标。需要一个能统一承担渲染、预览与导出的图形基础。

## 决策

- 应用外壳与 UI 使用 React Native（New Architecture）。
- 渲染、合成、预览与导出统一基于 Skia（`@shopify/react-native-skia`）。
- 应用代码使用 TypeScript（strict 模式）。
- `react-native-gesture-handler` 与 `react-native-reanimated` 作为编辑器手势与动画的标配依赖。
- 拒绝为 iOS/Android 分别实现原生图像合成管线：平台特定实现成本高、抽象复用弱，与当前产品阶段不匹配。

## 影响与代价

- Skia 提供跨端一致的渲染模型，且支持 Node 无头渲染，是测试策略（ADR 0011）的基础。
- 纯 Skia 管线无法处理 Apple HDR 增益图与 Live Photo 动态资产，MVP 相应收缩（ADR 0009），导出编码段接口化预留原生实现的可能（ADR 0007）。
- Skia Paragraph 的 emoji 排版存在已知问题（行高异常，上游 issue #3422），文本功能需在实现时评估规避。
