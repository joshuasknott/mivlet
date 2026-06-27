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

- Read-only, trusted-scope, and full-access modes.
- Consequence summaries before consequential actions.
- Approve once, session, rule, modify, and deny outcomes.
- Stronger confirmation for destructive, public, or financial actions.
- Memory provenance, freshness, permissions, and fact/inference separation.
- Connector health and permission review before execution.
- Explicit fixture states; missing provider configuration never appears connected.
- Provider content is normalized as untrusted KnowledgeSource data and cannot enter durable memory without approval.
- Connector client secrets and signing material stay in an auth broker; access and refresh tokens stay behind an OS secure-storage boundary.
- Connector logs/errors redact authorization headers, cookies, tokens, raw payloads, email bodies, Slack messages, and imported Drive/Notion content.
- OAuth uses high-entropy state and PKCE S256. Pending verifiers are stored in the OS credential store, callbacks require exact state, and plain HTTP redirects are restricted to literal loopback IP addresses.
- The auth broker is required only for confidential-client or provider-installation flows. It has no model endpoint and no authority to execute connector actions.
- General approval UI state is not execution authority. Native approval resolution writes a fingerprinted execution permit; the Rust side-effect boundary requires an exact, unconsumed permit.
- Native tools recheck the registered permission/risk policy and the exact argument preview. File operations remain workspace-confined.
- Connector writes always require a fresh per-action record containing connector, account, proposed action, target, human-readable preview, risk, result, timestamps, actor, request/run correlation, and normalized failure code.
- Adapters cannot downgrade writes to non-consequential operations: the shared connector runtime rejects any external write capability that is not declared consequential.
- Native provider retries are bounded and limited to connection failures, rate limits, and server failures. Connector writes are not blindly replayed after an ambiguous provider success.
- Agent runs and connector state persist only non-secret metadata. Interrupted runs are marked recoverable after restart; an old approval permit cannot be replayed.

## Remaining Security Work

- Deploy and independently review the auth broker before enabling confidential-client providers.
- Add provider-specific redirect allowlists, webhook verification, and token audience/issuer validation as each live adapter is implemented.
- Move non-secret JSON metadata to encrypted SQLite for transactional integrity and migrations.
- Add platform CI for macOS Keychain and Linux Secret Service; Windows and mock-store coverage alone is insufficient for release confidence.
- Add outbound network policy controls and SSRF protection before broadening `web-fetch` beyond the current explicit approval and HTTP(S) checks.
