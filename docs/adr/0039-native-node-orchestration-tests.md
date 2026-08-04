# ADR 0039：原生 Node 宿主编排器的测试运行器边界

- 状态：已接受
- 接受日期：2026-08-04
- 修订：[ADR 0026](0026-test-runners-by-runtime.md) 中 `node:test` 仅适用于 E2E runner 的范围
- 关联：[ADR 0011](0011-testing-strategy.md)、[测试策略](../guides/testing-strategy.md)

## 背景

ADR 0026 为 E2E runner 的参数解析、编排、超时和失败分类建立了原生 Node 测试边界，但将该许可限定在 E2E。随着工程基线增加，渲染测量与可靠性验证也需要宿主编排器负责命令行参数、环境隔离、子进程、宿主探针、结果协议和 artifact 发布。这些职责运行于原生 Node，不属于 App 功能行为，也不应为了复用 Jest 而依赖 React Native preset 或转换行为。

如果继续按特性增加例外，同类宿主职责会采用不同的测试边界，并让 `node:test` 的实际使用范围与 ADR 0026 不一致。测试运行器边界应按被测运行时和职责统一定义，而不是按 E2E、渲染或可靠性等特性名称分别决定。

## 决策

- 验证仍分为静态检查、单元与组件测试、无头渲染回归、设备 E2E 四层；宿主编排器测试不构成新的验证层级。
- App、core、services、组件和无头渲染的功能行为与领域 oracle 继续使用现有 Jest 配置；设备与 Maestro flow 的行为继续在目标环境验证。
- 不打包进 App、直接运行于宿主 Node 的编排器，可以使用 Node 内置测试运行器验证 CLI 参数、环境变量、子进程、超时、文件系统、宿主探针、结果协议和 artifact 发布。
- `node:test` 只验证上述宿主编排契约，不承载产品行为、领域规则、渲染正确性或设备行为。仅使用 Node API 不是迁移现有 Jest 测试或为其他 module 新增运行器的充分理由。
- `pnpm verify` 通过一个仓库级入口聚合全部原生 Node 编排器测试。具体命令和当前 runner 清单由测试指南维护。
- 如果编排逻辑迁入 App、共享生产 TypeScript module，或不再依赖原生 Node 边界，应重新评估并优先合并回 Jest。

## 迁移与兼容

仓库级 Node 测试入口由 `test:e2e-runner` 改名为 `test:orchestration`，并发现 `scripts/` 下的 `.test.mjs`。`pnpm verify` 同步切换到新入口；CI 继续调用 `pnpm verify`，无需迁移工作流。旧名称不保留别名，避免继续把跨特性宿主编排误称为 E2E runner。

## 影响与代价

- 仓库仍使用 Jest 与 `node:test` 两种运行器，但 Node 侧不增加依赖，并能直接覆盖实际执行的 ESM、CLI、环境和子进程边界。
- 新增 Node 编排测试时需要证明其职责符合本 ADR，评审成本略有增加，但避免按特性复制运行器例外和聚合脚本。
- 未采用全部迁回 Jest 的方案，因为这会让原生 Node 入口依赖 Jest 或 Expo 的模块加载与转换环境，不能直接验证实际宿主边界。
- 未采用每个特性独立决策的方案，因为同类职责会产生重复 ADR、命令命名分叉和长期治理漂移。
