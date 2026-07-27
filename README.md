# PlogKit

**A lightweight plog toolkit beyond your system Photos app.**

[简体中文](README.zh-Hans.md)

PlogKit is a lightweight mobile app for plog creators. It fills the gap between editing photos and publishing a plog, helping creators finish the last step faster. Photo adjustment and color tuning stay in the system Photos app; PlogKit focuses on a lightweight, direct finishing workflow.

## Status

PlogKit is in pre-release development. The current version runs in iOS and Android simulator development builds. Production signing, physical-device release validation, and store distribution are not configured yet.

## Features

The current version includes:

- A local draft library for creating, browsing, reopening, and deleting work on this device.
- Add text to images, with clean limited styles and long-text (CJK-first) layout support.
- Background colors.
- Stitch multiple images vertically or in grid layouts.
- Export JPEG or PNG with original, social, and compact presets.
- Undo and redo, autosave, and continued editing after export or app restart.

## Product Scope

The authoritative current scope, confirmed directions, and hard boundaries are maintained in [`docs/product/product-scope.md`](docs/product/product-scope.md). User-observable behavior and delivery status are maintained in [`docs/specs/`](docs/specs/).

## Tech Stack

React Native (Expo, New Architecture) + Skia + TypeScript. The editor is document-driven: a serializable document is the single source of truth, rendered by Skia both on-device and headlessly in CI for pixel-level regression testing.

## Documentation

Start with the canonical [`docs/README.md`](docs/README.md) navigation and ownership map. Authoritative project documentation under `docs/` is written in Chinese (see ADR 0014).

Agents working on this repository must follow [`AGENTS.md`](AGENTS.md).

## License

[GPL-3.0-only](LICENSE). Third-party fonts and assets must follow the permissive licensing policy in [ADR 0015](docs/adr/0015-license-gpl3-cla.md).
