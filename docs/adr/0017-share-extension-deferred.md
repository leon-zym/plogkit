# ADR 0017：暂缓 Share Extension，保留来源无关的图片入口

- 状态：已接受
- 接受日期：2026-07-02
- 关联：[ADR 0002](0002-expo-foundation.md)、[ADR 0006](0006-image-import-pipeline.md)

## 背景

Share Extension 可以让系统相册把图片直接交给 PlogKit，但在 RN/Expo 中需要原生 extension target。该决定当时将实现排在 v1.1；版本排期不属于 ADR 的现行约束，当前产品范围以产品文档为准。同时，导入管线不应与系统照片选择器耦合。

## 决策

- 当前不实现 Share Extension，产品范围以 [`product-scope.md`](../product/product-scope.md) 为准。
- 架构保留“外部图片进入编辑流程”的来源无关入口：导入管线（ADR 0006）接受来源无关的图片输入，不把系统照片选择器设为领域边界。
- 以后引入 Share Extension 时，需要新增 ADR 决定原生 target、进程边界、持久化交接与 CNG 集成方式。

## 影响与代价

- 来源无关的导入边界避免未来新增来源时重写图片校验与草稿创建流程。
- 当前仍需维护一个尚无第二调用方的 seam；其范围只覆盖输入来源，不提前实现原生 extension 或跨进程协议。
