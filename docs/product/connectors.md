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
| Claude     | Official Claude browser sign-in    | Restricted Claude CLI JSON stream|
| OpenAI     | API key                            | Native OpenAI-compatible adapter  |
| Anthropic  | API key                            | Native Anthropic Messages adapter |
| Antigravity| Official Google browser sign-in    | Google Antigravity ACP agent      |
| Cursor     | Official Cursor browser sign-in    | Cursor ACP agent                  |
| Grok       | Official Grok browser sign-in      | Grok ACP agent                    |
| OpenCode   | Existing OpenCode provider config  | Restricted OpenCode JSON stream   |
| xAI        | API key                            | Native OpenAI-compatible adapter  |
| Custom API | API key, HTTPS base URL, and model | Native OpenAI-compatible adapter  |

Codex owns its browser session. Antigravity owns its Google session in an
account-scoped local profile and exposes model turns through ACP; Fable pins
and verifies the downloaded agent, strips ambient Google credentials, and
mediates every ACP permission request. Cursor and Grok likewise own their
sessions and expose turns through ACP, but their official runtimes must be
installed separately. Claude and OpenCode run in deliberately restricted
conversation modes: tools are disabled or denied until their native permission
surfaces can be mediated by Fable. API credentials stay in the operating-system
credential store and enter outbound requests only inside Rust. Fable does not
accept browser cookies or private session tokens. A consumer subscription is
not treated as an API key.

Custom endpoints must use HTTPS except for loopback development. URLs with
user info, query strings, or fragments are rejected. Every connection is
verified before onboarding can finish. The managed Antigravity installer is
currently available on Windows x64; other platforms fail closed. The other
provider-owned runtimes are detected from their official local installations
and fail closed when missing, signed out, or unconfigured.

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

Google needs `FABLE_GOOGLE_OAUTH_CLIENT_ID` and
`FABLE_GOOGLE_OAUTH_CLIENT_SECRET`; the secret stays in the ignored local
environment and enters only the native token exchange. Confidential connectors
need `FABLE_AUTH_BROKER_URL` plus the matching provider credentials at the broker.
The checked-in templates at `apps/desktop/.env.example`,
`apps/broker/.env.example`, and `apps/broker/.dev.vars.example` are the current
configuration reference.

The native status response is authoritative. Search, import, account switching,
and provider actions remain unavailable until the exact workspace Connection is
connected, healthy enough for the operation, and granted the required scope.
Provider mutations additionally require a fresh approval bound to the exact
account, request, workspace, and action. A denied, expired, replayed, changed,
or mismatched approval fails before egress.

The desktop marketplace is opened from the compact Connectors row at the bottom
of the teammate sidebar. Its Plugins and Skills switcher keeps app Connections
separate from repeatable work learned by a teammate. Connected apps appear in
Installed, selected catalogue entries repeat in Recommended and capability
sections, and search covers names, descriptions, permissions, and section names.
Broader product, engineering, data, sales, marketing, commerce, finance, legal,
people, operations, and research entries are discovery-only until a native
manifest exists. They are labelled Planned and cannot begin authorization,
appear installed, or become available to a teammate.

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
