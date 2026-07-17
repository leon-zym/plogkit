# PlogKit

**A lightweight plog toolkit beyond your system Photos app.**

[简体中文](README.zh-Hans.md)

PlogKit is a lightweight mobile app for plog creators. It fills the gap between editing photos and publishing a plog, helping creators finish the last step faster. Photo adjustment and color tuning stay in the system Photos app; PlogKit focuses on a lightweight, direct finishing workflow.

## Status

PlogKit is in pre-release development. The current version runs in iOS and Android simulator development builds. Production signing, physical-device release validation, and store distribution are not configured yet.

## Features

The current version includes:

- Add text to images, with clean limited styles and long-text (CJK-first) layout support.
- Background colors.
- Stitch multiple images vertically or in grid layouts.
- Export JPEG or PNG with original, social, and compact presets.
- Undo and redo, auto-saved editing session, and continue editing after export.

## Roadmap

Planned additions:

- More platform-specific export presets.
- A collage-style freeform canvas.
- Share Extension.
- HDR and wide-gamut preservation.
- Live Photo support.

Their implementation order will follow design and technical validation.

Deliberately out of scope: beauty/retouch, filters, AI editing, general video editing, cloud sync, accounts, and template marketplaces. See `docs/product/` for the full boundary list.

## Tech Stack

React Native (Expo, New Architecture) + Skia + TypeScript. The editor is document-driven: a serializable document is the single source of truth, rendered by Skia both on-device and headlessly in CI for pixel-level regression testing.

## Documentation

Authoritative project documentation lives in [`docs/`](docs/) and is written in Chinese (see ADR 0014):

- [`docs/product/`](docs/product/): positioning, current product scope, naming.
- [`docs/adr/`](docs/adr/): architecture decision records with a decision ledger.
- [`docs/specs/`](docs/specs/): BDD acceptance specs (Given/When/Then) per feature.
- [`docs/guides/`](docs/guides/): design system, testing strategy, and development environment.

Agents working on this repository must follow [`AGENTS.md`](AGENTS.md).

## License

[GPL-3.0-only](LICENSE). Third-party fonts and assets must follow the permissive licensing policy in [ADR 0015](docs/adr/0015-license-gpl3-cla.md).
