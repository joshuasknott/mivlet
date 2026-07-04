# Auth broker contract

## Status: implemented foundation; not production-ready

This repository contains the portable TypeScript auth broker in `apps/broker`. The auth broker is buildable and configured targeting Cloudflare Workers (`src/worker.ts` + `wrangler.jsonc`) as the primary host. 

The broker targets Cloudflare Workers but is not deployed or production-ready in
this repository. The default storage backend is process-local memory for local
determinism. Durable Object classes, Worker bindings, migrations, encryption
helpers, and contract tests exist for pending authorization state, one-time
handoffs, and rate limiting behind `FABLE_BROKER_STORAGE_BACKEND=durable`; that
mode still requires a deployed Worker, Durable Object bindings, and
`FABLE_BROKER_STORE_ENCRYPTION_KEY`. Until an operator deploys the broker and
registers its callback URLs in each provider console (including a GitHub OAuth
App and Vercel Integration), confidential-client connectors fail closed with
`configuration-required`.

The broker core (routing, CORS, rate limiting, contract validation, the
confidential OAuth lifecycle, and all redacted error handling) is
runtime-neutral: it uses only the Web Crypto API and standard
`Request`/`Response`, and both transports delegate to one shared
`src/router.ts`. Provider-specific differences (token/identity/revoke endpoint
shapes, PKCE mode, identity normalization) are isolated in
`src/provider-profiles.ts`.

The implemented version-1 browser protocol is authoritative: `authorize`
redirects to the provider, the provider returns to the broker `callback`, and
the broker redirects an opaque ticket to the desktop for one-time `handoff`
redemption. Direct desktop operations use `refresh` and `revoke`. The earlier
`token` and `identity` route sketch is superseded by this handoff protocol.

Deploying, configuring, and independently reviewing the broker is explicitly a
separate release task (see [Roadmap](../product/roadmap.md) Milestone 3 and
[Threat model](../security/threat-model.md) "Remaining security work"). Until a
broker is deployed and its callback URLs are registered in each provider
console, **no confidential-client connector can be connected**. The desktop
runtime already enforces this by failing closed — see the "Fail-closed
configuration" section.

The core desktop workspace does **not** require the broker. Local files, memory,
approvals, the runtime snapshot, and the native API-key agent loop remain fully
usable without any hosted service. Google Drive, Gmail, and Calendar use a
separate direct desktop public-client PKCE flow and remain independent of the
broker. They fail closed only when their Google public client configuration is
missing.

## Purpose and scope

The broker exists for exactly one reason: confidential-client OAuth. Some
providers (GitHub OAuth, Vercel, Notion, Slack, Linear) require a client secret or
signing material that must never live in a desktop binary, React assets, logs,
snapshots, or local JSON state. The broker holds those secrets server-side and
performs the OAuth operations that need them.

The broker is **not** a general connector gateway, API proxy, or aggregator. It
does not intercept or proxy any model/inference calls, searches, imports, or
mutations. Once the desktop client resolves an access token, it communicates
directly with the provider APIs.

### The broker responsibilities (confidential OAuth only)

- **Authorization start** - `GET /oauth/{provider}/authorize`: begin the
  authorization-code flow using the provider's confidential client, redirecting
  to the provider authorization URL with broker-managed PKCE where required,
  state, and the exact desktop redirect URI.
- **Authorization callback** - `GET /oauth/{provider}/callback`: receive the
  provider callback, consume the single-use state, perform the confidential
  token exchange, resolve identity, issue a short-lived handoff ticket, and
  redirect back to the desktop callback with only `handoff` and `state`.
- **Token handoff** - `POST /oauth/{provider}/handoff`: direct desktop POST that
  redeems the single-use handoff ticket for the token set and normalized account
  identity.
- **Token refresh** - `POST /oauth/{provider}/refresh`: rotate an expiring
  access token using the refresh token and confidential client credentials.
- **Revocation** - `POST /oauth/{provider}/revoke`: revoke the access/refresh
  token at the provider during a desktop disconnect.
- **Identity resolution (internal)**: resolve the connected account's stable ID,
  display name, handle, email, workspace, and avatar during callback handling.
  There is no public identity route.

The desktop resolves exactly the OAuth routes above from the broker base URL via
`resolve_broker_endpoints` in `connector_auth.rs`. No connector data route is
derivable.

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
- **Local Files, memory, approvals, and the runtime snapshot** are entirely
  local and have no external auth.

The broker is required only by confidential OAuth connectors: **github, vercel,
notion, slack, linear**. This set is pinned in code
(`BROKER_REQUIRED_CONNECTOR_IDS`) and verified by tests.

## Cloudflare Workers target setup

For production, the broker is configured by `apps/broker/wrangler.jsonc` and
deployed with Wrangler. The Worker entrypoint is `apps/broker/src/worker.ts`;
the Node HTTP wrapper is not imported by the Worker bundle.

The checked-in Worker config currently sets:

- `name`: `fable-auth-broker`
- `main`: `src/worker.ts`
- `compatibility_date`: `2026-06-30`
- `observability.enabled`: `true`
- `FABLE_BROKER_RATE_LIMIT_PER_MINUTE`: `60`
- required secret binding: `FABLE_BROKER_PUBLIC_URL`

The Worker intentionally does not enable `nodejs_compat`; shared broker code
uses Web platform APIs (`fetch`, `Request`, `Response`, Web Crypto) so the
Worker path does not depend on Node's HTTP server, `Buffer`, or `node:crypto`.

### Secret management

Confidential client configuration from provider consoles must never be committed
to repository files. Register production values in the Cloudflare Worker
environment using Wrangler:

```bash
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_PUBLIC_URL
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_GITHUB_CLIENT_ID
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_GITHUB_CLIENT_SECRET
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_VERCEL_CLIENT_ID
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_VERCEL_CLIENT_SECRET
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_LINEAR_CLIENT_ID
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_LINEAR_CLIENT_SECRET
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_NOTION_CLIENT_ID
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_NOTION_CLIENT_SECRET
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_SLACK_CLIENT_ID
pnpm --filter @fable/broker wrangler secret put FABLE_BROKER_SLACK_CLIENT_SECRET
```

Provider client IDs are not OAuth secrets, but they are environment-specific
broker configuration. Keep them out of committed files; use Worker env bindings
or secrets.

## Local development steps

### Option A: emulated Worker environment

1. Copy `apps/broker/.dev.vars.example` to `apps/broker/.dev.vars`.
2. Populate `FABLE_BROKER_PUBLIC_URL` and the client ID/secret pair for each
   provider you are testing.
3. Start the Wrangler dev server:
   ```bash
   pnpm --filter @fable/broker worker:dev
   ```
4. Point the desktop app to the local broker:
   ```bash
   FABLE_AUTH_BROKER_URL=http://127.0.0.1:8788
   ```

### Option B: standalone Node.js server

1. Export the variables from `apps/broker/.env.example` in your shell or load
   them with local env tooling.
2. Populate the client ID and secret pair for each provider you are testing.
3. Start the dev script:
   ```bash
   pnpm --filter @fable/broker dev
   ```

## Expected environment variables and secrets

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `FABLE_BROKER_PUBLIC_URL` | Public var / Worker secret binding | The public base URL of the broker, for example `https://fable-auth-broker.workers.dev/`. Required by the Worker. |
| `FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS` | Public var | Comma-separated list of allowed non-loopback desktop redirect URLs. Optional. |
| `FABLE_BROKER_RATE_LIMIT_PER_MINUTE` | Public var | Rate limit threshold per peer and route. Defaults to `60`. |
| `FABLE_BROKER_STORAGE_BACKEND` | Public var | `memory` by default; set to `durable` only for Worker deployments with Durable Object bindings. |
| `FABLE_BROKER_STORE_ENCRYPTION_KEY` | Secret | Required only when `FABLE_BROKER_STORAGE_BACKEND=durable`; 32-byte base64url root secret for broker ephemeral-store encryption. |
| `FABLE_BROKER_PORT` / `FABLE_BROKER_HOST` | Public var | Bind settings for the local Node.js fallback server. |
| `FABLE_BROKER_<PROVIDER>_CLIENT_ID` | Secret/config | Client ID registered in the provider developer console. |
| `FABLE_BROKER_<PROVIDER>_CLIENT_SECRET` | Secret | Confidential client secret registered in the provider developer console. |

Replace `<PROVIDER>` with `GITHUB`, `VERCEL`, `LINEAR`, `NOTION`, or `SLACK`.

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
which owns the provider callback and returns an opaque handoff ticket plus state
to the exact desktop loopback redirect. The desktop then redeems that handoff
through the broker without exposing tokens to JavaScript.

Similarly, if the broker receives a request for a provider whose client
credentials (`FABLE_BROKER_<PROVIDER>_CLIENT_ID` or
`FABLE_BROKER_<PROVIDER>_CLIENT_SECRET`) are missing from its environment
bindings, the broker fails closed with a `configuration-required` error (HTTP
503). The Cloudflare Worker entrypoint also fails closed if
`FABLE_BROKER_PUBLIC_URL` is missing or malformed, because provider callback
URLs must be registered against the public Worker origin.

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
- `google_connectors_are_direct_public_pkce`
- `broker_resolver_fail_closed_keeps_core_workspace_usable`

## Deployment prerequisites (future)

Before the broker is enabled for external production use, it must, at minimum:

1. Store client secrets and signing material in its own server-side secret store
   (never in repo config, never shipped to the desktop).
2. Run durable storage mode for external Worker deployments, with Durable Object
   bindings and `FABLE_BROKER_STORE_ENCRYPTION_KEY` configured.
3. Return only a short-lived handoff ticket and state to the exact desktop
   redirect URI it was given. Long-lived desktop-scoped sessions are forbidden.
4. Be deployed behind HTTPS with registered callback URLs in each provider
   console.
5. Undergo independent security review before confidential-client providers are
   enabled for external users.

Provider console creation, consent screens, distribution review, and Google
restricted-scope verification remain external setup tasks independent of the
broker.

## Deployment targets

The broker has two interchangeable transport targets over one runtime-neutral
core:

- **Node.js** — `src/server.ts` reads `process.env`, binds a loopback (dev) or
  `0.0.0.0` (production, behind an HTTPS reverse proxy) socket via `node:http`,
  and adapts each `IncomingMessage`/`ServerResponse` to the shared router. Run
  locally with `pnpm --filter @fable/broker dev`.
- **Cloudflare Workers** — `src/worker.ts` is the fetch handler. It reads the
  Worker `env` binding, builds a `FableBroker`, and routes every inbound
  `Request` through the same shared `src/router.ts`. Build with
  `pnpm --filter @fable/broker build` and deploy with
  `pnpm --filter @fable/broker worker:deploy` (configuration in
  `apps/broker/wrangler.jsonc`).

Both targets share `src/router.ts` (routing, CORS, rate limiting, correlation
ids, contract version gating, body parsing, structured redacted error
responses), `src/broker.ts` (the confidential OAuth lifecycle), and
`src/provider-client.ts` (code exchange, refresh, revoke, identity). The core
uses only the Web Crypto API (`globalThis.crypto`) and standard
`Request`/`Response` — no Node `Buffer` or `node:crypto` — so the lifecycle is
identical on both runtimes.

### Lifecycle behavior

Each operation fails closed on any validation failure and surfaces only a
human-safe, redacted `BrokerErrorResponse` (never a secret, token, or raw
provider diagnostic):

- **`authorize`** — validates the contract version, provider, and that the
  provider is configured (else `configuration-required`, HTTP 503); validates
  the desktop `redirect_uri` against the narrow loopback/exact-HTTPS allowlist
  (else `invalid-request`, 400); stores a single-use pending exchange keyed by
  the desktop `state`; returns the provider authorization URL.
- **`callback`** — a provider `error` param → `needs-auth` (401); missing
  `code`/`state` → `invalid-request` (400); an unknown, expired, or already-used
  `state` → `invalid-state` (400), rejected **before** any token exchange; a
  provider/`state` mismatch → `invalid-state` (400). On success it performs the
  confidential exchange, resolves identity, issues a single-use ≤60s handoff
  bound to `state`, and 302-redirects to the exact desktop `redirect_uri` with
  only the opaque handoff + state (no token in the URL).
- **`handoff`** — validates the contract version and provider; an unknown,
  expired, or already-redeemed handoff, or a `state` mismatch, → `invalid-handoff`
  (400). Tokens cross to the desktop only here, over a direct (non-browser) call.
- **`refresh`** — rotates the token through the confidential client; provider
  401 → `needs-auth` (401, non-retryable), 429 → `rate-limited` (429, retryable),
  5xx/0 → `provider-unavailable` (502, retryable). The supplied refresh token
  never appears in the response.
- **`revoke`** — revokes at the provider; HTTP 404 / unknown-token is treated as
  success (already revoked). Non-404 failures map the same way as refresh. The
  revoked token never appears in the response. GitHub's token-grant revocation
  endpoint is keyed by client id; the `{clientId}` placeholder is substituted
  with the configured confidential client id before the call.

OAuth error responses are safe to show and log: every response is built from the
broker's own redacted messages, and the logger redacts token/secret-shaped
values (`code=`, `token=`, `access_token=`, `refresh_token=`, `client_secret=`,
`Bearer …`, and the matching JSON fields) before writing a request line. Request
bodies are never logged.

## Current deployment limitation

The implemented foundation defaults to memory storage, which is suitable for
local development and single-process tests. Cloudflare Worker durable mode is
implemented with Durable Object classes and bindings, but has not been deployed
or validated against live provider OAuth flows in this repository. Before
external production use, operators still need to enable durable mode, configure
the encryption secret, deploy the Worker, register provider callbacks, and run
live non-production OAuth validation.

## Provider OAuth callback URL guidance

In the developer consoles of supported confidential OAuth providers, register
the callback URL that routes to the auth broker:

`https://<your-broker-domain>/oauth/<provider>/callback`

Examples:

- GitHub OAuth App: `https://<your-broker-domain>/oauth/github/callback`
- Vercel Integration: `https://<your-broker-domain>/oauth/vercel/callback`
- Linear Application: `https://<your-broker-domain>/oauth/linear/callback`
- Notion Public Integration: `https://<your-broker-domain>/oauth/notion/callback`
- Slack App: `https://<your-broker-domain>/oauth/slack/callback`

Replace `<your-broker-domain>` with the Cloudflare Workers public origin or a
custom HTTPS domain bound to the Worker.
