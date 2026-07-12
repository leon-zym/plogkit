# AGENTS.md

Guidance for AI coding agents working on PlogKit.

## Project Overview

PlogKit is a lightweight, local-first mobile app for plog creators: add text,
backgrounds, stitch photos, and export with social-friendly presets.
It complements the system Photos app and deliberately excludes filters, beauty
editing, AI generation, and cloud features.

- Stack: React Native (Expo SDK 57, New Architecture) + TypeScript (strict) + Skia.
  Expo has changed significantly over time — consult the versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ before writing Expo-related code.
- State: Zustand document store; Reanimated shared values hold transient gesture
  state only. The serializable document is the single source of truth (ADR 0003).
- All significant decisions live in `docs/adr/` (one file per decision).
  Product scope: `docs/product/`. Feature acceptance specs: `docs/specs/`.

## Language Policy (ADR 0014)

- `docs/` (product, adr, specs, guides): **Chinese is authoritative.**
- `README.md` (English) and `README.zh-Hans.md` (Chinese): bilingual pair —
  when editing one, always update the other in the same change.
- Code, comments, commit messages, and this file: English.
- App UI strings: zh + en through the i18n layer; never hardcode copy.

## Architecture Map

- `src/core/` — pure TypeScript, no React/RN imports: document model & schema
  (versioned, with migrations), stitch layout math, undo stack, export presets.
- `src/render/` — document → Skia element tree. Must work on-device AND in
  Node headless (CanvasKit); keep it free of device-only APIs.
- `src/features/` — editor UI, panels, gestures (commit to document on gesture end).
- `src/services/` — photo import (sandbox copy + downsampled preview),
  persistence/autosave, export pipeline (render stage / encode stage split).
- `app/` — Expo Router routes.
- `e2e/flows/` — Maestro YAML flows, named after specs (e.g. `f01-add-text.yaml`).

## Commands

- Install: `pnpm install`
- Dev (iOS simulator): `pnpm ios`
- Type check + lint: `pnpm check`
- Unit/component tests: `pnpm test`
- Rendering goldens: `pnpm test:render` (update with `-u` only after inspecting diffs)
- E2E (booted simulator): `pnpm e2e`
- Full verification: `pnpm verify`

## Workflow

- Spec first: when behavior changes, update `docs/specs/` scenarios before code.
- TDD for `src/core`: write the failing test first.
- Decision changes require a new ADR (never rewrite an accepted one) and an
  update to `docs/adr/README.md` index in the same change.
- Git: Conventional Commits in English (`feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`). After scaffold, all changes go through branch + PR
  with green CI (ADR 0016). Run `pnpm verify` before committing.

## Code Style

- TypeScript strict. Never use `any`; prefer precise types and discriminated unions.
- No premature abstraction, no defensive/compat code, no feature flags.
- Comments: only for non-obvious intent or constraints; never narrate the code.
- Every interactive element must have a `testID` and a sensible
  `accessibilityLabel` (required for Maestro and real accessibility).

## Testing Rules (details: docs/guides/testing-strategy.md)

- Five layers: static checks → jest-expo unit/component → headless Skia
  goldens → Maestro E2E on iOS simulator → GitHub Actions.
- BDD as methodology, no Cucumber/Gherkin tooling. Test names describe behavior.
- Golden updates require visually inspecting rendered output/diff images first;
  never bulk-update goldens blindly. Goldens use bundled fonts only. Always
  `dispose()` Skia surfaces/images in headless code.
- E2E state assertions read the app sandbox (autosaved `document.json`,
  exported files) via `xcrun simctl get_app_container`; seed photos with
  `xcrun simctl addmedia`. Do not add test-only backdoors into app code.

## Hard Boundaries

- Never add: filters, beauty/retouch, AI generation, cloud sync, accounts,
  telemetry, watermarks, or any network calls. The app is local-first.
- Treat the "out of scope" lists in `docs/product/` as hard limits; do not
  implement deferred features (share extension, HDR export, Live Photo export,
  draft lists) without an explicit maintainer request plus a new ADR.
- Never introduce a new dependency (especially native) without explicit approval.
- Never hand-edit generated `ios/` and `android/` directories; use app config
  and config plugins (CNG), then `pnpm expo prebuild --clean`.
- Never commit secrets, signing assets, or large binaries (golden PNGs are OK).
- Assets/fonts must permit commercial closed-source embedding: fonts OFL,
  icons/other assets MIT/Apache-2.0/CC-BY. Never GPL/AGPL/NC-licensed assets
  (ADR 0015). App code itself is GPL-3.0-only.
- Document schema changes require a `schemaVersion` bump plus a migration
  (same for `presetSchemaVersion`).
- Export invariants: render from the document model (never screenshot the
  preview); respect per-preset caps (≤ 64MP total, ≤ 16384px long edge);
  strip EXIF/GPS by default; SDR output only in MVP (ADR 0007–0009).

## Environment Notes

See `docs/guides/dev-environment.md` for setup requirements and verified configurations.
