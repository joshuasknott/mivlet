# Release Readiness

Last updated: 2026-06-29.

## Runnable paths

Local setup and checks use pnpm:

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm tauri:check
pnpm check
```

Windows desktop bundles use:

```bash
pnpm tauri:build
```

Expected local Windows build outputs:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`

The core desktop workspace does not require a hosted Fable account. It can run
with local files, drafts, approvals, memory controls, schedules, action history,
runtime snapshots, and API-key providers. API keys for OpenAI-compatible, Anthropic,
Gemini, xAI, and OpenRouter providers are handed to the Rust credential
boundary and are not stored in React state, snapshots, logs, or JSON metadata.

## Gated paths

- Confidential OAuth connectors (GitHub, Vercel, Notion, Slack, and Linear)
  require a deployed Fable auth broker plus provider-console callback
  registration. The current in-memory handoff store is not production-ready;
  durable atomic storage is a release blocker.
- Google connectors are independent desktop public clients. They require
  `FABLE_GOOGLE_OAUTH_CLIENT_ID`, enabled Google APIs, consent configuration,
  test users while unpublished, and any verification required by Google.
- Codex runs through the local `codex app-server` process when the Codex CLI is
  installed and authenticated. Cursor and Grok run through their ACP CLI
  processes when installed and signed in. GitHub Copilot remains cataloged but
  not runnable until its SDK adapter lands. None of these paths require a Fable
  cloud account or expose provider-owned subscription tokens to React state.
- Convex is optional. `VITE_CONVEX_URL` can enable hosted/realtime features, but
  it is not required for the local desktop workspace.
- Local model execution is still planned and disabled in onboarding.

## Known limits

- Encrypted SQLite is active in the production Tauri path and intercept-routes monolithic JSON documents (snapshot, memory, approvals) to the `preferences` table, while falling back to JSON for tests. Action history is stored in the encrypted SQLite `audit_event` table. Schedules, workflows, knowledge sources, chunks, pins, and memory records persist in the encrypted SQLite database (`fable-vault.db`) under schema v5.
- Schedules persist locally and the Tauri runtime leases due occurrences, queues workflow runs, and executes scheduled prompts through the same provider-neutral `AgentBackend` path as the composer. Execution still depends on a connected runnable backend, respects approvals, and is backed by the SQLite store.
- Browser preview connector behavior is fixture-backed and must stay labeled as
  preview data.
- Native API providers use bounded dynamic model discovery. Live availability
  and entitlements still depend on each provider account and are not proven by
  fixture tests.
- Windows preview packaging is unsigned. macOS and Linux packaging are not
  ready.

## Remaining ship blockers

- Deploy and review the auth broker before enabling OAuth connectors for
  external users.
- Complete provider-console setup, callback registration, OAuth consent review,
  and live non-production validation for each external connector.
- Complete multi-workspace UI account switching on top of the schema v5 workspace isolation already present in storage.
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
