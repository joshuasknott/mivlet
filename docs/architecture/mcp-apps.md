# MCP Apps host

Mivlet hosts MCP Apps through the existing native MCP connection and approval
boundary. A tool advertises a `ui://` resource in `_meta.ui.resourceUri`; the
desktop transport reads that resource, preserves bounded `_meta.ui` metadata,
and `McpAppHostSession` registers the HTML with the native resource host. Each
registration receives a random, short-lived token and is loaded from an
ephemeral loopback origin (`http://127.0.0.1:<random-port>`). The origin is
deliberately not registered as a Tauri custom protocol: Tauri treats registered
Windows protocols as local and would allow a child frame to reach the renderer
IPC bridge. The frame uses
`iframe[sandbox="allow-scripts"]` without `allow-same-origin`; `srcdoc`, blob
URLs and renderer-owned object URLs are not used for app execution.

The iframe communicates through the official
`@modelcontextprotocol/ext-apps@1.7.5` AppBridge schemas and lifecycle. Mivlet
uses its own source-bound `McpAppTransport` for the postMessage channel because
the SDK convenience transport logs raw JSON-RPC payloads. The Mivlet transport
adds bounded message size/node/depth checks, accepts only the bound window and
the sandbox's opaque `null` origin, and never logs workspace data. The parent
keeps the app outside the parent DOM, credentials, local storage and native
IPC. Requested browser permissions are intersected with Mivlet grants; a
resource declaration does not grant access.

The generated policy starts with `default-src 'none'`, allows only the
negotiated HTTPS/WSS domains, rejects native schemes and broad sources, and
sets `navigate-to 'none'`. The native resource host parses the policy again
and rejects duplicate or unsupported directives, IPC schemes,
`chrome.webview`, local origins and unbounded resources. The parent production
CSP permits only the random loopback port in `frame-src`; it does not loosen
renderer `connect-src`. Because the loopback origin is remote to Tauri's ACL
classifier, every app and plugin invoke from the child frame is rejected
before Mivlet's command handler or plugin dispatch. Ordinary top-level Mivlet
IPC remains local. On Windows, a native WebView2 `FrameCreated`/`NavigationStarting`
fence locks each guest frame to its exact issued loopback token URL and rejects
renderer, native, other loopback and external destinations. A DOM load event is
not treated as evidence of navigation: the first handshake can finish before
the initial document load. The native HTTP
adapter accepts only the exact bound host, GET, token path and current account,
with bounded headers and no directory or query access. The signed-in Windows
run verified rendering, teardown and the DOM, storage and navigation boundaries.
The IPC response probes timed out and remain inconclusive; source-level ACL
evidence is recorded below. This is native development evidence, not acceptance
of a signed installer.
Nested guest frames are currently rejected: WebView2's supported frame event
does not cover recursive descendants, so Mivlet requires guest `frame-src
'none'` and refuses negotiated `frameDomains` with an actionable error.

The frame's expand action opens an `mcp-app` tab in the existing workspace right
panel and keeps the result discoverable beside Files, Memories and Activity.
The panel target is fenced to the same workspace, conversation, result and
generation. Closing the tab, switching away from it, stopping the run or
changing the account removes the target and disposes the session. React
recreates a portal subtree when its container changes, so docking explicitly
tears down the old AppBridge session and renegotiates the resource; it does not
pretend to preserve a guest document or replay an app action. Reopening the
result performs a fresh handshake and restores only the persisted tool input
and result data.

App initiated tools and resource reads are handled by explicit host callbacks.
Tool and resource calls carry the originating workspace, conversation, result
and generation fence into the existing native approval API. The host filters
`resources/list` to the connector's enabled resource set; native policy also
rejects reads for disabled URIs. A missing or denied approval returns a readable
error result. Stale generations, Stop, account or conversation changes and
teardown close the bridge and invalidate later requests. Rendering or
reopening a saved result never executes an action by itself.

The conversation surface does not wire an `onOpenLink` policy callback, so it
does not advertise `openLinks` and external navigation is unavailable there. A
future caller must provide an explicit HTTPS-only policy callback before that
capability is advertised. Camera, microphone, geolocation, downloads,
sampling and other browser permissions are disabled unless a separate Mivlet
policy grants them.

`McpAppFrame` keeps the full resource only transiently while registering it
with the native host; renderer snapshots expose metadata needed for layout,
not the HTML document. The transient host session is disposed when the result
closes, becomes stale or the MCP connection ends. The native host remains the
authority for serving bytes and all consequential actions.

Resource normalization keeps ordinary resource/tool text at 64 KiB. Only a
`ui://` resource with the MCP Apps HTML MIME profile can use the separate 5 MiB
artifact bound. The host rejects truncated HTML and requires the returned URI
to exactly match the approved resource; a different document in a multi-resource
response cannot replace it. Docking pairs each registered URL with the session
that loaded it before creating a replacement bridge.

MCP App approvals use the exact native proposal fingerprint and one-time
permit. The current native MCP authorization boundary rejects a resolution
that contains a modification, so a changed action must be denied and issued
again by the app as a fresh proposal; the generic approval panel must not be
treated as evidence that an MCP modification was applied. A future supported
modification path must re-prepare the changed proposal and obtain fresh
authority.

The lifecycle is covered by an actual `@modelcontextprotocol/ext-apps` App and
Mivlet transport peer test: initialize, send a host message, proxy a tool call
through the approval boundary, and tear down the bridge. This exercises the
official SDK wire format and lifecycle rather than only checking React output.
It is protocol evidence using in-memory peers, not native/browser evidence.

## Official quickstart reproduction

The harmless reference is the official MCP Apps quickstart at
[`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps/tree/82221c0c8ce7661efa6771c9d461511b1650495f/examples/quickstart),
pinned to commit `82221c0c8ce7661efa6771c9d461511b1650495f`. From a clean clone,
reproduce its bundle and connector-library discovery with:

```powershell
git clone https://github.com/modelcontextprotocol/ext-apps.git
Set-Location ext-apps
git checkout 82221c0c8ce7661efa6771c9d461511b1650495f
Set-Location examples/quickstart
pnpm install
pnpm run build
pnpm exec tsx main.ts --stdio
```

For Mivlet's existing local MCP connector path, configure the saved local
server with an absolute regular Windows executable. `pnpm.cmd` is rejected by
the native executable boundary. Use Node directly and pass absolute paths as
separate arguments (the local-server form has no working-directory field):

```text
Command:
C:\Program Files\nodejs\node.exe

Arguments:
<quickstart clone>\node_modules\tsx\dist\cli.mjs
<quickstart clone>\main.ts
--stdio
```

The verified ignored fixture in this checkout uses the equivalent concrete
configuration:

```text
Command:
C:\Program Files\nodejs\node.exe

Arguments:
C:\Users\Joshua Knott\.codex\worktrees\conversation-upgrade\mivlet\output\conversation-upgrade\mcp-apps-official-quickstart\node_modules\tsx\dist\cli.mjs
C:\Users\Joshua Knott\.codex\worktrees\conversation-upgrade\mivlet\output\conversation-upgrade\mcp-apps-official-quickstart\main.ts
--stdio
```

Explicitly enable `get-time`, then invoke it from a conversation. The action
only returns a timestamp. The connector-library verification has observed the
official stdio server's `get-time` tool and
`ui://get-time/mcp-app.html` resource through Mivlet's production MCP
transport. In the signed-in Windows acceptance run, that original example also
rendered in the production conversation iframe. Reopening retained the original
saved timestamp without a tool replay. Its button created a fresh concrete
`get-time {}` approval; denial displayed the host denial, and a later native
approval returned a new timestamp (`2026-10-08T23:18:13.016Z`).

The separate nested package at
`apps/hosted-runner/prototypes/opencode` is named
`@mivlet/opencode-compatibility-probe`. It is not imported by the production
`@mivlet/hosted-runner` package or included by the root workspace's
`apps/*` importer; its Wrangler entrypoint is a separately deployable
prototype. Its lockfile and checks must therefore be audited independently and
are not evidence for the desktop MCP Apps host.

Evidence boundaries remain separate:

- The Vitest SDK peer test is protocol/example evidence using in-memory peers.
- The quickstart build and stdio discovery are official-example and production
  connector-path evidence.
- Native resource registration, AppBridge rendering, one-use approval denial
  and success, and close/reopen were observed in the signed-in Windows run.
  Native docking and adversarial iframe isolation checks are recorded separately;
  they must not be inferred from successful rendering.

The compact Windows panel was also exercised with the official example. Moving
the iframe recreates its SDK session, pairs registration with that new session,
and requests fresh resource authority. It does not repeat the original tool.
Pending app approvals follow the exact workspace/conversation/result/generation
owner into the visible panel; closing its DOM target returns them to the normal
conversation approval surface until teardown cancels them. The right panel owns
the focus trap while docked. Native rechecks covered loading, approval, ready,
denial and closing in the narrow window.

Responsive layout changes preserve the owning conversation's mounted pane and
portal target. They do not renegotiate an unchanged app session. The production
native check retained the official app while crossing the compact breakpoint
in both directions. Explicit Return to conversation removes its panel tab and
creates a fresh inline session; explicit Close tears down the result and removes
the tab. A later disconnected transport displays recovery instead of leaving a
blank frame. The session, resource and approval tests cover these separate
lifetimes.

The existing native discovery supervisor bounds an idle read to 300 seconds.
If that channel expires, the app shows disconnected recovery; reopening
rediscovers capabilities and requests fresh resource authority. This is a local
connection lifetime limit, and never authorizes replaying a completed tool call.

A separate controlled HTML probe was temporarily served by the already-enabled
local reference server, using normal resource approval. In the actual native
iframe it could not read the parent document or local storage. The host rejected
its renderer navigation request, and a direct frame navigation attempt retained
the original document. Its read-only `runtime_status` and
`plugin:window|is_visible` calls timed out, so these observations do not establish
an explicit native IPC rejection response. The original official resource was
restored and its SHA-256 verified after the probe.

The pinned native source supplies the independent IPC authority evidence:
Wry 0.55.1 obtains the WebView2 message source URI; Tauri 2.11.5 classifies it as
local or remote and rejects remote custom/plugin commands without matching
remote ACL authority before dispatch. Mivlet's only capability grants the local
main window and has no remote URL grant. Tauri's own regression covers remote
custom-command rejection. An injected `window.ipc` object therefore does not
constitute native command authority. Keep this source evidence distinct from
the inconclusive live response probes.

Unsupported resources remain readable as ordinary MCP results. Live
interoperability requires an authenticated MCP connection and a real
standards-compatible server; fixtures and protocol tests do not establish
deployment or native acceptance.
