# ADR 0018：MVP 色彩策略：Skia 离屏导出统一为 sRGB

- 状态：已接受（2026-07-11）
- 取代：ADR 0010
- 关联：ADR 0007、0009

## 背景

ADR 0010 要求在脚手架完成后优先验证 Display P3 图片经当前 Skia 合成与重新编码后的色彩空间。MVP 导出必须先确定可兑现的色彩承诺，避免实现阶段默认假设 P3 保真。

2026-07-11 使用当前锁定的 React Native Skia 2.6.2 完成可复现 spike：

1. 将项目图标转换为带 Display P3 ICC profile 的 PNG，`sips -g profile` 确认输入为 `Display P3`。
2. 使用 React Native Skia 官方 headless/CanvasKit 入口解码图片。
3. 将图片绘制到 CPU offscreen surface，再用 `encodeToBytes()` 编码为 PNG。
4. `sips -g profile` 确认输出为 `sRGB IEC61966-2.1`。

该结果证明当前共享离屏管线不能保留输入的 Display P3 profile。React Native Skia 的公开 offscreen surface API也没有暴露可供本项目指定输出色彩空间的稳定接口。

## 决策

- MVP 的预览与导出以 sRGB 为目标色彩空间；Display P3 源图经合成导出后会转换为 sRGB。
- UI 与产品文档如涉及色彩承诺，必须明确 MVP 为 SDR/sRGB，不宣称广色域保真。
- 渲染与编码接口仍保持分离；若 React Native Skia 后续提供可验证的广色域离屏导出，或项目引入平台原生编码段，再以新 ADR 重评估 P3 保真。
- 在 iOS 模拟器导出链路可运行后补做设备侧样本验证。若结果与 headless spike 不一致，新增 ADR 修正本决策，不静默改变行为。

## 影响与代价

- 经过系统相册调整的 P3 高饱和颜色可能在导出后收缩，无法完全保留原观感。
- sRGB 与多数社交发布链路兼容，且当前实现与测试可保持确定性；这是 MVP 阶段的有意识妥协。
- 本决策关闭 ADR 0010 的实现阻塞，但不关闭未来广色域支持的技术评估。
