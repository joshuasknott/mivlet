# Connections

Fable calls model providers, service connectors, MCP servers, and local files
Connections. A Connection is available only after the native desktop boundary
proves its configuration and authorization. Missing credentials never produce
sample results or a synthetic connected state.

## Model providers

The supported catalogue is intentionally small:

| Connection | Method                             | Runtime                           |
| ---------- | ---------------------------------- | --------------------------------- |
| Codex      | Official ChatGPT browser sign-in   | Codex app-server                  |
| OpenAI     | API key                            | Native OpenAI-compatible adapter  |
| Anthropic  | API key                            | Native Anthropic Messages adapter |
| Gemini     | API key                            | Native Gemini adapter             |
| xAI        | API key                            | Native OpenAI-compatible adapter  |
| Custom API | API key, HTTPS base URL, and model | Native OpenAI-compatible adapter  |

Codex owns its browser session. API credentials stay in the operating-system
credential store and enter outbound requests only inside Rust. Fable does not
accept browser cookies, private session tokens, or CLI login as a normal
connection method. A consumer subscription is not treated as an API key.

Custom endpoints must use HTTPS except for loopback development. URLs with
user info, query strings, or fragments are rejected. Every connection is
verified before onboarding can finish.

## Service connectors

Local Files is available through the native file boundary. The remote
connector catalogue contains GitHub, Vercel, Google Drive, Notion, Gmail,
Slack, Google Calendar, and Linear. These integrations are
configuration-gated source code, not evidence of a deployed or provider-
certified service.

| Connector family                      | Authorization boundary             |
| ------------------------------------- | ---------------------------------- |
| Google Drive, Gmail, Calendar         | Public desktop OAuth with PKCE     |
| GitHub, Vercel, Linear, Notion, Slack | Separate confidential OAuth broker |

Google needs `FABLE_GOOGLE_OAUTH_CLIENT_ID`. Confidential connectors need
`FABLE_AUTH_BROKER_URL` plus the matching provider credentials at the broker.
The checked-in templates at `apps/desktop/.env.example`,
`apps/broker/.env.example`, and `apps/broker/.dev.vars.example` are the current
configuration reference.

The native status response is authoritative. Search, import, account switching,
and provider actions remain unavailable until the exact workspace Connection is
connected, healthy enough for the operation, and granted the required scope.
Provider mutations additionally require a fresh approval bound to the exact
account, request, workspace, and action. A denied, expired, replayed, changed,
or mismatched approval fails before egress.

Disconnect attempts provider revocation where supported, removes local
credential access, and invalidates knowledge tied to that exact Connection.
Provider account identifiers are display metadata, never authorization.

## Confidential OAuth broker

The broker has one job: complete confidential connector OAuth without exposing
client secrets to the desktop. Its public surface is limited to health plus
authorize, callback, single-use handoff, refresh, and revoke routes. It contains
no waitlist, account, model-provider, sync, or product-data endpoints.

Pending authorization state, handoff tickets, and rate limits may use memory in
local development and tests. Staging or production must use the encrypted
Durable Object binding declared in `apps/broker/wrangler.jsonc`; deployment
without durable storage or its encryption key fails closed. The broker never
stores long-lived user tokens after handoff.

The desktop callback is an ephemeral loopback URL or an explicitly allowed
HTTPS URL. State and handoff tickets are short-lived and single-use. Logs and
responses are redacted, request bodies are bounded, and every OAuth route is
rate-limited.

See the [broker storage decision](../adr/2026-07-03-broker-ephemeral-storage.md)
and [threat model](../security/threat-model.md) for the security boundary.

## MCP

MCP servers are optional Connections behind the same credential and approval
rules. A server must be explicitly configured and must complete capability
discovery before its tools can appear. Unknown tools, untrusted metadata,
oversized payloads, missing authorization, and consequential calls without an
exact approval fail closed.

## Evidence boundary

Unit and integration tests use controlled provider responses. They prove
request shaping, scope checks, token custody, redaction, approval enforcement,
and error handling. They do not prove live provider credentials, certification,
entitlement, deployment, quotas, billing, or current third-party behavior.
