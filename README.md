# PlogKit

**A lightweight plog toolkit beyond your system Photos app.**

[简体中文](README.zh-Hans.md)

PlogKit is a lightweight mobile app for plog creators. It does not try to replace the system Photos app or heavy photo editors. The system Photos app remains responsible for photo adjustment and color tuning; PlogKit fulfills the essential needs of plog creation: adding text, backgrounds, stitching multiple photos, and exporting with presets optimized for multiple social platforms.

## Status

Pre-development. Product scope, architecture decisions, and acceptance specs are finalized; scaffolding is in progress.

## Product Positioning

PlogKit is a system Photos app companion, not a full photo editor. It is a small, fast, local-first toolkit — no accounts, no network calls — that helps users complete the final step of plog creation after they have already selected and adjusted photos in the system Photos app.

## MVP Scope

- Add text to images, with clean limited styles and long-text (CJK-first) layout support.
- Background colors.
- Stitch multiple images vertically or in grid layouts.
- Export with presets optimized for multiple social platforms.
- Undo and redo, auto-saved editing session, and continue editing after export.

Deliberately out of scope: beauty/retouch, filters, AI editing, video, cloud sync, accounts, and template marketplaces. See `docs/product/` for the full boundary list.

## Tech Stack

React Native (Expo, New Architecture) + Skia + TypeScript. The editor is document-driven: a serializable document is the single source of truth, rendered by Skia both on-device and headlessly in CI for pixel-level regression testing.

## Documentation

Authoritative project documentation lives in [`docs/`](docs/) and is written in Chinese (see ADR 0014):

- [`docs/product/`](docs/product/) — positioning, MVP scope, naming.
- [`docs/adr/`](docs/adr/) — architecture decision records with a decision ledger.
- [`docs/specs/`](docs/specs/) — BDD acceptance specs (Given/When/Then) per feature.
- [`docs/guides/`](docs/guides/) — testing strategy and development environment.

Agents working on this repository must follow [`AGENTS.md`](AGENTS.md).

## License

[GPL-3.0-only](LICENSE). Bundled fonts and assets use permissive licenses (OFL, MIT/Apache-2.0/CC-BY) that permit commercial closed-source embedding.
