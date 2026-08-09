# ADR 0042：iOS CI E2E 分离构建与验收预算

- 状态：已接受
- 接受日期：2026-08-09
- 修订：[ADR 0020](0020-ci-lifecycle-and-main-ruleset.md) 中 iOS scheduled / manual E2E 的 job 生命周期
- 关联：[ADR 0019](0019-cross-platform-maestro-e2e.md)、[ADR 0039](0039-native-node-orchestration-tests.md)

## 背景

iOS development build 与完整 Maestro suite 都是长时间、资源敏感的阶段。二者共用一个 job timeout 时，较慢的原生构建会直接压缩验收阶段的可用时间；job 级 timeout 还可能在 failure artifact 上传前终止整个生命周期。该结构无法分别表达构建、验收和诊断收集的预算，也会把完整 suite 尚未结束误报为单一 job 超时。形成此决策的运行证据见 [Issue #90](https://github.com/leon-zym/plogkit/issues/90)。

## 决策

- scheduled / manual iOS E2E 使用顺序依赖的 build job 与 acceptance job。build job 只生成 development build，acceptance job 只准备 Simulator、拥有 Metro 生命周期并运行完整 Maestro suite。
- build job 将 `.app` 打包成保留 Unix 权限的 archive，再通过短期 GitHub artifact 交给 acceptance job；不直接上传展开后的 app bundle。
- 两个 job 分别拥有有界预算。长时间 build / suite step 的 timeout 必须小于所在 job 的 timeout，为失败诊断上传和 job 收尾保留明确余量；不得用共享 job 的总 timeout 隐式挤压后一阶段。
- build 与 acceptance 使用不同的 failure artifact 名称和目录。阶段 timeout 由 step 失败表达，使同一 job 内的 artifact 上传仍有机会运行。
- 当前 runner 的具体分钟数由测试策略和 workflow 维护；后续可依据实际时序调整，但必须保留阶段分离、step 小于 job、权限安全交接和诊断余量这些约束。
- Android E2E 的 job 结构不因本决策改变。

## 影响与代价

- iOS workflow 会分配两个顺序 macOS runner，并产生一个短期 development build artifact，增加少量 runner 初始化、上传和下载成本。
- acceptance job 不再重复原生构建；完整 flow 仍在同一专用 Simulator 和 owned Metro 生命周期内串行执行，保持现有设备状态、导出资源和 flow 隔离语义。
- 当前证据表明单独的 acceptance 预算足以容纳完整 suite，因此不引入 flow 分片。若 suite 后续超出独立预算，应基于新的时序证据重新评估分片，而不是增加 retry、固定等待或无依据地放宽 timeout。
