# Release Readiness

Last updated: 2026-07-10.

> **Release policy:** Fable is not authorised for public release. The agreed product requires a hosted, Clerk-backed Fable account and one connected provider. The current Clerk/Convex implementation is still a config-gated foundation, so the repository must not be presented as having completed that account requirement.

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

The current desktop runtime contains local-first encrypted storage and a
config-gated Clerk identity boundary. The target product requires hosted Fable
sign-in before normal use; completing that gate, workspace membership, and
account recovery is a release prerequisite. Provider keys remain separate from
Fable identity and are handed to the Rust credential boundary rather than
stored in React state, snapshots, logs, or JSON metadata.

## Gated paths

- Confidential OAuth connectors (GitHub, Vercel, Notion, Slack, and Linear)
  require a deployed Fable auth broker plus provider-console callback
  registration. The current in-memory handoff store is not production-ready;
  durable atomic storage is a release blocker.
- Google connectors are independent desktop public clients. They require
  `FABLE_GOOGLE_OAUTH_CLIENT_ID`, enabled Google APIs, consent configuration,
  test users while unpublished, and any verification required by Google.
- Codex runs through the local `codex app-server` process. Cursor, GitHub
  Copilot, Grok Build, OpenCode, Kimi, and Mistral Vibe use their installed ACP
  runtimes and provider-owned sign-in. Live account coverage remains unverified.
- Clerk + Convex now have a schema, policy tests, device/outbox foundations,
  and config-gated desktop commands. The product vertical slice for mandatory
  account onboarding and multi-person workspaces is still incomplete.
- Ollama runs only through an existing literal-loopback service. Fable does not
  install Ollama, download models, or store an Ollama credential.

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
- Complete mandatory Clerk account onboarding, recovery, sign-out, device
  revocation, and hosted session policy.
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
