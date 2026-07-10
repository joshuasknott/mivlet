# Agent Handoff Map

This document serves as a guide for future agent worktrees to quickly locate the implementations of core subsystems in Fable.

## 1. Provider Runtimes

Fable supports three runtime adapter families, defined under
`packages/connectors/src/backends/` and implemented in
`apps/desktop/src-tauri/src/`:

- **Native API, local, and custom providers**
  - Fixed profiles: OpenAI, Anthropic, Gemini, xAI, OpenRouter, DeepSeek,
    Z.AI, MiniMax, Alibaba Model Studio, Fireworks AI, Hugging Face, Kimi Code, Moonshot,
    Mistral, Meta Llama API, Perplexity, Tencent TokenHub, Xiaomi MiMo, Groq,
    Together AI, and Cerebras.
  - Ollama is the local loopback profile. Custom is a validated
    OpenAI-compatible base URL with an explicit model ID and optional bearer key.
  - Fable manages the full multi-round loop here.
  - TS shaping: [`packages/connectors/src/native-api/agent-loop.ts`](../../packages/connectors/src/native-api/agent-loop.ts)
  - Rust credential egress, endpoint policy, discovery, and cancellation: [`apps/desktop/src-tauri/src/native_api.rs`](../../apps/desktop/src-tauri/src/native_api.rs)
- **ACP providers (Cursor, GitHub Copilot, Grok Build, OpenCode, Kimi, Mistral Vibe)**
  - Speaks Agent Client Protocol JSON-RPC over stdio with an allowlisted
    external CLI command. Authentication remains provider-owned.
  - TS registry: [`packages/connectors/src/backends/acp.ts`](../../packages/connectors/src/backends/acp.ts)
  - TS transport: [`packages/connectors/src/agent-runtime/adapters/acp/transport.ts`](../../packages/connectors/src/agent-runtime/adapters/acp/transport.ts)
  - Rust stdio runner/probe: [`apps/desktop/src-tauri/src/acp_process.rs`](../../apps/desktop/src-tauri/src/acp_process.rs)
- **Codex app-server**
  - Speaks the Codex app-server JSON-RPC protocol over the local Codex CLI.
    ChatGPT/API-key login state stays in the Codex CLI; Fable records only the
    coarse auth state returned by the CLI status probe.
  - TS registry: [`packages/connectors/src/backends/codex.ts`](../../packages/connectors/src/backends/codex.ts)
  - Rust app-server driver: [`apps/desktop/src-tauri/src/codex_app_server.rs`](../../apps/desktop/src-tauri/src/codex_app_server.rs)

The provider catalogue and model fixtures live in
[`packages/connectors/src/backends/fixtures.ts`](../../packages/connectors/src/backends/fixtures.ts).
Do not add a provider as a connected/runnable state unless its native endpoint
profile or CLI adapter exists. Meta's hosted Llama API is availability-limited.
Vertex AI, Amazon Bedrock, and Azure AI/Foundry IAM do not have dedicated
adapters; Custom does not implement their IAM/signing schemes.

## 2. Connectors

Connectors are split into public-client (PKCE) and broker-gated confidential-client implementations:

- **Google Connectors (Drive, Gmail, Calendar)**
  - Public-client loopback PKCE. Live in local dev when a client ID is provided.
  - TS schema: [packages/connectors/src/providers/google-drive.ts](file:///c:/Users/Josh/Projects/fable/packages/connectors/src/providers/google-drive.ts)
  - Rust loops & API: [apps/desktop/src-tauri/src/google.rs](file:///c:/Users/Josh/Projects/fable/apps/desktop/src-tauri/src/google.rs)
- **Confidential Connectors (GitHub, Vercel, Notion, Slack, Linear)**
  - Fail closed until the HTTPS auth broker is configured and deployed.
  - TS definitions: [packages/connectors/src/providers/github.ts](file:///c:/Users/Josh/Projects/fable/packages/connectors/src/providers/github.ts), [vercel.ts](file:///c:/Users/Josh/Projects/fable/packages/connectors/src/providers/vercel.ts), [slack.ts](file:///c:/Users/Josh/Projects/fable/packages/connectors/src/providers/slack.ts)
  - Rust auth client: [apps/desktop/src-tauri/src/connector_auth.rs](file:///c:/Users/Josh/Projects/fable/apps/desktop/src-tauri/src/connector_auth.rs)
  - Rust connector logic: [apps/desktop/src-tauri/src/connectors.rs](file:///c:/Users/Josh/Projects/fable/apps/desktop/src-tauri/src/connectors.rs)

## 3. Remote Control (Mobile connection)

There is no active socket or remote protocol. The feature is represented as a UI stub:
- Sidebar device icon: [apps/desktop/src/components/WorkspaceSidebar.tsx](file:///c:/Users/Josh/Projects/fable/apps/desktop/src/components/WorkspaceSidebar.tsx)
- Action trigger: Sets `lastAction` to `"Mobile connection selected"` in [apps/desktop/src/App.tsx](file:///c:/Users/Josh/Projects/fable/apps/desktop/src/App.tsx#L483-L485)

## 4. Schedules

Schedules lease due items and run tasks. Their files include:
- Rust scheduler engine, queue, and tick: [apps/desktop/src-tauri/src/scheduler.rs](file:///c:/Users/Josh/Projects/fable/apps/desktop/src-tauri/src/scheduler.rs)
- TS scheduler client/trigger drivers: [packages/connectors/src/scheduler/](file:///c:/Users/Josh/Projects/fable/packages/connectors/src/scheduler/)
- Persistence: Schedules are persisted inside the encrypted SQLite database (`fable-vault.db`) in the `scheduled_job` and `scheduler_queue_entry` tables.
- **SQLite note:** In Batch 9, the scheduler runtime was fully migrated from `scheduler-store.json` to the encrypted SQLite database. Legacy JSON files are preserved on disk for rollback compatibility but are no longer the production authority.

## 5. Departments / Pipelines

Departments and pipelines are **not** present on the main branch of `Fable`. The core architecture represents them in design specs only, and actual implementation tasks must be conducted within dedicated feature branches (e.g. following the preset structures outlined in parallel agent pipelines).
