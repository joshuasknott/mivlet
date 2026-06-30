# Architecture

## Stack

- Tauri 2 for the desktop shell.
- Rust for runtime commands, permissions, jobs, local context, and connector execution.
- React, TypeScript, and Vite for the interface.
- Convex for optional realtime shared state and collaboration state when configured.
- Encrypted SQLite for offline/private local state (schedules and workflows are temporarily excluded and use raw JSON file persistence).
- OS secure storage for credentials.

## Runtime Boundaries

The UI talks to the runtime through typed protocol objects in `packages/protocol`.

Core domains:

- `Directive`: workspace-aware prompt starters that write into the universal composer.
- `ApprovalRequest`: consequence-aware approval prompts with once, session, rule, modify, and deny outcomes.
- `ApprovalGrant`: scoped approval grants, either temporary for the current session or persisted as standing rules.
- `ApprovalAuditEntry`: local audit history for user decisions and resumable follow-up.
- `MemoryRecord`: facts, inferences, provenance, freshness, permissions, and user controls.
- `MemoryPromotionRequest`: approval-gated conversion of trusted or untrusted knowledge sources into durable memory.
- `ConnectorManifest`: install/auth/permission/health metadata for bridges.
- `KnowledgeSource`: imported or indexed source metadata that can be pinned into context.
- `AutomationRule`: scheduled or event-driven workflow metadata with approval requirements.
- `RuntimeSnapshot`: resumable app state after restart, including active view, draft text, approvals, pinned sources, imported knowledge, automation status, and memory controls.

Implemented runtime commands cover approval resolution, one-time execution permits, standing approval rules, approval audit persistence, native agent-run journaling and restart recovery, local text-file import, imported knowledge persistence, memory control state, approval-gated memory promotion, memory export formatting, runtime snapshot recovery, and lexical cited retrieval over workspace sources. Browser preview keeps matching fallbacks so the UI remains testable outside Tauri.

### Action History (Audit)

A single normalized action-history event covers every auditable category: model calls, connector actions, shell/tool actions, browser/web actions, approvals, schedules, and blocked policy decisions. Events are recorded at execution boundaries (native tool execution, connector prepare/execute, approval resolution, backend/model call lifecycle, web/browser fetch, scheduler queue/run/cancel/block), carry correlation ids where available, and expose status, risk/profile/mode, actor, a safe summary, and a normalized failure code.

Storage is the encrypted SQLite `audit_event` table (schema v3). Query columns are non-secret and indexed (category, service, action, status, risk_level, mode, correlation_id, error_code, summary, actor, created_at); the encrypted payload holds only redacted safe detail. Tokens, API keys, raw provider secrets, auth handoff codes, full private file content, full email bodies, and environment-variable values are redacted at the storage boundary and never persisted. Audit observes actions only — it never grants execution authority, and recording is best-effort so it can never weaken the approval or permit gate. The `list_action_history` and `record_action_history` commands back the Settings → History inspectable surface, which shows type, summary, status, time, actor, and safe details with category filtering. The legacy `ApprovalAuditEntry` shape and `list_approval_audit` command remain compatible.

## Knowledge And Memory

`@fable/knowledge` is the pure domain layer for ingestion, chunking, retrieval,
memory proposals, context assembly, and store contracts. The desktop shell owns
the user interaction and delegates retrieval/context construction to that
  package; the Rust snapshot boundary persists imported local sources and durable
  memory through the encrypted SQLite store (via preferences document interception
  in the production path), while browser fallback uses localStorage. Workflows
  and schedules continue to use direct JSON files.

- Local file and recursive folder imports are bounded, typed, fingerprinted,
  chunked, and classified as untrusted knowledge. Provider imports retain their
  connector/account provenance and remain authorized only while that connector
  is connected.
- Retrieval is scoped to global, project, or thread context. Deleted, disabled,
  stale, failed, disconnected, or out-of-scope sources are excluded before
  context assembly.
- Citations identify the exact source and excerpt used. Pinned context is
  deliberate, not a trust upgrade.
- Imported content never becomes durable memory implicitly. “Remember” uses the
  existing approval-gated promotion path; memory remains editable, pinnable,
  exportable, disableable, and forgettable.
- Agent submissions assemble the same bounded, cited context used by Knowledge
  search. Durable memory is omitted when memory is disabled or a record has
  been forgotten.

The `KnowledgeStore` contract is snapshot-shaped and independent of a storage
engine. Goal 5's encrypted SQLite repository can implement the same boundary;
this branch does not introduce a competing database or secret store.

## Native AI Runtime

Fable owns the native API agent loop while preserving provider-specific wire formats:

- TypeScript shapes OpenAI-compatible, Anthropic, and Gemini messages, incrementally parses text, usage, and tool calls, and feeds tool results into the next model turn.
- Rust owns provider credentials, HTTP/TLS egress, status classification, bounded retry/backoff, SSE relay, and in-flight cancellation. Provider keys never cross into JavaScript.
- Each run is journaled in `agent-runs.json` without credentials. Checkpoints
  include the active thread plus bounded user, assistant, and tool exchanges.
  Interrupted runs surface in chat and can be explicitly retried from the
  durable user prompt without replaying prior tool side effects.
- Model tool calls are untrusted proposals. The shell obtains a user decision; Rust issues a request-fingerprinted, one-time execution permit and rechecks the tool policy, exact argument preview, workspace path confinement, and permit immediately before dispatch.
- Token usage comes from provider responses. Displayed cost is explicitly an estimate from Fable's maintained rate table when the provider does not return cost; Fable does not invent subscription quota or balance data.

Native API credentials are BYOK. Codex app-server and ACP providers are
separate adapters, not the foundation: Codex owns its app-server auth/process
protocol, and Cursor/Grok own auth in their ACP CLIs. Fable maps those streams
into the provider-neutral `AgentBackend` contract without reading subscription
tokens. GitHub Copilot remains cataloged until its SDK execution adapter lands.
The native API path does not reinterpret consumer subscriptions as API access.

## Schedules And Commands

The composer parses `/remember`, `/goal`, `/plan`, and `/schedule` through the
provider-neutral command layer in `@fable/connectors`. `/goal` and `/plan`
create local structured state and, when a backend is connected, submit a
follow-up prompt through the same `AgentBackend` run path as normal composer
messages. `/schedule` creates a validated one-time or recurring schedule; the
runtime pins the selected backend/model/permission route at creation time.

The Tauri scheduler leases due occurrences, writes queue records, and exposes
pending workflow runs to a headless scheduled-agent hook. Jobs and queue records
persist in the raw JSON file `scheduler-store.json` (migration to SQLite is a
release blocker). Scheduled prompts use
the same adapter contract as interactive prompts, so native API, Codex
app-server, and ACP runs share cancellation, blocked-auth handling, and approval
boundaries. Schedules do not require Convex or a hosted Fable account.

## Connector Runtime

`@fable/connectors` now exposes a typed adapter/runtime contract for authentication, account identity, capabilities, reads, writes, pagination, rate-limit metadata, normalized errors, token refresh, retry, revocation, and disconnection. Adapters register a closed capability set; duplicate registrations and undeclared operations fail closed.

The native connector boundary exposes status, auth start/complete/clear, health refresh, search, import, action preparation, approved-action execution, and detailed connector approval audit commands.

- OAuth connectors use Authorization Code with PKCE S256. Confidential clients
  use the configured auth broker and one-time loopback handoff; Google desktop
  public clients exchange directly with Google through an ephemeral loopback
  callback.
- Access tokens, refresh tokens, and pending PKCE verifiers are stored in the OS credential store.
- Plain local connection state contains account identity, scopes, expiry, status, and an opaque credential reference only.
- GitHub, Notion, Slack, Vercel, Linear, or another provider that requires confidential credentials routes through the configured HTTPS auth broker. The broker is limited to authorization start/callback, one-time handoff redemption, refresh, internal identity resolution, and revocation; it is not a general connector proxy.
- Every external write capability must be marked consequential. The shared runtime rejects non-consequential write declarations and requires a fresh matching per-action approval record before calling an adapter.

Authenticated provider egress exists on the desktop path for the first-wave
external connectors, but availability is gated by each connector's auth
boundary. GitHub, Vercel, Notion, Slack, and Linear require the HTTPS auth
broker and provider-console callback registration. Google Drive, Gmail, and
Google Calendar instead require `FABLE_GOOGLE_OAUTH_CLIENT_ID`, enabled APIs,
consent configuration, and applicable verification. Browser preview remains
explicitly fixture-backed, and missing configuration fails closed instead of
claiming a live connection.

Native API providers use bounded dynamic model discovery with explicit success,
empty, unsupported, offline, and failed outcomes. Discovery filters
non-generation models and cannot enable models with unknown execution
capabilities. The curated catalogue remains the truthful fallback when
discovery cannot run; live account entitlement validation still depends on the
provider response.

See [Native Agent Runtime](native-runtime.md) for discovery, recovery, retry,
limits, and tool-safety contracts.

See [Connectors](connectors.md) for scopes, callbacks, credential ownership, and external provider-console work.

## Offline Behavior

- Composer drafts, selected context, imported knowledge, durable memory, approval audit history, and connector health cache stay local.
- Plugin actions requiring network or missing credentials queue as resumable jobs.
- Recovered native runs are marked interrupted, retain partial
  transcript/usage/exchanges/pending approval identifiers, and expose an
  explicit retry-from-prompt action.

The desktop runtime persists non-secret approval, run, connector-account, and snapshot metadata in the Tauri app data folder. Credentials and OAuth tokens use OS secure storage. Session approval grants remain ephemeral, while high-risk full-access approvals fail closed unless the required confirmation phrase is provided.

The Tauri runtime initializes encrypted SQLite before commands, migrates legacy
JSON idempotently, and routes production documents (except schedules and
workflows) through the native store. Schedules and workflows still use raw
JSON files. Credentials remain in OS secure storage. See
[Encrypted local storage](../architecture/encrypted-storage.md).

A paired mobile device is designed as a second approval, observation, and schedule-control
surface (currently planned/deferred; only a UI stub exists on the desktop shell and no active socket or remote protocol is implemented). When implemented, pairing is pairwise and
LAN-local (no hosted account), mobile decisions are inputs to the existing
approval queue rather than execution authority, and no secret crosses the remote
channel. See [Mobile remote control](../architecture/mobile-remote.md).

## Selective TokenMaxxer Reuse

Fable inspected [joshuasknott/tokenmaxxer](https://github.com/joshuasknott/tokenmaxxer) and reused the compatible architectural ideas rather than its provider-specific usage endpoints:

- normalized provider/adapter contracts;
- credentials separated from account metadata through opaque credential references;
- refreshed token sets persisted after rotation with an expiry leeway;
- exact provider-reported token/cost data preferred over synthetic quota claims;
- provider errors normalized before crossing the UI boundary.

Fable did not reuse TokenMaxxer’s quota scraping, fixed blended cost estimates, Codex profile handling, or provider-specific reporting adapters because they do not implement Fable’s inference and connector execution requirements.

## Convex Boundary

Convex is optional. If `VITE_CONVEX_URL` is present, the UI can initialize a Convex client for realtime shared state, though collaboration schema and synchronization logic are not implemented on the main branch. Without it, the core desktop workspace, local files, approvals, runtime snapshots, memory controls, schedules, and API-key providers remain usable.
