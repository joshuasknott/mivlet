import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_LIFETIME_MS,
  activateSession,
  createSession,
  isSessionLive,
  revokeSession,
  touchSession
} from "./session";

const T0 = "2026-06-29T12:00:00.000Z";
function clockAt(ms: number): () => string {
  return () => new Date(new Date(T0).getTime() + ms).toISOString();
}

describe("createSession", () => {
  it("starts in the pairing state", () => {
    const session = createSession("device-1", clockAt(0), "session-1");
    expect(session.state).toBe("pairing");
    expect(session.deviceId).toBe("device-1");
    expect(session.id).toBe("session-1");
  });
});

describe("activateSession", () => {
  it("transitions pairing -> active and sets a bounded expiry", () => {
    const pairing = createSession("device-1", clockAt(0), "session-1");
    const active = activateSession(pairing, clockAt(0));
    expect(active.state).toBe("active");
    const expectedExpiry = new Date(new Date(T0).getTime() + SESSION_LIFETIME_MS).toISOString();
    expect(active.expiresAt).toBe(expectedExpiry);
  });

  it("is a no-op on an already-active session (one-shot activation)", () => {
    const pairing = createSession("device-1", clockAt(0), "session-1");
    const active = activateSession(pairing, clockAt(0));
    const again = activateSession(active, clockAt(1_000));
    // Unchanged reference is acceptable; expiry must not shift on re-activation.
    expect(again.expiresAt).toBe(active.expiresAt);
    expect(again.state).toBe("active");
  });
});

describe("isSessionLive", () => {
  it("is live for an active session within lifetime and idle window", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    expect(isSessionLive(active, clockAt(60_000))).toBe(true);
  });

  it("fails closed for a pairing session", () => {
    const pairing = createSession("device-1", clockAt(0), "s");
    expect(isSessionLive(pairing, clockAt(0))).toBe(false);
  });

  it("fails closed once the absolute lifetime elapses", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    expect(isSessionLive(active, clockAt(SESSION_LIFETIME_MS))).toBe(false);
    expect(isSessionLive(active, clockAt(SESSION_LIFETIME_MS + 1))).toBe(false);
  });

  it("fails closed once the idle window elapses without activity", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    // Just under the idle timeout is still live.
    expect(isSessionLive(active, clockAt(SESSION_IDLE_TIMEOUT_MS - 1))).toBe(true);
    // At/over the idle timeout fails closed.
    expect(isSessionLive(active, clockAt(SESSION_IDLE_TIMEOUT_MS))).toBe(false);
  });

  it("fails closed for a revoked session", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    const revoked = revokeSession(active, clockAt(1_000));
    expect(isSessionLive(revoked, clockAt(2_000))).toBe(false);
  });

  it("fails closed on malformed expiry timestamps", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    expect(isSessionLive({ ...active, expiresAt: "not-a-date" }, clockAt(0))).toBe(false);
  });
});

describe("touchSession", () => {
  it("extends the idle window for an active session", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    // Without a touch, the idle window would expire here.
    const touched = touchSession(active, clockAt(SESSION_IDLE_TIMEOUT_MS - 1));
    expect(isSessionLive(touched, clockAt(SESSION_IDLE_TIMEOUT_MS))).toBe(true);
  });

  it("does not revive a non-active session", () => {
    const revoked = revokeSession(
      activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0)),
      clockAt(1_000)
    );
    const touched = touchSession(revoked, clockAt(2_000));
    expect(touched.state).toBe("revoked");
    expect(isSessionLive(touched, clockAt(2_000))).toBe(false);
  });
});

describe("revokeSession", () => {
  it("is terminal: revoke of a revoked session is unchanged", () => {
    const active = activateSession(createSession("device-1", clockAt(0), "s"), clockAt(0));
    const revoked = revokeSession(active, clockAt(1_000));
    const revokedAgain = revokeSession(revoked, clockAt(2_000));
    expect(revokedAgain.state).toBe("revoked");
    expect(revokedAgain.lastActivityAt).toBe(revoked.lastActivityAt);
  });
});
