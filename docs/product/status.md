# Fable Status

Last audited: 2026-06-29.

This is the factual state of the repo, not the product pitch. Claims below were checked against current files in this checkout.

## Repo Shape

- The repo is a private pnpm monorepo named `fable`, with `@fable/desktop`, `@fable/broker`, `@fable/connectors`, `@fable/knowledge`, and `@fable/protocol`.
- The desktop app is Tauri 2 plus React, TypeScript, and Vite.
- The Rust runtime is under `apps/desktop/src-tauri`.
- Product docs already exist for thesis, roadmap, architecture, connectors, native-runtime, release notes, and threat model.
- Brand assets exist under `apps/desktop/public/brand`.

## Implemented

- Desktop shell: local-profile onboarding, sidebar navigation, universal composer, theme toggle, model picker, permission picker, add menu, connector page, interactive Knowledge page, schedules page, profile page, and settings page.
- Composer: supports text entry, slash command insertion, local file import trigger, voice toggle UI, model selection, permission selection, and native-agent submit path when a connected native backend exists.
- Protocol package: defines approvals, memory, connectors, backend providers, runtime snapshots, native agent events, native tool specs, and tool-call request shapes.
- Local file import: supports `txt`, `md`, `markdown`, `json`, `csv`, `yaml`, and `yml`; rejects empty files, unsupported extensions, changed file sizes, and files over 2 MB; imported files are untrusted local knowledge with a 6,000-character preview.
- Knowledge and retrieval: local files and recursive folders can be imported,
  chunked, fingerprinted, scoped, searched, inspected, refreshed, disabled, and
  deleted. Lexical retrieval returns cited snippets, scores, provenance,
  freshness, trust, and pin state; stale, failed, disabled, disconnected, and
  out-of-scope sources are excluded.
- Approvals: Rust commands and shell UI support once/session/rule/modify/deny decisions, audit entries, approval rules, high-risk confirmation, and denied-action handling.
- Memory: Rust commands support listing, saving, exporting, disabling, editing through shell state, and approval-gated promotion from a knowledge source into durable memory.
- Local recovery: runtime snapshot, approval audit, approval rules, imported knowledge, memory state, and connected backend ids are persisted through encrypted SQLite in Tauri; browser preview still uses localStorage. Schedules and workflows still use raw JSON files (`scheduler-store.json` and `workflow-runs.json`/`workflow-definitions.json`).
- Backend catalog: Codex, Cursor, GitHub Copilot, Grok, OpenAI, Anthropic, Gemini, xAI, and OpenRouter are modeled as agent-runtime backends. Native API-key providers connect through the Rust credential boundary. Codex can run through `codex app-server`; Cursor and Grok can run through ACP CLI processes when the corresponding CLI is installed and signed in. GitHub Copilot remains cataloged but not runnable until its SDK adapter lands.
- Backend credentials: Rust uses a keyring-backed credential boundary for backend secrets, with an in-memory fallback for headless/test paths. JavaScript receives auth state, capabilities, and models, not raw secrets.
- Native API agent loop: TypeScript owns provider request shaping and a bounded
  multi-round agent loop; Rust owns API key lookup, bounded HTTP/SSE egress,
  normalized retry/error events, idle timeout, response-size enforcement, and
  cancellation for OpenAI-compatible, Anthropic, and Gemini-style providers.
- Native model discovery: provider lists are paginated and bounded with
  distinct success/empty/unsupported/offline/failed outcomes. Non-generation
  and unknown-capability models cannot be selected.
- Agent recovery: run checkpoints persist active-thread user, assistant, and
  tool exchanges. Interrupted runs surface in chat and retry as new child runs
  from the durable user prompt without replaying tool effects.
- Tool execution: the registered tools are `read-file`, `write-file`,
  `run-shell`, and `web-fetch`; calls are bounded and route through approval
  before Rust re-validates an exact, fresh, single-use execution permit.
- First-wave connector catalog: GitHub, Vercel, Google Drive, Notion, Gmail, Slack, and Google Calendar are modeled with scopes, auth mode, health/status metadata, search/import/action protocol shapes, and fixture adapters.
- Connector writes: fixture-side connector write preparation creates approval requests for GitHub, Vercel, Gmail, Slack, and Calendar actions instead of directly executing them.
- Tauri connector runtime: external connector commands expose status/auth/health/search/import/action boundaries. Google public-client connectors use loopback PKCE and OS secure storage; confidential-client connectors (GitHub, Vercel, Notion, Slack, Linear) are broker-gated and fail closed with `configuration-required` until the auth broker and provider configuration exist.
- Google connectors: Drive, Gmail, and Calendar expose authenticated reads and approval-gated writes, incremental scopes, refresh-token preservation, explicit active-account selection, bounded responses, cancellation, and normalized provider errors. External use still requires Google Cloud configuration and applicable verification.
- Schedules page: users can create, pause/resume, and delete local schedule records. Records persist locally in raw JSON; the Tauri runtime leases due occurrences, queues workflow runs, and executes scheduled prompts through the provider-neutral `AgentBackend` path when a runnable backend is connected.
- CI file: `.github/workflows/ci.yml` exists and uses pnpm for typecheck, tests, build, Tauri check, Rust tests, clippy, and fmt on Windows.
- Tests exist across desktop, connectors, native API, local files, knowledge search, backend registry, and Rust runtime modules.
 
## Runtime Availability Matrix
 
| Area | Category | Details / Location |
| --- | --- | --- |
| Local files, approvals, memory controls, knowledge search, runtime snapshots | **Finished** | Live local runtime paths in Tauri. Monolithic JSON documents intercept-routed to SQLite `preferences` table. |
| Encrypted SQLite Core | **Finished** | Active in production Tauri path (keyring-backed AES-256-GCM vault). |
| Native API-key Backends (BYOK) | **Finished** | Live OpenAI, Anthropic, Gemini, xAI, OpenRouter model execution when keys are supplied to local keyring. (See [Native Agent Runtime](native-runtime.md) for the capability matrix). |
| Schedules Core | **Finished** | Local scheduler tick, leasing, queueing, and headless prompt execution are fully functional (depends on connected runnable backend). |
| Google Connectors (Drive, Gmail, Calendar) | **Functional but gated** | Live public-client PKCE egress is functional, but requires user-supplied Google Cloud Console OAuth Client configuration. |
| ACP Providers (Cursor, Grok) | **Functional but gated** | Live stdio JSON-RPC runs when local CLI is installed/authenticated. Grok entitlements resolved post-login. |
| Codex app-server | **Functional but gated** | Live chat-server loop when local Codex CLI is installed/authenticated. |
| Confidential Connectors (GitHub, Vercel, Notion, Slack, Linear) | **Functional but gated** | Rust/TS code exists, but fails closed as the auth broker and callback URLs are deferred (Missing configuration). |
| Browser Preview Mode | **Preview/fixture-only** | Purely synthetic fixture responses. Persists via `localStorage` instead of SQLite. |
| Mobile Remote Control | **Preview/fixture-only** | Sidebar UI button triggers state/accessibility announcement change only; no socket, protocol, or mobile backend. |
| Schedules & Workflows SQLite migration | **Missing** | Structured database tables defined in schema, but runtime execution still falls back to raw JSON files (`scheduler-store.json`, `workflow-runs.json`). |
| GitHub Copilot Execution | **Missing** | Cataloged in provider list, but execution adapter/runner is not implemented. |
| Local Model Execution | **Missing** | Onboarding UI labels local models as planned and disabled. |
| Non-Windows Packaging & CI Keychain | **Missing** | Release builds only support Windows (unsigned). macOS/Linux packaging and CI keychain test runners are missing. |
| Voice, Convex collaboration | **Missing** | Voice is UI toggle only (no capture/pipeline). Convex is optional and lacks schema/collab code. |

## Partially Implemented Or Preview-Only

- Onboarding collects an optional local display profile only. It does not create or require a hosted Fable account.
- The API-key path can hand native backend secrets to the Rust credential boundary, but subscription provider paths are represented as backend catalog states and install/setup flows, not proven live provider integrations.
- Browser preview can mark API-key backends as locally connected for testability. Connector reads remain explicitly fixture-backed and do not become live connections.
- Connector search/import in browser preview uses explicitly labeled synthetic fixture behavior.
- The Knowledge page provides Sources and Memory modes with search, provenance,
  status, scope, account, freshness, local file/folder import, connector entry,
  refresh, pin, disable/delete, explicit memory promotion, edit, export,
  disable, and forget controls.
- Schedules execute locally through the runtime scheduler when due and when a connected runnable backend is available. Blocked-auth and unavailable-backend states remain explicit instead of silently falling back. The schedules are backed by raw JSON file storage.
- Voice is a toggle and status affordance; no dictation, audio capture, realtime voice provider, or transcript pipeline was found.
- Convex is optional via `VITE_CONVEX_URL`, but no Convex schema or collaboration implementation was found in this repo.

## Not Implemented Yet

- No deployed production auth broker or externally validated confidential OAuth session.
- No provider-console apps, deployed callback URLs, OAuth consent verification, or non-production live OAuth validation evidence in the repo.
- No externally validated live connector sessions in this checkout. Google public-client connectors still require provider configuration and test accounts; confidential-client connectors still require the deferred auth broker.
- Browser-only preview state still uses localStorage; the Tauri production path uses encrypted SQLite for main documents, and raw JSON files for schedules/workflows. Backend and connector credentials remain separately handled by OS secure storage.
- No local model runtime path. The onboarding UI labels local models as planned and disabled.
- No signed release, updater channel, macOS packaging, or Linux packaging. Release docs identify the Windows preview build path and unsigned distribution gaps.
- No product website, legal pages, downloads page, or public release pipeline in the audited files.

## Highest-Risk Gaps

- External connectors look close in the UI but are not live. The repo correctly fails closed, but product messaging must keep this distinction clear.
- Backup restoration requires the database and matching OS-secure master key; external recovery UI polish remains future work.
- Scheduled work still depends on a connected runnable backend and user approval gates for consequential actions; live account coverage was not externally validated in this checkout.

## Evidence Checked

- `README.md`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/product/thesis.md`
- `docs/product/roadmap.md`
- `docs/product/architecture.md`
- `docs/product/connectors.md`
- `docs/product/release.md`
- `docs/security/threat-model.md`
- `apps/desktop/package.json`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src/hooks/useShellRuntime.ts`
- `apps/desktop/src/hooks/useNativeAgent.ts`
- `apps/desktop/src/components/Composer.tsx`
- `apps/desktop/src/components/pages/OnboardingPage.tsx`
- `apps/desktop/src/components/pages/ProfilePage.tsx`
- `apps/desktop/src/components/pages/SettingsPage.tsx`
- `apps/desktop/src/components/pages/KnowledgePage.tsx`
- `apps/desktop/src/components/pages/SchedulesPage.tsx`
- `apps/desktop/src/data/workspace.ts`
- `apps/desktop/src/lib/persistence.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/models.rs`
- `apps/desktop/src-tauri/src/paths.rs`
- `apps/desktop/src-tauri/src/snapshot.rs`
- `apps/desktop/src-tauri/src/memory.rs`
- `apps/desktop/src-tauri/src/connectors.rs`
- `apps/desktop/src-tauri/src/connector_auth.rs`
- `apps/desktop/src-tauri/src/connector_api.rs`
- `apps/desktop/src-tauri/src/collaboration_connectors.rs`
- `apps/desktop/src-tauri/src/google.rs`
- `apps/desktop/src-tauri/src/oauth_loopback.rs`
- `apps/desktop/src-tauri/src/backends.rs`
- `apps/desktop/src-tauri/src/native_api.rs`
- `apps/desktop/src-tauri/src/tools.rs`
- `packages/protocol/src/index.ts`
- `packages/connectors/src/index.ts`
- `packages/connectors/src/local-files.ts`
- `packages/connectors/src/knowledge-search.ts`
- `packages/connectors/src/providers/registry.ts`
- `packages/connectors/src/backends/registry.ts`
- `packages/connectors/src/native-api/agent-loop.ts`
- `packages/connectors/src/native-api/tools.ts`
- `packages/connectors/src/native-api/tool-executor.ts`
- `docs/connectors/auth-broker.md`
