/**
 * Remote session lifecycle — pure logic, no I/O.
 *
 * A remote session binds a trusted mobile device to the desktop for a bounded
 * lifetime. The desktop is the authority for whether a session is live: a
 * non-live session fails closed and authorizes no command (see
 * `authorizeCommand` in `authorization.ts`).
 *
 * Bounded lifetimes are deliberate: a session cannot live forever, and an idle
 * session expires even before its absolute deadline. This bounds the window in
 * which a stolen/lost device can act.
 *
 * SECRET INVARIANT: this module holds no key, no token, no PSK. Sessions carry
 * only ids, state, and bookkeeping timestamps.
 */

import type { RemoteDeviceId, RemoteSession, RemoteSessionState } from "@fable/protocol";

/**
 * Absolute session lifetime. A session created at T is live at most until
 * T + SESSION_LIFETIME_MS regardless of activity.
 */
export const SESSION_LIFETIME_MS = 1000 * 60 * 60 * 4; // 4 hours

/**
 * Idle timeout. A session with no activity for this long expires even before
 * its absolute deadline.
 */
export const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 15; // 15 minutes

/** A `now` timestamp provider; injectable so tests are deterministic. */
export type Now = () => string;

/**
 * Create a new session in the `pairing` state for the given device. The
 * session is NOT live until `activateSession` transitions it to `active`.
 */
export function createSession(
  deviceId: RemoteDeviceId,
  now: Now,
  id: string
): RemoteSession {
  const at = now();
  return {
    id,
    deviceId,
    state: "pairing",
    createdAt: at,
    // A pairing-state session has no active expiry until activated; use the
    // absolute creation time as a placeholder that is always "not yet expired"
    // for the pairing window, which pairing.ts validates separately.
    expiresAt: at,
    lastActivityAt: at
  };
}

/**
 * Transition a pairing session to active and set its bounded expiry. Returns a
 * new session object; the input is untouched. No-op (returns input unchanged)
 * if the session is not in the `pairing` state — activation is a one-shot.
 */
export function activateSession(session: RemoteSession, now: Now): RemoteSession {
  if (session.state !== "pairing") {
    return session;
  }
  const at = now();
  return {
    ...session,
    state: "active",
    expiresAt: new Date(new Date(at).getTime() + SESSION_LIFETIME_MS).toISOString(),
    lastActivityAt: at
  };
}

/**
 * True only when the session is `active`, within its absolute lifetime, and
 * within its idle window. Every other case fails closed (returns false).
 */
export function isSessionLive(session: RemoteSession, now: Now): boolean {
  if (session.state !== "active") {
    return false;
  }
  const at = new Date(now()).getTime();
  const expires = new Date(session.expiresAt).getTime();
  const lastActivity = new Date(session.lastActivityAt).getTime();
  if (Number.isNaN(expires) || Number.isNaN(lastActivity)) {
    return false;
  }
  if (at >= expires) {
    return false;
  }
  if (at - lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
    return false;
  }
  return true;
}

/**
 * Bump `lastActivityAt` on an active session. No-op for non-active sessions
 * (touching a revoked/expired session does not revive it — fail closed).
 */
export function touchSession(session: RemoteSession, now: Now): RemoteSession {
  if (session.state !== "active") {
    return session;
  }
  return { ...session, lastActivityAt: now() };
}

/**
 * Mark a session revoked. Revocation is terminal: a revoked session never
 * returns to active, regardless of subsequent touch/activate calls.
 */
export function revokeSession(session: RemoteSession, now: Now): RemoteSession {
  if (session.state === "revoked") {
    return session;
  }
  return { ...session, state: "revoked" as RemoteSessionState, lastActivityAt: now() };
}
