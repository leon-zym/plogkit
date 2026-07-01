# PlogKit

**A lightweight plog toolkit beyond your system Photos app.**

PlogKit is a lightweight mobile app for plog creators. It does not try to replace the system Photos app or heavy photo editors. The system Photos app remains responsible for photo adjustment and color tuning; PlogKit focuses on the missing lightweight publishing steps: adding text, adding borders or backgrounds, stitching multiple photos, and exporting with social-platform-friendly compression presets.

## Product Positioning

PlogKit is a system Photos app companion, not a full photo editor.

It should feel like a small, fast, local-first toolkit that helps users finish plog posts after they have already selected or adjusted photos in the system Photos app.

## MVP Scope

The first version focuses on:

- Add text to images, with clean limited styles and long-text layout support.
- Add borders, margins, rounded corners, and background colors.
- Stitch multiple images vertically or in grid layouts.
- Export with several compression presets for social publishing.
- Support undo and redo.
- Auto-save the current editing session.
- Keep the exported project editable after export.

## Explicitly Out Of Scope

The first version does not include:

- Beauty, body reshaping, makeup, or face editing.
- Filters, heavy color grading, or photo retouching.
- AI removal, expansion, generation, or background replacement.
- Video editing.
- Sticker marketplace or asset feed.
- Full freeform canvas entry.
- Complex layer management UI.
- Cloud sync, accounts, collaboration, or community features.
- Full draft list or multi-project management.

## Technical Direction

The app targets both iOS and Android with React Native and Skia. Skia is the chosen rendering and export foundation. A native image-composition pipeline is intentionally rejected for now because it adds platform-specific complexity and weakens the shared abstraction.

The product is lightweight by feature discipline, not by minimizing package size at all costs.

## Documents

- [Product Decisions](docs/product-decisions.md)
- [MVP Scope](docs/mvp-scope.md)
- [Technical Decisions](docs/technical-decisions.md)
- [Naming And Slogan](docs/naming-and-slogan.md)

