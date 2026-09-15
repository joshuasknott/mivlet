# Provider driver registry

Date: 2026-09-03

Status: Accepted

## Decision

Fable separates a configured provider instance from the driver that runs it.
The built-in instance id remains the existing provider id, preserving current
local connections and thread routing. A driver kind selects the adapter and may
later back more than one named account without widening the conversation shell.

The built-in catalogue contains account routes for ChatGPT/Codex, Claude,
Google Antigravity, Grok, Cursor, and OpenCode, followed by direct OpenAI,
Anthropic, Gemini, xAI, DeepSeek, Alibaba/Qwen, Moonshot/Kimi, Z.ai/GLM, Groq, Together,
Fireworks, Cerebras, Mistral, OpenRouter, NVIDIA, SiliconFlow, Cohere, and custom
OpenAI-compatible connections. Provider families
group an account route with its advanced API-key fallback.

Configuration and execution use separate registries. The provider-driver
registry owns metadata, the default instance, grouping, setup kind, and the
provider builder. The runtime adapter registry owns executable adapters. Adding
a driver does not require a provider-id branch in the shell or catalogue.

## Truthful availability

Catalogue presence is not runtime availability. A provider is runnable only
when its instance is connected, advertises streaming, and its driver has a
registered adapter. Registered drivers without a shipped adapter remain
unavailable and publish no capabilities or models. Fixtures cannot change
that state into a live-capability claim.

Older local payloads may omit instance, driver, and setup metadata. Fable keeps
a narrow backend-type fallback while those payloads age out; all current native
and TypeScript catalogue builders emit the new fields.

The first shipped managed-runtime set uses full ACP execution for Cursor and
Grok, including model discovery, cancellation, and Fable-mediated permissions.
Claude uses its bidirectional Agent SDK stdio protocol; OpenCode uses a
Fable-owned authenticated loopback server and session event stream. Both route
provider tool permissions through Fable and advertise tool, approval, and file
change capabilities only when their runtime and account state are connected.
Antigravity remains a separate pinned ACP runtime because Fable owns its
verified installation and account-scoped profile lifecycle.

## Credential boundary

### Embedded direct API execution (2026-09-10)

Direct API text/tool turns for the registered native provider catalogue use
`packages/agent-host`, pinned to OpenCode V2 SDK/plugin `0.0.0-dev-19449`.
This is the embedded SDK, separate from the retained OpenCode account/CLI route.
OpenCode alone owns the model/tool loop for these turns. Its native provider
modules send key-free requests over a private authenticated loopback bridge;
the Rust parent validates the current account/provider/workspace route and owns
provider egress. Native screenshots are hydrated only at that Rust boundary.

Direct Gemini text/tool turns keep Mivlet's local wire loop (`shapeGeminiRequest`
/ `parseGeminiLine` over the same Rust egress boundary) rather than the embedded
host: its SDK admission contract is not verified, and no second agent loop wraps
the first. See [Gemini provider](../architecture/gemini-provider.md). The Gemini API key stays in the same account-scoped OS secure-store
boundary as the other direct routes and never crosses into JavaScript. Gemini
discovery uses the official `models.list` endpoint, and credential verification
hit-tests the stored key the same way.

The adapter translates SDK events into existing Mivlet conversation events and
routes tools through the existing permission/approval executor. It removes all
SDK built-in tools and other agents, disables project configuration, plugins,
MCP servers, skills, shell creation, auto-compaction, sharing and background model
fetches. Mivlet supplies context budgets and canonical history. Each attempt has
an in-memory SDK database and an isolated temporary configuration directory.
Cancellation fences callbacks and terminates the child; startup requires the
bundled Windows host and its verified manifest.

The September 12 catalogue expansion uses the same native bridge and embedded
host. Public lists are not credential probes: each new provider verifies a bounded
chat request to its default curated model. Vendor options are enforced at native
egress as well as request shaping. Alibaba stores its endpoint alongside the key
and accepts only official regional/workspace Model Studio hosts. New model
discoveries remain conservative until their exact IDs have audited tool support.
Synthetic function-call round trips cover all 12 new routes through the actual
bundled Windows executable; they do not establish paid live-provider acceptance.

User-image turns and remaining wire families retain the existing visual/direct
adapter. This preserves capabilities whose SDK admission contract is not yet
verified. Runtime selection happens once per turn; there is no second loop around
OpenCode and no silent fallback after an embedded failure. Provider-owned Codex,
Claude, ACP and OpenCode account routes continue to serve their distinct supported
authentication and execution contracts.

OpenCode's native provider modules cover the adopted routes. The custom Vercel
AI SDK package-hook reproducer failed before model execution, so Mivlet does not
add a second Vercel agent loop or claim its approval/middleware controls are active.
Vercel compatibility packages remain SDK implementation dependencies where used.
The official MCP TypeScript SDK `1.30.0` replaces the custom client negotiation,
request correlation and timeout plumbing inside the bundled native host. The
renderer only forwards discovery frames through the existing transport; SDK
tool execution is not exposed. Native transport ownership, OAuth,
exact tool authorization, result bounds and unsupported server-request rejection
remain Mivlet responsibilities.

Provider-owned account runtimes retain their own authentication state. Direct
API credentials remain in Fable's account-scoped OS secure-store boundary.
Neither path puts provider credentials in React state, persisted snapshots,
logs, model transcripts, or cross-provider configuration.
