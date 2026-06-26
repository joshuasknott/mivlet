# Design — Native Model API Adapters (OpenAI, Anthropic, Gemini, xAI, OpenRouter)

Status: **Proposed** — pending user approval before implementation.
Date: 2026-06-26
Owner: Arden desktop
Spec of record: the goal objective for the native model API adapter family.

## 1. Objective (restated as deliverables)

Build the native model API adapter family where **Arden owns the entire agent
loop**: OpenAI, Anthropic, Gemini (API + Vertex), xAI, and OpenRouter. Unlike the
runtime backends (Codex/Cursor/Copilot/Grok, shipped in the prior goal) that
borrow sessions/approvals from their providers, here Arden owns tool dispatch,
streaming, approval routing, memory integration, usage/cost, and cancellation.

This goal **extends** the prior goal's foundation — the `BackendProvider` /
capability surface, the credential boundary, the approval-routing commands, and
the onboarding shell — it does not re-derive them. The credential boundary's
provider vocabulary (`SUPPORTED_BACKEND_PROVIDER_IDS` + its catalog) and the
`BackendType` union are **extended** with the native-API providers and a
native-API backend type, not rebuilt.

Hard invariant (carried from goal 1): **the API key never enters React state,
logs, or `RuntimeSnapshot`.** Network egress and key handling are owned by the
Rust boundary. The TypeScript layer owns orchestration (loop control,
tool-call handling, approval routing) and request/response shaping as pure,
fixture-testable logic. Stream normalized events back to the shell over the same
event surface the runtimes emit. Goal 1 deliberately deferred live transport to
this goal.

### Success criteria (the checklist the verifier will check)

1. The credential-boundary vocabulary is **extended** (not rebuilt): the
   `SUPPORTED_BACKEND_PROVIDER_IDS` catalog in `models.rs` and the
   `BACKEND_PROVIDER_IDS` registry in `@arden/connectors` both gain the native
   providers (`openai`, `anthropic`, `gemini`, `xai`, `openrouter`); the
   `BackendType` union gains a native-API type (`native-api`); the closed
   `BACKEND_CAPABILITIES` vocabulary is extended with any new capability the
   native loop requires. Existing provider ids/types keep working.
2. **One shared OpenAI-compatible client** with per-provider shaping lives in
   `@arden/connectors` behind an **injectable HTTP-transport seam** so tests use
   recorded/fixture responses and never touch the network. OpenAI, OpenRouter,
   and xAI share the request/response path; Anthropic Messages and Gemini
   `generateContent` get provider-specific shaping behind the shared capability
   interface.
3. **Network egress + key handling are owned by Rust.** Rust looks the key up
   from its store and performs the HTTP/SSE call; TypeScript never receives the
   key and never opens a socket. A new Tauri command carries an opaque
   request and streams normalized events back.
4. **Real cancellation** of in-flight requests, not just UI dismissal — Rust
   drops the in-flight HTTP future on cancel.
5. **Tool dispatch** — model tool calls don't auto-execute; each routes through
   the `ApprovalRequest` system (read-only/trusted-scope/full-access,
   once/session/rule/modify/deny, fail-closed high-risk) before execution by an
   Arden-owned tool registry. Unregistered/model-invented tools fail closed.
6. **Streaming** normalized to the same event stream the runtimes emit. A typed
   `BackendAgentEvent` union (text-delta, tool-call, tool-result, usage, done,
   error, cancelled) is defined in `@arden/protocol` and emitted on a Tauri
   event channel so the shell renders deltas/usage.
7. **Memory** — pinned knowledge/memory enters context by trust level; approved
   inferences write back with provenance, freshness, and kind, via the existing
   memory promotion path.
8. **Per-request usage/cost accounting** — every completion surfaces input/output
   tokens + a cost figure via the `usage` event.
9. **Compliance** is hard:
   - Claude is API key / Bedrock / Vertex only — no "Connect Claude subscription";
     Anthropic blocks third-party Claude.ai login.
   - Gemini is API key / Vertex only — no Google AI Pro/Ultra subscription reuse;
     Google's CLI terms forbid third-party OAuth.
   - Never assert any Grok entitlement (carried over; Grok entitlement stays
     post-login-only).
   - Onboarding copy reflects this: the API-key path becomes **functional** for
     OpenAI/Anthropic/Google/xAI/OpenRouter and reflects compliance.
10. **Onboarding**: API-key path becomes functional; local-model path still
    disabled. Gate unchanged: "Connect one AI backend to continue."
11. Model-generated tool output is untrusted content crossing into trusted
    action — approval gates apply before any tool runs. API keys are protected
    assets (pre-release local store, never logged/snapshotted/committed).
12. Deferred: local models, enterprise backends beyond Vertex-under-Gemini,
    OpenCode, the four runtime backends (already shipped), voice/realtime,
    marketing/CI/release-signing.
13. Green: `npm run check`, `cargo fmt --check`, `cargo check`, `cargo clippy`,
    `cargo test`. **No real network in tests** — recorded/fixture responses only.
14. Goal report added to `docs/`.

## 2. Architecture decisions

### 2.1 The transport split (the central decision)

The objective fixes the division of responsibility precisely:

| Concern | Owner | Why |
|---|---|---|
| **Key lookup** | Rust | never crosses into JS |
| **HTTP/SSE egress** | Rust | "Network egress and key handling are owned by the Rust boundary" |
| **Request/response shaping** (provider-specific body + SSE→event parse) | TS (`@arden/connectors`) | "request/response shaping as pure, fixture-testable logic" |
| **Loop control** (turn iteration, tool-call handling, approval routing) | TS | "The TypeScript layer owns orchestration" |
| **Cancellation** | Rust (drops the future) + TS (signals) | "Real cancellation of in-flight requests" |

This is implemented as **two halves that meet at a clean seam**:

**TS half — pure shapers + orchestrator.** `@arden/connectors/native-api/`
contains:
- A normalized internal request type (`NativeCompletionRequest`) and event type
  (`BackendAgentEvent`).
- Per-provider modules that are **pure functions**:
  `shapeRequest(provider, normalized) -> {url, headers-dict, body}` and
  `parseEvents(provider, sseLine) -> BackendAgentEvent[]`.
- The **agent loop** (`runAgentLoop`) which is pure over an injectable
  `HttpTransport` seam. Tests inject a `FixtureTransport` that replays recorded
  responses; production injects a transport that delegates the actual call to
  Rust via `invoke`. The shaper output (`url`, header *names*, `body`) is what
  gets handed to Rust — but Rust adds the `Authorization` header itself from the
  store, so the key is never in the TS-shaped request.

**Rust half — key + egress.** A new Tauri command
`stream_backend_completion(request, on_event)`:
1. Receives `{ providerId, requestId, model, body, url, stream }` (no key — TS
   only knows the path, not the credential).
2. Looks up the key from `CREDENTIAL_STORE`, builds the `Authorization` /
   `x-api-key` / `x-goog-api-key` header per provider, and issues the streaming
   `reqwest` request.
3. Parses SSE bytes and emits each normalized line back over the Tauri event
   channel `arden://backend/<requestId>`.
4. Holds the in-flight future in a `CancelMap` keyed by `requestId`; the
   `cancel_backend_completion(requestId)` command aborts it (real cancellation).

> **Why not have Rust do the per-provider shaping too?** Centralizing egress is
> nice, but the objective is explicit that shaping is "pure, fixture-testable
> logic" in TS, and that the shared client "lives in the connectors package."
> Putting shaping in Rust would move it out of the fixture-testable layer and
> duplicate it against the registry. So Rust owns **bytes + key**, TS owns
> **shape + parse + loop**. The provider-specific header Rust adds is the one
> piece of provider knowledge Rust holds, and it's a single match arm.

### 2.2 Vocabulary extension (extend, don't rebuild)

In `models.rs`:
- `SUPPORTED_BACKEND_PROVIDER_IDS` grows to include the five native ids.
- `BACKEND_TYPES` gains `"native-api"`.
- `BACKEND_CAPABILITIES` gains any new capability the loop needs. The minimal
  addition is `"usage-cost"` (already present) used at native-API granularity,
  plus **`"memory"`** and **`"tool-dispatch"`** if they aren't expressible with
  existing caps. (Decision: reuse `tool-requests` + `approvals` for tool
  dispatch — model *requests* tool exec, Arden routes through *approvals* — so
  **no new capability token is strictly required**; memory write-back rides the
  existing memory path. This keeps the closed vocabulary stable. The native
  adapter declares the full set: authentication, threads, streaming,
  tool-requests, approvals, file-changes, usage-cost, model-availability,
  cancellation.)

In `@arden/connectors/src/backends/registry.ts`:
- `BACKEND_PROVIDER_IDS` grows to match.
- A new `native-api.ts` adapter exposes `resolveNativeProvider(id, authState)`
  for each of the five, with fixture catalogs (models + compliant copy) in
  `fixtures.ts` (extended).

The catalog served by Rust (`CATALOG` in `backends.rs`) is extended with the
five native entries. `validate_catalog_vocabulary()` already panics on a bad
value at first use, so a typo is caught immediately.

### 2.3 Capability model (dynamic, fail-closed — unchanged)

Native providers are API-key only, so the only two meaningful auth states are
`needs-auth` (no key) → empty capabilities, and `connected` (key present) →
full set including `usage-cost`. `resolveCapabilities` is extended to handle
`backendType: "native-api"`. No entitlement-pending state for native providers.

### 2.4 The shared OpenAI-compatible client + per-provider shaping

The connectors package gains `native-api/`:

```
packages/connectors/src/native-api/
  types.ts              normalized NativeCompletionRequest, Message, Tool, BackendAgentEvent re-export
  openai-compat.ts      SHARED request shape + SSE parse for OpenAI/OpenRouter/xAI
  anthropic.ts          Anthropic Messages shaping (request + event parse)
  gemini.ts             Gemini generateContent + Vertex host shaping
  registry.ts           native provider catalog + providerKind(id) -> 'openai'|'anthropic'|'gemini'
  agent-loop.ts         runAgentLoop(transport, ...) — pure orchestrator
  transport.ts          HttpTransport interface (the seam)
  fixtures/             recorded non-network SSE responses (openai.txt, anthropic.txt, …)
  *.test.ts             fixture-driven, never network
```

`BackendAgentEvent` is defined in `@arden/protocol` (so the shell imports it)
and is the "same event surface" generalized — there is no pre-existing runtime
event union, so this becomes it:

```ts
export type BackendAgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; callId: string; tool: string; arguments: string;
      approval: ApprovalRequest }          // pre-shaped, ready for the queue
  | { type: "tool-result"; callId: string; ok: boolean; output: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; message: string }
  | { type: "cancelled" };
```

### 2.5 Tool dispatch (Arden owns it)

A small Arden-owned tool registry in `@arden/connectors/native-api/tools.ts`:
`read-file`, `write-file`, `run-shell`, `web-fetch`. Each declares its
default `mode`/`riskLevel`. The loop:

1. Model emits a `tool-call` event (parsed from the provider's native shape).
2. The shaper converts it into a `BackendAgentEvent.tool-call` carrying a
   pre-shaped `ApprovalRequest` (service = provider, action = tool+args digest,
   mode/risk from the tool registry default, modifiable by the user).
3. The shell pushes that `ApprovalRequest` into the **existing** approval queue
   — same UI, same grants/rules/audit/fail-closed confirmation as today.
4. On approval, Arden executes the tool via a runtime function and feeds a
   `tool-result` back into the next loop turn.
5. **Unregistered tools fail closed**: the loop emits a `tool-result` with
   `ok:false` and "tool not registered" rather than executing anything. Model-
   invented tool names never auto-run.

### 2.6 Memory integration

Pinned `MemoryRecord`s (trust = trusted) and pinned `KnowledgeSource`s (trust
may be untrusted) are injected into the request's system/context by trust level:
trusted memory enters as authoritative context; untrusted sources enter marked
as untrusted and never as tool definitions. When the model emits an inference
worth remembering, the loop surfaces it for approval; on approval it writes back
via the **existing** `promote_knowledge_source_to_memory` path (provenance =
provider, freshness = now, kind = `inference`). No new memory code path.

### 2.7 Usage / cost

Each provider's response includes usage; the shaper extracts it into a
`BackendAgentEvent.usage` with a per-model cost rate table in
`native-api/pricing.ts` (input $/Mtok, output $/Mtok). The loop accumulates and
the shell renders it. This honors the `usage-cost` capability at native-API
granularity.

### 2.8 Cancellation

Rust keeps a `Mutex<HashMap<String, oneshot::Sender<()>>>` cancel map. On
`cancel_backend_completion(requestId)` it sends; the streaming future selects
on the request future vs the cancel receiver and drops cleanly. TS signals via
`invoke("cancel_backend_completion", { requestId })`. This is real
cancellation of the in-flight HTTP request, not UI dismissal.

## 3. Compliance (enforced by tests, not just documented)

- **Anthropic**: only API-key (and Vertex/Bedrock host options) surfaced. No
  "Connect Claude.ai subscription." Copy: "Claude via Anthropic API key or
  Vertex/Bedrock."
- **Gemini**: only API key or Vertex. No Google AI Pro/Ultra subscription reuse.
  Copy: "Gemini via Google AI API key or Vertex AI."
- **Grok**: never assert any entitlement (carried over).
- A connectors test asserts the native catalogs contain no forbidden phrases
  (`claude.ai subscription`, `google ai pro`, `ultra subscription`,
  `included.*grok`, OAuth-for-Claude/Gemini), and that only the five native ids
  plus the four runtime ids appear.

## 4. Onboarding change

The `OnboardingPage` "Bring an API key" path transitions from `aria-disabled`
pending to **functional**. It renders the five native providers (OpenAI,
Anthropic, Gemini, xAI, OpenRouter) with compliant copy and a secret input that
hands off to the existing `connectBackend(providerId, secret)` →
`store_backend_credential`. The local-model card stays disabled. Gate copy
unchanged. (The four subscription providers remain on the subscription path.)

## 5. Testing strategy (no real network)

- **Connectors** (`native-api/*.test.ts`): shaper correctness per provider
  against recorded SSE fixtures; the agent loop over a `FixtureTransport`
  asserting text deltas, a tool-call producing an `ApprovalRequest`, usage
  accounting, cancellation, and unregistered-tool fail-closed. Registry tests
  for the extended vocabulary + compliance phrases.
- **Rust** (`tests.rs`): the new command's pure helpers (header building per
  provider, SSE-line normalization) + cancel-map mechanics, all with no network.
  The streaming command itself is exercised through its pure decomposition so no
  socket is opened. Secrets-never-leak assertions extended to the new providers.
- **Desktop** (`App.test.tsx`): the API-key path is now functional (input +
  connect clears the gate); the five native providers render; compliance copy
  present; local-model still disabled.

## 6. Non-goals / deferred

Local models, enterprise backends beyond Vertex-under-Gemini, OpenCode, the
four runtime backends (already shipped), voice/realtime, marketing/CI/release-
signing. Live transport for the *runtime* backends (spawning CLIs/app-server
sockets) remains deferred; this goal adds live transport only for the native
API adapters.
