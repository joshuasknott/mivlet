# Verification

Choose checks by the final diff. Documentation-only edits need link/command validation and `git diff --check`; they do not require compiling every application. Implementation changes need the relevant package tests, types, build, and any affected security or quality gates. Run the broad gate for cross-package work and release readiness, or when explicitly requested.

Keep each pull request focused on one behavior or cleanup, with its reason and
actual validation results. Use a separate branch and worktree per concurrent
change; agree ownership before editing shared protocol, runtime, or lockfiles.
Open draft pull requests early to expose overlap, and merge prerequisite changes
before dependent ones. Update affected documentation in the same pull request;
delete superseded instructions and obsolete tests with the behavior they describe.
Retain tests for observable behavior, authorization, persistence, and regressions.

CI runs on pull requests to `main` and pushes to `main`. New revisions cancel
older runs of the same pull request. Local feature-branch pushes need a pull
request for CI; run focused checks locally before pushing. Require the CI check
before merging and rerun affected checks after resolving conflicts.

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

`?view=avatars` shows the eight production robot shells at 112, 32 and 18 px,
with state, colour and background controls. Test the editor at 390 px and desktop
widths. The sidebar stays still; the active conversation and picker allow gentle
motion. Reduced motion disables all avatar animations. A newly completed turn
settles after one brief expression; restored completion does not replay it.
Runtime presence uses approvals, execution status, confirmed dictation listening,
provider availability and relevant computer control. Speaking and explicit-input
expressions are previewable contracts only until those runtime events exist;
text streaming and question marks must never stand in for them.
Conversation regressions cover ordered durable segments, call/result pairing,
redaction, scroll following, safe Markdown and preview scope changes. Native
tests cover bounded previews, public-summary persistence and external link schemes.
