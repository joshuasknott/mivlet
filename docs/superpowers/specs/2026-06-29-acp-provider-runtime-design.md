# ACP Process Runtime — Cursor & Grok `AgentBackend`

**Date:** 2026-06-29
**Branch:** `codex/runtime-acp-providers`
**Builds on:** `28f0b64 feat: add provider-neutral agent backend runtime` (Goal 1's
committed `AgentBackend` contract).
**Status:** Approved → implementing

## 1. Goal

Land the reusable ACP (Agent Client Protocol) process adapter behind Goal 1's
`AgentBackend` contract, plus thin Cursor and Grok provider definitions. ACP is
the shared stdio/JSON-RPC transport Cursor and Grok speak; auth is a
**user-installed CLI** (CLI-owned — Fable never holds a subscription token).

This goal delivers the **provider-neutral protocol adapter** (process lifecycle,
session, prompt, streamed output, tool activity, approvals, cancellation,
errors, shutdown) and the **CLI-availability/auth-state detection**. It does
**not** bundle a CLI, does not require a live provider account, and makes no
capability the adapter cannot back.

## 2. Constraints (non-negotiable, from the objective + security docs)

- **Reuse provider-owned auth.** No subscription token is ever collected in
  Fable, stored in React state, logs, fixtures, snapshots, or JSON metadata.
- **Spawn CLIs only through a dedicated Rust command** (process + auth broker),
  never from JavaScript. This mirrors the native-API egress boundary
  (`native_api.rs`), the auth-broker doc's "model/inference egress goes direct,
  never through a generic broker," and the threat model's credential boundary.
- **Keep generic ACP protocol handling separate from provider-specific
  executable discovery + capability declarations.** No Codex-specific behavior.
- **Do not claim unsupported capabilities.** `ACP_CAPS` is the truthful ceiling;
  capabilities are only reported when the adapter can honor them.
- **Preserve unrelated changes and local-first behavior.** No hosted Fable
  account required; no unrelated UI redesign.

## 3. Architecture

Two clean layers, matching the existing `native-api` adapter's shape (logic/data
split, pure protocol over an injected transport):

```
packages/connectors/src/agent-runtime/
  contract.ts                  ← (Goal 1, unchanged) AgentBackend + deps
  adapters/
    acp.ts                     ← resolveAcpBackend(): builds AcpAgentBackend
    acp/                       ← NEW: generic ACP protocol handling (no provider ids)
      protocol.ts              ←   typed JSON-RPC message envelope + framing
      transport.ts             ←   AcpTransport interface (pure seam)
      session.ts               ←   session/prompt/cancel orchestration → BackendAgentEvent
      events.ts                ←   normalize ACP frames → BackendAgentEvent
      approvals.ts             ←   ACP tool call → ApprovalRequest (reuses buildToolApproval)
      index.ts                 ←   barrel
    acp-providers.ts           ← NEW: provider definitions (executable discovery + caps)
      cursor/grok: which CLI command, args, capability/limit declarations
  factory.ts                   ← switch case "acp" now returns the real backend
```

**Provider-specific concerns (executable discovery, capabilities) live ONLY in
`acp-providers.ts`.** The `acp/` subpackage is generic JSON-RPC over stdio and
never references "cursor"/"grok". Adding a future ACP provider = one entry in
`acp-providers.ts`.

## 4. ACP transport seam (dependency injection)

The adapter does **not** spawn a process from TS. It consumes an injected
`AcpTransport` (like native-API's `HttpTransport`):

```ts
// acp/transport.ts — pure, browser-safe
export interface AcpFrameSender { (frame: AcpFrame): Promise<void> }
export interface AcpTransport {
  /** Send a JSON-RPC frame to the CLI's stdin (Rust owns the actual pipe). */
  send: AcpFrameSender;
  /** Async stream of frames the CLI emitted on stdout/stderr. */
  frames(): AsyncIterable<AcpFrame>;
  /** Best-effort shutdown of the underlying process (Rust kills the child). */
  close(): Promise<void>;
}
```

The desktop shell supplies a Tauri-bound transport in a follow-up wiring step
(the Rust `spawn_acp_process` command). **This goal implements the adapter +
fake-process tests against a scripted transport** — the Rust spawn command is
named and its contract documented, but live process wiring is gated behind
landing that command (out of scope to avoid a half-wired spawn path). This keeps
the secrets/process boundary intact: there is no path where JS spawns a CLI.

## 5. Protocol framing (`acp/protocol.ts`)

A typed, generic JSON-RPC 2.0 envelope over newline-delimited stdio frames. The
adapter is **transport-driven** (it does not hard-code a provider's wire
contract): it reads framed messages and normalizes the event categories the
`AgentBackend` contract requires.

```ts
export type AcpFrame =
  | AcpRequest            // { jsonrpc, id, method, params }
  | AcpResponse           // { jsonrpc, id, result? | error? }
  | AcpNotification;      // { jsonrpc, method, params }  (no id — streamed events)
```

`AcpNotification` carries the streamed run events (`session/update`,
`message/text`, `tool/call`, `tool/result`, `usage`, `done`, `error`). The
adapter maps these onto `BackendAgentEvent` (`events.ts`). Unknown methods are
ignored (forward-compatible) and never raise — the adapter cannot be broken by a
new notification method.

A `parseAcpLine(line: string): AcpFrame | null` helper does the framing + JSON
validation (bounded size, malformed → null). This is the pure, fixture-tested
unit.

## 6. Session lifecycle (`acp/session.ts`)

`run()` orchestrates a prompt turn:
1. `initialize` → negotiate protocol version + capabilities the CLI declares.
2. `session/new` → open a session (model from `AgentRunRequest.model`).
3. `session/prompt` → submit the user turn; consume the streamed notification
   frames, yielding `BackendAgentEvent`s as they arrive.
4. For each `tool/call`: build an `ApprovalRequest` (via the reused
   `buildToolApproval`), yield `tool-call`, then await `options.execute(...)`.
   The result is sent back as a `tool/result` frame; the loop continues.
5. `done`/`error`/`cancelled` terminate the run and the session is closed
   (`session/close`) + `close()`.

Cancellation: `cancel(runId)` sends a cancellation and closes the transport; the
session loop also checks `options.shouldCancel` between frames (cooperative).

Bounds enforced (mirroring the native loop's tool-safety gates):
- max turns, max tool calls per run, max tool output characters, arg size,
  callId shape validation, replayed/reused callId rejection, unknown-tool
  fail-closed. Same invariants as `agent-loop.ts` so ACP tool calls route through
  Fable's approval queue identically.

## 7. CLI availability + auth-state detection

The Rust `list_backends` already resolves ACP providers to
`install-required` (`backends.rs:399`). For **connected** state, a real CLI
probe is needed. This goal adds a **pure capability resolver** +
`detectAcpRuntime(providerId, probe)` that maps a CLI probe result to a truthful
`BackendAuthState` + capability set:

```
probe result        → authState          → capabilities
─────────────────────────────────────────────────────────
not-installed       → install-required   → []
installed/signed-out→ needs-auth         → []
auth-failed         → unavailable        → []  (fail-closed)
probe-unavailable   → unavailable        → []
connected+ready     → connected          → ACP_CAPS (streaming, tools, …)
```

`BackendAuthState`'s closed vocabulary is `connected | needs-auth |
install-required | entitlement-pending | unavailable` — there is no standalone
"failed" auth state, so an `auth-failed` probe maps to `unavailable` (fail-closed:
no capabilities). Run-level failures (a model/protocol error during a turn)
surface separately as `BackendAgentEvent` `error` events, which the shell
already handles.

`acp-providers.ts` declares each provider's executable spec (command name, args
to probe auth, e.g. `cursor agent status` / `grok status`) without bundling it.
The desktop wiring invokes the probe through Rust (a future
`detect_acp_cli` command); tests inject a fake probe. **No executable is spawned
from TS.**

## 8. Cursor & Grok provider definitions (`acp-providers.ts`)

```ts
export const ACP_PROVIDERS: Record<AcpProviderId, AcpProviderDefinition> = {
  cursor: { executable: "cursor", authProbeArgs: ["agent", "status"], label, models: [...] },
  grok:   { executable: "grok",   authProbeArgs: ["status"],          label, models: [...], entitlementsPending: true }
};
```
- Reuses the existing `acpFixtures` (install hints, models) — no duplication.
- Grok: entitlements stay empty until a post-login check (compliance invariant).

## 9. Factory wiring

`factory.ts`:
- `"acp"` → `resolveAcpBackend()` returns a live `AcpAgentBackend` when the
  provider is connected + streaming; `null` otherwise (preserving
  `connectedNativeBackend` behavior).
- `hasRunnableAdapter("acp")` → `true` (the adapter is now live for a connected
  ACP provider). Shell behavior is preserved because today no ACP provider can
  be `connected` (CLI probe wiring lands later), so the predicate change is
  inert until a real CLI connects.

## 10. Testing (fake-process, no live accounts)

`acp/*.test.ts`:
- `protocol.test.ts` — `parseAcpLine` framing: valid request/response/notification,
  malformed/oversized/non-JSON → null, `[DONE]`/control lines.
- `events.test.ts` — each ACP notification → correct `BackendAgentEvent`.
- `approvals.test.ts` — ACP tool call → ApprovalRequest (registered + unregistered
  fail-closed); reuses `buildToolApproval`.
- `session.test.ts` — a scripted `FakeAcpTransport` drives a full turn:
  initialize → prompt → text deltas → tool/call → execute → tool/result → done.
  Asserts the exact `BackendAgentEvent` sequence + that tool results are sent
  back. Cancellation mid-turn. Error frame → `error` event. Max-turn/tool-call
  caps. Replay rejection.
- `acp-providers.test.ts` — Cursor/Grok definitions; `detectAcpRuntime` maps each
  probe result to the truthful auth-state + caps (install-required, signed-out,
  connected, failed, unavailable). Grok entitlement-pending.
- `factory.test.ts` (extend) — `acp` returns a live backend when connected+streaming,
  null otherwise.

`BackendAgentEvent` is the universal surface, so `useNativeAgent` event handling
is **unchanged** (byte-compatible) — no UI redesign.

## 11. What this does NOT do

- Does not bundle or redistribute a CLI.
- Does not spawn a CLI from JavaScript — only through the (documented) Rust
  command; live Rust spawn wiring is gated behind landing it safely.
- Does not collect, store, or pass subscription tokens anywhere.
- Does not change the secrets boundary, the Rust catalog, or unrelated UI.
- Does not embed Codex-specific behavior.

## 12. Verification gates

- `pnpm --filter @fable/connectors test` (new fake-process tests)
- `pnpm typecheck`
- `pnpm lint`
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
  (Rust catalog stays unchanged; gates stay green)
- `pnpm tauri:check` (cargo check) — unchanged Rust still compiles
