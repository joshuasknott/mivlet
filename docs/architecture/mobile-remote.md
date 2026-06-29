# Mobile remote control

> [!WARNING]
> **Status: Planned Design / UI Stub Only**
> This document describes the planned architecture and specification for mobile remote control.
> In the current codebase, this feature is not implemented. There is no active socket, mDNS advertising, or remote protocol. The remote control is represented solely as a UI preview/stub on the desktop shell.

The mobile device is designed to be a **second approval, observation, and control surface** for
the desktop. It does not become a cloud backend, a hosted account, or an
execution authority. The desktop remains the only execution authority: every
mobile-originated action funnels through the existing approval and scheduler
boundaries — and their fingerprinted one-time execution permits — unchanged.
This document covers pairing, trust, transport, threat model, revocation,
offline behavior, the approval flow, and what is explicitly not cloud-hosted.

The wire types live in `packages/protocol/src/index.ts` (the mobile-remote
section); the pure session/pairing/authorization/dispatch logic lives in
`packages/connectors/src/mobile-remote/`; the desktop command boundary is
`apps/desktop/src-tauri/src/remote_control.rs`. The design spec is
`docs/superpowers/specs/2026-06-29-mobile-remote-control-design.md`.

## Mental model

A paired phone is a remote control with a deliberately narrow capability set:
observe run and schedule status, approve or deny pending approvals, and pause,
resume, or delete schedules. It is never a substitute for the desktop's own
approval queue. Mobile approve/deny is an *input* to that queue — it does not
issue an execution permit. A tool still requires the desktop's fresh
fingerprinted one-time permit before it fires, exactly as it does for a
desktop-initiated decision.

## Pairing

Pairing establishes pairwise local trust. The flow:

1. The desktop shows a QR code encoding an ephemeral pre-shared key (PSK) plus
   its LAN endpoint.
2. The mobile device scans the QR and is prompted to type the short numeric
   confirmation code displayed on the desktop.
3. The confirmation code proves physical presence. A remote attacker who only
   captured the QR — for example via a screenshot — cannot pair, because they
   never see the code displayed on the desktop screen.
4. The Rust boundary verifies a PSK-derived proof token. The PSK itself never
   crosses into JavaScript and is never written to a protocol type.
5. On success the ephemeral PSK rotates to a long-lived per-device key. The
   device is added to the trust list and a bounded session begins.

## Trust

Trust is pairwise and local. There is **no hosted Fable account**. The trust
list is a set of `RemoteDevice` records holding only non-secret metadata: an
opaque id, a user-editable label, the trust state (`pending`, `trusted`,
`revoked`), and bookkeeping timestamps. PSK material and long-lived device keys
live behind the Rust boundary, exactly like backend credentials, and are never
read back into JavaScript, React state, logs, snapshots, or JSON.

## Transport (v1)

Version one is **LAN-direct**. The mobile device discovers the desktop on the
local network via mDNS and connects over a local WebSocket Secure (WSS)
connection authenticated with PSK-mutual authentication. Replay protection uses
a per-frame nonce carried in the versioned envelope. There is no relay and no
cloud hop in v1.

> Note: the live WebSocket listener and mDNS advertiser in Rust are the next
> layer and are not part of this foundation pass. The command boundary in
> `remote_control.rs` exposes the surface the transport will call, and fails
> closed until that transport binds sessions to devices.

## Threat model

This model extends the existing threat model in `docs/security/threat-model.md`
with a new trust boundary: *mobile device to desktop runtime*.

- **Stolen-QR-only attacker.** An attacker who captures only the QR (screenshot,
  shoulder-surf of the code) gains the ephemeral PSK but not the confirmation
  code, which is shown on the desktop screen and typed separately. Pairing fails
  closed without it.
- **Replayed approvals.** A mobile approve carries an approval id; the
  fail-closed authorization gate rejects any id that is not present in the
  pending index. A replayed id — after the approval was already resolved — is
  absent from the index and is rejected with `approval-not-found`.
- **Argument-substituted approvals.** Mobile approve/deny never carries tool
  arguments or an execution permit. It resolves an existing approval through the
  same path the desktop uses, which still rechecks the exact argument preview,
  workspace confinement, and permit freshness before any tool fires.
- **Offline / unpaired device.** Off-LAN or unpaired devices cannot reach the
  desktop and fail closed. No remote command is queued for later execution.
- **Credential exfiltration via the remote channel.** Nothing secret crosses the
  wire. The protocol types carry no key, token, PSK, or credential; the
  `HARD SECRET INVARIANT` on the mobile-remote types mirrors the native-API
  invariant. A compromised mobile device learns only the non-secret observation
  stream and can only submit the narrow control commands above.
- **Lost or stolen device.** Bounded session lifetimes and idle timeouts limit
  the window. Revocation (below) closes it immediately.

## Revocation

Revoking a device removes it from the trust list (or marks it revoked),
rekeys the long-lived device key, and marks any active session revoked. The
transport rejects the next frame from a revoked device and tears the connection
down. A revoked device cannot re-pair without a fresh QR + confirmation code
issued from the desktop. Revocation is terminal for that device id.

## Offline behavior

When the mobile device is off-LAN, asleep, or unpaired, it sees "offline" and
can do nothing. The desktop keeps working unmodified — runs proceed, schedules
fire, approvals queue for local resolution. There is **no queued remote
command**: a missed mobile decision does not defer or auto-resolve anything on
the desktop. If a pending approval times out on the desktop, it times out
according to the existing approval rules, exactly as without a paired device.

## Approval flow

A pending approval surfaced to the mobile device is the same `ApprovalRequest`
shape the desktop queue already uses. The desktop streams an
`approval-requested` event; the mobile device returns `approve` (with a grant
decision of `once`, `session`, or `rule`) or `deny`. The desktop's fail-closed
authorization gate checks that the approval id is still pending and the session
is live before applying the decision. Applying the decision routes through the
existing approval-resolution path, which records the audit entry, persists any
grant, and — for tool-call approvals — issues the one-time execution permit that
the Rust side-effect boundary still revalidates immediately before dispatch. At
no point does the mobile decision become execution authority on its own.

## Schedule control

The mobile device may pause, resume, or delete a scheduled job. Each command
requires an exact matching job id; an unknown id fails closed with
`schedule-not-found`. The command routes through the same scheduler mutation
path the desktop shell uses, so scheduling semantics, lease/fencing behavior,
and queue recovery are unchanged.

## Explicitly not cloud-hosted

- **No hosted Fable account.** Pairing is pairwise local trust; there is no
  Fable server that authenticates the device or brokers the session.
- **No relay.** v1 is LAN-direct only. An optional thin relay for roaming is
  documented as a future seam, not built here, and would relay packets only —
  never storing session data or secrets.
- **No session data leaves the LAN.** Observation events and control commands
  stay on the local network between the paired device and the desktop.
- **No mobile-originated auto-execution.** Mobile decisions are inputs to the
  existing approval queue; they never bypass the desktop's permit system.
- **No secrets in any mobile-visible type.** The protocol, the trust list, and
  sessions carry no key, token, PSK, or credential. Secrets live behind the
  Rust boundary.
- **No secrets in React state, logs, snapshots, or JSON.** The trust list and
  sessions are non-secret metadata only.

## What is deferred

The following are explicitly out of scope for this foundation pass and are
documented here so the boundary is clear:

- The live Rust WebSocket listener and mDNS advertiser (the transport layer this
  command surface plugs into).
- Real PSK generation, proof verification, and long-lived device-key rotation
  (the crypto the transport wires up).
- The real mobile application build (React Native, Tauri Mobile, or similar)
  that consumes these protocol types.
- An optional thin relay for roaming — a future seam, not an exclusion.
- Mobile composer/submit, model selection, backend connection, and credential
  entry. Out of scope for v1.
