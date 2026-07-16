# ADR 0021：以类型化编辑意图深化编辑提交模块

- 状态：已接受（2026-07-15）
- 关联：ADR 0003、0004

## 背景

当前编辑流程由 caller 组合文档 operation、预览、提交、选择清理、撤销重做与自动保存。纯 operation 和 Zustand store 各自容易测试，但真正影响编辑语义的调用顺序分散在多个 caller 中，缺少 locality；随着自由画布、花字和更多拼图布局增加，这个 shallow seam 会继续扩大并泄漏文档不变量。

候选 interface 包括按领域分组的大量方法、声明式批处理 program，以及统一消息入口。按领域分组的方法易于发现，但会随编辑能力增长；通用 program 能表达复合操作，却提前引入顺序、部分失败与嵌套语义。项目需要稳定的小 interface，同时保留类型检查和领域可发现性。

## 决策

- 建立 deep 编辑提交 module，external interface 仅包含 `read`、`subscribe`、`dispatch`。`read` 提供已提交文档、预览文档、撤销重做能力与 revision；React 通过薄 adapter 订阅，不接触 Zustand store。
- `dispatch` 接收类型化消息，分别表达预览意图、取消预览、提交意图、撤销与重做。按文本、画布、拼接、导出等领域分组的 builder 负责构造语义编辑意图；新增编辑能力扩展 intent union 和 interpreter，不扩大 module interface。
- module 同时只维护一个 active preview。新预览替换旧预览；编辑提交、取消预览、撤销或重做会清除预览。手势逐帧状态仍留在 Reanimated，手势结束只形成一次编辑提交。
- interpreter 集中执行验证、语义 no-op 判断与文档变换。一次语义完整的意图可以原子改变多个字段或对象；拒绝的意图和 no-op 均不改变文档、快照 history 或自动保存状态。
- Zustand、有界文档快照 history 和自动保存调度属于 implementation。成功的编辑提交产生一个快照并调度一次自动保存；撤销与重做恢复文档快照。intent、active preview 和 history 均不持久化，应用重启只恢复最后保存的文档，不能继续重启前的撤销历史。
- 不提供 generic document patch、`commit(nextDocument)`、任意 partial update 或通用 batch/program。若未来出现用户可组合动作、宏操作、事件溯源或跨重启撤销的真实需求，另行评估并记录新 ADR。
- 可预期结果以 changed、previewed、unchanged 或 rejected typed result 返回；编程错误才抛异常。编辑结果只报告 created/removed 等文档实体效果，选择状态仍由 UI caller 管理。

## 影响与代价

- preview、提交粒度、验证、history 和自动保存获得 locality；测试以 module interface 为 surface，不再依赖 caller 编排或内部 store 结构。
- 自由画布、多对象操作、花字和更多布局可以增加语义意图而保持 external interface 稳定。Share Extension 属于导入 adapter，HDR 与 Live Photo 属于渲染/编码 seam，不并入编辑提交 module。
- intent union 和 interpreter 会随能力增长，但 exhaustive checking 让新增行为及其测试位置明确，提高 leverage 与 AI 可导航性。
- 禁止 generic patch 意味着每种新编辑语义都必须显式建模；这是为集中不变量与原子提交而接受的成本。
