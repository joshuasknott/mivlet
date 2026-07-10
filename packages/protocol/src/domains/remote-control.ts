import type { ApprovalDecision, ApprovalRequest } from "./approvals.js";
import type { ScheduledJobStatus, WorkflowRunStatus } from "./scheduling-workflows.js";

// ---------------------------------------------------------------------------
// Mobile remote-control foundation.
//
// The mobile device is a SECOND approval / observation / control surface for
// the desktop, never an authority and never a cloud backend. The desktop is
// the only execution authority: every mobile-originated action still funnels
// through the existing approval + scheduler boundaries and their fingerprinted
// one-time execution permits, unchanged. There is no hosted Fable account;
// pairing is pairwise and LAN-local.
//
// See docs/architecture/mobile-remote.md for pairing, trust, transport, threat
// model, revocation, offline behavior, and the explicit non-cloud guarantees.
//
// HARD SECRET INVARIANT: none of these types carry a key, token, PSK,
// credential, or device secret. Pairing secrets and long-lived device keys
// live behind the Rust boundary (like backend credentials) and are never read
// back into JavaScript. The trust list and sessions below are non-secret
// metadata only. Wire types here mirror the protocol's existing secret-free
// contract.
// ---------------------------------------------------------------------------

/** The trust state of a paired device in the local trust list. */
export type RemoteDeviceTrustState = "pending" | "trusted" | "revoked";

/** Opaque id of a paired device. */
export type RemoteDeviceId = string;

/**
 * A paired device record held in the desktop trust list. Non-secret metadata
 * only — no PSK, no long-lived key. Those live behind the Rust boundary.
 */
export interface RemoteDevice {
  id: RemoteDeviceId;
  label: string;
  trustState: RemoteDeviceTrustState;
  /** ISO timestamp of first successful pairing. */
  firstPairedAt: string;
  /** ISO timestamp of the last frame seen from this device. */
  lastSeenAt: string;
  /** ISO timestamp when the device was revoked, if any. Terminal. */
  revokedAt?: string;
}

/** Lifecycle of a remote session bound to a trusted device. */
export type RemoteSessionState = "pairing" | "active" | "expired" | "revoked";

/**
 * A session between a trusted device and the desktop. Non-secret: only ids,
 * state, and bookkeeping timestamps. The desktop is the authority for whether
 * a session is live; a non-live session fails closed and applies no command.
 */
export interface RemoteSession {
  id: string;
  deviceId: RemoteDeviceId;
  state: RemoteSessionState;
  /** ISO timestamp of session creation. */
  createdAt: string;
  /** ISO timestamp after which an active session is treated as expired. */
  expiresAt: string;
  /** ISO timestamp of the last command/event activity on this session. */
  lastActivityAt: string;
}

/** Local remote-control lifecycle. `unavailable` means no live LAN transport is bound. */
export type RemoteControlLifecycleStatus = "disabled" | "unavailable" | "pairing" | "active" | "error";

/** The transport family for v1. Deliberately LAN-local, not a hosted relay. */
export type RemoteControlTransport = "lan-local";

/** Desktop-owned remote-control status snapshot. Non-secret metadata only. */
export interface RemoteControlStatusSnapshot {
  status: RemoteControlLifecycleStatus;
  requestedEnabled: boolean;
  enabled: boolean;
  transport: RemoteControlTransport;
  transportReady: boolean;
  pairingReady: boolean;
  serverName: string;
  deviceCount: number;
  trustedDeviceCount: number;
  revokedDeviceCount: number;
  activeSessionCount: number;
  message: string;
  updatedAt: string;
}

/** Enable/disable request. `ephemeral` means process-only preference. */
export interface RemoteControlPreferenceRequest {
  ephemeral?: boolean;
}

/**
 * Desktop-issued pairing challenge. `confirmCode` is the short numeric code
 * the user types to prove physical presence — it is never the PSK. The PSK
 * proof material is computed and held in Rust; this object carries no secret.
 */
export interface RemotePairingChallenge {
  /** High-entropy nonce binding this challenge to a single pairing attempt. */
  challengeNonce: string;
  /** Short numeric confirmation code displayed on the desktop. */
  confirmCode: string;
  /** ISO timestamp the challenge was issued. */
  issuedAt: string;
  /** ISO timestamp after which the challenge is no longer valid. */
  expiresAt: string;
}

/** Start a short-lived local pairing artifact. */
export interface RemotePairingStartRequest {
  manualCode?: boolean;
}

/** Outcome of starting pairing. Fails closed until LAN transport/crypto exists. */
export type RemotePairingStartResult =
  | { ok: true; challenge: RemotePairingChallenge; status: RemoteControlStatusSnapshot }
  | { ok: false; code: RemoteErrorCode; message: string; status: RemoteControlStatusSnapshot };

/** Poll a pairing artifact. Exactly one id/code is used by future transport. */
export interface RemotePairingStatusRequest {
  challengeNonce?: string;
  manualCode?: string;
}

/** Current state of a pairing artifact. */
export type RemotePairingPollStatus = "pending" | "claimed" | "expired" | "unavailable";

/** Outcome of reading pairing status. */
export interface RemotePairingStatusResult {
  ok: boolean;
  status: RemotePairingPollStatus;
  claimed: boolean;
  code?: RemoteErrorCode;
  message: string;
}

/** Outcome of a pairing attempt. */
export type RemotePairingResult =
  | { ok: true; device: RemoteDevice; session: RemoteSession }
  | { ok: false; code: RemoteErrorCode; message: string };

/** Version of the mobile remote-control wire protocol. */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

/**
 * The versioned envelope carrying one mobile-remote frame. PSK-mutual
 * authentication and replay protection are transport-layer concerns handled
 * in Rust; this envelope carries only version, session binding, a per-frame
 * nonce, and the typed payload.
 */
export interface RemoteEnvelopeV1 {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  /** Session id the frame belongs to. */
  sessionId: string;
  /** Per-frame high-entropy nonce for replay protection. */
  nonce: string;
  /** Typed observation event or control command. */
  payload: RemoteEvent | RemoteCommand;
}

/**
 * A read-only observation the desktop streams to the mobile device. Reuses
 * existing domain shapes verbatim so the mobile surface never invents a
 * parallel truth about runs, schedules, or approvals.
 */
export type RemoteEvent =
  | {
      type: "run-status";
      runId: string;
      status: WorkflowRunStatus;
      updatedAt: string;
    }
  | {
      type: "schedule-status";
      jobId: string;
      status: ScheduledJobStatus;
      nextRunAt: string;
    }
  | {
      type: "approval-requested";
      /** The existing approval shape, surfaced for a remote decision. */
      approval: ApprovalRequest;
    }
  | {
      type: "approval-resolved";
      approvalId: string;
      decision: ApprovalDecision;
      decidedAt: string;
    };

/**
 * A control command from the mobile device. These are *inputs* to the existing
 * approval and scheduler boundaries — never execution authority. Approve/deny
 * feeds the existing approval-resolution path, which still requires its own
 * fresh fingerprinted permit for any tool to fire. Schedule commands require an
 * exact matching job id or are rejected.
 */
export type RemoteCommand =
  | { type: "approve"; approvalId: string; decision: "once" | "session" | "rule" }
  | { type: "deny"; approvalId: string }
  | { type: "pause-schedule"; jobId: string }
  | { type: "resume-schedule"; jobId: string }
  | { type: "delete-schedule"; jobId: string };

/** Machine-readable failure codes for remote operations (all fail-closed). */
export type RemoteErrorCode =
  | "device-unpaired"
  | "device-revoked"
  | "session-expired"
  | "approval-not-found"
  | "approval-already-resolved"
  | "schedule-not-found"
  | "invalid-command"
  | "protocol-version-unsupported"
  | "transport-unavailable"
  | "unauthorized";

/** Result of applying (or refusing) a remote command. */
export type RemoteCommandResult =
  | { ok: true; appliedAt: string }
  | { ok: false; code: RemoteErrorCode; message: string };
