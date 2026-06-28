# Auth broker contract

## Status: deferred

This repository does **not** contain a deployable auth broker app. The desktop
runtime is the only app in the repo (`apps/desktop`), plus the `@fable/connectors`
and `@fable/protocol` packages. There is no Cloudflare Worker, edge function, or
server project that implements the broker surface defined below.

Building, deploying, and independently reviewing the broker is explicitly a
separate release task (see [Roadmap](../product/roadmap.md) Milestone 3 and
[Threat model](../security/threat-model.md) "Remaining security work"). Until a
broker is deployed and its callback URLs are registered in each provider
console, **no confidential-client connector can be connected**. The desktop
runtime already enforces this by failing closed — see the "Fail-closed
configuration" section.

The core desktop workspace does **not** require the broker. Local files, memory,
approvals, the runtime snapshot, the native API-key agent loop, and Google
public-client (PKCE) connectors remain fully usable without any hosted service.

## Purpose and scope

The broker exists for exactly one reason: confidential-client OAuth. Some
providers (GitHub App, Vercel, Notion, Slack, Linear) require a client secret or
signing material that must never live in a desktop binary, React assets, logs,
snapshots, or local JSON state. The broker holds those secrets server-side and
performs the OAuth operations that need them.

The broker is **not** a general connector gateway, API proxy, or aggregator. It
is deliberately limited to four OAuth operations and nothing else.

### The broker MAY do (confidential OAuth only)

- **Authorization** — `GET /oauth/{provider}/authorize`: begin or resume the
  authorization-code flow using the provider's confidential client, returning an
  authorization URL (or redirecting) with Fable-supplied PKCE challenge, state,
  and the exact desktop redirect URI.
- **Token exchange** — `POST /oauth/{provider}/token`: exchange the provider
  authorization code for access/refresh tokens using the confidential client
  secret. The broker returns tokens and account identity to the desktop, which
  stores them in OS secure storage.
- **Token refresh** — `POST /oauth/{provider}/token` (grant_type=refresh_token):
  rotate an expiring access token using the refresh token and confidential
  credentials.
- **Identity** — `GET /oauth/{provider}/identity`: resolve the connected
  account's stable id, display name, handle, email, workspace, and avatar from
  the provider's userinfo/identity endpoint.
- **Revocation** — `POST /oauth/{provider}/revoke`: revoke the access/refresh
  token at the provider during a desktop disconnect.

The desktop resolves exactly these four routes from the broker base URL via
`resolve_broker_endpoints` in `connector_auth.rs`. No other route is derivable.

### The broker MUST NOT do

The broker must not proxy, terminate, observe, or log any of the following. These
operations always go **directly from the desktop to the provider API** after the
desktop resolves a usable token inside the OS credential boundary:

- **Model / inference calls.** Native API completions (OpenAI-compatible,
  Anthropic, Gemini) use the user's API key and never touch the broker. The
  broker has no `/chat`, `/messages`, `/completions`, or model endpoint.
- **Connector searches.** `search_connector` calls the provider search API
  directly with a resolved access token.
- **Connector imports.** `import_connector_item` reads provider items directly.
- **Connector actions.** `execute_approved_connector_action` writes to the
  provider directly, after the desktop's per-action approval and one-time
  execution permit.
- **Provider capability reads** (GitHub/Vercel/Linear identity, lists, etc.).

This boundary is structural, not just policy: the `BrokerEndpoints` type in
`connector_auth.rs` only exposes the four OAuth fields, and no other module in
the runtime reads `FABLE_AUTH_BROKER_URL`. Search/import/action/model egress
paths (`connector_api.rs`, `google.rs`, `collaboration_connectors.rs`,
`native_api.rs`) reference only provider API hosts.

## Local-first guarantees

These guarantees hold whether or not a broker is deployed:

- **API-key agent providers** (openai, anthropic, gemini, xai, openrouter) store
  their key in OS secure storage and call the provider directly. No broker
  dependency.
- **Google connectors** (Drive, Gmail, Calendar) are public PKCE clients. The
  desktop binds a loopback redirect, performs the code exchange directly with
  Google, and stores tokens in OS secure storage. No broker dependency.
- **Local Files, memory, approvals, and the runtime snapshot** are entirely
  local and have no external auth.

The broker is required only by the confidential-client connectors: **github,
vercel, notion, slack, linear**. This set is pinned in code
(`BROKER_REQUIRED_CONNECTOR_IDS`) and verified by tests.

## Fail-closed configuration

The desktop resolves the broker URL from the `FABLE_AUTH_BROKER_URL` environment
variable. `resolve_broker_endpoints` applies these checks, in order, and **fails
closed** on any failure with a non-retryable `configuration-required` error:

1. The variable must be present and non-empty. Missing → fail closed.
2. It must parse as a valid URL. Malformed → fail closed.
3. The scheme must be `https`, **or** `http` with a literal loopback host
   (`127.0.0.1` or `::1`) for local development. Anything else → fail closed
   ("The Fable auth broker must use HTTPS.").

A fail-closed result means the confidential connector surfaces a clear
`needs-auth` / `configuration-required` state in the UI. It never falls back to
fixtures, never claims a connected state, and never downgrades to a public
client.

The desktop uses the same exact loopback receiver for public and confidential
OAuth. For confidential providers, the authorization URL points at the broker,
which owns the provider callback and returns the final code/state to the exact
desktop loopback redirect. The desktop then completes exchange through the
broker token endpoint without exposing tokens to JavaScript.

### Why the checks are separated

`resolve_broker_endpoints` takes the URL as an argument rather than reading the
environment inline. This keeps the fail-closed logic deterministic and
unit-testable without env-var races across the parallel test process. The only
environment read (`provider_config`) feeds the validated value in; all policy
lives in the pure resolver.

## Secrets boundary

- Provider client secrets and signing material live **only** in the broker.
- Access tokens, refresh tokens, and pending PKCE verifiers live **only** in the
  desktop OS credential store (Windows Credential Manager, macOS Keychain, Linux
  Secret Service) via the `keyring` crate.
- The local connection JSON file holds only non-secret metadata: connector id,
  account summary, scope names, expiry, status, and an opaque credential
  reference.
- Secrets never appear in React state, logs, runtime errors, snapshots, or
  provider-metadata JSON. Connector text is redacted before crossing any
  boundary (see `redact_connector_text`).

## Verification

The fail-closed and non-proxying boundaries are covered by tests in
`apps/desktop/src-tauri/src/connector_auth.rs` and `tests.rs`:

- `broker_resolver_fails_closed_when_no_url_is_configured`
- `broker_resolver_fails_closed_for_non_loopback_plain_http`
- `broker_resolver_fails_closed_for_a_malformed_url`
- `broker_resolver_accepts_https_and_derives_only_oauth_paths`
- `broker_resolver_accepts_a_loopback_url_for_local_development`
- `broker_resolver_derives_no_model_search_import_or_action_endpoint`
- `only_confidential_connectors_require_the_auth_broker`
- `google_connectors_are_public_pkce_and_broker_free`
- `broker_resolver_fail_closed_keeps_core_workspace_usable`

## Deployment prerequisites (future)

When the broker is built, it must, at minimum:

1. Implement exactly the five operations above per provider, scoped to the
   provider's confidential-client flow.
2. Store client secrets and signing material in its own server-side secret store
   (never in repo config, never shipped to the desktop).
3. Return the final authorization code and state to the exact desktop redirect
   URI it was given — it must not mint its own tokens or hold long-lived
   desktop-scoped sessions.
4. Be deployed behind HTTPS with registered callback URLs in each provider
   console.
5. Undergo independent security review before confidential-client providers are
   enabled for external users.

Provider console creation, consent screens, distribution review, and Google
restricted-scope verification remain external setup tasks independent of the
broker.
