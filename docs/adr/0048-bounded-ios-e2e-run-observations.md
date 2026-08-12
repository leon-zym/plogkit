# ADR 0048：iOS E2E 持续发布有界运行观测

- 状态：已接受
- 接受日期：2026-08-13
- 修订：[ADR 0047](0047-sanitized-ios-e2e-artifact-publication.md) 中只在失败后发布 iOS 证据的生命周期边界
- 关联：[Issue 99](https://github.com/leon-zym/plogkit/issues/99)

## 背景

fresh iOS Simulator 的长尾失活会漂移到 boot、应用服务、照片注入、UI driver 或系统照片选择器。只在失败后抓取系统状态不能还原长阶段内的宿主压力变化；只保留失败样本也无法与健康样本比较。观测本身不能增加 guest 或 UI driver 的交互，也不能成为验收控制流。

## 决策

- iOS runner 通过一个独立 recorder 记录固定阶段的单调耗时与白名单宿主指标。公开快照只含版本化字段、有限枚举和有界数字，不含原始错误、命令、PID、设备标识、私人路径、端点或自由文本。Maestro 退出后只解析其已有 command metadata，归纳 driver、App 根界面与 Picker 语义耗时，不启动新探针。
- 周期性宿主采样仅在 native preparation 期间低频、非重叠执行；job、build 与 Maestro 进程退出后等固定边界可各取一次同类快照。每次采样有独立短 deadline，总次数和公开文件大小均有硬上限。进入唯一 Maestro suite driver 前必须停止并收口周期采样，因此不在 UI driver 或 Photos Picker 热路径创建探针。
- 采样只读取宿主 CPU、load、memory pressure、swap、磁盘与白名单进程名汇总，不调用 guest 或改变设备状态。缺失或超限只把观测标记为不完整，绝不影响 readiness、primary error、cleanup、retry 或通过结论。
- recorder 从工具链 preflight 通过后的有效 E2E 事务开始，在 iOS public artifact root 原子更新单个结构化快照。workflow 无论成功或失败都上传该 public root；既有脱敏失败证据仍只在失败时发布。Android artifact 和执行路径保持不变。
- `passed` 只能在 cleanup 与成功提交完成后记录；信号中断保留最后一个 durable stage 并标记为 `interrupted`。recorder 自身失败不参与 E2E 错误聚合。

## 影响与代价

- 同一 SHA 的成功与失败样本可以按阶段和宿主压力比较，且不需要复制 Maestro 状态机或引入第二个 driver。
- native preparation 增加少量有界宿主只读进程；公开快照的采样耗时与缺口可用于判断观测开销是否需要继续收紧。
- Picker 内部的加载阶段仍由一次性取证或 Maestro 原生证据确认，不为常驻遥测向业务 flow 注入 sidecar。

## 迁移与兼容

公开快照从 `schemaVersion: 1` 开始，不迁移历史 artifact。消费者必须先验证版本与有限字段；遇到未知版本或不完整快照时停止解释该份证据，不能猜测缺失语义。未来不兼容字段变化递增版本，既有版本只在仍能维持相同隐私和有界性契约时兼容读取。
