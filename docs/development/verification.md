# Verification

Choose checks by the final diff. Documentation-only edits need link/command validation and `git diff --check`; they do not require compiling every application. Implementation changes need the relevant package tests, types, build, and any affected security or quality gates. Run the broad gate for cross-package work and release readiness, or when explicitly requested.

Keep each pull request focused on one behavior or cleanup, with its reason and
actual validation results. Use a separate branch and worktree per concurrent
change; agree ownership before editing shared protocol, runtime, or lockfiles.
Open draft pull requests early to expose overlap, and merge prerequisite changes
before dependent ones. Update affected documentation in the same pull request;
delete superseded instructions and obsolete tests with the behavior they describe.
Retain tests for observable behavior, authorization, persistence, and regressions.

CI runs on pull requests to `main`, or manually. New revisions cancel older runs
of the same pull request. There is no duplicate full run on pushes to `main`.
The required `check` job aggregates affected jobs and fails if any required job
fails, is cancelled, or unexpectedly skips. Documentation-only PRs skip compilation.

TypeScript changes run types, quality and package tests on Linux. Rust/Tauri,
embedded host, protocol/connectors, dependency, release and workflow changes also
run Windows host acceptance, Rust tests, Clippy and formatting with Cargo caching.
The Windows Bun dependency is optional on other operating systems; Windows host
builds still fail if it is absent. These tests never substitute a Linux host.

Full validation (`pnpm check`, Rust tests, Clippy and formatting) runs manually or
nightly at 03:17 UTC. Installer generation remains manual in the Windows
preview artifact workflow. Its artifacts are accessible to repository readers;
the channel label does not make an artifact private. Cargo and cargo-audit are cached.

While editing a renderer, run desktop typecheck and focused tests; for a package,
run its build and tests. Run native checks for native changes. Use `pnpm check`
for release candidates and broad integration work, not every intermediate edit.
Require the aggregate CI check before merging and rerun affected checks after conflicts.

| Scope | Commands |
| --- | --- |
| Repository types and tests | `pnpm typecheck`, `pnpm test` |
| Code quality | `pnpm quality` |
| Production build validation | `pnpm verify:build` |
| Performance budgets | `pnpm perf:check`, `pnpm perf:test`, `pnpm perf:runtime` |
| Release manifest | `pnpm release:test` |
| Rust compile | `pnpm tauri:check` |
| Embedded Windows agent host | `pnpm --filter @fable/agent-host typecheck`, `pnpm --filter @fable/agent-host build`, `pnpm --filter @fable/agent-host test` |
| Hosted runner | `pnpm --filter @fable/hosted-runner test`, `pnpm --filter @fable/hosted-runner build` |
| Full repository gate | `pnpm check` |

For Rust changes, use the affected tests plus:

`cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`

`cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

UI changes need browser/native inspection of affected flows and relevant viewport sizes. Packaging, native Windows control, authentication, deployment, and live smoke tests are separate evidence. Wrangler dry-runs establish packaging and bindings only. Report skipped checks and missing prerequisites without describing them as passes.

`verify:build` builds the embedded host before the test gate runs its actual
Windows executable. The fixture tests use the same cleared environment and
stdio framing as native custody, with deterministic OpenAI-compatible,
DeepSeek and Anthropic SSE. They verify tool results, denial, ordering, Stop,
replay rejection, provider failures and absence of plaintext prompt/tool
canaries on disk. These tests do not establish live provider or signed-installer
acceptance. Native computer authority and screenshot hydration retain their
existing Rust tests.

Production builds prune unused Phosphor icon weights with `apps/desktop/scripts/icon-weights.ts`.
It reads the desktop and shared package sources, keeps the original SVG artwork,
and retains all variants for indirect uses or unknown props. Context, re-exports,
and dynamic icon imports disable pruning. Package-format changes keep the original
definitions; the bundle gate still checks the resulting size. The desktop suite
tests the analysis and retained artwork against the installed icon package.

The development-only `design-preview.html` exercises the production conversation
components with labelled sample data: streaming, completion, reasoning disclosure,
failure and stop/continue. Select a fixture with `?conversation=stream`,
`?conversation=stopped` or `?conversation=failure`; the default is completed.
`?conversation=context` shows the context-budget diagnostics and continuation action.
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
