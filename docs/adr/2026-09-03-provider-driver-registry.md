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
Anthropic, xAI, and custom OpenAI-compatible connections. Provider families
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

Provider-owned account runtimes retain their own authentication state. Direct
API credentials remain in Fable's account-scoped OS secure-store boundary.
Neither path puts provider credentials in React state, persisted snapshots,
logs, model transcripts, or cross-provider configuration.
