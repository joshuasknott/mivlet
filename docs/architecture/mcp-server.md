# External assistants and Mivlet's MCP server

Mivlet exposes selected local Work through a native, authenticated Streamable HTTP
server. This is independent of connections to third-party MCP servers and MCP Apps
hosting. It does not start another execution worker or reuse connector OAuth tokens.

In the signed-in desktop, open **Settings → General → External assistants**. Start
the server on an available local port, then add the displayed `/mcp` URL to an MCP
client and start its OAuth sign-in. Match the browser's request code to the pending
request in Settings. Choose named agents, optionally share specific existing Work,
and approve a lifetime of one hour to seven days. Read only is the default. Task
requests must be both requested by the client and selected by the user.

For example, an OAuth-capable Codex client can use:

```sh
codex mcp add mivlet --url http://127.0.0.1:39440/mcp
codex mcp login mivlet
```

For task requests, use `codex mcp login mivlet --scopes mivlet:read,mivlet:tasks`
and explicitly select task access when approving in Mivlet. Asking for a scope
does not approve it.

Clients discover RFC 9728 protected-resource metadata and RFC 8414 authorization
metadata. Public-client registration, authorization-code exchange, S256 PKCE,
resource binding, state round-trip and issuer identification are supported. Callback
URIs match exactly, including loopback ports: register the actual callback before
sign-in. Tokens last at most eight hours and never outlive the approved grant.
There are no refresh tokens; sign in again after expiry. Grant revocation is in
Settings and takes effect on every subsequent native check.

## Shared data and execution

Every tool names a workspace; every Work tool also names an agent. The server
returns only the approved agents and explicitly shared Work, plus Work that this
grant started. Shared existing Work is read-only. Read results contain bounded,
secret-redacted request/status/output projections, never captured instructions,
private conversation history, files, account details, provider configuration or
credentials. Grant selection uses native account-scoped repositories.

`mivlet_request_task` creates an ordinary private conversation and Work record.
`mivlet_message_work` adds untrusted task data, separately from user steering.
`mivlet_stop_work` checks the current generation in the same native transaction as
canonical cancellation, including queued or waiting Work and unfinished descendants.
Writes require stable `requestId` values; identical retries return their saved receipt,
and changed payloads are rejected. Receipts remain after conversation deletion
until their grant expires or is revoked, so deletion cannot authorize replay.
The native access log retains the latest 256 decisions and calls without prompt
bodies, codes, tokens or verifiers.

Task mode is capped at supervised (`trusted-scope`), the current agent mode and
the global mode. A client cannot approve a tool, widen a scope, continue interrupted
Work, or steer another client's Work. The selected agent uses its configured
instructions and approved memory; consent explains this. Provider credentials,
runtime prerequisites, exact tool approvals and native control leases remain
under the existing boundaries. Delegation is limited to the grant's selected
agents, and grant expiry/revocation is checked for descendants and late results.

The open workspace receives native change notifications and refreshes its existing
`WorkspaceExecution` owner. Provider failures are recorded by the ordinary Work
executor. Keep Mivlet open, signed in and awake. No detached-worker capability is
claimed by this branch; the background-worker workstream can later consume the
same native Work records without replacing this server's admission checks.

## Local and remote transport

The listener binds only `127.0.0.1`. It validates the exact configured Host, rejects
unknown browser Origins and session IDs, bounds request bodies/concurrent calls,
and limits request rates and registrations. Browser access is opt-in for exact
HTTPS origins. No wildcard CORS, cookie authority, forwarded-header authority,
arbitrary credential passthrough or dynamic metadata fetching is used. MCP
requests never accept browser cookies as authorization.

### Phone and web view

Managed phone access connects from desktop Settings to a separate Cloudflare
Free Worker through outbound authenticated WebSocket transport. The exact native
account, selected cloud workspace and device are asserted before Connect. The
Worker URL comes only from authenticated native Convex authorization. No router,
Docker installation, paid Container plan, custom domain, host port forwarding or
user-operated tunnel is needed for this mode. The manual sharing server and
managed access are exclusive; changing mode requires an explicit disconnect.

The managed `/d/<connection>/remote` address opens the same responsive client for the agents and Work deliberately
shared with that browser. Each browser connects through the same desktop consent
flow; read-only remains the default. Permitted clients can request new tasks,
read bounded saved results, and stop only tasks they started. Consequential tool
approvals and interrupted-task continuation stay on the desktop.

The native server owns OAuth PKCE and bearer credentials. The phone receives an
opaque, rotated HttpOnly/SameSite-Strict cookie, with Secure and the `__Host-`
prefix on HTTPS. No credentials enter JavaScript, browser storage or result text.
Managed begin and consent polling perform the entire OAuth code/PKCE exchange
inside native memory. No callback code or bearer crosses the relay. Every
operation rechecks the underlying grant, account, scope and expiry. Writes
require the exact same Origin and a fixed custom header; this cookie is accepted
only by the opt-in phone routes, never by MCP. Disconnect removes the browser's
session; already accepted tasks continue within their grant. Revoke its grant in
desktop Settings to stop its outstanding tasks and invalidate all access.

The client renders untrusted results as text, polls only while visible and retains
the exact request ID after an uncertain write. It never retries a write
automatically. Opt-in Web Push sends a payload-free, VAPID-signed wake signal
through supported browser-vendor push services. The service worker shows a generic
notification, including when this page is closed; task content never enters the
push service. The native host checks grant expiry/revocation and current shared
Work, pins public DNS addresses, rejects redirects/proxies and bounds delivery.
Subscriptions and signing keys live only in native memory and end with browser
disconnect, access expiry, or server restart. Failed or uncertain delivery is not
retried automatically. Page polling still pauses when hidden. Delivery requires
an awake signed-in host, HTTPS, browser permission, and on iOS a Home Screen web
app. The managed service worker is scoped to the exact connection path and opens
only that path after a generic notification. Protocol and mocked checks do not
establish real-device delivery. The desktop must stay running, awake, signed in
and connected to the relay; this transport does not execute tasks while it sleeps.

### Managed relay custody and lifetime

`wrangler.phone.jsonc` deploys only a Worker and SQLite Durable Object. Static
HTML, scripts, styles, icon and service worker are pinned imports from this
client. The shared origin never serves native-generated HTML or arbitrary native
headers. Only closed begin, consent, session, task-call, disconnect and push
operations are accepted; there is no HTTP/TCP proxy or arbitrary local target.
Cloudflare carries the deliberately shared requests, statuses and results over
TLS. Task text, results, browser cookies, PKCE and tokens are not persisted in DO
storage. Its bounded metadata contains account/workspace/device ownership,
connection epoch/revision, sequence counters, short-lived nonce receipts and
deadlines; final expiry deletes all object storage metadata.

Convex derives the opaque connection namespace with a domain-separated HMAC of
server account, workspace, device and native random epoch. Another account cannot
claim an expired public address after metadata cleanup. Native connect capabilities
last at most two minutes, renew every minute, and recheck current account/device
membership. The original eight-hour session maximum never extends on renewal.
The native captured identity-generation fence remains strict: credential refresh,
sign-out, relink or account change ends this connection and requires explicit
Connect and fresh browser consent. Continuous renewal across verified credential
refresh is not claimed by this implementation.

The relay bounds bodies to 64 KiB, frames to 70 KiB, concurrent calls to 16,
each exchange to ten seconds and traffic to 240 calls/minute per connection.
Managed reads drop complete history/output entries when needed and report
truncation; a large read does not end the connection or stop other tasks. Native
and DO epoch/revision/sequence checks reject stale responses. Connection loss,
timeout or replacement never replays writes. The browser preserves an uncertain
write's original native idempotency key for an explicit retry; it cannot infer
that a failed delivery means the task was not accepted. Disconnecting managed
access invalidates native browser sessions and stops grant-owned tasks.

Managed activation needs the distinct `MIVLET_PHONE_RELAY_SIGNING_KEY` in Convex
and the phone Worker, plus `MIVLET_PHONE_RELAY_URL` in Convex. No provider key,
computer lifecycle credential or local bearer is transferred. Worker unit tests
and dry-runs do not prove signed-in native or real-phone acceptance.

### Manual remote transport

Enable **Phone and web view** before starting the manual server. Its `/remote`
page uses the same desktop grants and remains available for user-operated setups.
A loopback URL is local only.

Manual remote mode requires a user-operated HTTPS reverse proxy or tunnel reachable by
the client. Set its exact public HTTPS origin before starting the server. Forward
that host to the chosen loopback port, preserve Host, terminate TLS at the proxy,
disable query-string/access-token logging, enforce connection/body/time/rate
limits, and forward OAuth discovery and `/oauth/*` as well as `/mcp`. Browser
clients additionally need their exact Origin in the allowlist. The operator is
responsible for that proxy and public endpoint. Managed phone access is the
separate closed transport described above. Account authentication and desktop
consent remain required in both modes.

The implementation negotiates MCP `2025-06-18` and `2025-11-25`, using stateless
Streamable HTTP JSON responses. GET/SSE subscriptions, server-initiated requests,
session resumption and the newer `2026-07-28` wire format are not advertised.
The current [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
were checked during implementation.

## Reference and verification

T3 Code was reviewed at `a4c9494b0e3606775cc5fc929fc138399288bd43`, including
`docs/user/outside-agents.md`, `McpHttpServer.ts`, `McpToolAccess.ts`, `McpOAuth.ts`
and its tests. Its central per-tool access declarations, read-only default,
native consent and explicit remote prerequisites informed this design. No source,
branding or assets were transplanted. Relevant merged changes include OAuth
`2c8be5893eb3754071162e344a8c8e8a67bef597` (#16336) and hosted-client sign-in
`10f39eb9ac80c9a4b7f5097575dd2addc3b6f631` (#16718).

Focused verification:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml mcp_server
pnpm --filter @mivlet/desktop exec vitest run src/components/settings/McpServerSettings.test.tsx --configLoader runner
```

The Rust suite uses the production HTTP router and native consent/admission code
with isolated encrypted stores. Its interoperability test runs the official MCP
TypeScript SDK client through discovery, registration, PKCE, consent, tool listing,
request/message/read/Stop and an idempotent retry. This does not establish a live
paid-provider run, production account sign-in, installed-package acceptance, or a
deployed HTTPS proxy. Follow the repository verification guide for native, types,
build and UI checks before release.

On October 17, 2026, the managed phone Worker was deployed to
`https://mivlet-phone-relay.joshhknott.workers.dev` in the existing Cloudflare
account. Its distinct signing key is configured in the Worker and the persistent
`chatty-roadrunner-66` development deployment within the existing `fable` Convex
project. The local recovery copy uses Windows DPAPI outside the repository.

Fourteen live boundary checks passed against Cloudflare and its SQLite Durable
Object: fixed client/CSP and device-scoped service worker, origin/body limits,
native WSS admission, capability replay rejection, opaque secure cookies,
cross-device cookie isolation, renewal, unknown writes without replay and
expiry at the original session deadline. These used a synthetic native peer;
they do not establish signed-in desktop admission or physical-phone delivery.
Evidence is in the ignored integration `output/agent-phone-live-boundaries.json`.

Eight further browser checks passed against the deployed phone client at desktop
and 390px widths, still using a synthetic native peer. They covered pairing,
escaped result text, explicit retry of the original uncertain write, Stop,
read-only grants and offline state. All seven screenshots were inspected; there
were no page errors or horizontal overflow, and visible buttons met 44px targets.
The initial session check now keeps Connect disabled and stale session responses
cannot reset a newer connection. This client is deployed as version
`aeef283c-631d-4dd6-b110-5f30d7a2dc3c`. Evidence and the design review are under
`output/playwright/managed-phone-20261017/`. Physical-phone and real native
account acceptance remain separate, unexercised checks.
