/**
 * Mobile remote-control foundation — public surface for the pure logic layer.
 *
 * The desktop shell and Rust boundary consume these. The module is pure: no
 * network, no filesystem, no timers except injected ones. Secrets (PSK,
 * long-lived device keys) live behind the Rust boundary, never here.
 *
 * See docs/architecture/mobile-remote.md and the design spec at
 * docs/superpowers/specs/2026-06-29-mobile-remote-control-design.md.
 */

export {
  SESSION_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  createSession,
  activateSession,
  isSessionLive,
  touchSession,
  revokeSession,
  type Now
} from "./session";
export {
  PAIRING_CHALLENGE_TTL_MS,
  CONFIRM_CODE_LENGTH,
  verifyConfirmCode,
  generateConfirmCodeFixture,
  challengeExpiry,
  type ConfirmCodeResult
} from "./pairing";
export {
  authorizeCommand,
  type PendingApprovalIndex,
  type RemoteDeviceIndex,
  type ScheduledJobIndex
} from "./authorization";
export {
  dispatchCommand,
  type RemoteCommandRuntime
} from "./dispatcher";
