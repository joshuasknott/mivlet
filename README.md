# Fable

Fable is an open-source AI workspace for real work. It lets you chat with your computer, delegate tasks across your tools and files, and stay in control at every step.

Local-first and private by default, Fable is built for people who want powerful AI assistance without giving up ownership of their work.

## Current Slice

- Tauri 2 desktop shell with Chats, Projects, Connectors, Knowledge, and Schedules navigation.
- Universal composer with text, attachments, `@` tools, slash commands, and send affordances; voice input is a UI toggle preview only.
- Contextual directive cards that fill the composer instead of behaving like task cards.
- Knowledge view with sources, memory provenance, and source pinning.
- Connectors view with auth state, permissions, health, search/import, and approval-gated actions.
- Schedules view and local scheduler engine for managing and executing recurring tasks automatically (using encrypted SQLite persistence).
- Approval flow with once/session/rule/modify/deny decisions and audit history.
- Local recovery for composer drafts, pinned sources, schedule definitions, and approval audit.
- Protocol types for approvals, memory, connector health, directives, and runtime snapshots.
- Native API-key agent path for OpenAI-compatible, Anthropic, Gemini, xAI, and OpenRouter providers, with keys held by the local credential boundary.
- First-wave connector boundaries with explicit fixture previews, Google public-client PKCE support, and broker-gated confidential connectors that fail closed until configured.

## Feature Status Matrix

| Component | Status | Details / Storage |
| :--- | :--- | :--- |
| **Local Workspace & Chat** | **Implemented (Live)** | Multi-turn chat thread navigation, draft recovery, and settings |
| **Local Knowledge Ingestion** | **Implemented (Live)** | Text, MD, CSV, JSON, YAML import with path-escape safety, structure-aware chunking, hybrid RRF k=60 retrieval |
| **Local Approvals & Memory** | **Implemented (Live)** | Once/session/rule grants, high-risk confirm, memory editing & promotion, lifecycle disables/deletes/forgets, SQLite composite key isolation (schema v5) |
| **Schedules & Automations** | **Implemented (Live)** | Local scheduler tick loop, leases, queueing, and headless prompt execution (persisted in encrypted SQLite) |
| **BYOK Native APIs** | **Implemented (Live)** | OpenAI, Anthropic, Gemini, xAI, and OpenRouter backend model execution using local keyring credentials |
| **Google Connectors** | **Functional (Gated)** | Google Drive, Gmail, and Calendar read/write via loopback PKCE; requires user Google Cloud Console config |
| **ACP/Codex Providers** | **Functional (Gated)** | Cursor, Grok, and Codex run via local stdio JSON-RPC or CLI app-server if installed and authenticated |
| **Confidential Connectors** | **Functional (Gated)** | Brokered adapters and fail-closed lifecycle states are implemented for GitHub, Vercel, Notion, Slack, and Linear; deployment, provider configuration, and live OAuth validation remain external |
| **Browser Preview Mode** | **Preview/Stub** | Purely synthetic fixture responses using `localStorage` instead of SQLite |
| **Mobile Remote Control** | **Preview/Stub** | Sidebar device button triggers state/accessibility announcement change only; no socket or remote protocol |
| **Voice Dictation** | **Preview/Stub** | Composer voice toggle changes UI status; no audio capture or transcription pipeline |
| **GitHub Copilot Execution** | **Planned (Missing)** | Cataloged in provider list, but execution adapter/runner is not implemented |
| **Local Model Execution** | **Planned (Missing)** | Onboarding UI labels local models as planned and disabled |
| **Signing, Updater, Multi-OS** | **Planned (Missing)** | Unsigned Windows preview build only; macOS/Linux packaging and updater channels are deferred |

## Brand

Brand assets live in `apps/desktop/public/brand`:

- `fable-mark.svg`
- `fable-mark-graphite.svg`
- `fable-wordmark.svg`
- `fable-logo.svg`
- `fable-logo-dark.svg`
- `fable-app-icon.svg`

The product position and usage notes are documented in `docs/brand.md`.

## Commands

```bash
pnpm install
pnpm dev
pnpm check
```

Tauri checks use:

```bash
pnpm tauri:check
```

### First-time build / stale cache

If `pnpm tauri:check` (or `cargo check`/`cargo test` under `apps/desktop/src-tauri`)
fails with a path referencing an old repo name — e.g. the directory was ever
cloned/renamed from `arden` to `fable`, leaving incremental cache pointing at the
old absolute path — clear the stale target directory once:

```bash
cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml
```

This is a cache artifact, not a code defect. A fresh rebuild after `cargo clean`
compiles and runs all Rust tests cleanly. (CI runs against a fresh checkout and
is unaffected.)

Windows bundles use:

```bash
pnpm tauri:build
```

Expected local build outputs:

- `apps/desktop/src-tauri/target/release/fable-desktop.exe`
- `apps/desktop/src-tauri/target/release/bundle/msi/Fable_0.1.0_x64_en-US.msi`
- `apps/desktop/src-tauri/target/release/bundle/nsis/Fable_0.1.0_x64-setup.exe`
