# Auth broker contract

## Status: implemented, not deployed

This repository contains the portable Node/TypeScript auth broker in
`apps/broker`. It is buildable and tested, but it has not been deployed or
independently reviewed for external use.

**Cloudflare Workers** is the chosen production target host environment for the Fable auth broker. The core broker logic is implemented in a platform-agnostic way (`FableBroker` in `apps/broker/src/broker.ts`), allowing it to run within a Cloudflare Workers isolate or be wrapped in a Node.js HTTP server.

Deploying, configuring, and independently reviewing the broker is explicitly a
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

The broker is **not** a general connector gateway, API proxy, or aggregator. It does not intercept or proxy any model/inference calls, searches, imports, or mutations. Once the desktop client resolves an access token, it communicates directly with the provider APIs.

### The broker responsibilities (confidential OAuth only)

- **Authorization start** — `GET /oauth/{provider}/authorize`: Begin the authorization-code flow using the provider's confidential client, returning an authorization URL (or redirecting) with a Fable-supplied PKCE challenge, state, and the desktop redirect URI.
- **Authorization callback** — `GET /oauth/{provider}/callback`: The provider redirects the user's browser back to this endpoint with a temporary authorization code and state. The broker consumes the state, performs the confidential client exchange with the provider, resolves the account identity, issues a single-use handoff ticket, and redirects the browser back to the desktop app.
- **Token exchange (handoff)** — `POST /oauth/{provider}/handoff`: Direct POST from the desktop client. The desktop redeems the single-use handoff ticket for the final access/refresh tokens and normalized account identity.
- **Token refresh** — `POST /oauth/{provider}/refresh`: Direct POST from the desktop client. Rotates an expiring access token using the refresh token and confidential client credentials.
- **Revocation** — `POST /oauth/{provider}/revoke`: Direct POST from the desktop client. Revokes the access/refresh token at the provider during a desktop disconnect.
- **Identity resolution (Internal)**: The broker resolves the connected account's stable ID, display name, handle, email, workspace, and avatar from the provider's userinfo/identity API. This resolution is performed **internally** by the broker during the callback handler and returned to the desktop during handoff redemption; it is not exposed as a public route.

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

## Cloudflare Workers Target Setup

For production, the broker is deployed to Cloudflare Workers. 

### Worker Entrypoint
The core logic in `FableBroker` is wrapped in an ES module fetch handler (e.g. using Hono or raw Request/Response routing). The entrypoint instantiates `FableBroker` passing in the Cloudflare `env` bindings:

```typescript
export default {
  async fetch(request, env, ctx) {
    const publicBaseUrl = env.FABLE_BROKER_PUBLIC_URL;
    const broker = new FableBroker({ env, publicBaseUrl });
    // route and dispatch to broker.authorize(), broker.callback(), etc.
  }
}
```

### Wrangler Configuration (`wrangler.toml` / `wrangler.json`)
The worker is configured and deployed using Wrangler, the Cloudflare Workers CLI. A typical `wrangler.toml` contains:

```toml
name = "fable-auth-broker"
main = "src/index.ts"
compatibility_date = "2026-06-30"
compatibility_flags = [ "nodejs_compat" ] # Required for Node compatibility if using Node HTTP helpers

[vars]
FABLE_BROKER_PUBLIC_URL = "https://fable-auth-broker.<your-subdomain>.workers.dev/"
FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS = ""
FABLE_BROKER_RATE_LIMIT_PER_MINUTE = "60"
```

### Secret Management
Confidential client secrets from the provider consoles must never be committed to repository files. Register them in the Cloudflare Worker production environment using Wrangler:

```bash
wrangler secret put FABLE_BROKER_GITHUB_CLIENT_SECRET
wrangler secret put FABLE_BROKER_VERCEL_CLIENT_SECRET
wrangler secret put FABLE_BROKER_LINEAR_CLIENT_SECRET
wrangler secret put FABLE_BROKER_NOTION_CLIENT_SECRET
wrangler secret put FABLE_BROKER_SLACK_CLIENT_SECRET
```

## Local Development Steps

### Option A: Emulated Worker Environment (Wrangler)
To run a local emulation of the Cloudflare Worker environment:
1. Copy `.env.example` to `apps/broker/.dev.vars` (Wrangler uses `.dev.vars` to load environment variables locally).
2. Populate the client IDs and secrets for local testing.
3. Start the Wrangler dev server:
   ```bash
   pnpm wrangler dev
   ```
   This serves the broker at `http://127.0.0.1:8788`.
4. Point the desktop app to the local broker:
   ```bash
   FABLE_AUTH_BROKER_URL=http://127.0.0.1:8788
   ```

### Option B: Standalone Node.js Server
Alternatively, developers can run the bundled Node.js server wrapper locally:
1. Copy `.env.example` to `apps/broker/.env`.
2. Populate the client IDs and secrets.
3. Start the dev script:
   ```bash
   pnpm --filter @fable/broker dev
   ```
   This builds and starts the Node.js server at `http://127.0.0.1:8788`.

## Expected Environment Variables & Secrets

The broker expects the following environment variables (which are loaded from process environment in Node or from environment bindings in Cloudflare Workers):

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `FABLE_BROKER_PUBLIC_URL` | Public Var | The public base URL of the broker (e.g. `https://fable-auth-broker.workers.dev/`). |
| `FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS` | Public Var | Comma-separated list of allowed non-loopback desktop redirect URLs (optional). |
| `FABLE_BROKER_RATE_LIMIT_PER_MINUTE` | Public Var | Rate limit threshold per peer and route (default: `60`). |
| `FABLE_BROKER_PORT` / `FABLE_BROKER_HOST` | Public Var | Bind settings for the local Node.js fallback server. |
| `FABLE_BROKER_<PROVIDER>_CLIENT_ID` | Secret | Public client ID registered in the provider's developer console. |
| `FABLE_BROKER_<PROVIDER>_CLIENT_SECRET` | Secret | Confidential client secret registered in the provider's developer console. |

*Note: Replace `<PROVIDER>` with `GITHUB`, `VERCEL`, `LINEAR`, `NOTION`, or `SLACK`.*

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

Similarly, if the broker receives a request for a provider whose client credentials (`FABLE_BROKER_<PROVIDER>_CLIENT_ID` or `FABLE_BROKER_<PROVIDER>_CLIENT_SECRET`) are missing from its env environment bindings, the broker **fails closed** by throwing a `configuration-required` error (which returns a HTTP 503 to the desktop), indicating that the provider is not configured.

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

## Provider OAuth Callback URL Guidance

In the developer consoles of the supported confidential OAuth providers, you must register the callback URL that routes to the auth broker. 

The callback URL pattern is structured as:
`https://<your-broker-domain>/oauth/<provider>/callback`

For example:
- **GitHub App:** `https://<your-broker-domain>/oauth/github/callback`
- **Vercel Integration:** `https://<your-broker-domain>/oauth/vercel/callback`
- **Linear Application:** `https://<your-broker-domain>/oauth/linear/callback`
- **Notion Public Integration:** `https://<your-broker-domain>/oauth/notion/callback`
- **Slack App:** `https://<your-broker-domain>/oauth/slack/callback`

*Note: Replace `<your-broker-domain>` with your actual Cloudflare Workers public origin (e.g. `fable-auth-broker.workers.dev` or a custom HTTPS domain bound to the worker).*

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

