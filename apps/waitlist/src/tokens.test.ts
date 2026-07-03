import { describe, it, expect } from "vitest";
import { generateConfirmToken, hashToken, isExpired, computeExpiry, CONFIRM_TTL_MS } from "./tokens.js";

describe("tokens (hash only at rest)", () => {
  it("generates url-safe token >=32 chars", () => {
    const t = generateConfirmToken();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(/^[A-Za-z0-9_-]+$/.test(t)).toBe(true);
  });

  it("hashes are deterministic and different from token", async () => {
    const t = "test-token-12345678901234567890";
    const h = await hashToken(t);
    const h2 = await hashToken(t);
    expect(h).toBe(h2);
    expect(h).not.toBe(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("expiry computation and check", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const exp = computeExpiry(now);
    expect(new Date(exp).getTime() - now.getTime()).toBeCloseTo(CONFIRM_TTL_MS, -2);
    expect(isExpired(exp, new Date(now.getTime() + CONFIRM_TTL_MS + 1000))).toBe(true);
    expect(isExpired(exp, now)).toBe(false);
  });
});
