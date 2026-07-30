# AGENTS.md

Project development rules for contributors and coding agents working on PlogKit.

## Start here

Before editing, start with the [documentation ownership map](docs/README.md), then read the canonical documents for the affected areas.

## Architecture

PlogKit is a local-first React Native app built with Expo SDK 57, TypeScript strict mode, and Skia. Use the [versioned Expo documentation](https://docs.expo.dev/versions/v57.0.0/) for Expo APIs.

```text
.
├── src/
│   ├── app/       Expo Router routes and application composition
│   ├── core/      document model and platform-independent business rules
│   ├── features/  feature UI and interaction orchestration
│   ├── render/    document rendering shared by device and headless runtimes
│   ├── services/  persistence, import, export, settings, and platform integration
│   ├── ui/        shared UI primitives and theme
│   └── i18n/      localized copy and resources
├── e2e/           Maestro flows, fixtures, and platform-specific subflows
├── scripts/e2e/   E2E orchestration and device preparation
├── render-tests/  headless rendering integration and golden images
└── plugins/       Expo config plugins
```

The serializable document is the single source of truth. Rendering, persistence, undo, and export must consume it rather than parallel UI state.

`src/core/` must not import React or React Native. Shared rendering code must not depend on device-only APIs.

Transient interaction state may remain outside the document while an interaction is in progress, but the final result must be written back to the document model.

## Development workflow

- Read the relevant canonical docs, implementation, and tests before editing.
- Update the affected spec before changing user-visible behavior.
- Create a new ADR for architectural or long-term engineering governance decisions that meet the [ADR criteria](docs/adr/README.md).
- Keep the change scoped to the current request and define its verification seam.
- Do not weaken contracts, specs, or tests merely to make a change pass. Use TDD for `src/core/`. Every bug fix needs a regression test that fails without the fix.
- Update affected canonical docs and generated artifacts with the code.
- Read and follow the [testing strategy](docs/guides/testing-strategy.md) to choose the appropriate verification. Run `pnpm verify` before committing.
- Review any resulting diff against the original request, affected specs, and project standards.
- If the task requires commits, use an appropriate branch, split the work into coherent commits, and write Conventional Commit messages in English.
- Report the changes, verification performed, and any remaining risks or decisions to the user.

## Development standards

- Do not add speculative abstractions, compatibility layers, fallback branches, feature flags, or generalized machinery unless the current request or a documented contract requires them.
- Follow established project patterns. Before deviating materially from an established pattern, explain the tradeoff and obtain maintainer approval.
- Do not introduce dependencies, especially native dependencies, without explicit maintainer approval.
- Follow [ADR 0002](docs/adr/0002-expo-foundation.md): do not hand-edit generated `ios/` or `android/` directories. Change Expo app config or config plugins, then run `pnpm prebuild`.
- Changes to an established persistent data schema require a version bump and migration. Any exception that intentionally discards existing data requires a new ADR.
- For UI changes, follow the [design system](docs/guides/design-system.md). Every interactive element needs a stable `testID`, a localized `accessibilityLabel`, and the appropriate accessibility role and state.
- Check the canonical [product scope](docs/product/product-scope.md) before changing product boundaries or adding network behavior.
- `docs/` is authoritative in Chinese. Code, comments, commit messages, and this file use English. Keep `README.md` and `README.zh-Hans.md` semantically aligned. App copy belongs in the i18n layer.
- Never commit secrets, signing assets, or large binaries. Golden PNGs are allowed.
- When adding embedded assets, follow [ADR 0015](docs/adr/0015-license-gpl3-cla.md): fonts require OFL; icons and other assets require MIT, Apache-2.0, or CC-BY; GPL, AGPL, and non-commercial assets are prohibited.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
