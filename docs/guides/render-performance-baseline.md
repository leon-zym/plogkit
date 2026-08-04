# 导出与缩略图性能基线

本指南定义当前可执行的 Mac / CanvasKit 工程基线，以及后续真机 headline 测量必须遵守的隔离边界。测量不设置产品性能阈值，只描述对应 commit、fixture、运行时和样本。

## Mac / CanvasKit 工程基线

正式工程基线在干净 worktree、接入交流电、关闭低电量模式，并确认没有其他构建、测试、Simulator、Emulator、索引或 benchmark 负载时运行：

```sh
PLOGKIT_RENDER_HOST_ISOLATION_CONFIRMED=1 \
pnpm measure:render
```

标准入口先运行 `pnpm test:render`，成功后生成包含 commit、lockfile SHA-256 和完成时间的临时 receipt，再把 receipt 交给 measurement 子进程验证并写入最终 artifact。临时 receipt 与 measurement 共用 Git 忽略的 `artifacts/render-measurements.noindex/` 根目录；标准入口显式把该 root 传给子进程，避免 runner 与 measurement 的默认路径漂移。`.noindex` 后缀用于防止证据写盘反向触发 Spotlight，并未放宽活跃索引进程的 hard gate。receipt 在子进程退出后删除；手填环境变量不能替代同仓库身份的验证证据。render suite 与 measurement 串行运行，可能给宿主机带来短时负载，因此 receipt 完成时间到首个 thermal preflight 的间隔也会记录；首个 workload block 仍必须通过 thermal、内存压力与电源检查。

只有实际完成宿主隔离后才能设置确认变量。runner 还会记录进程、1 / 5 / 15 分钟 load average、可用内存、电源、低电量模式和 worktree 状态。以下任一条件使结果保留为 diagnostic，而不是有效工程基线：

- smoke profile；
- worktree 非 clean；
- 未显式确认宿主隔离；
- render verification receipt 缺失、无效，或与当前 commit / lockfile 不一致；
- 进程探针不可用、输出为空或存在无法解析的行；
- 检测到其他构建、测试、模拟器、活跃索引或 benchmark；
- 未接入交流电或启用了低电量模式；
- thermal 或内存压力为 warning，或相应探针无法确认 nominal 状态；
- 测量期间 HEAD、branch、dirty 状态、lockfile、plan 或 schedule 发生变化；
- 任一 warm-up 或 measured sample 失败。

runner 在 warm-up block 与每个 measured round 的共享边界采集宿主快照；探针与 recovery poll 均不会进入单个 sample 的计时窗口。某个 block 后出现 warning 或已知并发 workload 时，该 block 的全部样本保留并标记 ineligible。下一 block 遇到 thermal、内存压力、进程探针不可用或已知短时 workload 时，每隔固定 2 秒重探一次，最多重试 3 次、累计等待最多 6 秒；恢复 nominal 后按原计划执行，达到上限则把整个 block 的计划项保留为 typed precondition failure。未接交流电、低电量模式或电源状态不可确认属于需要人工修正的条件，直接 fail fast。runner 不随机等待或无限重试，artifact 记录每次观察、固定策略和总等待时间。快照记录 1 / 5 / 15 分钟 load average、free memory、磁盘空间、电源与低电量模式；在没有本机 clean-window 历史分布前，不对 load average、free memory 或磁盘空间虚设硬阈值。`pmset -g therm` 的文本形式必须同时明确 no thermal warning、no performance warning 与 no CPU power status；numeric 形式除了完整的 nominal level / speed / scheduler 字段，还要求 `CPU_Available_CPUs` 与宿主 logical CPU count 精确一致，无法证明时 fail closed。任何未知非空状态行均视为 unknown。`sysctl -n kern.memorystatus_vm_pressure_level` 必须返回 nominal level `1`。进程分类覆盖 npm、yarn、bun、pnpm、Jest、Vitest、Node test、TypeScript、ESLint、Prettier、Gradle、Metro、Expo、原生 build、simulator 和 benchmark 命令，但显式宿主隔离仍是未知高负载的必要门禁；full profile 的平衡多轮样本和 MAD 用于暴露抖动，不据 elapsed 删除样本。进程探针只持久化 category、PID、CPU 百分比和 executable basename，不写入原始 command line。

首次验证命令、改动 runner 或排查协议时可使用功能 smoke。标准入口仍会先完成 render verification 并生成 receipt：

```sh
PLOGKIT_RENDER_MEASUREMENT_PROFILE=smoke pnpm measure:render
```

smoke 始终标记为 diagnostic。无论 eligibility 如何，runner 都保留全部成功、失败和受干扰样本，不删除慢样本或只挑最佳结果。

### 触发与责任

- 修改 render / export / thumbnail policy、Skia runtime、measurement fixture 或 toolchain 后，由变更负责人运行 smoke，并根据影响范围更新冻结 manifest 与说明。
- 高风险图像链路改动或 release candidate 前，由变更负责人在 clean、isolated、交流电宿主机运行 full profile。
- 原始 measurement artifacts 始终保持 Git ignored；diagnostic、失败和受干扰 artifacts 仍完整保留。需要协作复核时附到对应 Issue 或 CI job artifact，不提交一次性结果。
- 当前协议是手动、资格门禁的工程测量，不宣称为自动 CI 性能防回归。

### 冻结矩阵与正确性边界

- 1 / 3 / 9 图；
- `original` JPEG、`original` PNG、`social` JPEG、`compact` JPEG，共 12 个 export case；
- 每个图片数量各执行一次 `square + original` two-target Thumbnail Pair，共 3 个 thumbnail case；
- full profile 每个 case 先执行 1 次 warm-up，再执行 3 次 measured run；smoke 为 1 次 warm-up 和 1 次 measured run。

每个 case 的期望输出尺寸和格式是独立冻结的 literal manifest，不由被测代码在运行时生成。runner 同时使用 `ResolvedExportPolicy` 或共享 scene、正式 thumbnail profile 与 `calculateDraftThumbnailGeometry` 推导第二份结果；生产推导与冻结 manifest 不一致时立即失败。这样既能发现输出违约，也能发现生产策略与已批准规格一起漂移，避免循环 oracle。

schedule 先完成全部 case 的 warm-up，再按 measured round 轮转 case 起点，使每个 case 在 full profile 的前、中、后段各出现一次。schedule 与 SHA-256 一并写入环境产物，执行中不按已观察结果改序。

计时使用 `performance.now()`，只包围一次 public `backend.prepare()` 或 `thumbnailAdapter.generate()` 调用。policy 解析、backend / adapter 构造、输出二次解码、SHA-256、宿主快照和报告写入均在计时窗口之外；renderer 内部的素材 decode、文字布局、draw、encode，以及 public seam 自身的写出仍包含在窗口内。

两张仓库内 JPEG fixture 交替组成 1 / 3 / 9 图文档。runner 解码验证 fixture 尺寸并记录格式、字节数和 SHA-256；每个 case 另记录统一文档 SHA-256。它们提供可重复的小型输入，不代表相机级原图的 decode / encode 压力。measurement 层验证可解码性、精确尺寸、magic-byte 格式、字节数和稳定身份，不把这些信号冒充像素内容正确性；内容正确性由运行前的 golden / pixel-diff suite 负责。

### 产物与判读

默认产物写入被 Git 忽略且抑制 Spotlight 索引的 `artifacts/render-measurements.noindex/<run-id>/`。`PLOGKIT_RENDER_MEASUREMENT_DIR` 仍是精确输出目录 override，不会自动追加 `<run-id>`：

- `environment.json`：开始/结束的 commit、branch、dirty 状态、lockfile / plan / schedule SHA-256，render verification receipt、toolchain、运行协议、block 边界宿主快照和 eligibility；
- `fixtures.json`：fixture 与 case input 身份，以及覆盖期望尺寸和格式的 case manifest SHA-256；
- `samples.jsonl`：逐样本耗时、状态、typed failure、输出身份、所属宿主观察 block 和内存可用性；
- `validation.json`：bundle 的 `valid` 或 `invalid` 状态；
- `summary.json`：相互独立的 structural validation、functional outcome、claim eligibility，以及可由 raw samples 重算的 case 级 median、median absolute deviation（MAD）、max、成功数、失败数、输出尺寸、实际格式和字节数。

runner 先在同一父目录写入带 `.in-progress-*` 标记的临时目录。它对编码结果二次解码尺寸，并以 PNG / JPEG magic bytes 判断实际格式，不能只相信 case 名称或扩展名。成功样本必须具有可解码的非空输出、精确匹配冻结契约的尺寸和格式、正字节数与 SHA-256；case 缺失、sampleIndex 不精确、出现未知 phase、failure 缺少 typed code / phase、目标遗漏，以及同一 case 在成功样本间输出身份、格式或尺寸漂移都会使 structural validation 无效。每条 sample 冗余保存相同 provenance、本 case 的期望输出契约、文档 hash 和 case manifest hash，使 raw JSONL 脱离 summary 后仍可追溯。只有结构验证通过后才生成 summary，并把目录原子改名为最终路径；样本失败可以是“结构有效但功能失败”，此时 `functionalOutcome.status` 为 `failed` 且 `claimEligibility.eligible` 必为 `false`。formal claim 还要求每条 sample 明确记录 `eligibility.eligible: true` 与空 `reasons`；字段缺失、false 或携带任何原因都 fail closed，不能生成 completed summary。结构验证失败时仍保留 environment、fixtures、全部 raw samples 和 `validation.status: invalid`，但不生成容易误判为完成的 summary。任何失败样本都会使 measurement suite 失败。MAD 基于全部 measured success 的绝对中位差计算，单样本为 0；不执行 outlier trimming，失败和受干扰样本仍保留在 raw data 与计数中。

`processPeakRssBytes` 是 Node / CanvasKit 进程自启动以来的累计 peak RSS，只用于定位工程趋势；它不是单 case native allocation。当前 timing run 没有 native allocation profiler，因此对应字段明确为 unavailable，不用 JS heap 代替。

Mac / CanvasKit 数据受宿主机、WASM 和测试字体影响，full profile 每 case 仅 3 个 measured sample，只能作为协议复现和工程 reference / 回归基线，不能作为产品、Simulator、Emulator 或物理设备 headline 数据。

## 真机 headline 协议

当前命令不生成真机数据。后续设备 runner 必须复用相同 case、fixture hash、逐样本 schema 和汇总规则，并满足以下约束：

1. 使用 release-like build 和内嵌 JS bundle；关闭 Metro、debugger、dev menu 与 profiler。
2. timing run 与 Instruments、Perfetto 或 `dumpsys meminfo` profiler run 分开。
3. cold process 与 warm in-process 分开预注册、采样和汇总。
4. 每个 headline case 至少 3 次 warm-up 和 15 次 measured run。
5. 记录设备型号、OS、RAM、可用存储、电量、低电量模式、thermal state、build 与测量工具。
6. 宿主机只触发和收集设备已生成的结果；Android 与 iOS 串行，采样期间停止其他模拟器、构建、测试、索引和 benchmark。
7. 前后版本比较冻结 case，并采用 ABBA 或其他平衡顺序；看结果后不得换 case、删失败样本或缩小输入。
8. 仓库 fixture 用于复现；相机级代表图片保留 checksum，可不提交大型或私有原图。

thermal state 非 nominal、系统干扰或协议条件不满足的样本仍需保存，并以明确原因标记 `eligible: false`。真机结果不能与 Mac / CanvasKit、Simulator 或 Emulator 混合汇总。
