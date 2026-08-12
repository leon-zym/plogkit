# ADR 0047：iOS E2E 只发布脱敏证据集

- 状态：部分修订
- 接受日期：2026-08-13
- 修订：[ADR 0042](0042-controlled-standalone-simulator-e2e.md) 与 [ADR 0045](0045-sanitized-e2e-diagnostic-evidence.md) 中 iOS 失败证据的上传边界
- 后继：[ADR 0048](0048-bounded-ios-e2e-run-observations.md)
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

Maestro 原生输出、crash report 与系统诊断可能包含宿主私人路径、完整命令参数和本地 capability 端点。它们在临时工作区中有助于 runner 完成故障收集，但不能因此直接成为可下载的 CI artifact。仅在个别探针落盘前脱敏，无法覆盖第三方工具生成的全部文件。

## 决策

- iOS runner 将私有执行工作区与可上传证据集分离；workflow 只上传后者，绝不直接上传前者。
- 失败清理完成后，runner 从 iOS 证据白名单生成有文件数、单文件和总字节上限的脱敏副本。文本删除私人路径与 capability 端点；受支持的图片须通过格式验证；无法安全解释的文件省略并在摘要中标记证据不完整。
- 可上传证据集先在独立目录完整生成，再原子发布。发布或清理失败均作为次级错误保留，不覆盖原始 E2E failure 的身份、阶段与错误码。Android 原始诊断证据不在本次修订范围。

## 影响与代价

- iOS CI artifact 不再是私有执行工作区的逐字节镜像，但仍保留故障阶段、Maestro flow、UI hierarchy、日志语义、截图与结构化探针。
- 不透明或超出预算的证据不会上传；摘要明确标记缺口，维护者可据此决定是否在受控环境追加采样。
- runner 增加一个失败后、只读且有界的发布步骤，不新增设备生命周期、driver、retry 或业务控制分支。
