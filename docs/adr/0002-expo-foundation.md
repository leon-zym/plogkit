# ADR 0002：工程底座：Expo SDK（56/57）+ CNG + dev client + pnpm，iOS 先行

- 状态：部分修订
- 接受日期：2026-07-02
- 后继：[ADR 0019](0019-cross-platform-maestro-e2e.md)
- 关联：[ADR 0001](0001-core-stack-rn-skia.md)

## 背景

原技术文档未决定 Expo 与 bare React Native CLI 的取舍。2026 年现状：React Native 官方推荐 Expo；SDK 56（RN 0.85 + React 19.2，New Architecture 强制）对 pnpm isolated 依赖原生支持；CNG（prebuild）免去手工维护原生目录；`expo run:ios` 支持本地构建，不依赖 EAS 云服务。图库选择、文件系统、分享、本地化等周边模块在 Expo 生态内维护良好。

## 决策

- 采用 Expo SDK + CNG/prebuild + development build（dev client），不使用 Expo Go。
  - 版本勘误（2026-07-02）：实际采用 SDK 57（2026-06 发布，内容为 SDK 56 + RN 0.86 的官方无破坏延续，工具链要求不变），决策实质不变。
- 包管理器使用 pnpm；本地构建（`expo run:ios`），不强制依赖 EAS。
- 路由使用 Expo Router。
- `ios/`、`android/` 为 prebuild 生成目录，不入版本库；原生配置一律通过 app config 与 config plugins 表达。
- 平台节奏：iOS 先行。代码保持跨端纪律（不裸调平台独占 API），CI 保留 Android 编译检查防腐，Android 实测待 CI 环境与设备就绪后跟进。

## 影响与代价

- 受 Expo SDK 升级节奏约束，原生依赖选择需优先考虑 Expo 兼容性。
- CNG 减少手工维护原生工程的成本，但原生配置必须通过 app config 或 config plugin 表达。
- iOS 先行造成的自动化平台范围已由 [ADR 0019](0019-cross-platform-maestro-e2e.md) 修订。
