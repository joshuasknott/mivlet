# Verification

Choose checks by the final diff. Documentation-only edits need link/command validation and `git diff --check`; they do not require compiling every application. Implementation changes need the relevant package tests, types, build, and any affected security or quality gates. Run the broad gate for cross-package work and release readiness, or when explicitly requested.

| Scope | Commands |
| --- | --- |
| Repository types and tests | `pnpm typecheck`, `pnpm test` |
| Code quality | `pnpm quality` |
| Production build validation | `pnpm verify:build` |
| Performance budgets | `pnpm perf:check`, `pnpm perf:test`, `pnpm perf:runtime` |
| Release manifest | `pnpm release:test` |
| Rust compile | `pnpm tauri:check` |
| Hosted runner | `pnpm --filter @fable/hosted-runner test`, `pnpm --filter @fable/hosted-runner build` |
| Full repository gate | `pnpm check` |

For Rust changes, use the affected tests plus:

`cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`

`cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

UI changes need browser/native inspection of affected flows and relevant viewport sizes. Packaging, Docker availability, authentication, deployment, and live smoke tests are separate evidence. Wrangler dry-runs establish packaging and bindings only. Report skipped checks and missing prerequisites without describing them as passes.

The development-only `design-preview.html` exercises the production conversation
components with labelled sample data: streaming, completion, reasoning disclosure,
failure and stop/continue. Select a fixture with `?conversation=stream`,
`?conversation=stopped` or `?conversation=failure`; the default is completed.
Fixture controls stay out of the conversation. It does not call a provider or establish live acceptance.
Conversation regressions cover ordered durable segments, call/result pairing,
redaction, scroll following, safe Markdown and preview scope changes. Native
tests cover bounded previews, public-summary persistence and external link schemes.

The September 2026 conversation pass replaces the initial 157 KB Markdown stack
with the 43 KB Marked lexer and renders its tokens as React elements. The measured
desktop bundle is about 1.014 MiB raw / 291 KiB gzip. The total gzip allowance adds
20 KiB for the lexer, conversation UI and verified artifact preview; all raw,
entry, CSS and existing route ceilings remain unchanged. Keep these additions
accountable to the existing budget checks rather than silently widening every gate.
