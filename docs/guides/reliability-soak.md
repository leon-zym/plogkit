# 草稿可靠性 Soak 执行协议

本文规定 Draft Library 与 Current Editing Session 的确定性故障注入基线。它使用真实 public module 组合与内存 adapter，验证持久化协议和会话并发不变量；不测量设备文件系统、真实线程调度或性能。

## Profiles 与命令

| Profile  | 命令                                                  | 固定输入                                                                 | 用途                          |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------- |
| quick    | `pnpm test:reliability-soak`                          | seeds `1,7,42,99,256,1001,12345,12648430` × 125 steps = 1,000 状态机步骤 | 默认回归，随 `pnpm test` 执行 |
| evidence | `pnpm test:reliability-soak:evidence`                 | seeds `0..99` × 250 steps = 25,000 状态机步骤，随后完整重放一次          | 生成 dated baseline artifact  |
| replay   | `pnpm test:reliability-soak:replay -- <seed> [steps]` | 单一十进制 seed；默认 250 steps                                          | 重放失败轨迹                  |

Evidence 的第二轮 25,000 steps 只证明同一输入产生相同 event digest，不计为独立覆盖量。quick 与 evidence 的输入已在 runner 和测试内冻结，不接受命令行覆盖。两个 full-profile digest 不一致或任一不变量失败时命令非零退出；失败信息包含 seed、step、实际触发的 fault、最终 public state、独立 reference state、完整失败轨迹和 replay 命令。

Runner 固定调用仓库本地 Jest，并清除继承的可靠性控制变量。所有成功 profile 必须输出机器可解析的 result marker；runner 独立校验 profile、seed、steps、event 数量、SHA-256 digest 和不变量结果，缺失、畸形或不符合契约时 fail closed。Evidence writer 按共享 artifact vocabulary 完整校验每个 event 的 operation、result、fault、recovery、effects、public state、reference state 及 seed/step 顺序；随后从 canonical baseline events 独立重算整体与逐 seed digest，以及 operation、fault、typed failure、重启和恢复计数，并与 baseline payload、replay summary 和两份 result summary 交叉验证。共享 vocabulary 只定义 artifact 枚举与 shape，不参与 public oracle 或 writer 的统计归约。

为避免重复输出另一份 25,000 行轨迹，deterministic replay 只输出逐 seed digest 与汇总计数，不写入 replay events。Writer 因而以 canonical baseline events 的独立归约结果校验 replay summary，并校验 replay 产生的整体和逐 seed digest 与 baseline 相同；它不声称能在 runner 外重新执行或逐行重建 replay。

任何 Draft Library、Current Editing Session、recoverable persistence 协议或相关 adapter 变更都必须运行 quick；它也随默认 `pnpm test` 执行。高风险持久化/并发改动合并前和 release candidate 验收时运行 evidence，并将 ignored artifact 附到对应 Issue 或 CI run，避免把本地生成物提交到仓库。

## 故障与 oracle 边界

Harness 只通过 `createDraftLibrary(...)`、`createCurrentEditingSession(...)` 及既有 file、preview、thumbnail adapter 注入确定性故障，不增加生产 test hook。固定矩阵覆盖：

- write-before 与 write-committed-but-result-unknown；
- recoverable replacement 的 before、destination removal、destination copy 与 process interruption；
- directory publication、read、existence probe、directory listing 与 cleanup；
- dirty save 中的新编辑、switch validation 中的新编辑、ingest 与 switch/delete 交错、delete unknown retry；
- 额外覆盖 stale thumbnail completion。

正确性只能由 public result、`getState()`、`read()` 和重启后 `open()` 判断。Reference model 独立推导 document 内容、照片数量与 `contentRevision`，并检查权威列表成员、所有 document asset 的 original descriptor、no-op save revision、timer-driven autosave、switch 成败后的 handle 生命周期，以及故障阶段所规定的完整旧状态或完整新状态。Harness 不解析内部持久化文件，也不以被测系统的读取结果回填预期值。

每个状态机 step 可能组合调用多个公开方法，不能解释为用户操作数。`faultCounts` 只统计 adapter 或并发 gate 已确认实际命中的故障，不按预定 operation 静态预增。

## Artifact

Evidence 成功后以临时目录写入并原子发布到：

```text
artifacts/reliability/YYYY-MM-DD/HHMMSSmmm-evidence-<digest>/
├── summary.json
└── events.jsonl
```

`artifacts/` 已被 Git 忽略。`summary.json` 记录运行前后的 HEAD 与 worktree status、baseline 资格、Node/pnpm/Jest 版本、profile、固定 seeds/steps、两次 SHA-256 event digest 及一致性、operation/fault/typed-failure 计数、重启、恢复和不变量失败数。`events.jsonl` 每行记录 baseline 的 seed、step、状态机 operation、fault、typed result、恢复动作、该步实际重启/恢复增量，以及最终 public state 摘要。

只有测试进程成功退出才会发布成功 artifact；失败时改为原子发布 `failure.json`，保存退出状态、结构化失败诊断及原始 stdout/stderr。dirty worktree 的成功结果标记为 `diagnostic-only`；只有 clean commit 上生成的 artifact 可作为正式 baseline。

## 结论边界

正式 evidence 必须来自运行前后 HEAD 一致且 worktree 均为 clean 的执行。其有效范围由固定 seeds、状态机步骤、实际故障触发次数、public oracle、不变量结果和完整重放 SHA-256 digest 共同限定。

本基线不能证明“无 bug”、线上故障率、真机稳定性、文件系统性能或真实并发。Harness 使用内存 adapter、确定性 PRNG、显式 Promise gate、单进程串行执行和全量 digest 重放；宿主机资源变化只应影响 wall time，不应改变输入、调度点或结果。Wall time 不设置阈值，也不属于可靠性结论；真机和真实文件系统必须由独立设备基线验证。
