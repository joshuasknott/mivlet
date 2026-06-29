# Provider-Neutral `AgentBackend` Runtime Contract — Design

**Date:** 2026-06-29
**Status:** Approved → implementing
**Scope:** Refactor the agent execution path from native-API-only into a
provider-neutral `AgentBackend` runtime contract. Preserve existing native
API-key behavior exactly. Introduce the abstraction needed for Codex app-server,
ACP, Copilot SDK, and future local/subscription runtimes. Do **not** make Codex
the foundation — make it one adapter.

---

## 1. Current state (from read-only audit)

### Execution path today
- The agent loop lives **entirely in TypeScript** (`runAgentLoop`,
  `packages/connectors/src/native-api/agent-loop.ts`), pure over three
  injectable seams: `HttpTransport.stream()`, `ToolExecutor`, and the
  `ApprovalGate`/`ToolRuntime` pair.
- Rust owns the **credential boundary** (`backends.rs`, keyring-primary) and
  the **HTTP/SSE transport** (`native_api.rs` → `stream_backend_completion`,
  relaying normalized SSE lines on `arden://backend/<requestId>`). Rust does
  **not** run an agent loop.
- The single hard choke point is `connectedNativeBackend`
  (`useShellRuntime.ts:461`): `backendType === "native-api" && connected &&
  streaming`. Both submit paths (`runPrompt`, Composer `onSubmit`) branch on it.

### What already exists as provider-neutral vocabulary
- `BackendType = "codex-app-server" | "acp" | "copilot-sdk" | "native-api"`
  (`packages/protocol/src/index.ts:470`) — the discriminator already exists.
- `BackendAgentEvent` (`packages/protocol/src/index.ts:1332`) — already a
  provider-neutral streaming surface: `text-delta | tool-call | tool-result |
  usage | done | error | cancelled`.
- `ToolExecutor`, `ApprovalGate`, `ToolRuntime` — already provider-neutral.
- `BackendProvider` with dynamic `capabilities`/`authState`/`models`.

### The gap
There is no provider-neutral **runtime contract**. The loop, transport, and
provider-id dispatch (`shapeBodyFor`, `streamFor`) are native-API-shaped. Codex,
ACP, and Copilot are **metadata-only** today (`resolveCodexProvider` etc. return
`BackendProvider` data with no execution path). The shell is wired to one
backend family by construction.

### Secrets boundary (already clean — must stay so)
- Keyring-primary + process-scoped in-memory fallback (`CREDENTIAL_STORE`),
  never serialized, never crossed to JS.
- `BackendCredentialRequest` carries a one-time secret into Rust; the response
  is `provider_id` only.
- No secret in React state, logs, snapshots, JSON config, fixtures, or the
  encrypted SQLite store.

---

## 2. The `AgentBackend` runtime contract

A new interface in `@fable/connectors` that any backend family implements. The
shell talks to one `AgentBackend` at a time. Native-API is the first concrete
adapter — **not** the foundation.

```ts
// packages/connectors/src/agent-runtime/contract.ts

/** A provider-neutral agent runtime. Native-API, Codex, ACP, Copilot each
 *  implement this. The shell resolves one AgentBackend per run and consumes
 *  its events uniformly. Carries NO secret — auth lives behind the Rust
 *  boundary / provider-owned auth caches, never in this type. */
export interface AgentBackend {
  /** The backend metadata this adapter runs for. */
  readonly backend: BackendProvider;
  readonly providerId: string;
  /** The closed capability set this adapter honors at its current auth state. */
  readonly capabilities: readonly BackendCapability[];

  /** Stream a prompt turn. Yields the same normalized BackendAgentEvent the
   *  native loop emits — text deltas, tool-call/approval requests, tool
   *  results, usage, done/error/cancelled. Every backend speaks this surface. */
  run(request: AgentRunRequest, options: AgentRunOptions): AsyncIterable<BackendAgentEvent>;

  /** Best-effort in-flight cancellation of the run with the given id. */
  cancel(runId: string): Promise<void>;

  /** Discover selectable models. Optional: a backend may report a fixed
   *  entitlement set or none at all. Truthful outcome required. */
  listModels?(): Promise<ModelDiscoveryResult>;
}

/** Normalized run request. Shaped like the existing key-free
 *  NativeCompletionRequest; carries NO key, NO token, NO URL. */
export interface AgentRunRequest {
  model: string;
  messages: NativeMessage[];
  tools: NativeToolSpec[];
  maxTokens: number;
}

export interface AgentRunOptions {
  execute: ToolExecutor;
  shouldCancel?: () => boolean;
  contextPrefix?: string;
  permissionMode?: PermissionMode;
  runId?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxToolOutputCharacters?: number;
}
```

### Design decisions
- **`BackendAgentEvent` is reused as the universal streaming surface.** Every
  backend emits the same events, so the shell's event handling (in
  `useNativeAgent`) stays byte-for-byte unchanged.
- **`ToolExecutor` + `ApprovalGate` stay exactly as-is** — already
  provider-neutral. A Codex/ACP backend that issues tool calls routes through
  the same approval queue.
- **`NativeMessage`/`NativeToolSpec` stay** as the normalized conversation
  shape (names retained to avoid churn; they are the generic run contract).
- **`listModels?` is optional** — native implements it via
  `list_backend_models`; Codex may report an entitlement set; ACP may report
  nothing.

### Secrets (reaffirmed)
The new types carry **no key, no token**. They are shaped like the existing
key-free `NativeCompletionRequest`/`NativeMessage`. Future adapters that need
auth reach credentials only through the Rust boundary or provider-owned auth
caches — never through the TS contract. This is enforced by code review and by
the existing `persistence.test.ts` assertions that no secret-named keys land in
snapshots/localStorage.

---

## 3. Adapter layer + factory

```
packages/connectors/src/agent-runtime/
  contract.ts              ← AgentBackend + AgentRunRequest/Options (above)
  factory.ts               ← resolveAgentBackend(provider, deps) dispatcher
  adapters/
    native-api.ts          ← NativeApiAgentBackend (wraps runAgentLoop + HttpTransport)
    codex.ts               ← resolveCodexBackend() → null (stub, documented contract)
    acp.ts                 ← resolveAcpBackend() → null (stub)
    copilot.ts             ← resolveCopilotBackend() → null (stub)
```

### Native-API adapter (`NativeApiAgentBackend`)
- Holds the resolved `BackendProvider` + an injected `HttpTransport` (desktop
  wires this over the Rust boundary; tests inject `FixtureTransport`).
- `run()` delegates to the **unchanged** `runAgentLoop`. The `streamFor` /
  `shapeBodyFor` provider-id dispatch stays **inside the adapter** — it is
  native-API-specific by nature and does not leak into the contract.
- `cancel()` delegates to the transport's cancel handle (the `requestId`).
- `listModels()` delegates to an injected discovery function.

### Factory (`resolveAgentBackend`)
- Switches on `provider.backendType`:
  - `"native-api"` → `NativeApiAgentBackend`
  - `"codex-app-server" | "acp" | "copilot-sdk"` → `null` (not yet wired), each
    with a comment naming the future adapter and what it must implement.
- Returns `null` when `authState !== "connected"` or the `streaming` capability
  is absent — **so `connectedNativeBackend` behavior is preserved by
  construction** (today only native-api can be connected+streaming).

### Dependency injection — `BackendDeps`
```ts
export interface BackendDeps {
  createTransport: (provider: BackendProvider) => HttpTransport | null;
  discoverModels?: (providerId: string) => Promise<ModelDiscoveryResult>;
}
```
The desktop shell supplies Tauri-bound implementations; tests inject fakes.
This keeps `@fable/connectors` pure (no network, no Tauri import) — same
boundary as today.

---

## 4. Shell wiring

### `useNativeAgent.ts`
- Calls `resolveAgentBackend(connectedBackend, deps)` → `AgentBackend | null`.
- `run()` calls `backend.run(request, opts)` instead of
  `runAgentLoop(transport, ...)`. Transport-building, `shapeBodyFor`, and
  `streamFor` move **into** the native adapter — the hook no longer references
  provider ids.
- Event handling (`text-delta`, `tool-call`, persistence, retry) is
  **unchanged** — it already consumes `BackendAgentEvent`, now the universal
  surface.
- `tauriTransport` becomes the desktop's `createTransport` dependency;
  `cancelRef` still holds the `requestId` so `cancel()` reaches Rust.

### `useShellRuntime.ts`
- `connectedNativeBackend` → `connectedAgentBackend`: same filter but
  generalized to *any* backend with `streaming` capability + `connected`.
  **Behavior preserved exactly**: today only native-api can be
  connected+streaming, so the result is identical. Future adapters naturally
  take over when they connect.

### `App.tsx`
- Submit paths (`runPrompt`, Composer `onSubmit`) switch from
  `connectedNativeBackend` to `connectedAgentBackend`. The fallback to
  knowledge-search is unchanged.

---

## 5. Rust side (minimal, boundary-preserving)

`backends.rs` and `native_api.rs` are **already provider-neutral at the
contract level** (`BackendType`, the `BackendCredentialStore` trait,
`stream_backend_completion` keyed by providerId). No structural Rust change is
required to *introduce* the TS abstraction — the abstraction lives in TS.

- **No new Rust commands this goal.** Codex/ACP/Copilot execution stays
  metadata-only (out of scope). The abstraction is the deliverable.
- **No secret consolidation.** Egress stays per-family; there is no generic
  "run any backend" Rust path that could funnel secrets. `native_api.rs`
  remains the sole egress command, reserved for native-API.
- The duplicated capability sets (`backends.rs` `CATALOG` caps vs
  `capabilities.ts`) are **left as-is** to preserve behavior and avoid scope
  creep; a cross-reference comment documents the relationship.

---

## 6. Testing

- New unit tests in `packages/connectors/src/agent-runtime/`:
  - `factory.test.ts` — dispatch returns `NativeApiAgentBackend` for
    connected native-api; `null` for non-native / unconnected / no-streaming.
  - `adapters/native-api.test.ts` — `NativeApiAgentBackend.run()` over a
    `FixtureTransport` yields the expected `BackendAgentEvent` sequence;
    `cancel()` and `listModels()` delegate correctly.
- Existing `agent-loop.test.ts`, `transport.test.ts`, `App.test.tsx`,
  `useNativeAgent.test.tsx` stay green (loop unchanged, just wrapped).
- `App.test.tsx` still asserts the credential boundary receives `secret`, the
  no-transport path surfaces, etc.

---

## 7. Verification gates

- `pnpm check` (typecheck + test + build + tauri:check)
- `pnpm lint`
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`

---

## 8. What this does NOT do

- Does not implement Codex/ACP/Copilot execution (out of scope — stubs only).
- Does not change the secrets boundary in any way.
- Does not refactor the Rust catalog or merge the duplicated capability sets.
- Does not rename `NativeMessage`/`NativeCompletionRequest` (churn risk; they
  remain the generic conversation shape).
