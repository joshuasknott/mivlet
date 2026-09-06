# Connections

Fable calls model providers, service connectors, MCP servers, and local files
Connections. A Connection is available only after the native desktop boundary
proves its configuration and authorization. Missing credentials never produce
sample results or a synthetic connected state.

Connected apps and approval preferences belong to the workspace, not individual
teammates. Every conversation advertises the connected native apps and saved
official remote connections. Remote tools are rediscovered and checked against
the current enabled tool list before use. Switching teammates preserves the
workspace approval preference; exact action, workspace, and freshness checks
still apply.

Packaged desktop builds include the public Google client ID and broker URL.
The Google desktop client secret is provisioned from the local native environment
into the OS credential store, scoped to its client ID; it is never bundled.
Other installations still need supported provider configuration or an official
remote connector sign-in.

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
`FABLE_GOOGLE_OAUTH_CLIENT_SECRET`; the secret is provisioned from the ignored local
environment into the OS credential store and enters only native token exchanges. Confidential connectors
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
of the teammate sidebar. Connected apps appear as compact icons in Installed;
Popular and category sections use two-column rows with expandable lists. Search
covers names, descriptions, permissions, and section names. Each implemented
connector has a detail page with usage examples, permissions, and connection
controls. Skills are specific to a teammate and live in that teammate's editor,
outside Connectors.
Official remote connection routes are also available for Notion, Linear,
Vercel, Canva, Figma, Jira, Sentry, Stripe, Miro, Cloudflare,
Granola, Airtable, Amplitude, Mixpanel, Vanta, and Ramp. These use the existing native MCP OAuth
boundary and provider-hosted endpoints; no broker client secret is required
when the provider supports public client registration. Figma client approval,
Ramp redirect allowlisting, organization policies, provider plans, data regions, and OAuth registration
requirements still apply. Each detail view links to its provider's setup guide.
Amplitude, Mixpanel, and Vanta offer region selection before saving a connection.
The endpoint registry is `apps/desktop/src/components/marketplace/remote-connectors.ts`.

Choose Connect and complete the provider's browser sign-in. Fable discovers and
enables the returned tools automatically, then shows Connected only once usable
tool access is saved. The Connect click authorizes the exact official endpoint;
its native configuration receipt is retained without a second typed confirmation.
Reopening the detail view checks existing access without restarting OAuth or
expanding a previously restricted tool list. Tools are used in conversations;
manual server configuration remains in advanced Settings.

Direct API and ChatGPT/Codex agents receive native reads and supported write
actions for connected workspace apps. Connector mentions identify the app the
person wants to use; connected apps remain available on follow-up turns. Access is
rechecked after approval and on result delivery. Native reads use the connected
account's consent without an extra approval; external writes require a fresh,
exact approval with a preview in the conversation. Connector status refreshes
after turns and when the window regains focus.
Connector mentions display an inline logo and name while retaining stable IDs
in stored messages. Codex turns disable host shell tools and provider memories;
unadvertised tool requests are declined without opening an approval card.

Direct API and ChatGPT/Codex agents can use `connector-tools` to discover enabled tool schemas
and `connector-call` to invoke them. Saved official remote connections are available
across workspace conversations without individual agent assignment. Each call rediscovers the current Connection.
Native policy recognizes a fixed list of Vercel documentation, project, deployment,
and log reads at the exact official endpoint and runs these under account consent.
Changes and unrecognized tools still require native approval bound to the exact
tool and inputs. All executions retain current account, workspace, discovery,
enablement, revision, and single-use permit checks. Server annotations and tool
name prefixes cannot grant read status. Other provider-owned runtimes still
require their own tool integration.

Entries without a native adapter or official remote route remain Planned and
cannot begin authorization or appear installed. Box and HubSpot, for example,
need separate application credentials or administrator setup; their public
MCP endpoint alone does not establish a compatible authorization flow. Intercom
remains planned because its endpoint did not publish the protected-resource
metadata required by Fable during the compatibility check.

OAuth uses the provider-advertised resource exactly, including a same-origin
root audience when published for a path-based endpoint. Stored credentials
remain bound separately to the exact transport endpoint; an origin audience
does not permit token reuse at another path.

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

ChatGPT app connections belong to ChatGPT. Signing into the same model account
does not supply those credentials or tools to Fable. Connect a native adapter or
an official remote MCP route inside Fable. Setup requests all permissions that
the implemented adapter supports; provider consent and organization restrictions
still determine access. Drive offers full read/write access as well as its
limited selected-files scope. Existing grants need reconnection to expand them.

For a local debug build, `node apps/desktop/scripts/check-connectors.mjs` runs a
bounded real read through the native executor for each connected native adapter.
Add `--chat --model <connected-model-id>` to verify actual Codex tool requests,
execution, result delivery, and completion across connected apps. Build Rust and
the connectors package first. The report contains statuses and response sizes,
not credentials or returned source content. Configured but unsigned-in apps are
reported separately. This debug-only command does not exist in release builds.

Unit and integration tests use controlled provider responses. They prove
request shaping, scope checks, token custody, redaction, approval enforcement,
and error handling. They do not prove live provider credentials, certification,
entitlement, deployment, quotas, billing, or current third-party behavior.
