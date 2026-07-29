# AGENTS.md

Project development rules for contributors and coding agents working on
PlogKit.

## Start here

Start with the [documentation ownership map](docs/README.md), then read the
owners relevant to the task. Update canonical documentation with the change
instead of maintaining the same fact in multiple files.

## Architecture

PlogKit is a local-first React Native app built with Expo SDK 57, TypeScript
strict mode, and Skia. Use the
[versioned Expo documentation](https://docs.expo.dev/versions/v57.0.0/) for
Expo APIs.

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

The serializable document is the single source of truth. Render, persistence,
undo, and export must consume that model rather than parallel UI state.
`src/core/` must not import React or React Native. Shared rendering code must
not depend on device-only APIs. Transient interaction state may stay outside the
document while an interaction is active, but the completed change must commit
to the document model.

## Development workflow

- Read the relevant docs, implementation, and tests before editing. Update the
  affected spec before changing user-visible behavior. Record a durable
  decision in a new ADR before implementing it; never rewrite an accepted ADR.
- Define the smallest coherent change and its verification seam. Use TDD for
  `src/core/`. Every bug fix needs a regression test that fails without the fix.
- Implement the direct, typed solution. Run affected tests regularly and
  `pnpm check` when broader static feedback is useful.
- Update canonical docs and generated artifacts that changed with the code.
- Follow the [testing strategy](docs/guides/testing-strategy.md) to choose
  additional render or device verification. Run `pnpm verify` before
  committing.
- Review the final diff against the original request, affected specs, and
  project standards. Then commit with a Conventional Commit message in English.
  Work on a branch and open a non-draft PR when the change is ready for review.

## Development standards

- Prefer the smallest implementation that fully satisfies the current
  contract. Do not add `any`, speculative abstractions, or generalized
  machinery for hypothetical requirements.
- Do not add speculative compatibility layers, fallback branches for
  hypothetical states, or feature flags unless the user requests them or a
  documented compatibility or recovery contract requires them.
- Prefer mature best practices supported by the current stack. Before departing
  from an established project pattern, explain the benefit and ask the
  maintainer.
- Comment non-obvious invariants, tradeoffs, and failure handling. Do not
  narrate straightforward code.
- Do not introduce dependencies, especially native dependencies, without
  explicit maintainer approval.
- Do not hand-edit generated `ios/` or `android/` directories. Change Expo app
  config or config plugins, then run `pnpm prebuild`.
- Released document schema changes require a version bump and migration. A
  pre-release reset may omit migration only when an ADR authorizes discarding
  unpublished data. Catalog schema changes also bump `catalogSchemaVersion`.
- Every interactive element needs a `testID`, a localized accessibility label,
  and the appropriate accessibility state.
- Check the canonical [product scope](docs/product/product-scope.md) before
  changing product boundaries or adding network behavior.
- `docs/` is authoritative in Chinese. Code, comments, commit messages, and this
  file use English. Keep `README.md` and `README.zh-Hans.md` semantically
  aligned. App copy belongs in the i18n layer.
- Never commit secrets, signing assets, or large binaries. Golden PNGs are
  allowed.
- Embedded fonts must use OFL. Icons and other embedded assets must use
  MIT, Apache-2.0, or CC-BY. Do not embed GPL, AGPL, or non-commercial assets.
  App code is GPL-3.0-only.

## Verification

Use the [testing strategy](docs/guides/testing-strategy.md) for test ownership,
commands, CI gates, E2E scope, and failure handling. `pnpm verify` is the
required pre-commit suite.

## Pull requests

- Pushing commits and opening a non-draft PR starts the review cycle; it does
  not complete the task. Report the submitted PR to the user, create a scheduled
  follow-up for an interval appropriate to the expected CI and review latency,
  then end the active run instead of waiting synchronously.
- When the follow-up starts, remove the existing schedule if it remains
  configured. Inspect merge conflicts, every required check on the latest head,
  and all new or unresolved review threads.
- Fix valid findings, rerun the required verification, push the follow-up
  commit, and resolve threads whose concerns are addressed.
- If a review comment is not valid, reply in the PR's main conversation with a
  link to or quotation from the original comment and a specific explanation.
  Do not place the disagreement reply inside the review thread; resolve that
  thread after posting the explanation.
- Report each follow-up result to the user. If checks or review are still
  pending, create a new follow-up before ending the run. After every new push,
  repeat the same cycle against the new head.
- The task is complete only when the PR has no merge conflict, all required
  checks pass on the latest head, and no new or unresolved review feedback
  remains. Remove any remaining follow-up schedule, send the final report, and
  stop. Report external blockers or repeated identical failures instead of
  looping. Do not merge unless requested.

If scheduled follow-ups or task wake-ups are unavailable, keep the task active
and monitor the PR with a background polling command. If background polling is
also unavailable or unsuitable, report the limitation and ask the user to
trigger the next check later. Do not claim completion while the PR is pending.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
