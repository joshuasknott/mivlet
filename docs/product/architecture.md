# Architecture

**Document role:** Supporting current-state architecture. The final-state product and durable architecture direction are defined in the [Product Blueprint](vision.md); ordered migrations and implementation work belong in the [Master Build Plan](master-build-plan.md). Where this document describes legacy local-only, project-bound, schedule-first, or optional-account behavior, it reports current implementation rather than approved final state.

## Stack

- Tauri 2 for the desktop shell.
- Rust for runtime commands, permissions, jobs, local context, and connector execution.
- React, TypeScript, and Vite for the interface.
- Clerk for required Fable identity/session and Convex for shared workspace state and hosted coordination; the current implementation remains config-gated and incomplete.
- Encrypted SQLite for offline/private local state (including schedules, workflows, and knowledge structures).
- OS secure storage for credentials.

## Runtime Boundaries

The UI talks to the runtime through typed protocol objects in `packages/protocol`.

Core domains:

- `Directive`: workspace-aware prompt starters that write into the universal composer.
- `ApprovalRequest`: consequence-aware approval prompts. Tool and connector writes use fresh per-action decisions; lower-risk legacy flows can still represent session or saved grants.
- `ApprovalGrant`: scoped approval grants, either temporary for the current session or saved as rules.
- `ApprovalAuditEntry`: local audit history for user decisions and resumable follow-up.
- `MemoryRecord`: facts, inferences, provenance, freshness, permissions, and user controls.
- `MemoryPromotionRequest`: approval-gated conversion of trusted or untrusted knowledge sources into durable memory.
- `ConnectorManifest`: install/auth/permission/health metadata for bridges.
- `KnowledgeSource`: imported or indexed source metadata that can be pinned into context.
- `AutomationRule`: scheduled or event-driven workflow metadata with approval requirements.
- `RuntimeSnapshot`: resumable app state after restart, including active view, draft text, approvals, pinned sources, imported knowledge, automation status, and memory controls.

Implemented runtime commands cover approval resolution, one-time execution permits, approval audit persistence, native agent-run journaling and restart recovery, local text-file import, imported knowledge persistence, memory control state, approval-gated memory promotion, memory export formatting, runtime snapshot recovery, and lexical cited retrieval over workspace sources. Development and test builds may use explicitly labelled preview adapters; production never silently substitutes fixtures for an unavailable native runtime.

### Action History (Audit)

Action history is a local record of actions Fable has performed, such as model calls, connector updates, shell commands, web queries, approvals, schedules, and blocked policy decisions. It provides an inspectable activity log so you can review Fable's past work on your device. Events are recorded at execution boundaries and contain a status, risk level, actor, safe summary, and correlation ID.

For privacy and security, all credentials, API keys, private tokens, auth codes, full file or email contents, and environment variables are automatically redacted at the storage boundary and never persisted. The history is saved locally in the encrypted SQLite `audit_event` table. This audit system only observes activity; it does not grant execution authority and does not bypass any security checks. You can refresh and inspect this history inside Settings → History, with options to filter by category. The legacy `ApprovalAuditEntry` shape and `list_approval_audit` command remain compatible.

## Knowledge And Memory

`@fable/knowledge` is the pure domain layer for ingestion, chunking, retrieval,
memory proposals, context assembly, and store contracts. The desktop shell owns
the user interaction and delegates retrieval/context construction to that
package; the Rust snapshot boundary persists imported local sources and durable
memory through the encrypted SQLite store (via composite-key SQLite tables in schema v5),
while browser fallback uses localStorage. Workflows, schedules, chunks, and tombstones
are also fully persisted in the SQLite vault.

- Local file and recursive folder imports are bounded, typed, fingerprinted,
  structurally chunked (for Markdown, JSON, CSV, YAML), sanitized with path-escape guards,
  and classified as untrusted knowledge. Provider imports retain their
  connector/account provenance and remain authorized only while that connector
  is connected.
- Retrieval is scoped to global, project, or thread context. Deleted (tombstoned), disabled,
  stale, error, indexing, disconnected, or out-of-scope sources are excluded before
  context assembly. Hybrid retrieval uses Reciprocal-Rank Fusion (RRF, k=60) to combine
  lexical and semantic scores.
- Citations identify the exact source and excerpt used. Pinned context is
  deliberate, not a trust upgrade.
- Imported content never becomes durable memory implicitly. “Remember” uses the
  existing approval-gated promotion path; memory remains editable, pinnable,
  exportable, disableable, and forgettable.
- Agent submissions assemble the same bounded, cited context used by Knowledge
  search. Durable memory is omitted when memory is disabled or a record has
  been forgotten (tombstoned).

The `KnowledgeStore` contract is snapshot-shaped and independent of a storage
engine. In the production Tauri path, encrypted SQLite repositories implement
that boundary; browser preview keeps using local fixture/localStorage behavior
and does not introduce a competing production database or secret store.

## Native AI Runtime

Fable owns the native API agent loop while preserving provider-specific wire formats:

- TypeScript shapes OpenAI-compatible, Anthropic, and Gemini messages, incrementally parses text, usage, and tool calls, and feeds tool results into the next model turn.
- Fixed native profiles cover OpenAI, Anthropic, Gemini, xAI, OpenRouter,
  DeepSeek, Z.AI, MiniMax, Alibaba Model Studio, Fireworks AI, Hugging Face,
  Kimi Code, Moonshot, Mistral, Meta Llama API, Perplexity, Tencent TokenHub, Xiaomi MiMo,
  Groq, Together AI, and Cerebras. Ollama supplies the local loopback path;
  Custom supplies a validated OpenAI-compatible base URL, explicit model ID, and optional bearer key.
- Rust owns provider credentials and custom endpoint configuration, HTTP/TLS
  egress, status classification, bounded retry/backoff, SSE relay, and
  in-flight cancellation. Once submitted, stored provider keys are never
  returned from Rust to JavaScript. Custom endpoints require HTTPS except for
  HTTP on a loopback host.
- Each run is journaled in `agent-runs.json` without credentials. Checkpoints
  include the active thread plus bounded user, assistant, and tool exchanges.
  Interrupted runs surface in chat and can be explicitly retried from the
  durable user prompt without replaying prior tool side effects.
- Model tool calls are untrusted proposals. The shell obtains a user decision; Rust issues a request-fingerprinted, one-time execution permit and rechecks the tool policy, exact argument preview, workspace path confinement, and permit immediately before dispatch. High-risk calls require a fresh decision and never auto-match a standing grant.
- Approval presets are explicit policy, not UI-only state. The UI uses **Read Only**, **Ask Me** (default), **Work Freely**, and **Custom**. Internally these resolve to the existing `read-only`, `trusted-scope`, and `full-access` modes; Custom never creates a second policy engine.
- Consequential actions are categorized by risk level:
  - **Low / Medium risk**: Actions that query services or read data. Fable asks before running to keep you in control.
  - **High risk**: Actions that make local modifications or configuration changes. Fable checks with you before these run.
  - **Critical risk**: Actions that cannot be undone, such as sending messages or deleting resources. Fable requires typing a confirmation phrase to run them.
- Token usage comes from provider responses. Displayed cost is explicitly an estimate from Fable's maintained rate table when the provider does not return cost; Fable does not invent subscription quota or balance data.

Remote native API credentials are BYOK; Ollama uses a local connection marker
and Custom may omit its bearer key for an unauthenticated compatible endpoint.
Codex app-server and ACP providers are separate adapters, not the foundation:
Codex owns its app-server auth/process protocol, while Cursor, GitHub Copilot,
Grok Build, OpenCode, Kimi, and Mistral Vibe own authentication in their ACP
CLIs. Fable maps those streams into the provider-neutral `AgentBackend`
contract without reading or persisting provider-owned session tokens. The
native API path does not reinterpret consumer subscriptions as API access.

Vertex AI, Amazon Bedrock, and Azure AI/Foundry IAM are not dedicated runtime
adapters. Custom can target a compatible endpoint only when ordinary optional
Bearer authentication is sufficient; it does not implement cloud IAM,
SigV4/request signing, service accounts, or provider-specific regional routing.

Mission coordination is compiled independently of provider transport. The
portable compiler binds each worker to the authenticated selected Plan revision,
preserves its dependency DAG, requires an explicit `all`, `any`, or quorum join
for every multi-source step, and clamps total and concurrent work to the saved
budgets. A deterministic evaluator derives only which workers or reference-only
aggregations are ready; it does not grant tools, select credentials, evaluate
acceptance, or treat model output as authority. Native persistence and execution
must still revalidate the exact route, grants, approvals, journal head, and owner
before any worker or tool crosses a runtime boundary. The current desktop
parallel journey remains a fixed native composition while that general native
orchestrator is completed.

## Schedules And Commands

The composer parses `/remember`, `/goal`, `/plan`, and `/schedule` through the
provider-neutral command layer in `@fable/connectors`. `/goal` and `/plan`
create local structured state and, when a backend is connected, submit a
follow-up prompt through the same `AgentBackend` run path as normal composer
messages. `/schedule` creates a validated one-time or recurring schedule while
the legacy writer is selected. After an explicit proved cutover it creates a
canonical Routine instead. Legacy schedules retain their captured
backend/model/permission route and fail closed if it is no longer runnable.
Canonical Routines resolve the current provider and model at execution time
inside their saved no-expansion policy. A deliberate pin without exact native
route evidence fails closed rather than silently changing provider, billing,
privacy, credential, or placement boundaries.

The Tauri scheduler has a single workspace writer selected by a monotonic epoch
and fresh fence. The legacy writer leases queue records. The canonical Routine
writer evaluates durable trigger cursors, appends deduplicated occurrences, and
leases exact driver records to the same headless scheduled-agent hook. Driver
renewal and settlement require the occurrence, epoch, lease token, run id, and
attempt number to match; expired work recovers with bounded retry. SQLite schema
v34 stores both paths. Scheduled prompts use the same adapter contract as
interactive prompts, so native API, Codex app-server, and ACP runs share
cancellation, blocked-auth handling, and approval boundaries. Local schedules
do not require Convex, but the target product still requires a Fable account.

Reconciliation and a transactional authority transition prevent the legacy
scheduler and Routine scheduler from both writing. Legacy records without exact
persisted member ownership quarantine instead of inheriting the active session
identity.

Rollback after canonical execution is a data bridge, not just a writer toggle.
Within one encrypted transaction Fable requires every active Routine to remain
the exact unchanged result of one owner-qualified schedule migration, requires
every driver occurrence to be terminal, writes a content-free terminal reference
into that legacy job's history, and advances its last-run cursor. Only then does
the monotonic scheduler epoch move through rollback to the restored legacy
writer. Canonical-only, edited, ambiguous, in-flight, or cross-owner work blocks
the transition.

The `/schedule` command and visible Scheduled Task form resolve that same writer
before creation. After cutover they translate one-time, daily, weekly, or
monthly input into the canonical time-trigger contract; before cutover they use
the legacy job path. The Routine editor round-trips those same recurrence
details, and a successful ordinary chat response can open a transient Routine
draft without persisting it before explicit save.

The canonical native driver also evaluates bounded five-field cron recurrence
in the Routine timezone. Numeric fields, lists, ranges, steps, month/weekday
aliases, standard day-of-month/weekday matching, cutoffs, missed-run policy, and
DST all reuse the same encrypted cursor, occurrence deduplication, lease, and
writer-fence path. Unsupported extensions or malformed fields fail closed. The
calm Scheduled Task form intentionally remains on one-time, daily, weekly, and
monthly choices; cron is currently an expert/native contract rather than a
second scheduling UI.

For records created after this boundary, native commands overwrite renderer
identity and stamp the authenticated workspace, project, member, and creator on
the schedule and immutable workflow version. Queue occurrences and workflow runs
carry the same evidence forward. Existing exact identity is immutable; missing
legacy identity is not backfilled. Scheduler commands authenticate renderer
workspace/project assertions, and production workflow writes require the
encrypted store rather than degrading to JSON.

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
- Every external write capability must be marked consequential. The shared runtime rejects non-consequential write declarations and requires a fresh matching per-action approval record before calling an adapter. Connector action preparation and execution also re-check the captured workspace permission profile, so read-only workspaces cannot prepare or run connector writes.

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
explicitly non-generation models. Compatible discovered generation models can
be selected without first appearing in Fable's curated catalogue. The curated
catalogue remains the fallback when discovery cannot run or the provider does
not expose a compatible model-list endpoint; live account entitlement
validation still depends on the provider response.

See [Native Agent Runtime](native-runtime.md) for discovery, recovery, retry,
limits, and tool-safety contracts.

See [Connectors](connectors.md) for scopes, callbacks, credential ownership, and external provider-console work.

See [Browser Automation Architecture](../architecture/browser-automation.md) for the permission policy architecture, session derivation boundaries, risk-level mapping, and audit redaction rules.


## Offline Behavior

- Composer drafts, selected context, imported knowledge, durable memory, approval audit history, and connector health cache stay local.
- Plugin actions requiring network or missing credentials queue as resumable jobs.
- Recovered native runs are marked interrupted, retain partial
  transcript/usage/exchanges/pending approval identifiers, and expose an
  explicit retry-from-prompt action.

The desktop runtime persists non-secret approval, run, connector-account, and snapshot metadata in the Tauri app data folder. Credentials and OAuth tokens use OS secure storage. Session approval grants remain ephemeral, while high-risk full-access approvals fail closed unless the required confirmation phrase is provided.

The Tauri runtime initializes encrypted SQLite before commands, migrates legacy
JSON idempotently, and routes production documents (including schedules, workflows,
and knowledge structures) through the native store. Credentials remain in OS secure storage. See
[Encrypted local storage](../architecture/encrypted-storage.md).

A future paired mobile device is a second approval, observation, and schedule-control
surface. The current build exposes honest local status and fail-closed command
boundaries, but no live LAN transport or pairing. There is no hosted account
requirement; mobile decisions can only feed the existing approval queue, and
secret-derived pairing material must stay inside the native transport. See
[Mobile remote control](../architecture/mobile-remote.md).

## Selective TokenMaxxer Reuse

Fable inspected [joshuasknott/tokenmaxxer](https://github.com/joshuasknott/tokenmaxxer) and reused the compatible architectural ideas rather than its provider-specific usage endpoints:

- normalized provider/adapter contracts;
- credentials separated from account metadata through opaque credential references;
- refreshed token sets persisted after rotation with an expiry leeway;
- exact provider-reported token/cost data preferred over synthetic quota claims;
- provider errors normalized before crossing the UI boundary.

Fable did not reuse TokenMaxxer’s quota scraping, fixed blended cost estimates, Codex profile handling, or provider-specific reporting adapters because they do not implement Fable’s inference and connector execution requirements.

## Convex Boundary

Convex is optional. Batch 6 selected Clerk + Convex for the first shared
workspace MVP, documented in
[ADR: Optional Cloud Team Backend](../adr/2026-07-05-cloud-team-backend.md).
If `VITE_CONVEX_URL` is present, the UI can initialize a Convex client for
realtime shared state. The first collaboration schema and synchronization slice
now implements hosted membership lifecycle, shared-project authority, immutable
revision history, and the authenticated native encrypted cache/outbox adapter.
Production deployment, live multi-session validation, and a realtime desktop
consumer remain open. Without Convex, the core desktop workspace, local files,
approvals, runtime snapshots, memory controls, schedules, and API-key providers
remain usable.

Solo workspaces remain authoritative in encrypted local SQLite. Shared
workspaces use Convex as the shared authority only after explicit enrollment,
with a local encrypted cache/outbox, workspace-scoped authorization, device
linking, idempotency keys, revision cursors, deterministic conflict handling,
and tombstones. Connector OAuth remains separate from Clerk identity and the
confidential auth broker remains limited to authorize, callback, handoff,
refresh, and revoke.
