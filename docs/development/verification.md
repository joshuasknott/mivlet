# Verification

Choose checks by the final diff. Documentation-only edits need link/command validation and `git diff --check`; they do not require compiling every application. Implementation changes need the relevant package tests, types, build, and any affected security or quality gates. Run the broad gate for cross-package work and release readiness, or when explicitly requested.

Keep each pull request focused on one behavior or cleanup, with its reason and
actual validation results. Use a separate branch and worktree per concurrent
change; agree ownership before editing shared protocol, runtime, or lockfiles.
Open draft pull requests early to expose overlap, and merge prerequisite changes
before dependent ones. Update affected documentation in the same pull request;
delete superseded instructions and obsolete tests with the behavior they describe.
Retain tests for observable behavior, authorization, persistence, and regressions.

Runtime calls live in `apps/desktop/src/runtime/domains/`; import their owning
domain directly. Provider setup and model discovery belong to
`hooks/shell-runtime/useProviderConnections.ts`. Keep account transitions,
snapshot persistence and execution ownership explicit when separating shell code.

`useAccountWorkspace` owns account requests and scope transitions;
`useWorkspaceSnapshot` owns hydration and identity-bound snapshot writes;
`useWorkspaceApprovals` owns the queue, audit and decision bridge.
`shell/TeammateWorkspace.tsx` remains the public shell entry (account, theme,
and onboarding). `shell/ActiveWorkspace.tsx` owns live workspace composition
and `WorkspaceExecution` service wiring. Conversation chrome, the context
panel, and overlay dialogs live beside it; `workspace-presentation.ts` owns
indicator, preview, and new-action parity. Lazy route islands stay in
`workspace-lazy.tsx`. `shell/useWorkspaceNavigation.ts` owns view restoration
and navigation, while `WorkspaceExecution` retains execution ownership. Native-agent regressions are
split into context, persistence, recovery, cancellation and provider suites;
their shared `native-agent-test-harness.ts` supplies deterministic native transport.
The hook implementation lives in `hooks/native-agent/` behind the stable
`hooks/useNativeAgent.ts` facade (`useNativeAgent`, `NativeAgentState`,
`UseNativeAgentOptions`, `NativeAgentRunControl`).

Generated logs, screenshots, reports and build comparisons belong under the
ignored `output/` directory or the system temporary directory, not the repository
root. They can be regenerated. Do not put the only copy of source changes or
recovery bundles there. Dead-code checks include test entry points, so trace
production callers before retaining or deleting a module used only by tests.

CI runs on pull requests to `main`, or manually. New revisions cancel older runs
of the same pull request. There is no duplicate full run on pushes to `main`.
The required `check` job aggregates affected jobs and fails if any required job
fails, is cancelled, or unexpectedly skips. Documentation-only PRs skip compilation.

TypeScript changes run types, quality and package tests on Linux. Rust/Tauri,
embedded host, protocol/connectors, dependency, release and workflow changes also
run Windows host acceptance, Rust tests, Clippy and formatting with Cargo caching.
The Windows Bun dependency is optional on other operating systems; Windows host
builds still fail if it is absent. Linux daily loops use `pnpm test:pr`. Host
executable tests remain `pnpm test:host` on Windows. These tests never substitute a Linux host.

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
| Repository types and tests | `pnpm typecheck`, `pnpm test:pr` (Linux PR package tests; excludes `@mivlet/agent-host`), `pnpm test` (full workspace, including host; fixture tests skip unless Windows + bundled executable) |
| Linux PR loop (matches CI) | `pnpm check:pr` |
| Linux package tests without agent-host | `pnpm test:pr` (`test:ci` is an alias) |
| Code quality | `pnpm quality` (`lint` is security-subset ESLint via `lint:security` plus the explicit-any ratchet, not typed/React lint; `format:check` is an allowlisted ratchet, not repository-wide Prettier) |
| Linux PR job | `pnpm check:pr` (`typecheck` + `quality` + `test:pr`) |
| Mock Clerk deploy guard | `node scripts/ci/refuse-mock-clerk.mjs` (required CI `changes` step; refuses `MIVLET_CLERK_ALLOW_MOCK=1` + mock issuer on production/non-local configs) |
| Production build validation | `pnpm verify:build` (includes hosted-runner `tsc` emit) |
| Performance budgets | `pnpm perf:check`, `pnpm perf:test`, `pnpm perf:runtime` |
| Release manifest | `pnpm release:test` |
| Rust compile | `pnpm tauri:check` |
| Embedded Windows agent host | `pnpm test:host` (also `pnpm --filter @mivlet/agent-host typecheck` / `build`) |
| Hosted runner | `pnpm --filter @mivlet/hosted-runner test`, `pnpm --filter @mivlet/hosted-runner build`, `pnpm --filter @mivlet/hosted-runner worker:deploy:dry-run` |
| Full repository gate | `pnpm check` |

The PDF viewer is an optional island. Performance accounting includes its
`.mjs` worker and applies separate ceilings to ordinary workspace code and
PDF code, as well as the total. The Vite manifest must place both viewer and
renderer outside every static startup dependency; worker assets cannot appear
on that graph. The October allowance records the measured pre-PDF `main`
baseline and preserves the original baseline for comparison. Font and character
map assets are packaged locally and loaded as needed; they are not JS/CSS.

`pnpm test` still runs every workspace test, including `@mivlet/agent-host`. Host
fixture tests skip unless they are on Windows with the bundled executable present,
so the chain no longer aborts on Linux.
`pnpm test:pr` matches PR CI, which excludes that package entirely.
`pnpm check:pr` is the Linux TypeScript job (`typecheck`, `quality`, `test:pr`).
`pnpm check` / `verify:build` compile the Windows Bun host even on Linux.
Changing root `package.json` is a native path and schedules the 35-minute
Windows job.

For Rust changes, use the affected tests plus:

`cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`

`cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

UI changes need browser/native inspection of affected flows and relevant viewport sizes. Packaging, native Windows control, authentication, deployment, and live smoke tests are separate evidence. Wrangler dry-runs establish packaging and bindings only. Report skipped checks and missing prerequisites without describing them as passes.

Claude SDK initialization has a separate opt-in check:
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_claude_sdk_initialization_acceptance -- --ignored --nocapture`.
Set `MIVLET_CLAUDE_SDK_ACCEPTANCE_EXE` to an independently verified official
executable and `MIVLET_CLAUDE_SDK_ACCEPTANCE_SHA256` to its release SHA256.
The check clears inherited credentials, creates a disposable profile, requires
signed-out status, sends only SDK/MCP initialization, and closes the supervised
process. It sends no user prompt and verifies no paid model execution. Windows
CLI 2.1.289 passed on October 4 after its official release checksum and Anthropic
Authenticode signature were independently verified. This is startup evidence;
authenticated shared tool calls, images and packaged account acceptance remain
separate checks.

Use `pnpm tauri:dev` for interactive desktop work. Its launcher owns the Vite
server so account-driven native restarts cannot tear down the UI server. The
server stays available after the native process exits; stop the development
session with Ctrl+C when finished. A debug executable launched alone still
requires that development server.

`verify:build` builds the embedded host before the test gate runs its actual
Windows executable. That compile runs on Linux as part of `pnpm check`; it is
not a substitute for `pnpm test:host` on Windows. The fixture tests use the
same cleared environment and stdio framing as native custody, with
deterministic OpenAI-compatible,
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

The conversation upgrade is a separately measured deferred graph. `vite.config.ts`
keeps assistant-ui, OpenUI, MCP Apps, conversation rendering, output preview and
history chunks behind the lazy conversation boundary, and `cssCodeSplit` keeps its
ConversationPane and WorkspaceHistory styles out of the base stylesheet. The perf
summary reports that graph under `conversationUpgrade` and subtracts it from
`commonJsCss`; the existing common and initial-entry ceilings therefore remain
unchanged. The initial 2026-10-08 feature measurement was 672,598 raw / 202,723
gzip, with caps of 688,982 raw / 210,915 gzip. Final integration measured 688,961
raw / 208,523 gzip after deferring the CSV parser, grid and styles until a CSV
output opens, and loading browser branch helpers only when history is requested.
Base CSS measured 175,633 raw, common JS/CSS 1,200,763 raw /
342,977 gzip, and the startup entry 435,683 raw. The original common and feature
ceilings were retained; both raw limits have very little remaining headroom. The manifest check rejects any
feature chunk that becomes reachable through the entry's static imports. PDF assets
remain independently classified and capped.

Inspect the actual application entry point when verifying UI. Use the native app
for account-owned storage, conversation navigation, provider setup, approvals and
computer control; the browser entry is a runtime-limited rendering of that same
application. There is no separate design-preview shell to maintain.

Cover relevant desktop and narrow layouts, focus/keyboard behavior, loading and
error states. Avatar and voice state regressions remain in their focused component
tests; speaking must come from confirmed audio playback, and reduced motion must
retain static expressions. Conversation tests cover ordered durable segments,
call/result pairing, redaction, scrolling and safe Markdown. Native tests cover
bounded previews, public-summary persistence and external link schemes.

## Conversational UI acceptance

Use a separate harmless test conversation with an existing connected provider.
Do not bypass onboarding or insert synthetic successful provider results into
the native store. Browser/component fixtures and SDK protocol examples are
separate evidence from a signed-in native/provider run.

| Journey | Acceptance evidence |
| --- | --- |
| Generated response | Ask the provider for an OpenUI comparison, clarification form, table and plan. Change an answer, review it in the composer, restart, and verify the saved answer/source without another model call. Exercise incomplete/invalid output and Stop. |
| Branches | Edit an earlier user turn, regenerate an alternative, switch back, then restart. Original IDs/attribution and completed external-effect records must remain; switching must not invoke a provider or replay tools. |
| Outputs | Open beside chat, save a direct edit, request a targeted agent revision, compare/restore, reopen, and export. A stale revision response must conflict rather than overwrite a newer edit. |
| Context | Inspect the draft retrieval, exclude a source/memory/history, then compare the admitted native capture and actual request receipt. A sibling private conversation must never appear. |
| MCP Apps | The SDK 1.7.5 lifecycle peer covers initialize, host messages, approval-gated tool calls and teardown. The unmodified official quickstart was discovered and rendered through the signed-in Windows production host, including denial, approval, docking and close/reopen without tool replay. A separate controlled native probe verified parent DOM, storage and navigation isolation. Read-only IPC response probes timed out; the pinned Wry/Tauri source establishes remote ACL rejection, which is distinct from a live response observation. |
| Coordination | Follow owner and handoff context through approval, Stop and restart. Recovery must describe uncertain effects and require explicit continuation. |

Inspect wide and narrow native windows, a large table, open output, long response
and pending approval. Check keyboard actions, labels, focus, scrolling and reduced
motion. Save screenshots under `output/`; record any unavailable provider/app or
authentication prerequisite without presenting fixture evidence as live success.

The October 8 local acceptance run used the ordinary signed-in Windows app,
its encrypted account store, and an existing GPT-6-Luna provider connection in
a separate harmless Side Chat. It did not bypass onboarding or seed successful
responses. The provider generated the OpenUI comparison, required clarification,
table, chart, checklist and draft. Selecting Tea and entering “Afternoon reading”
staged a reviewable reply; restarting restored both values without a model call.
Editing and regenerating the original prompt preserved three alternatives, which
remained switchable after restart. A pinned Markdown output was edited directly,
revised by that provider, compared and restored as a new fourth revision. Native
Save As exported the fourth revision with matching file contents; Files reopened
that revision after restart with the immutable earlier revisions intact.

The same run inspected native context snapshots: excluding history produced zero
messages and a provider answer saying the earlier discussion was unavailable;
including history produced four canonical message texts and the provider correctly
recovered the earlier drinks and recommendation. The native context reader and
summary-cache regression tests also cover the production string-shaped message
envelope, legacy object envelopes, and selected-branch isolation. Screenshots and
the harmless export are under the ignored `output/conversation-upgrade/` directory.
These are native development/provider observations, not installer or hosted
deployment evidence. MCP sandbox acceptance and final gates are recorded
separately below rather than inferred from these results.

The same native run exercised interruption recovery for the harmless official
`get-time` example. Restart retained the interrupted attempt; continuation stayed
disabled until its effects were explicitly reviewed, and then created a fresh
attempt. No previous tool action was replayed. The narrow 753-pixel window kept
the approval details readable and Stop accessible. A notification positioning
defect that covered Stop in that layout was corrected and inspected again.

A further live run delegated one harmless sentence from Chief of Staff to
Acceptance Reviewer. The reviewer completed its own assignment and the parent
resumed; Activity grouped both owners and retained the exact shared assignment.
Stop at the parent's pending `get-time` approval removed that proposal and
cancelled the effort. Restart retained the reviewer result and cancelled effort
without a provider call or tool replay. This run caught two production issues:
children previously received the root prompt instead of their scoped assignment,
and stale branch-head snapshots accumulated false alternatives. Both fixes have
focused regressions. A deliberate `user-stop` notice now renders as Cancelled;
missing terminal results and unexpected restart notices remain Interrupted.

The provider also generated a 30-row, six-column OpenUI table. Its multiline
literal arrays exposed a validator defect; the bounded parser now accepts those
arrays and canonicalizes a sole unambiguous display component to `root`. Invalid
or incomplete interfaces retain readable source and actionable recovery text.
The saved response rendered after the fix without another provider call. Native
filtering found three Herbal tea rows and numeric Minutes sorting ordered them
19, 23, 25. Large tables use a bounded keyboard-focusable scrolling region and
sticky headers; they do not widen the conversation or hide the composer.

Office package regressions cover plain paragraph/cell edits, immutable revisions,
formula and unrelated-entry preservation, stale edits, owner/agent assignment and
selection references. These native tests do not establish a live provider-created
Office document journey. Keep that evidence distinct from the Markdown output
journey above.

The final October 9 automated integration run (`final-full-check-v33.log` under
the ignored evidence directory) passed `pnpm check`: quality/dead-code/cycle
checks, production builds, 1,420 desktop tests, 500 connector tests, 342 knowledge
tests, 135 broker tests, 83 hosted-runner tests, 21 account tests, the Windows
embedded-host fixtures (56 passed, 3 platform/capability skips), CI/release tests,
bundle/runtime budgets, native checking and dependency audits. The separate
native pass recorded 906 passed and 16 explicitly ignored opt-in tests, plus
`cargo fmt --check` and all-target/all-feature Clippy with warnings denied.
Two pnpm advisories are source-verified local patches; Cargo reports two reviewed
notification-only quick-xml findings expiring October 31 and nine informational
maintenance/unsoundness warnings. These accepted findings remain visible.

The image-led refinement retains the catalogue's real data and established app
assets. Its final native visual comparison is tracked in `design-qa.md`. Neither
that comparison nor native MCP iframe acceptance is inferred from the automated
gate. Native docking retained the original official timestamp; app approvals
followed the exact owner into the visible drawer. A controlled sandbox probe
could not read the parent DOM or local storage and could not navigate to the
renderer through either host requests or direct frame navigation. Its two
read-only native IPC calls timed out, so they remain inconclusive. Pinned
Wry/Tauri source review independently established the remote ACL dispatch
boundary; see `docs/architecture/mcp-apps.md` for that evidence and supported
capabilities. The unmodified official resource was restored after the probe.

The existing Gmail connection did not advertise an MCP App resource. It is
therefore evidence for ordinary connector fallback, not third-party MCP App
interoperability. Windows is the supported interactive host; nested app frames,
external navigation, sampling and ungranted browser permissions fail closed.
Changing an MCP action requires denial and a fresh proposal because native
modification of that proposal is not supported. Office package regression
coverage and the live Markdown journey remain distinct. No signed installer,
hosted deployment or additional provider route acceptance is implied.
