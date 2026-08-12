# PlogKit

**A lightweight plog toolkit beyond your system Photos app.**

<p align="center">
  <strong>English</strong> · <a href="README.zh-Hans.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue.svg" alt="License: GPL-3.0-only" /></a>
  <a href="https://docs.expo.dev/versions/v57.0.0/"><img src="https://img.shields.io/badge/Expo%20SDK-57-000020.svg?logo=expo&logoColor=white" alt="Expo SDK 57" /></a>
  <a href="https://reactnative.dev/"><img src="https://img.shields.io/badge/React%20Native-0.86-61DAFB.svg?logo=react&logoColor=black" alt="React Native 0.86" /></a>
  <a href="https://shopify.github.io/react-native-skia/"><img src="https://img.shields.io/badge/React%20Native%20Skia-2.6-4285F4.svg" alt="React Native Skia 2.6" /></a>
</p>

PlogKit is a lightweight mobile app for plog creators. It fills the gap between editing photos and publishing a plog, helping creators finish the last step faster. Photo adjustment and color tuning stay in the system Photos app; PlogKit focuses on a lightweight, direct finishing workflow.

## Project Status

PlogKit is in pre-release development. The current version runs in iOS and Android simulator development builds. Production signing, physical-device release validation, and store distribution are not configured yet.

## Highlights

Current highlights include:

- A local draft library for creating, browsing, reopening, and deleting work on this device.
- Add text to images, with clean, restrained styles and Chinese-first long-text layout support.
- Background colors.
- Stitch multiple images vertically or in grid layouts.
- Export JPEG or PNG with original, social, and compact presets.
- Undo and redo, autosave, and continued editing after export or app restart.

## Product Scope

The authoritative current scope, confirmed directions, and hard boundaries are maintained in [`docs/product/product-scope.md`](docs/product/product-scope.md). User-observable behavior and delivery status are maintained in [`docs/specs/`](docs/specs/).

## Tech Stack

React Native (Expo, New Architecture) + Skia + TypeScript. The editor is document-driven: a serializable document is the single source of truth, rendered by Skia both on-device and headlessly in CI for pixel-level regression testing.

## Documentation

Start with the canonical [`docs/README.md`](docs/README.md) navigation and ownership map. Authoritative project documentation under `docs/` is written in Chinese.

## Development

PlogKit's development baseline is macOS, the repository-pinned Node.js and pnpm toolchain, and the native toolchain for the target platform.

```bash
pnpm install
pnpm ios # or pnpm android
pnpm verify
```

See the [development environment](docs/guides/dev-environment.md) and [testing strategy](docs/guides/testing-strategy.md) for complete setup and verification details. Project directory structure, development workflow, and guidelines are in [`AGENTS.md`](AGENTS.md).

## License

[GPL-3.0-only](LICENSE). Third-party fonts and assets must follow the permissive licensing policy in [ADR 0015](docs/adr/0015-license-gpl3-cla.md).
