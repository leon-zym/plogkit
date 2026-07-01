# ADR 0017：Share Extension 延后至 v1.1，预留外部图片入口

- 状态：已接受（2026-07-02）
- 关联：ADR 0002、0006

## 背景

PlogKit 定位为系统相册的伴侣应用，用户在相册修完图后最自然的动作是"分享 → 发送到 PlogKit"直接进入编辑，而非切换应用后重新选图。Share Extension 是该定位的关键入口，但在 RN/Expo 中实现需要原生 extension target（社区有 `expo-share-intent` 等 config plugin 方案），有确定的实现成本。

## 决策

- Share Extension 不进 MVP，列入 v1.1 roadmap。
- MVP 架构预留"外部图片进入编辑流程"的通用入口：导入管线（ADR 0006）接受来源无关的图片输入，路由层预留外部启动参数的处理位置。
- v1.1 实现时优先评估 `expo-share-intent` 类 config plugin 方案，保持 CNG 纪律（ADR 0002），届时新增 ADR。

## 影响与代价

- MVP 阶段用户只能从应用内选图进入，入口体验暂不完整。
- 预留入口的抽象成本极低（导入函数不耦合图片来源），不构成过度设计。
