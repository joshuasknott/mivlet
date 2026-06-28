# Architecture

## Stack

- Tauri 2 for the desktop shell.
- Rust for runtime commands, permissions, jobs, local context, and connector execution.
- React, TypeScript, and Vite for the interface.
- Convex for optional realtime shared state and collaboration state when configured.
- Encrypted SQLite for offline/private local state.
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

Native API credentials are BYOK. Subscription backends remain separate adapters with dynamically reported capabilities and entitlements; the native API path does not reinterpret consumer subscriptions as API access.

## Connector Runtime

`@fable/connectors` now exposes a typed adapter/runtime contract for authentication, account identity, capabilities, reads, writes, pagination, rate-limit metadata, normalized errors, token refresh, retry, revocation, and disconnection. Adapters register a closed capability set; duplicate registrations and undeclared operations fail closed.

The native connector boundary exposes status, auth start/complete/clear, health refresh, search, import, action preparation, approved-action execution, and detailed connector approval audit commands.

- Public desktop OAuth clients use Authorization Code with PKCE S256 and loopback/HTTPS callbacks.
- Access tokens, refresh tokens, and pending PKCE verifiers are stored in the OS credential store.
- Plain local connection state contains account identity, scopes, expiry, status, and an opaque credential reference only.
- GitHub, Notion, Slack, Vercel, or another provider that requires confidential credentials routes through the configured HTTPS auth broker. The broker is limited to authorization, token exchange/refresh, identity, and revocation; it is not a general connector proxy.
- Every external write capability must be marked consequential. The shared runtime rejects non-consequential write declarations and requires a fresh matching per-action approval record before calling an adapter.

Authenticated provider egress exists on the desktop path for the first-wave external connectors, but availability is gated by each connector's auth boundary. Google Drive, Gmail, and Google Calendar use public-client loopback PKCE and can run without the auth broker once Google desktop OAuth configuration is supplied. GitHub, Vercel, Notion, Slack, and Linear are confidential-client or provider-installation flows; they require the HTTPS auth broker and provider-console callback registration before users can connect them. Browser preview remains explicitly fixture-backed, and missing configuration fails closed instead of claiming a live connection.

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

Encrypted SQLite remains incomplete: current non-secret metadata uses atomic JSON files. This does not weaken credential storage, but schema migrations, cross-file transactions, and high-volume history should move to encrypted SQLite before broad production rollout.

## Selective TokenMaxxer Reuse

Fable inspected [joshuasknott/tokenmaxxer](https://github.com/joshuasknott/tokenmaxxer) and reused the compatible architectural ideas rather than its provider-specific usage endpoints:

- normalized provider/adapter contracts;
- credentials separated from account metadata through opaque credential references;
- refreshed token sets persisted after rotation with an expiry leeway;
- exact provider-reported token/cost data preferred over synthetic quota claims;
- provider errors normalized before crossing the UI boundary.

Fable did not reuse TokenMaxxer’s quota scraping, fixed blended cost estimates, Codex profile handling, or provider-specific reporting adapters because they do not implement Fable’s inference and connector execution requirements.

## Convex Boundary

Convex is optional. If `VITE_CONVEX_URL` is present, the UI can initialize a Convex client for realtime shared state. Without it, the core desktop workspace, local files, approvals, runtime snapshots, memory controls, schedules, and API-key providers remain usable.
