# Native agent runtime

Fable owns the conversation and tool loop. TypeScript assembles bounded model
requests and interprets responses; Rust owns credentials, endpoint policy,
network egress, streaming, timeout/retry behavior, cancellation, encrypted
checkpoints, and final tool dispatch.

## Provider connections

The native boundary implements OpenAI-compatible, Anthropic Messages, and
Gemini wire formats. The provider catalogue maps supported services onto those
formats and keeps model names, endpoints, headers, discovery, and connection
methods in adapters.

Connection methods are explicit:

- Codex app-server may start its official ChatGPT browser authorization and
  keeps that session inside Codex. Fable does not collect browser cookies or
  private session tokens and does not use a CLI login as the product flow.
- Direct remote providers use a user-supplied API key held by the
  operating-system credential store. The key is injected only by Rust.
- A custom OpenAI-compatible connection needs an explicit base URL and model.
  Remote URLs require HTTPS; plain HTTP is accepted only on loopback. User info,
  query strings, and fragments are rejected.

A configured key is not proof of a working account. Verification and model
discovery report missing, rejected, unsupported, offline, and transient failure
states separately. Curated model names are fallbacks where a provider exposes
no compatible model-list endpoint; they are not entitlement evidence.

The reachable catalogue contains only Codex browser sign-in, OpenAI API,
Anthropic API, Gemini API, xAI API, and a custom OpenAI-compatible endpoint.
No consumer subscription is treated as a general API credential.

## Request boundary

All three wire formats support text completion, streaming, bounded multi-round
tool calls, retries before a stream begins, and cancellation. Image and file
attachments are not yet supported by the native provider payload path.

Connect attempts time out after 20 seconds. A connected stream fails after 90
seconds without a new chunk. Authentication and client-request failures do not
retry; rate limits, connection failures, and server failures may retry up to two
times with bounded `Retry-After` or exponential backoff. Once response bytes
start, an interruption terminates the attempt rather than risking a repeated
effect.

## Execution attempts and recovery

One internal execution attempt records the provider, model, conversation,
usage, pending approvals, and bounded exchange needed to recover safely. It is
implementation state, not a user-managed product object.

If the app exits mid-attempt, startup marks it interrupted. Retrying starts a
new attempt from the durable user request. It never replays a previous tool
result, approval permit, or external effect. Completed, cancelled, failed, and
interrupted are mutually exclusive terminal outcomes.

Ordinary conversation does not continue after Fable closes. A local Docker
container or optional hosted computer being alive does not change that claim.

## Tool safety

Tool calls are bounded by rounds, count, identifier, argument size, output size,
and strict JSON shape. Unknown tools, duplicate call IDs, malformed arguments,
and oversized payloads fail before execution.

Consequential calls bind an exact request fingerprint, service, action, risk,
permission mode, bounded preview, workspace, teammate, computer generation, and
fresh single-use permit. The final trusted boundary revalidates and consumes
that authority immediately before the effect.

Local file and terminal tools target only the selected teammate's local
computer scope. `run-shell` executes inside that Docker container. Hosted tools
run only when the request explicitly selects hosted placement and the external
hosted prerequisites are valid.

## Evidence boundary

Provider conformance tests use local fixtures. They prove request shaping,
stream parsing, redaction, timeout, cancellation, and error classification—not
live credentials, account entitlements, provider availability, pricing, or
billing. Live-provider and hosted validation remain explicit external gates.
