# ADR 0016：Git 工作流：Conventional Commits + PR 门禁

- 状态：已接受
- 接受日期：2026-07-02
- 关联：[ADR 0011](0011-testing-strategy.md)、[ADR 0014](0014-language-policy.md)

## 背景

项目采用 PR 流程以确保每次合并有 CI 保障与可回溯的变更单元。

## 决策

- Commit message 采用 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`），英文书写。
- 工程脚手架与 CI 建立后：所有变更走分支 + PR，GitHub Actions 绿灯方可合并 main。
- 提交前必须通过本地验证命令（`pnpm verify`，脚手架后生效）。
- 禁止提交秘密、签名资产与大体积二进制；golden 快照图片属测试资产，允许入库。

## 影响与代价

- PR 流程带来节奏成本，换取每次合并有 CI 保障与可回溯的变更单元。
