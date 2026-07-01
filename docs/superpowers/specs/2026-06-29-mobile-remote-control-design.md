# Mobile Remote-Control Foundation — Design

**Date:** 2026-06-29
**Branch:** `feat/mobile-remote-control` (worktree at `.worktrees/mobile-remote-control`)
**Status:** Approved design — to be implemented from this spec.

## Goal

Design and implement the **smallest credible local-first mobile remote-control foundation** for Fable. The mobile device controls / approves / observes the desktop. It does **not** become a cloud backend, a hosted account, or an execution authority.

## Non-Goals (explicit)

- A full mobile app build. This pass is the desktop-side foundation plus versioned protocol types and pure logic.
- A live WebSocket listener / mDNS advertiser in Rust (the next layer; deliberately deferred to avoid overbuilding).
- Cloud relay, roaming, or any hosted Fable account. Pairing is pairwise and LAN-local.
- Mobile-originated auto-execution. Mobile decisions are *inputs* to the existing approval queue, never execution authority.
- Mobile composer/submit, model selection, backend connection, or credential entry. Out of scope for this pass.

## Mental Model

The mobile device is a **second approval / observation / control surface**. The desktop remains the only execution authority. Every mobile-originated action funnels through the **existing** approval and scheduler boundaries — and their fingerprinted one-time execution permits — unchanged. Mobile approve/deny is an input to the existing approval queue, not a substitute for the desktop's fresh permit.

Trust is pairwise and local: there is no hosted Fable account. The trust list is non-secret local metadata; PSK material lives behind the Rust boundary exactly like backend credentials.

## Decisions (locked)

1. **Transport/trust model:** LAN-direct primary. mDNS discovery + local WSS with PSK-mutual auth. No relay, no cloud. Relay/roaming are explicitly deferred future work, documented here rather than built.
2. **Capabilities (v1):** Observe (read-only run + schedule status event stream) + Approve/Deny pending approvals + Schedule control (pause/resume/delete).
3. **Pairing:** QR carries an ephemeral PSK + LAN endpoint; user types/confirms a short numeric code displayed on the desktop to prove physical presence. PSK rotates to a long-lived per-device key on first session.

## Architecture (component layout)

The design maps onto Fable's existing layering with no new conventions:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Wire types | `packages/protocol/src/index.ts` | Versioned, secret-free protocol types only. No tests (matches existing protocol package convention). |
| Pure logic | `packages/connectors/src/mobile-remote/` | Session state machine, pairing validation, fail-closed authorization, command dispatch. Vitest, no I/O. |
| Rust command boundary | `apps/desktop/src-tauri/src/remote_control.rs` | Trust list + PSK ownership, command validation, delegation to existing `approvals`/`scheduler` modules. Registered in `lib.rs`. No WS listener this pass. |
| Architecture note | `docs/architecture/mobile-remote.md` | Pairing, trust, transport, threat model, revocation, offline, approval flow, what is not cloud-hosted. |

The existing `@fable/protocol` package is types-only (no tests); `@fable/connectors` holds pure logic with vitest; Rust owns credentials and side-effects; the shell wires them. Mobile remote-control reuses this exact split.

## Protocol Types

All additive, secret-free, closed-vocabulary, mirroring the existing style in `packages/protocol/src/index.ts`. A `HARD SECRET INVARIANT` comment block accompanies them: no key/token/credential/PSK ever appears in any of these types.

### Trust + session identity
- `RemoteDeviceId` — opaque string id for a paired device.
- `RemoteDeviceLabel` — user-editable display name (e.g. "Josh's phone").
- `RemoteDeviceTrustState` — `"pending" | "trusted" | "revoked"`.
- `RemoteDevice` — `{ id, label, trustState, firstPairedAt, lastSeenAt, revokedAt? }`. Non-secret metadata only; no key material.
- `RemoteSessionState` — `"pairing" | "active" | "expired" | "revoked"`.
- `RemoteSession` — `{ id, deviceId, state, createdAt, expiresAt, lastActivityAt }`.

### Pairing handshake
- `RemotePairingChallenge` — desktop-issued: `{ challengeNonce, confirmCode }`. `confirmCode` is the short numeric code; never the PSK.
- Pairing proof is verified entirely inside the future Rust transport. No PSK-derived proof value crosses the JavaScript/protocol boundary.
- `RemotePairingResult` — `{ ok: true; device: RemoteDevice; session: RemoteSession } | { ok: false; code: RemoteErrorCode; message }`.

### Versioned envelope
- `RemoteProtocolVersion` — `1` (constant for v1).
- `RemoteEnvelopeV1` — `{ protocolVersion: 1; sessionId: string; nonce: string; payload: RemoteEvent | RemoteCommand }`. PSK-mutual authentication + replay protection are transport-layer concerns (Rust); the envelope carries only routing + version + a per-frame nonce.

### Observation (desktop → mobile, read-only)
`RemoteEvent` — discriminated union:
- `{ type: "run-status"; runId; status: WorkflowRunStatus; updatedAt }`
- `{ type: "schedule-status"; jobId; status: ScheduledJobStatus; nextRunAt }`
- `{ type: "approval-requested"; approval: ApprovalRequest }` — reuses the existing `ApprovalRequest` shape verbatim.
- `{ type: "approval-resolved"; approvalId; decision: ApprovalDecision; decidedAt }`

### Control (mobile → desktop)
`RemoteCommand` — discriminated union:
- `{ type: "approve"; approvalId; decision: "once" | "session" | "rule" }`
- `{ type: "deny"; approvalId }`
- `{ type: "pause-schedule"; jobId }`
- `{ type: "resume-schedule"; jobId }`
- `{ type: "delete-schedule"; jobId }`

### Errors + fail-closed
- `RemoteErrorCode` — `"device-unpaired" | "device-revoked" | "session-expired" | "approval-not-found" | "approval-already-resolved" | "schedule-not-found" | "invalid-command" | "protocol-version-unsupported" | "transport-unavailable" | "unauthorized"`.
- `RemoteCommandResult` — `{ ok: true; appliedAt } | { ok: false; code: RemoteErrorCode; message }`.

## Pure Logic — `packages/connectors/src/mobile-remote/`

Pure, fixture-testable logic. No network, no filesystem, no timers except injected ones. Mirrors how the native-API agent loop lives in connectors with the Rust boundary owning egress.

### `session.ts`
- `createSession(deviceId, now)` → `RemoteSession` in `pairing` state.
- `activateSession(session, now)` → transitions to `active`, sets `expiresAt` (bounded session lifetime).
- `isSessionLive(session, now)` → `true` only when `active` and `now < expiresAt` and `now - lastActivityAt < idleTimeout`. Otherwise fail-closed `false`.
- `touchSession(session, now)` → bumps `lastActivityAt`.
- `revokeSession(session, now)` → transitions to `revoked` (terminal).
- Constants: `SESSION_LIFETIME_MS`, `SESSION_IDLE_TIMEOUT_MS` (bounded; session cannot live forever).

### `pairing.ts`
- `verifyConfirmCode(expected, provided, now, deadline)` → validates the short numeric confirm code within its time window. Returns `{ ok: true } | { ok: false; code: RemoteErrorCode }`. Pure over injected crypto/nonce material; PSK proof itself is Rust-side.
- `generateConfirmCodeFixture(seed)` — deterministic test helper producing a valid numeric code (mirrors how connectors expose fixture builders).

### `authorization.ts` (the fail-closed gate)
The load-bearing module. A mobile command only resolves a pending desktop approval that **exists and is unconsumed**; everything else is a rejected no-op.
- `authorizeCommand(command, session, devices, pendingApprovals, now)` → `RemoteCommandResult`. Every command requires a session bound to a currently trusted device. Approval decisions also require a live session and an exact pending approval id; schedule commands require an exact job id.
- Approval commands do **not** produce an execution permit. They return whether the command is *eligible to be applied*; the actual permit issuance stays in the existing Rust `approvals`/`execution_approvals` path, unchanged.
- `RemoteCommand` types that aren't recognized → `{ ok: false; code: "invalid-command" }`.

### `dispatcher.ts`
Maps a `RemoteCommand` validated by `authorization.ts` onto the existing runtime seams. Pure: it takes the current state + a `CommandRuntime`-style dependency interface and returns the next state, never performing I/O. Schedule mutations route to the same scheduler state transitions the shell already performs; approve/deny route to the same approval-resolution seam. No new side-effect paths are introduced.

### Tests
- `session.test.ts` — live/expired/idle-timeout/revoked transitions; every non-live session fails closed.
- `pairing.test.ts` — confirm-code window, mismatched code, expired deadline.
- `authorization.test.ts` — **fail-closed is the core assertion**: replayed approval ids, non-existent approvals, already-resolved approvals, unpaired/revoked devices, expired/revoked sessions, unknown job ids, and unknown command types all return `{ ok: false }` and apply nothing.
- `dispatcher.test.ts` — validated commands map onto the correct runtime seams; nothing dispatches without authorization.

## Rust Command Boundary — `apps/desktop/src-tauri/src/remote_control.rs`

A thin module registered in `lib.rs` `invoke_handler`. **No WebSocket listener in this pass** — that is the documented next layer. The module exposes the command surface the (future) WS transport will call:

- `remote_control_status()` / `remote_control_enable()` / `remote_control_disable()` → honest non-secret local status. Enablement remains unavailable until a transport exists.
- `remote_list_devices()` → `Vec<RemoteDevice>` (trust list; non-secret metadata).
- `remote_pairing_start()` / `remote_pairing_status()` → fail closed with `transport-unavailable` until the Rust transport and crypto exist.
- Pairing completion is not a JavaScript command; future proof verification and key rotation stay inside Rust.
- `remote_revoke_device(deviceId)` → removes device from trust list, rekeys, marks any session revoked. Subsequent frames from that device are rejected.
- `remote_handle_command(envelope)` → validates the inbound envelope against the trust list + a live session via the pure `authorization` logic, then delegates `approve`/`deny` to the existing `approvals`/`execution_approvals` modules and schedule commands to the existing `scheduler` module. Returns `RemoteCommandResult`. Never issues an execution permit on mobile authority alone — it feeds the existing approval-resolution path, which still requires its own fresh permit for any tool to fire.

Secrets (PSK, long-lived device keys, pairing nonces) stay behind the Rust boundary exactly like backend credentials. JavaScript/the shell only ever see `RemoteDevice` metadata, `RemoteSession` state, and `RemoteCommandResult`.

## Architecture Note — `docs/architecture/mobile-remote.md`

A standalone doc alongside `encrypted-storage.md`; `docs/product/architecture.md` gains a one-line cross-reference in its boundaries section. Covers, as sections:

1. **Mental model** — second surface, not authority; desktop is the only execution authority.
2. **Pairing** — QR (ephemeral PSK + LAN endpoint) + short confirm code for physical-presence proof; PSK rotation to a long-lived device key on first session.
3. **Trust** — pairwise device records, not accounts; trust list is local non-secret metadata.
4. **Transport (v1)** — LAN-direct: mDNS discovery + local WSS, PSK-mutual. **No relay, no cloud.**
5. **Threat model** — stolen-QR-only attacker (confirm code stops them); replayed approvals (existing one-time permit stops them); offline/unpaired (fail closed); credential exfiltration via remote (none cross the wire — protocol is secret-free).
6. **Revocation** — delete device from trust list; desktop rekeys; stale device's next frame rejected + connection torn down.
7. **Offline behavior** — off-LAN/unpaired device sees "offline"; desktop keeps working unmodified; no queued remote commands.
8. **Approval flow** — mobile approve/deny is an input to the existing approval queue, not execution authority; tools still require the desktop's fresh fingerprinted permit.
9. **Explicitly not cloud-hosted** — no account, no relay, no session data leaves the LAN, no mobile-originated auto-execution, no secrets in any mobile-visible type.
10. **What's deferred** — WS listener/mDNS advertiser in Rust, mobile app build, relay/roaming, mobile composer/submit.

## Secret Safety

- **No secrets in any protocol type.** A `HARD SECRET INVARIANT` comment block on the mobile-remote types mirrors the existing native-API invariant.
- PSK + device keys live behind the Rust boundary (like backend credentials), never read back into JS.
- No secrets in React state, logs, snapshots, or JSON. The trust list and sessions are non-secret metadata only.
- No hosted account required; pairing is pairwise local trust.

## Verification

- `pnpm test` covers the pure logic (session, pairing, authorization fail-closed, dispatcher).
- `pnpm typecheck` + `pnpm build` cover the protocol additions.
- `pnpm tauri:check` confirms the new Rust module compiles.
- `pnpm check` is the aggregate. New logic is pure TS + Rust compile, so it's covered by these. Anything not run is explained at commit time.
- Commit on `feat/mobile-remote-control` only; `main` is not pushed.

## Future Work (documented, not built here)

- Rust WebSocket listener + mDNS advertiser (the transport layer this foundation plugs into).
- Real mobile app build (React Native / Tauri Mobile) consuming these protocol types.
- Optional thin relay for roaming — explicitly deferred; documented as a future seam, not an exclusion.
- Mobile composer/submit and model selection — out of scope for v1.
