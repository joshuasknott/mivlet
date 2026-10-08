# MCP Apps host

Mivlet hosts MCP Apps through the existing native MCP connection and approval
boundary. A tool advertises a `ui://` resource in `_meta.ui.resourceUri`; the
desktop transport reads that resource, preserves bounded `_meta.ui` rendering
metadata, and `McpAppHostSession` loads the HTML into an opaque
`iframe[sandbox="allow-scripts"]`.

The iframe communicates only through the official
`@modelcontextprotocol/ext-apps@1.7.5` AppBridge and PostMessageTransport
protocol. The parent validates the source window, keeps the app outside the
parent DOM, credentials, local storage and native IPC, and applies a generated
CSP from the resource's declared origins. Requested browser permissions are
intersected with Mivlet grants; a resource declaration does not grant access.

App initiated tools, resource reads, messages, model context updates, external
links and display mode requests are handled by explicit host callbacks. Tool
and resource calls carry the originating workspace, conversation, result and
generation fence into the existing native approval API. A missing or denied
approval returns a readable error result. Stale generations, Stop, account or
conversation changes and teardown close the bridge and invalidate later
requests. Rendering or reopening a saved result never executes an action by
itself.

`McpAppFrame` is the conversation integration slot. The conversation owner
supplies its transport, tool metadata, result identity and approval callback;
the host emits owner-tagged messages and context updates for normal Mivlet
persistence. Unsupported resources remain readable as ordinary MCP results.

The current implementation intentionally supports inline and fullscreen modes,
HTTPS external links, text HTML resources and the host-side tool/resource
proxy. Camera, microphone, geolocation, downloads, sampling and arbitrary
cross-origin navigation require a separate Mivlet policy callback and are
disabled unless explicitly granted. Live interoperability still requires an
authenticated MCP connection and a real standards-compatible server; local
fixtures and the official example protocol tests do not establish that
deployment evidence.
