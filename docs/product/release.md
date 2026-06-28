# Release Readiness

Last updated: 2026-06-28.

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
with local files, drafts, approvals, memory controls, schedules, runtime
snapshots, and API-key providers. API keys for OpenAI-compatible, Anthropic,
Gemini, xAI, and OpenRouter providers are handed to the Rust credential
boundary and are not stored in React state, snapshots, logs, or JSON metadata.

## Gated paths

- Confidential-client connectors (GitHub, Vercel, Notion, Slack, Linear)
  require a deployed Fable auth broker plus provider-console callback
  registration. Without that configuration, they fail closed.
- Google Drive, Gmail, and Google Calendar use public-client loopback PKCE and
  do not require the broker, but they still require Google Cloud OAuth client
  setup, consent configuration, and any provider verification required by
  Google.
- Subscription/CLI-backed agent providers (Codex, Cursor, GitHub Copilot,
  Grok) remain gated until a real capability-bearing runtime adapter is
  connected. The UI no longer treats them as one-click mock connections.
- Convex is optional. `VITE_CONVEX_URL` can enable hosted/realtime features, but
  it is not required for the local desktop workspace.
- Local model execution is still planned and disabled in onboarding.

## Known limits

- Non-secret runtime metadata still uses app-data JSON plus a runtime snapshot
  contract; encrypted SQLite is not wired yet.
- Schedules persist and can be managed locally, but there is no background
  scheduler/recurring execution engine yet.
- Browser preview connector behavior is fixture-backed and must stay labeled as
  preview data.
- Native API providers use bounded dynamic model discovery. Live availability
  and entitlements still depend on each provider account and are not proven by
  fixture tests.
- Windows preview packaging is unsigned. macOS and Linux packaging are not
  ready.

## Remaining ship blockers

- Deploy and review the auth broker before enabling confidential-client
  connectors for external users.
- Complete provider-console setup, callback registration, OAuth consent review,
  and live non-production validation for each external connector.
- Move non-secret metadata from JSON files to encrypted SQLite with migrations.
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
