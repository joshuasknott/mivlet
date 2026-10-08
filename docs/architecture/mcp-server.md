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
`mivlet_stop_work` uses canonical Work cancellation and generation fences. Writes
require stable `requestId` values; identical retries return their saved receipt,
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
arbitrary credential passthrough or dynamic metadata fetching is used.

Remote mode requires a user-operated HTTPS reverse proxy or tunnel reachable by
the client. Set its exact public HTTPS origin before starting the server. Forward
that host to the chosen loopback port, preserve Host, terminate TLS at the proxy,
disable query-string/access-token logging, enforce connection/body/time/rate
limits, and forward OAuth discovery and `/oauth/*` as well as `/mcp`. Browser
clients additionally need their exact Origin in the allowlist. The operator is
responsible for the proxy and public endpoint. Mivlet neither deploys nor exposes
one automatically. Account authentication and desktop consent remain required.

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
