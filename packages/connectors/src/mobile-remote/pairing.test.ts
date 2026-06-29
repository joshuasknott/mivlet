import { describe, expect, it } from "vitest";
import {
  CONFIRM_CODE_LENGTH,
  PAIRING_CHALLENGE_TTL_MS,
  challengeExpiry,
  generateConfirmCodeFixture,
  verifyConfirmCode
} from "./pairing";

const T0 = "2026-06-29T12:00:00.000Z";
function clockAt(ms: number): () => string {
  return () => new Date(new Date(T0).getTime() + ms).toISOString();
}

describe("verifyConfirmCode", () => {
  const code = "123456";
  const issuedAt = T0;
  const expiresAt = challengeExpiry(issuedAt);

  it("accepts a matching code within the window", () => {
    const result = verifyConfirmCode({
      expected: code,
      provided: code,
      issuedAt,
      expiresAt,
      now: clockAt(1_000)
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails closed on a mismatched code", () => {
    const result = verifyConfirmCode({
      expected: code,
      provided: "000000",
      issuedAt,
      expiresAt,
      now: clockAt(1_000)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("fails closed once the challenge has expired", () => {
    const result = verifyConfirmCode({
      expected: code,
      provided: code,
      issuedAt,
      expiresAt,
      now: clockAt(PAIRING_CHALLENGE_TTL_MS + 1)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("fails closed before the challenge is valid (clock skew)", () => {
    // A challenge issued in the future relative to `now` fails closed.
    const futureIssuedAt = clockAt(60_000)();
    const result = verifyConfirmCode({
      expected: code,
      provided: code,
      issuedAt: futureIssuedAt,
      expiresAt: challengeExpiry(futureIssuedAt),
      now: clockAt(0)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("fails closed on malformed timestamps", () => {
    const result = verifyConfirmCode({
      expected: code,
      provided: code,
      issuedAt: "not-a-date",
      expiresAt: "not-a-date",
      now: clockAt(0)
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-command");
  });

  it("accepts the code exactly at the expiry boundary's predecessor", () => {
    // At expiresAt - 1ms the challenge is still valid.
    const result = verifyConfirmCode({
      expected: code,
      provided: code,
      issuedAt,
      expiresAt,
      now: clockAt(PAIRING_CHALLENGE_TTL_MS - 1)
    });
    expect(result.ok).toBe(true);
  });
});

describe("generateConfirmCodeFixture", () => {
  it("produces a fixed-length numeric code", () => {
    const c = generateConfirmCodeFixture(42);
    expect(c).toMatch(/^\d{6}$/);
    expect(c.length).toBe(CONFIRM_CODE_LENGTH);
  });

  it("is deterministic for a given seed", () => {
    expect(generateConfirmCodeFixture(42)).toBe(generateConfirmCodeFixture(42));
  });

  it("zero-pads small seeds to the full length", () => {
    const c = generateConfirmCodeFixture(0);
    expect(c).toBe("000000");
  });
});

describe("challengeExpiry", () => {
  it("is issue time plus the TTL", () => {
    const expiry = challengeExpiry(T0);
    const expected = new Date(new Date(T0).getTime() + PAIRING_CHALLENGE_TTL_MS).toISOString();
    expect(expiry).toBe(expected);
  });
});
