# ADR 0026：验证层级与测试运行器边界

- 状态：已接受（2026-07-21）
- 修订：ADR 0011 中 CI 作为第五层，以及“jest-expo 单一运行器”与“单一 Jest 运行器”的适用范围
- 关联：ADR 0019

## 背景

ADR 0011 在独立的 Node E2E runner 出现前选择了单一 jest-expo 运行器，并把 GitHub Actions 列为第五个测试层级。CI 实际负责执行和组合测试门禁，不产生独立的测试类型。当前 runner 还包含不依赖 React Native 或设备的参数解析、编排、超时和失败分类逻辑。不测试会让重复故障缺少快速回归保护，而把这些测试放入 jest-expo 会让纯 Node CLI 依赖 React Native preset 与转换行为，不能直接覆盖原生 ESM 和子进程边界。

## 决策

- 验证分为静态检查、单元与组件测试、无头渲染回归、设备 E2E 四层。CI 是这些层级的执行环境和合并门禁，不单列为测试层级；触发规则仍由 ADR 0020 决定。
- App、核心逻辑、组件和无头渲染继续使用现有 Jest 配置。
- E2E runner 中不依赖设备和 Maestro flow 的纯 Node 逻辑使用 Node 内置测试运行器。Maestro YAML 与设备行为只在 iOS、Android 目标环境验证。
- `pnpm verify` 聚合两类测试；`node:test` 不成为其他模块新增测试运行器的默认许可。

## 影响与代价

- 仓库存在两个测试运行器，但 Node 侧不增加依赖，边界按被测运行时划分。
- 将 CI 与测试类型分开后，测试层级和执行频率可以独立调整。
- 如果 runner 逻辑迁入 App 或共享 TypeScript 模块，应重新评估是否合并回 Jest。
