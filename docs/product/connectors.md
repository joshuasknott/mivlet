# Plugins

Plugins is the user-facing home for app integrations. Connector and Connection
remain internal adapter and authorization terms; model providers remain separate.
A Connection is available only after the native desktop boundary
proves its configuration and authorization. Missing credentials never produce
sample results or a synthetic connected state.

Connected apps and approval preferences belong to the workspace, not individual
teammates. Every conversation advertises verified native and official remote
connections. Incomplete and disconnected setups are excluded. Remote tools are rediscovered and checked against
the current enabled tool list before use. Switching teammates preserves the
workspace approval preference; exact action, workspace, and freshness checks
still apply.

Packaged desktop builds include the public Google client ID and broker URL.
The Google desktop client secret is provisioned from the local native environment
into the OS credential store, scoped to its client ID; it is never bundled.
Other installations still need supported provider configuration or an official
remote connector sign-in.

## Model providers

The catalogue includes provider-owned account runtimes and metered direct APIs:

| Connection | Method                             | Runtime                                |
| ---------- | ---------------------------------- | -------------------------------------- |
| Codex      | Official ChatGPT browser sign-in   | Codex app-server                       |
| Claude     | Claude account via official runtime| Claude Agent SDK stdio, mediated tools |
| OpenAI     | API key                            | Embedded OpenCode host, native keys    |
| Anthropic  | API key                            | Embedded OpenCode host, native keys    |
| Antigravity| Official Google browser sign-in    | Google Antigravity ACP agent           |
| Cursor     | Official Cursor browser sign-in    | Cursor ACP agent                       |
| Grok       | Official Grok browser sign-in      | Grok ACP agent                         |
| OpenCode   | Existing OpenCode provider config  | Mivlet-owned loopback server           |
| xAI        | API key                            | Embedded OpenCode host, native keys    |
| DeepSeek   | API key                            | Embedded OpenCode host, non-thinking mode |
| Alibaba / Qwen | Model Studio API key and regional/workspace endpoint | Embedded OpenCode host, non-thinking mode |
| Moonshot / Kimi, Z.ai / GLM | API key | Embedded OpenCode host, non-thinking mode |
| Groq, Together, Fireworks, Cerebras | API key | Embedded OpenCode host, native keys |
| Mistral, OpenRouter, NVIDIA, SiliconFlow, Cohere | API key | Embedded OpenCode host, native keys |
| Custom API | API key, HTTPS base URL, and model | Embedded OpenCode host, native keys    |

Codex owns its browser session. Antigravity owns its Google session in an
account-scoped local profile and exposes model turns through ACP; Mivlet pins
and verifies the downloaded agent, strips ambient Google credentials, and
mediates every ACP permission request. Cursor and Grok likewise own their
sessions and expose turns through ACP. Claude runs Anthropic's Agent SDK
protocol, and OpenCode connects through a Mivlet-owned authenticated loopback
server with a session event stream. These four runtimes are installed
separately from their official sources and must be signed in; Mivlet routes
their tool permission requests through the same exact-approval boundary and
advertises tool, approval, and file-change capabilities only when the runtime
and account are connected. Direct API text and tool turns run on the embedded
OpenCode host bundled with the desktop app; user-image turns keep the audited
native adapter. API credentials stay in the operating-system credential store
and enter outbound requests only inside Rust. Mivlet does not accept browser
cookies or private session tokens. A consumer subscription is not treated as an
API key.

Custom endpoints must use HTTPS except for loopback development. URLs with
user info, query strings, or fragments are rejected. Every connection is
verified before onboarding can finish. The managed Antigravity installer is
currently available on Windows x64; other platforms fail closed. The other
provider-owned runtimes are detected from their official local installations
and fail closed when missing, signed out, or unconfigured; Codex additionally
requires the official Codex desktop app components. Direct API turns start only
when the bundled OpenCode host and its verified manifest are present; packaged
builds include both.

New direct providers use a short chat request (at most 16 output tokens) to
verify credentials and access to the default curated model. This can incur a
small provider charge; a public model-list response does not establish access.
Discovery preserves vendor pagination and response formats, while only curated,
audited model IDs advertise tools. The new routes currently expose text and
tools; vision, reasoning controls and structured output remain unavailable.
OpenRouter requires an upstream route that supports the requested parameters.
Alibaba credentials are bound to an allowlisted official regional or workspace
Model Studio endpoint, so a key is never redirected to another host.

## Service connectors

Local Files is available through the native file boundary. The OAuth connector
catalogue contains GitHub, Vercel, Google Drive, Notion, Gmail,
Slack, Google Calendar, and Linear, alongside the native token plugins below. These integrations are
configuration-gated source code, not evidence of a deployed or provider-
certified service.

| Connector family                      | Authorization boundary             |
| ------------------------------------- | ---------------------------------- |
| Google Drive, Gmail, Calendar         | Public desktop OAuth with PKCE     |
| GitHub, Vercel, Linear, Notion, Slack | Separate confidential OAuth broker |
| Outlook, Teams, Zoom, LinkedIn, Instagram, YouTube, Google Ads, Meta Ads, Shopify, Docusign, Greenhouse, Lever, Workday | Provider-issued API access token or API key, verified and stored by native Rust |

### Native token plugins

The 13 formerly planned integrations have a deliberately bounded first release.
Their setup pages identify permissions and account prerequisites, clear submitted
secret fields, and enable chat only after an authenticated read succeeds. Native
Rust stores credentials in the OS secure store and rechecks the selected
Connection before egress and before returning results. The `plugin-read` tool
is offered only for selected connected apps and names their implemented operations.
There is no arbitrary URL, query language, mutation, or shell endpoint.

| Plugin | Implemented reads | Official setup/API reference |
| --- | --- | --- |
| Outlook | Mail list/search, message content, events | [Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0) |
| Microsoft Teams | Chats and chat messages | [Graph chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0) |
| Zoom | Meetings, meeting details, recording metadata | [Zoom Meetings API](https://developers.zoom.us/docs/api/meetings/) |
| LinkedIn | Basic profile for the authenticated member | [LinkedIn OpenID Connect](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) |
| Instagram | Professional account profile, media, comments | [Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/) |
| YouTube | Own channels, playlist items, video details, comment threads | [YouTube Data API v3](https://developers.google.com/youtube/v3/docs/) |
| Google Ads | Accessible customers and campaign performance | [Google Ads REST authorization](https://developers.google.com/google-ads/api/rest/auth) |
| Meta Ads | Ad accounts, campaigns, performance insights | [Marketing API](https://developers.facebook.com/docs/marketing-api/) |
| Shopify | Products and accessible orders | [Admin GraphQL API](https://shopify.dev/docs/api/admin-graphql) |
| Docusign | Envelopes, status changes, recipients | [Account discovery](https://developers.docusign.com/platform/auth/user-info/) |
| Greenhouse | Jobs, candidates, applications | [Harvest v3 OAuth](https://harvestdocs.greenhouse.io/docs/authentication), [pagination](https://harvestdocs.greenhouse.io/docs/pagination) |
| Lever | Opportunities, opportunity details, users | [Lever API](https://hire.lever.co/developer/documentation) |
| Workday | Worker list and worker details | [Workday REST fundamentals](https://developer.workday.com/documentation/GUID-85810465-bcfb-4fdf-a26d-55eaff3968a8-enHYPHENus/) |

These plugins do not yet renew tokens, start OAuth sign-in, import/sync knowledge,
or perform writes. Supply a current provider-issued access token (a Lever API key
for Lever); an API subscription, approved application, tenant administrator grant,
or vendor review may be required. Extra operations can require permissions beyond
the connection probe. LinkedIn's basic OIDC permissions do not provide general
feed, messaging or recruiting access. Instagram requires a Business or Creator
account linked through Facebook Login. Google Ads also needs a developer token.
Shopify and Workday use allowlisted tenant hosts; Docusign discovers and validates
the account's regional API host. Secrets never enter tool input or result metadata.
Redirects are disabled, responses are bounded, and secret-bearing response fields
and tokenized URL parameters are removed. Local fixture tests establish transport
and authorization behavior, not a live connection to these providers.

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

The desktop marketplace is opened from the compact Plugins row at the bottom
of the teammate sidebar. Connected apps appear as compact icons in Installed;
Popular and category sections use two-column rows with expandable lists. Search
covers names, descriptions, permissions, and section names. Each implemented
connector has a compact detail page with Connect or Reconnect, an account/access
summary, and optional examples and permissions under About. Back to chat remains
available while work runs. Skills are specific to a teammate and live in that teammate's editor,
outside Plugins. Built-in plugins, starting with Computer Use, use the same
card and detail-modal treatment, but their Enabled/Disabled setting stays
distinct from connection readiness and never implies permission or runtime
availability. See the [plugin and daily-driver assessment](daily-driver.md)
for remaining capability gaps.
Official remote connection routes are also available for Notion, Linear,
Vercel, Canva, Figma, Sentry, Stripe, Cloudflare, Granola, and Atlassian Rovo.
These use the
existing native MCP OAuth boundary and provider-hosted endpoints; no broker
client secret is required when the provider supports public client registration.
Atlassian Rovo authorizes through the provider's dynamic client
registration with a public client; Rovo rate limits, Rovo credit usage, and
admin controls still apply per site. The former Todoist route is retired: it is
no longer offered, and any saved `marketplace-todoist` server record is ignored
rather than deleted, so only that record remains removable in advanced
Settings. Asana's official MCP server requires
pre-registering an OAuth app with a client secret in the Asana developer
console and does not support dynamic client registration, so it remains on
manual server configuration in advanced Settings. Figma client approval,
organization policies, provider plans, and OAuth
registration requirements still apply. Each detail view links to its provider's
setup guide. The endpoint registry is
`apps/desktop/src/components/marketplace/remote-connectors.ts`.

Choose Connect and complete the provider's browser sign-in. Mivlet discovers and
enables the returned tools automatically, then shows Connected only once usable
tool access is saved. Native providers are health-checked automatically; Vercel
additionally performs an authenticated account read because public discovery is
insufficient. The Connect click authorizes the exact official endpoint;
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
in stored messages. Codex and embedded OpenCode turns disable host shell tools
and provider memories; unadvertised tool requests are declined without opening
an approval card.

Direct API and ChatGPT/Codex agents can use `connector-tools` to discover enabled tool schemas
and `connector-call` to invoke them. Verified official remote connections are available
across workspace conversations without individual agent assignment. Each call rediscovers the current Connection.
Native policy recognizes fixed lists of Vercel, Notion, Figma and Canva reads at
their exact official endpoints and runs these under account consent.
Changes and unrecognized tools still require native approval bound to the exact
tool and inputs. All executions retain current account, workspace, discovery,
enablement, revision, and single-use permit checks. Server annotations and tool
name prefixes cannot grant read status. Other provider-owned runtimes still
require their own tool integration.

An Approve click confirms the exact queued connector action without a second
typed phrase; Work Freely resolves the same single-use receipt automatically.
Native developer-connector writes are never automatically replayed after network
or ambiguous provider failure. The result reports uncertainty for reconciliation.
Google reads retain complete JSON records and pagination; large text excerpts
are labelled, and results that remain too large return a request-for-smaller-page
error. Provider MCP `isError` results propagate as failures with safe details.

Entries without a native adapter or official remote route remain Planned and
cannot begin authorization or appear installed.

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
no account, model-provider, sync, or product-data endpoints.

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
does not supply those credentials or tools to Mivlet. Connect a native adapter or
an official remote MCP route inside Mivlet. Setup requests all permissions that
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
