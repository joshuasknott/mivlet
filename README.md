# Fable

Fable is an AI workspace for real work. It brings providers, tools, knowledge,
approvals, projects, and repeatable work into one human-controlled product.

Fable is designed around hosted Fable identity, local secure execution, and
optional depth. Its current Clerk/Convex implementation is a foundation rather
than a completed hosted-account experience; this repository is not a release.

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
- Provider-first model setup: choose a provider, then choose one of its implemented connection methods. Submitted native API credentials are stored behind the local Rust credential boundary; provider-owned CLI sessions stay inside their own CLI.
- Native execution across OpenAI-compatible, Anthropic, and Gemini wire formats for OpenAI, Anthropic, Gemini, xAI, OpenRouter, DeepSeek, Z.AI, MiniMax, Alibaba Model Studio, Fireworks AI, Hugging Face, Kimi Code, Moonshot, Mistral, Meta Llama API, Perplexity, Tencent TokenHub, Xiaomi MiMo, Groq, Together AI, Cerebras, and custom endpoints.
- Local Ollama execution through an explicitly trusted literal-loopback service; Fable does not bundle, start, download, or credential local models.
- First-wave connector boundaries with explicit fixture previews, Google public-client PKCE support, and broker-gated confidential connectors that fail closed until configured.
- Clerk identity and Convex workspace-sync foundations exist but are config-gated. Completing mandatory account onboarding and multi-person workspace behaviour is a planned milestone, not a completed claim.

## Feature Status Matrix

| Component | Status | Details / Storage |
| :--- | :--- | :--- |
| **Local Workspace & Chat** | **Implemented (Live)** | Multi-turn chat thread navigation, draft recovery, and settings |
| **Local Knowledge Ingestion** | **Implemented (Live)** | Text, MD, CSV, JSON, YAML import with path-escape safety, structure-aware chunking, hybrid RRF k=60 retrieval |
| **Local Approvals & Memory** | **Implemented (Live)** | Once/session/rule grants, high-risk confirm, memory editing & promotion, lifecycle disables/deletes/forgets, SQLite composite key isolation (schema v5) |
| **Schedules & Automations** | **Implemented (Live)** | Local scheduler tick loop, leases, queueing, and headless prompt execution (persisted in encrypted SQLite) |
| **Native APIs, Local & Custom** | **Functional; provider-gated** | OpenAI, Anthropic, Gemini, xAI, OpenRouter, DeepSeek, Z.AI, MiniMax, Alibaba Model Studio, Fireworks AI, Hugging Face, Kimi Code, Moonshot, Mistral, Meta Llama API, Perplexity, Tencent TokenHub, Xiaomi MiMo, Groq, Together AI, Cerebras, custom OpenAI-compatible endpoints, and external Ollama. Remote providers require user credentials; live account entitlements have not been externally validated. |
| **Google Connectors** | **Functional (Gated)** | Google Drive, Gmail, and Calendar read/write via loopback PKCE; requires user Google Cloud Console config |
| **ACP/Codex Providers** | **Functional (Gated)** | Codex app-server plus Cursor, GitHub Copilot, Grok Build, OpenCode, Kimi, and Mistral Vibe ACP runtimes run only when their local CLI is installed and authenticated. Fable does not read provider-owned session tokens. |
| **Local Model Execution** | **Functional (Gated)** | Ollama can run through a trusted literal-loopback service when the user installs/starts Ollama and pulls a model; no bundled runtime, downloads, or credential. |
| **Confidential Connectors** | **Functional (Gated)** | Brokered adapters and fail-closed lifecycle states are implemented for GitHub, Vercel, Notion, Slack, and Linear; deployment, provider configuration, and live OAuth validation remain external |
| **Optional Cloud Identity** | **Spike (Config-gated)** | Clerk public-client PKCE boundary, keyring storage, and disabled/missing-config status surface exist; production enablement needs live Clerk validation and cloud/team verifier work |
| **Browser Preview Mode** | **Preview/fixture-only; transport deferred** | Permission architecture, session derivation, and audit redaction implemented; live browser transport deferred |
| **Mobile Remote Control** | **Local status surface; transport deferred** | Settings reports the native local status honestly. No socket, live pairing, mobile app, or remote execution path is enabled. |
| **Voice Dictation** | **Preview/Stub** | Composer voice toggle changes UI status; no audio capture or transcription pipeline |
| **Hosted Fable Account & Team Workspaces** | **Foundation only** | Clerk identity and Convex sync foundations exist; mandatory hosted account onboarding and multi-person workspace product flows remain incomplete. |
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
