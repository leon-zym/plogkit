# ADR 0020：CI 生命周期与 main 分支门禁

- 状态：已接受（2026-07-15）
- 调整：ADR 0011、0019 中 PR 编译检查的平台范围、触发时机与 E2E 定时频率
- 关联：ADR 0016、0019

## 背景

项目需要在 PR 早期提供快速反馈，同时避免 draft 阶段的每次提交都消耗 macOS 和 Android 原生编译资源。仅编译 Android 无法发现 Pod、Xcode build setting、config plugin 或 iOS 原生依赖的独立回归。ADR 0016 要求 PR 绿灯后才能合并，但只在文档中约定无法阻止绕过检查直接更新 `main`。

完整双端 E2E 的成本高于提交级门禁，不需要每天运行；每周回归足以发现非 PR 路径产生的长期漂移，关键变更和里程碑仍可按需触发。手动诊断可能在同一分支上分别运行平台或 flow，不应互相取消。

## 决策

- push 到 `main` 和所有 PR 提交均运行 `pnpm verify`。
- Draft PR 不运行原生编译检查。PR 转为 ready 时，以及正式 PR 的每次新提交，并行运行 Android arm64 Debug 和 iOS Simulator Debug 编译检查。
- iOS 编译检查使用 generic simulator destination 并只编译 runner 宿主架构，不启动 Simulator；它验证 CNG、Pods 和 Xcode 原生集成，不替代 iOS E2E。
- `main` 使用 active repository ruleset：禁止删除和 force push，所有更新必须经 PR，并要求静态/单元/渲染验证及双端编译检查通过。当前不要求人工 approval，也不要求分支在合并前同步到最新 `main`。
- 完整双端 E2E 每周一北京时间 02:30 定时运行。定时任务继续按 ref 取消重复运行；`workflow_dispatch` 以 run ID 隔离并发组，使同一分支上的手动诊断任务彼此独立，也不取消定时任务。

## 影响与代价

- Draft 阶段保留快速反馈，转为 ready 后才承担两端原生编译成本。
- 两端原生工程在合并前均有编译保护；设备行为仍由每周定时任务、手动 E2E 和发布前真机冒烟覆盖。
- Ruleset 将 ADR 0016 从协作约定变成 GitHub 强制门禁。管理员也不配置常规 bypass；紧急绕过必须显式临时调整 ruleset，并留下可审计记录。
- 手动 E2E 不再自动取消同分支旧任务，连续误触可能并行消耗 runner，应由触发者手动取消不再需要的运行。
