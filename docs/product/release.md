# Release Readiness

Last updated: 2026-07-27.

> **Release policy:** Fable is not authorised for public release. The agreed product requires a hosted, Clerk-backed Fable account and one connected provider. One Clerk + Convex development account and the local Codex path are now live-validated on one Windows machine, but production configuration, recovery, multi-account collaboration, packaging, and external connectors remain release gates.

## Runnable paths

Local setup and checks use pnpm:

```bash
pnpm install
pnpm dev
pnpm tauri:dev
pnpm typecheck
pnpm test
pnpm build
pnpm tauri:check
pnpm check
```

`pnpm tauri:dev` loads optional desktop development configuration from the
ignored `apps/desktop/.env.local` file before launching Tauri. Keep Clerk,
Convex, and debugging values there or in secure storage; never commit them.

Windows desktop bundles use:

```bash
pnpm tauri:build
```

The `Windows private artifacts` workflow is manual-dispatch only. It runs all
repository and native checks, builds MSI and NSIS with `--no-sign`, exercises
the NSIS clean-install/repair/uninstall lifecycle on its disposable runner, and
uploads a 14-day validation artifact. It does not create a GitHub release,
publish an updater, or use signing material. See
[`docs/operations/windows-private-release.md`](../operations/windows-private-release.md).

Expected local Windows build outputs:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`

The current desktop runtime contains local-first encrypted storage and a
config-gated Clerk identity boundary. The target product requires hosted Fable
sign-in before normal use; completing that gate, workspace membership, and
account recovery is a release prerequisite. Provider keys remain separate from
Fable identity and are handed to the Rust credential boundary rather than
stored in React state, snapshots, logs, or JSON metadata.

## Gated paths

- Confidential OAuth connectors (GitHub, Vercel, Notion, Slack, and Linear)
  require a deployed Fable auth broker plus provider-console callback
  registration. The repository contains encrypted, atomic, one-time Durable
  Object SQLite storage plus declared staging/production bindings and migration
  metadata. Provisioning its encryption key, applying and reviewing the live
  Durable Object migration, deploying the Worker, and validating registered
  callbacks remain release blockers. Memory storage is local-development only.
- Google connectors are independent desktop public clients. They require
  `FABLE_GOOGLE_OAUTH_CLIENT_ID`, enabled Google APIs, consent configuration,
  test users while unpublished, and any verification required by Google.
- Codex runs through the local `codex app-server` process. One authenticated
  Codex CLI completed a harmless streamed prompt and a no-tools scheduled run
  during the 2026-07-27 development validation. Cursor, GitHub Copilot, Grok
  Build, OpenCode, Kimi, and Mistral Vibe use their installed ACP runtimes and
  provider-owned sign-in; their execution paths were not validated in that run.
- Clerk + Convex now have a schema, policy tests, device/outbox foundations,
  and config-gated desktop commands. Real development sign-in, initial hosted
  workspace bootstrap, and restart persistence are validated for one account.
  Production configuration, recovery, device revocation, and the multi-person
  workspace journey remain incomplete release evidence.
  Verified-email invitation targeting additionally requires the Convex server
  environment variable `FABLE_INVITATION_RECIPIENT_HMAC_KEYRING`, encoded as
  `{"active":"v2","keys":{"v2":"<64 lowercase hex>","v1":"<64 lowercase hex>"}}`.
  Keep at most three 256-bit keys, retain the previous version during rotation,
  and never place this secret in the desktop environment or renderer bundle.
- Ollama runs only through an existing literal-loopback service. Fable does not
  install Ollama, download models, or store an Ollama credential.

## Known limits

- Encrypted SQLite is active in the production Tauri path and intercept-routes monolithic JSON documents (snapshot, memory, approvals) to the `preferences` table, while falling back to JSON for tests. Action history is stored in the encrypted SQLite `audit_event` table. Schedules, workflows, canonical private Routines and versions, trigger cursors, migration evidence, Knowledge, Memory, Missions, one-time Mission approval consumption, artifacts, Connections, and grants persist in `fable-vault.db` under schema v37. The v36/v37 steps repair the historical agent-run and dependent foreign-key names; their table rebuilds preserve existing rows, and the migration transaction refuses to commit when SQLite reports a foreign-key violation.
- Privacy settings can create and immediately verify a non-overwriting encrypted SQLite recovery backup. Raw backup restore requires the same OS-held vault key, is staged without replacing the live database, applies only at restart, preserves the prior database, and rolls back if the candidate cannot open or migrate. Provider and OAuth credentials are excluded and still require their own account recovery or reconnection. Portable workspace export is the separate credential-free cross-device path. Packaged installer/upgrade restore observation and any vault-key export or escrow decision remain release gates.
- Portable workspace export and import are available in Privacy settings as a plaintext JSON copy. Native code derives the active authenticated workspace, validates integrity and secret absence, writes atomically only to a new link-free `.json` destination, and never overwrites. Import requires an exact confirmation, rejects linked, non-JSON, oversized, invalid, newer-format, or credential-shaped archives, and applies inside one rollback-safe transaction under skip-existing conflict handling. Workspace content never enters renderer state. Exact-owner Project copies preserve Project, conversation, and message ownership plus conversation titles only for the same active private member and original internal creator; substituted, stripped, or cross-owner current authority fails closed and cannot transfer ownership. Ownerless legacy archives gain no private authority. Imported Connections, schedules, scheduled jobs, and active canonical Routines remain disabled or paused. Routine definitions, immutable versions, triggers, and occurrence history require the exact active owner/workspace/member; scheduler authority, leases, cursors, retries, and legacy-migration rollback evidence remain node-local and are excluded.
- Privacy settings also expose a secret-free local health report for storage, providers, Connections, MCP, Missions, Routines, queues, migrations, and sync. It returns only authenticated workspace-scoped states and counts from control columns and never includes content, paths, account identifiers, or credentials. Deployed monitoring and runtime-node telemetry remain open.
- Privacy settings can pause new execution for the active workspace. The encrypted, revisioned control blocks new native-provider, local-model, ACP, Codex, approved MCP tool, Schedule, and Routine starts, and pause/resume transitions enter secret-safe action history. It does not undo external effects already accepted or replace the owning runtime's in-flight cancellation path.
- Repository and Windows CI checks enforce the current desktop bundle, CSS, initial-entry, and lazy-route size budgets plus deterministic connector, Knowledge, encrypted-storage/cache, and scheduler-queue performance fixtures. The initial entry remains above Vite's 600 KiB advisory threshold and is an explicit optimization target. These checks are not evidence of packaged cold start, comparable RSS, live-provider streaming, or private long-run soak behavior.
- General Mission reviewer selection is native, owner-scoped, encrypted, replay-safe, and required before reviewer execution. Declared worker-evaluated criteria retain exact evaluator authority. The composer's explicit `review:` step instead records a Product Spine 1.8 `user-requested-advisory` selection with no criterion keys and no acceptance authority; reshaping it to claim human or worker authority fails closed. Native high-risk/conflicting-evidence policy composition, reviewer-provider validation, and packaged/live-provider observation remain release gates.
- General Mission plan and progress cards are native-derived and reopen-safe. They expose readable goals, outcomes, step objectives, dependency counts, budgets, usage, and acceptance without exposing internal authority or provider identifiers; packaged live-provider observation remains a release gate.
- Schedules persist locally and the Tauri runtime leases due occurrences, queues workflow runs, and executes scheduled prompts through the same provider-neutral `AgentBackend` path as the composer. Execution still depends on a connected runnable backend, respects approvals, and is backed by the SQLite store. A live development cycle created, edited, paused, resumed, ran, and deleted one harmless Codex schedule while Fable remained open; tool-bearing, connector-backed, consequential, multi-process, and packaged-restart cases remain gated.
- The desktop composer exposes a bounded `/mission` entry for two to six total steps. Ordinary bullets remain independent; an explicit `all: …` or `any: …` line declares one continuation over their immutable outputs, and following `then: …` lines can declare a short sequential continuation chain within the same six-worker ceiling. A final explicit `review: …` plus `revise: …` pair instead adds one advisory reviewer and exactly one revision pass. The revision receives both exact encrypted draft and review receipts through a second predeclared `all` join; model review cannot accept the work, and identified-human acceptance remains required. Up to four final `accept: …` lines replace the generic review placeholder with exact human-authored required criteria; they consume no worker slots and bind only to immutable required-output receipts. Fable creates an encrypted Plan, persists every multi-source join before outcomes exist, pins the selected authorized provider/model route without fallback, runs native provider workers through the reusable graph path, and has Rust rebuild every downstream objective from exact encrypted predecessor receipts before egress. It persists the command and review bundle in the source conversation, supports native cancellation and restart recovery, and requires evidence-bound human review. A successful reviewed result materializes every required final deliverable as a deterministic immutable accepted Artifact in the same terminal transaction; intermediate outputs remain immutable Mission evidence rather than silently becoming accepted deliverables. Replay revalidates the encrypted provider receipt, signed-in human evidence, selected Plan, private owner, source conversation, and every required acceptance result, while partial, failed, and cancelled results create none. A terminal partial, failed, or cancelled result can start a fresh Mission only from its exact durable preceding `/mission` command; the current scope and authorized route are selected again, while the old journal, output, checkpoints, grants, approvals, provider choice, and route evidence are never reused. It does not infer branches, tools, effects, grants, or cross-Mission handoff authority. Arbitrary branching graph authoring, repeated iteration, automatic escalation, packaged-app observation, and live-provider observation remain release gates.
- The same `/mission` ceiling now admits repeated explicitly numbered joins such
  as `all 1,2: …` and `any 2,3: …`. Every dependency must name distinct earlier
  steps, every multi-source join is persisted before execution, only terminal
  leaves become required deliverables, and mixed or future-referencing grammar
  fails closed. Quorum authoring, repeated iteration, automatic escalation,
  cross-Mission handoff, and packaged/live-provider observation remain gates.
- Canonical Routines can be created, edited, paused, resumed, deleted, listed,
  migrated, and executed locally with encrypted evidence, time-zone-aware
  one-time/daily/weekly/monthly plus bounded five-field cron recurrence, restart
  cursors, leases, bounded retry, and exact settlement. Unsupported cron
  extensions fail closed, and the calm form does not expose expert cron editing.
  New schedules, immutable workflow versions, queue occurrences, and workflow
  runs carry native-authenticated owner evidence; renderer identity is ignored,
  and production workflow writes require encrypted SQLite. Reconciliation plus
  an explicit one-writer cutover is implemented, but legacy rows without exact
  persisted member ownership still quarantine rather than being backfilled.
  Post-execution rollback is supported only for unchanged migrated Routines: it
  copies terminal occurrence references into the exact legacy history and
  advances the legacy cursor before the fenced writer restore. Canonical-only,
  edited, ambiguous, in-flight, or cross-owner state remains blocked rather than
  guessed. Native local-STDIO and remote-HTTP MCP tool/resource-list change
  notifications now supply authenticated events to the intake, and the local
  editor exposes only those exact implemented event kinds for ready MCP
  Connections owned by the active private member. Other provider events,
  signed webhooks, packaged-app restart observation, and live provider
  execution remain release blockers.
- Browser preview connector behavior is fixture-backed and must stay labeled as
  preview data.
- First-wave Connector search/import now binds each result to the exact
  authenticated Fable Connection and rejects selection changes before import.
  Imported connector Knowledge is encrypted under the private workspace owner,
  secret-redacted before persistence, restored after restart, and supports
  durable disable/re-enable and tombstone delete. Retrieval rechecks that exact
  Connection before ranking and context assembly. Live credential-backed
  observation, background synchronization, and provider crawling remain
  release gates. Repository-local Project search/import is implemented: the
  desktop offers only Connections already saved on the active private Project,
  native code requires that exact Project/Connection pair before provider
  egress, and it rechecks the encrypted Project revision and selection before
  persisting the normalized source in Project-private Knowledge.
- Project detail includes a bounded Activity summary for exact active
  Project conversation Mission runs, canonical project Routines, current
  project Artifacts, and workspace Connections referenced by those Routine
  triggers or Artifact evidence. Connection labels come only from the current
  native projection, and unavailable references are shown as needing attention.
  The same page can atomically write a new plaintext JSON copy of one exact
  active-member private Project. Native code rejects foreign, shared, deleted,
  and ambiguous legacy Projects, filters private documents before decryption,
  and excludes credentials, workspace/account settings, machine state, audit
  history, unrelated records, and external Artifact handoff authority.
  Re-import preserves Project, conversation, and message ownership plus
  conversation titles only for the same active private member and original
  internal creator; it rejects authority substitution or removal and never
  transfers ownership. An active Project can also choose up to 32 already
  authorized exact-owner or workspace-shared Connections. Selection persists
  only opaque IDs, grants no capability, and filters connector context before
  ranking; native and MCP semantic reads independently require the resolved
  Connection to match that saved selection before grant use. Missing prior
  choices stay visible for removal. Exact-revision native controls can pause,
  resume, or delete a Project Routine, while archived Projects remain read
  only. Project Artifacts open immutable versions, private review state,
  citations, exact-version export, and explicitly confirmed same-owner private
  Project handoff through the same detail contract as Knowledge. Archived
  Projects retain their exact durable private conversations and bounded Mission
  summaries as non-interactive history; they cannot reopen the composer or any
  Project mutation control. Each Mission exposes its bounded durable progress,
  usage, budget, acceptance state, and next action. Active Projects can record
  exact revision-fenced identified-human acceptance or needs-revision decisions;
  a retryable terminal general Mission can start a fresh run only from its exact
  canonical `/mission` record after the active Project thread is rechecked for
  unchanged membership and revision. The old journal and authority are not
  reused. Active Project Missions also expose a plain `Stop` action. It reloads
  the exact encrypted Run head and appends the existing authenticated
  cooperative cancellation request before refreshing Project activity. The UI
  states that this prevents Fable from accepting further results but cannot
  undo provider work already sent. The active graph aborts its providers, waits
  for every in-flight boundary to settle, and only then asks Rust to append the
  terminal cancellation and Mission result; restart recovery owns the same
  terminalization when no active graph remains.
- Browser-preview schedules are explicitly labeled `Preview only` and state
  that their synthetic records stay in the browser and cannot run provider
  work. The unavailable Departments placeholder is not shown in primary
  navigation. Every current modal entry point now has initial focus, keyboard
  containment, safe Escape close, and restoration to the opener or an explicit
  stable invoking control through one shared focus scope. It also makes
  background branches inert for keyboard and assistive-technology navigation
  while the modal is active, including nested confirmations. The final desktop
  style layer applies an operating-system reduced-motion preference globally to
  scrolling, transitions, and animations. Shared secondary/status text tokens
  are regression-tested at WCAG AA 4.5:1 or better on their supported light and
  dark backgrounds. This is not a claim of complete packaged-WebView or
  assistive-technology validation.
- Native API providers use bounded dynamic model discovery. Live availability
  and entitlements still depend on each provider account and are not proven by
  fixture tests.
- Windows preview packaging is unsigned. macOS and Linux packaging are not
  ready.
- Private Windows artifact generation now emits deterministic release notes and
  a checksum manifest that accepts only private/internal/preview channels and
  says unsigned/unpublished explicitly. The disposable-runner rehearsal proves
  clean NSIS installation, same-version repair, uninstall registration, and
  preservation of its local-data sentinel. A true previous-version upgrade,
  rollback, packaged first launch, and keyring/vault continuity still require
  packaged private evidence.

## Remaining ship blockers

- Deploy and review the auth broker before enabling OAuth connectors for
  external users.
- Complete provider-console setup, callback registration, OAuth consent review,
  and live non-production validation for each external connector.
- Complete production Clerk configuration and validate recovery, sign-out,
  device revocation, hosted session policy, and account switching.
- Complete and review the Clerk + Convex shared-workspace vertical slice before
  enabling team workspaces for external users.
- Add release signing, updater channels, download/legal pages, and platform
  packaging beyond Windows.
- Add platform CI coverage for macOS Keychain and Linux Secret Service.

## Stale cache recovery

If `pnpm tauri:check` or Rust commands under `apps/desktop/src-tauri` fail with
a path referencing an old checkout name, clear the stale native target once:

```bash
cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml
```

This is an incremental cache artifact. A fresh checkout is unaffected.
