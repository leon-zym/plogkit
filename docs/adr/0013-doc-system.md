# ADR 0013：文档体系：ADR + specs + guides，暂不引入 OpenSpec

- 状态：已接受（2026-07-02）
- 关联：ADR 0014

## 背景

前期讨论产生 30+ 决策点与 7 个功能需求，需要可追溯、可检索、结构化的固化形式。评估了 OpenSpec（Fission-AI，活跃维护的轻量 SDD 框架，proposal → apply → archive 变更状态机 + spec 校验）。

## 决策

- 文档体系分三层：
  - `docs/adr/`：架构决策记录，一决策一文件，可废弃不可篡改。
  - `docs/specs/`：功能需求 spec，一功能一文件，含 Given/When/Then 验收场景，是 Maestro flow 与测试命名的蓝本。
  - `docs/guides/`：操作性指南（测试策略、开发环境等）。
  - `docs/product/`：产品定位、MVP 范围与命名等产品文档。
- 暂不引入 OpenSpec：其价值集中在存量代码的持续变更管理，当前绿地阶段属于为不存在的问题付管理税。
- specs 的场景写法保持与 OpenSpec 亲和（`#### Scenario:` + GIVEN/WHEN/THEN），MVP 落地进入迭代期后如变更管理失控，可低成本 `openspec init` 增量接入，届时新增 ADR。

## 影响与代价

- 手写体系无工具校验，spec 完整性依赖 PR 审查与项目约定。
