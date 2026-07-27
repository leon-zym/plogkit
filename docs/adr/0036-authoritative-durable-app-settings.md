# ADR 0036：应用设置由进程级 module 权威持有并采用 durable-first 更新

- 状态：已接受（2026-07-27）
- 关联：ADR 0003、0017、[F09](../specs/F09-app-settings.md)、[Issue #48](https://github.com/leon-zym/plogkit/issues/48)

## 背景

设置持久化原本只提供整份记录的 `load/save`，首页和设置页各自长期保存快照、合并字段并写回。Expo runtime 的单次 cache 不提供订阅或 mutation 串行化，因此仍挂载的旧 caller 可以覆盖另一个 caller 已保存的字段；写入前的乐观更新还会在失败时让界面、cache 与磁盘事实分裂。

设置是可以由安全默认值重建的低价值偏好，但不同入口仍必须观察同一份进程内事实，并且不能用降级默认值覆盖一次暂时无法读取的持久记录。

## 决策

- App Settings module 拥有进程内唯一、不可变的设置快照。其 external interface 只允许 caller 触发或等待初始化、同步读取状态、订阅状态变化，以及提交改变 metadata 默认值或缩略图显示方式的类型化编辑意图。
- external snapshot 不包含持久化 `schemaVersion`。整份记录合并、schema version 2、JSON 校验与迁移、文件位置及 Expo 文件 adapter 都属于 implementation；Expo 文件 adapter 与内存文件 stand-in 构成 module 内部的 local-substitutable seam。
- 初始化是可重试的 single-flight load barrier。文件不存在时安装 privacy-first 默认值；支持的旧 schema 在 implementation 内迁移；JSON 或已知字段内容损坏时安装默认值但不自动写回。`exists/read` 等 I/O 失败进入非权威失败状态，且不缓存失败 Promise。
- 未初始化、读取中或读取失败时可向运行时提供 `{strip, square}` 安全降级。该值不冒充已读取事实：设置交互不可提交；新草稿仍可使用 `strip`；重试会重新读取磁盘。
- 所有编辑意图进入同一进程内队列，并在执行时应用于最新已提交快照。不同字段的交错更新组合保留；同字段按接收顺序执行；失败不毒化队列；设置为当前值是无需写盘或发布的成功操作。
- 设置更新采用 durable-first：implementation 先写入包含 schema version 2 的下一记录，成功后才替换权威快照并通知订阅者。预期存储失败以 typed result 返回并保留旧快照；invariant 或 programming error 才抛出。
- `EditorRuntime` 创建新草稿时读取 module 的当前 metadata 默认值，不长期缓存设置快照。screen 只保留保存中、错误和菜单开关等瞬时 UI 状态。
- 当前只允许 PlogKit 主进程写设置，不增加跨进程锁、revision/CAS、journal 或草稿级 backup/temp 恢复协议。若 Share Extension 或其他进程成为真实 writer，必须以新 ADR 重新设计跨进程 seam。

## 影响与代价

- 两个 caller 不再理解持久记录，丢失更新与乐观状态分裂集中由一个小 interface 消除。
- durable-first 使设置在存储较慢时暂时保持旧值；对应交互需要在 intent 执行期间禁用，并在失败时显示可重试错误。
- 损坏内容与 I/O 失败必须在 implementation 内区分：前者安全降级，后者保留未知磁盘事实并要求重试。
- 单进程队列不解决未来真实多进程 writer；这是当前产品范围内有意接受的限制。
