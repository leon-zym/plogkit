# AGENTS.md

Project rules for coding agents working on PlogKit.

## Sources of truth

- Start at the [documentation ownership map](docs/README.md). Read and update
  only the owners relevant to the task.
- `docs/` is authoritative in Chinese. Code, comments, commit messages, and this
  file use English.
- [`docs/specs/`](docs/specs/) owns user-visible behavior and delivery status.
  Update the affected spec before changing behavior.
- [`docs/adr/`](docs/adr/) owns durable architecture and engineering decisions.
  Add a new ADR for a decision change; never rewrite an accepted decision.
- [`docs/product/product-scope.md`](docs/product/product-scope.md) owns current
  scope and product boundaries.
- [`docs/guides/`](docs/guides/) owns current development, testing, and design
  procedures. [`CONTEXT.md`](CONTEXT.md) owns domain terminology.
- Keep `README.md` and `README.zh-Hans.md` semantically aligned whenever either
  changes. App copy belongs in the zh/en i18n layer.
- Long-lived docs contain current contracts, not issue history, review reports,
  diagnostics, or implementation logs.

## Architecture

PlogKit is a local-first React Native app built with Expo SDK 57, TypeScript
strict mode, Skia, Zustand, and Reanimated. Use the
[versioned Expo documentation](https://docs.expo.dev/versions/v57.0.0/) for
Expo APIs.

- `src/core/`: pure TypeScript document model, migrations, layout math, undo,
  and export policy. Do not import React or React Native.
- `src/render/`: document-to-Skia rendering shared by devices and Node
  CanvasKit. Do not use device-only APIs.
- `src/features/`: editor UI and gestures. Transient gesture state may use
  Reanimated; commit document changes when the gesture ends.
- `src/services/`: drafts, imported assets, current-session persistence, and
  export orchestration.
- `src/app/`: Expo Router routes.
- `e2e/flows/`: cross-platform Maestro business flows.
- `e2e/subflows/`: shared steps and narrow platform adapters.

The serializable document is the single source of truth. Render, persistence,
undo, and export must consume that model rather than parallel UI state.

## Change workflow

- Use TDD for `src/core/`. Bug fixes need a regression test that fails without
  the fix.
- ADR metadata and `docs/adr/README.md` must change together. Predecessor and
  successor links are bidirectional.
- Released document schema changes require a version bump and migration. A
  pre-release reset may omit migration only when an ADR authorizes discarding
  unpublished data. Catalog schema changes also bump `catalogSchemaVersion`.
- Do not introduce dependencies, especially native dependencies, without
  explicit maintainer approval.
- Do not hand-edit generated `ios/` or `android/` directories. Change Expo app
  config or config plugins, then run `pnpm expo prebuild --clean`.
- Keep implementations typed and direct. Do not add `any`, speculative
  abstractions, compatibility layers, or feature flags.
- Every interactive element needs a `testID` and an accessibility label.
- Use Conventional Commits in English. Run `pnpm verify` before committing.
  Changes go through a branch and non-draft PR with green CI.
- After opening or updating a non-draft PR, schedule a follow-up in about ten
  minutes when the agent environment supports scheduling or wake-ups. Do not
  wait synchronously for CI.
- Each follow-up checks every required job on the latest head and all new or
  unresolved review threads. Fix valid findings and resolve their threads. If
  you disagree, reply in the original thread with the specific reason.
- Repeat the follow-up after every push. Stop when required checks pass and no
  review feedback remains. Report external blockers or repeated identical
  failures instead of looping without progress. Do not merge unless requested.

## Verification

- `pnpm check`: TypeScript and lint.
- `pnpm test`: unit and component tests.
- `pnpm test:render`: headless Skia goldens.
- `pnpm verify`: required pre-commit suite.
- `pnpm e2e:ios`, `pnpm e2e:android`, or `pnpm e2e`: device acceptance.

Run the affected platform's full E2E suite for system-UI or platform-specific
changes. Run both platforms for native configuration, persistence, export, or a
critical cross-platform flow.

Do not hide unexplained E2E failures with retries, sleeps, or longer timeouts.
Rerun the failing flow unchanged before diagnosing it. Inspect rendered output
and diffs before updating a golden. Dispose every headless Skia surface and
image.

See the [testing strategy](docs/guides/testing-strategy.md) for test ownership,
CI gates, and device assertions.

## Hard boundaries

- Follow the canonical [product scope](docs/product/product-scope.md). Do not
  add excluded behavior such as cloud sync, accounts, telemetry, AI generation,
  filters, or beauty editing without an explicit scope decision.
- Do not add network calls. The app is local-first.
- Never commit secrets, signing assets, or large binaries. Golden PNGs are
  allowed.
- Embedded fonts must use OFL. Icons and other embedded assets must use
  MIT, Apache-2.0, or CC-BY. Do not embed GPL, AGPL, or non-commercial assets.
  App code is GPL-3.0-only.
- Export from the document model, not a preview screenshot. Keep preset limits
  at or below 64 MP and 16384 px on the long edge, strip EXIF/GPS by default,
  and keep export SDR-only until a later ADR changes the baseline.

## Operational references

- [Development environment](docs/guides/dev-environment.md)
- [Issue tracker](docs/agents/issue-tracker.md)
- [Triage labels](docs/agents/triage-labels.md)
- [Domain documentation](docs/agents/domain.md)
