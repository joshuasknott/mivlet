# Threat Model

## Assets

- Local files and imported knowledge.
- Credentials in OS secure storage.
- Durable memory and user preferences.
- Approval audit history.
- Connector tokens and external service data.
- Generated artifacts and published work.

## Trust Boundaries

- User interface to Rust runtime.
- Runtime to local filesystem.
- Runtime to external connectors.
- Runtime to Convex shared state.
- Model-generated content to trusted user action.
- Auth broker to native desktop token exchange.
- Native execution permit store to side-effecting tool/connector commands.

## Key Risks

- Prompt injection through imported documents or web content.
- Accidental publish/write/delete through a connector.
- Memory poisoning from untrusted or stale sources.
- Credential leakage through logs, screenshots, artifacts, or PRs.
- Lost state after restart during a pending approval.
- Forged, replayed, or argument-substituted approval requests.
- OAuth callback interception, state confusion, or PKCE verifier leakage.
- Refresh-token replay or accidental token persistence in ordinary app state.
- Provider retry storms and duplicated writes after ambiguous failures.

## Controls

- User-facing read-only, trusted, and full-with-approvals profiles mapped onto
  the stable `read-only`, `trusted-scope`, and `full-access` protocol modes.
- Consequence summaries before consequential actions.
- Approve once, session, rule, modify, and deny outcomes.
- Stronger confirmation for destructive, public, or financial actions.
- Memory provenance, freshness, permissions, and fact/inference separation.
- Connector health and permission review before execution.
- Explicit fixture states; missing provider configuration never appears connected.
- Provider content is normalized as untrusted KnowledgeSource data and cannot enter durable memory without approval.
- Retrieval excludes disabled, deleted, stale, failed, disconnected, and
  out-of-scope sources before agent context is assembled. A pin changes
  selection priority, not trust.
- Local imports retain provenance and bounded previews. Recursive folder import
  is capped, and unsupported or oversized files fail closed.
- Durable memory is never inferred directly from imported content. Promotion is
  explicit and audited; disabled or forgotten memory is excluded from future
  agent context.
- Connector client secrets and signing material stay in an auth broker; access and refresh tokens stay behind an OS secure-storage boundary.
- Connector logs/errors redact authorization headers, cookies, tokens, raw payloads, email bodies, Slack messages, and imported Drive/Notion content.
- OAuth uses high-entropy state and PKCE S256. Pending verifiers are stored in the OS credential store, callbacks require exact state, and plain HTTP redirects are restricted to literal loopback IP addresses.
- The auth broker is required only for confidential-client or provider-installation flows. It has no model endpoint and no authority to execute connector actions.
- General approval UI state is not execution authority. Native approval resolution writes a fingerprinted execution permit; the Rust side-effect boundary requires an exact, unconsumed permit.
- Native tools recheck the registered permission/risk policy, active profile,
  and exact argument preview. File operations remain workspace-confined.
- Connector writes always require a fresh per-action record containing connector, account, proposed action, target, human-readable preview, risk, result, timestamps, actor, request/run correlation, and normalized failure code. Preparation and execution fail closed when the captured profile is read-only or otherwise does not allow connector writes.
- Schedules capture the selected backend, model, and permission route at
  creation time. Read-only routes cannot create or execute scheduled runs, and
  pinned routes fail closed rather than silently switching backend.
- Adapters cannot downgrade writes to non-consequential operations: the shared connector runtime rejects any external write capability that is not declared consequential.
- Native provider retries are bounded and limited to connection failures, rate limits, and server failures. Connector writes are not blindly replayed after an ambiguous provider success.
- Agent runs and connector state persist only non-secret metadata. Interrupted runs are marked recoverable after restart; an old approval permit cannot be replayed.

## Remaining Security Work

- Deploy and independently review the auth broker before enabling confidential-client providers.
- Add provider-specific redirect allowlists, webhook verification, and token audience/issuer validation as each live adapter is implemented.
- Continue review of the encrypted SQLite schema and recovery UX as new Goal 8
  domains are integrated; do not create a competing persistence layer.
- Add platform CI for macOS Keychain and Linux Secret Service; Windows and mock-store coverage alone is insufficient for release confidence.
- Add outbound network policy controls and SSRF protection before broadening `web-fetch` beyond the current explicit approval and HTTP(S) checks.
