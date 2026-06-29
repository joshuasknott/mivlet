# Agent Handoff Map

This document serves as a guide for future agent worktrees to quickly locate the implementations of core subsystems in Fable.

## 1. Provider Runtimes

Fable supports four types of backend execution providers, defined under `packages/connectors/src/backends/` and implemented in `apps/desktop/src-tauri/src/`:

- **Native BYOK API (OpenAI, Anthropic, Gemini, xAI, OpenRouter)**
  - Fable manages the full multi-round loop here.
  - TS shaping: [packages/connectors/src/native-api/agent-loop.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/native-api/agent-loop.ts)
  - Rust keyring egress & cancellation: [apps/desktop/src-tauri/src/native_api.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/native_api.rs)
- **ACP Providers (Cursor, Grok)**
  - Speaks JSON-RPC over stdio with an external CLI.
  - TS registry & adapter: [packages/connectors/src/backends/acp.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/backends/acp.ts)
  - Rust stdio runner: [apps/desktop/src-tauri/src/acp_process.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/acp_process.rs)
- **Codex app-server**
  - Speaks ChatGPT socket/CLI protocols.
  - TS registry: [packages/connectors/src/backends/codex.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/backends/codex.ts)
  - Rust app-server driver: [apps/desktop/src-tauri/src/codex_app_server.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/codex_app_server.rs)
- **GitHub Copilot**
  - Modeled/cataloged, but **not runnable** (no execution adapter implementation exists yet).
  - TS registry: [packages/connectors/src/backends/copilot.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/backends/copilot.ts)

## 2. Connectors

Connectors are split into public-client (PKCE) and broker-gated confidential-client implementations:

- **Google Connectors (Drive, Gmail, Calendar)**
  - Public-client loopback PKCE. Live in local dev when a client ID is provided.
  - TS schema: [packages/connectors/src/providers/google-drive.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/providers/google-drive.ts)
  - Rust loops & API: [apps/desktop/src-tauri/src/google.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/google.rs)
- **Confidential Connectors (GitHub, Vercel, Notion, Slack, Linear)**
  - Fail closed until the HTTPS auth broker is configured and deployed.
  - TS definitions: [packages/connectors/src/providers/github.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/providers/github.ts), [vercel.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/providers/vercel.ts), [slack.ts](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/providers/slack.ts)
  - Rust auth client: [apps/desktop/src-tauri/src/connector_auth.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/connector_auth.rs)
  - Rust connector logic: [apps/desktop/src-tauri/src/connectors.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/connectors.rs)

## 3. Remote Control (Mobile connection)

There is no active socket or remote protocol. The feature is represented as a UI stub:
- Sidebar device icon: [apps/desktop/src/components/WorkspaceSidebar.tsx](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src/components/WorkspaceSidebar.tsx)
- Action trigger: Sets `lastAction` to `"Mobile connection selected"` in [apps/desktop/src/App.tsx](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src/App.tsx#L483-L485)

## 4. Schedules

Schedules lease due items and run tasks. Their files include:
- Rust scheduler engine, queue, and tick: [apps/desktop/src-tauri/src/scheduler.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/scheduler.rs)
- TS scheduler client/trigger drivers: [packages/connectors/src/scheduler/](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/packages/connectors/src/scheduler/)
- Persistence path: Resolves to `scheduler-store.json` via [apps/desktop/src-tauri/src/paths.rs](file:///C:/Users/Josh/Projects/fable-worktrees/docs-reconciliation/apps/desktop/src-tauri/src/paths.rs#L72).
- **SQLite note:** The database schema has a `schedule` table and a corresponding Rust repository `src/store/repos/schedule.rs`, but the scheduler runtime has **not** been migrated to SQLite and still writes directly to raw JSON.

## 5. Departments / Pipelines

Departments and pipelines are **not** present on the main branch of `Fable`. The core architecture represents them in design specs only, and actual implementation tasks must be conducted within dedicated feature branches (e.g. following the preset structures outlined in parallel agent pipelines).
