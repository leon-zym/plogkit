# AGENTS.md

Guidance for AI coding agents working on PlogKit.

## Project Overview

PlogKit is a lightweight, local-first mobile app for plog creators. It
complements the system Photos app with focused publishing preparation. The
canonical current scope and product boundaries live in
[`docs/product/product-scope.md`](docs/product/product-scope.md).

- Stack: React Native (Expo SDK 57, New Architecture) + TypeScript (strict) + Skia.
  Expo has changed significantly over time — consult the versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ before writing Expo-related code.
- State: Zustand document store; Reanimated shared values hold transient gesture
  state only. The serializable document is the single source of truth (ADR 0003).
- Start documentation navigation and ownership decisions from
  [`docs/README.md`](docs/README.md). ADRs own durable architecture and
  engineering-governance decisions; specs own user-observable acceptance and
  feature delivery status.

## Language Policy (ADR 0014)

- `docs/` (product, adr, specs, guides): **Chinese is authoritative.**
- `README.md` (English) and `README.zh-Hans.md` (Chinese): bilingual pair —
  when editing one, always update the other in the same change.
- Code, comments, commit messages, and this file: English.
- App UI strings: zh + en through the i18n layer; never hardcode copy.

## Documentation Discipline

- Follow the ownership map and update triggers in
  [`docs/README.md`](docs/README.md). Treat long-lived docs as contracts, not
  work logs; keep implementation history and investigation evidence in Issues,
  PRs, tests, or artifacts.
- Update the canonical owner when a contract changes. Other documents may keep
  only the minimum local context their readers need and must link the owner.

## Architecture Map

- `src/core/` — pure TypeScript, no React/RN imports: document model & schema
  (versioned, with migrations), stitch layout math, undo stack, export presets.
- `src/render/` — document → Skia element tree. Must work on-device AND in
  Node headless (CanvasKit); keep it free of device-only APIs.
- `src/features/` — editor UI, panels, gestures (commit to document on gesture end).
- `src/services/` — draft persistence and imported-asset ownership,
  current-session autosave, and export orchestration. Export backends own render
  and encode responsibilities behind the pipeline seam.
- `src/app/` — Expo Router routes.
- `e2e/flows/` — cross-platform Maestro YAML flows, named after specs (e.g. `f01-add-text.yaml`).
- `e2e/subflows/` — shared steps and narrowly scoped iOS/Android system-UI adapters.

## Commands

- Install: `pnpm install`
- Metro for an installed development build: `pnpm start`
- Build and run: `pnpm ios` or `pnpm android`
- Type check + lint: `pnpm check`
- Unit/component tests: `pnpm test`
- Rendering goldens: `pnpm test:render` (update with `-u` only after inspecting diffs)
- E2E (dedicated iOS + Android devices): `pnpm e2e`
- E2E (single platform): `pnpm e2e:ios` or `pnpm e2e:android`
- Full verification: `pnpm verify`

## Workflow

- Spec first: when behavior changes, update `docs/specs/` scenarios before code.
- TDD for `src/core`: write the failing test first.
- Decision changes require a new ADR (never rewrite an accepted one) and an
  update to `docs/adr/README.md` index in the same change.
- Git: Conventional Commits in English (`feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, `chore:`). After scaffold, all changes go through branch + PR
  with green CI (ADR 0016). Run `pnpm verify` before committing.
- Run the affected platform's full E2E for system-UI or platform-specific
  behavior changes. Run full dual-platform E2E for native configuration,
  persistence, export, or a critical cross-platform flow.

## Code Style

- TypeScript strict. Never use `any`; prefer precise types and discriminated unions.
- No premature abstraction, no defensive/compat code, no feature flags.
- Comments: only for non-obvious intent or constraints; never narrate the code.
- Every interactive element must have a `testID` and a sensible
  `accessibilityLabel` (required for Maestro and real accessibility).

## Testing Rules (details: docs/guides/testing-strategy.md)

- Four verification layers: static checks → unit/component → headless Skia
  goldens → Maestro E2E. GitHub Actions executes these layers as CI gates.
- BDD as methodology, no Cucumber/Gherkin tooling. Test names describe behavior.
- Golden updates require visually inspecting rendered output/diff images first;
  never bulk-update goldens blindly. Goldens use bundled fonts only. Always
  `dispose()` Skia surfaces/images in headless code.
- Keep Maestro business flows cross-platform. Isolate system UI differences in
  platform subflows; do not duplicate complete flows.
- Test non-trivial pure E2E runner logic with Node's built-in runner; validate
  Maestro flow behavior on the affected target platform or platforms.
- When E2E fails without a diagnosed cause, rerun the failing flow unchanged;
  never add retries, sleeps, or longer timeouts merely to suppress flakiness.
- E2E state assertions may read autosaved draft state from the app sandbox.
  Export E2E asserts a new system Photos/MediaStore resource; pixel, format,
  dimensions, and metadata belong to backend contract/headless tests. Do not
  add test-only backdoors into app code.

## Hard Boundaries

- Treat the current scope, confirmed directions, and hard boundaries in
  [`docs/product/product-scope.md`](docs/product/product-scope.md) as canonical.
  Do not implement behavior outside the current scope without an explicit
  maintainer request; update the relevant spec first and add an ADR when the
  change alters a durable architecture or engineering constraint.
- Never introduce a new dependency (especially native) without explicit approval.
- Never hand-edit generated `ios/` and `android/` directories; use app config
  and config plugins (CNG), then `pnpm expo prebuild --clean`.
- Never commit secrets, signing assets, or large binaries (golden PNGs are OK).
- Assets/fonts must permit commercial closed-source embedding: fonts OFL,
  icons/other assets MIT/Apache-2.0/CC-BY. Never GPL/AGPL/NC-licensed assets
  (ADR 0015). App code itself is GPL-3.0-only.
- Released document schema changes require a `schemaVersion` bump plus a
  migration. A pre-release baseline reset may omit migration only when an ADR
  explicitly authorizes discarding all unpublished data. Catalog declaration
  schema changes likewise bump `catalogSchemaVersion`.
- Export invariants: render from the document model (never screenshot the
  preview); respect per-preset caps (≤ 64MP total, ≤ 16384px long edge);
  strip EXIF/GPS by default; the current export baseline is SDR-only until a
  later ADR explicitly changes it (ADR 0007–0009, 0018).

## Environment Notes

See `docs/guides/dev-environment.md` for setup requirements and verified configurations.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical labels without overrides. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context layout. See `docs/agents/domain.md`.
