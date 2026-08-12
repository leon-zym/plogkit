# ADR 0045：iOS E2E 系统诊断证据先脱敏再保留

- 状态：已接受
- 接受日期：2026-08-13
- 修订：[ADR 0042](0042-controlled-standalone-simulator-e2e.md) 中原始平台日志的保留决策
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

iOS 系统日志与系统探针会包含宿主 home、Simulator container 路径和本地验证端点。这些值不参与 guest、driver 或系统扩展的故障分类，不应随 E2E artifact 保留。

## 决策

- iOS E2E 文本系统诊断在落盘前删除私人宿主路径及包含 capability token 的 loopback 端点；iOS 结构化系统探针只保留诊断所需的白名单字段和执行元数据。Android 原始诊断证据不在本次修订范围。
- 脱敏不参与测试控制流，不改变 primary error、deadline、字节上限或 artifact 生命周期。
- [ADR 0042](0042-controlled-standalone-simulator-e2e.md) 的其他失败证据决策保持不变。

## 影响与代价

- iOS 文本平台日志不再保证与系统命令输出逐字节相同，但时间、进程、subsystem 和事件语义继续保留。
- 系统探针失去容器路径等低价值细节，以换取可安全上传的故障证据。
