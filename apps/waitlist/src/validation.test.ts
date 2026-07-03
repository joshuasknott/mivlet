import { describe, it, expect } from "vitest";
import {
  normalizeEmail, isValidEmail, boundPlatformInterest, boundConnectorInterest,
  boundReferralCode, isHoneypotFilled, isValidConsentMarketing, isValidConsentVersion
} from "./validation.js";

describe("waitlist validation (pure)", () => {
  it("normalizes email", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });

  it("validates email length and shape", () => {
    expect(isValidEmail("a@b.c")).toBe(true);
    expect(isValidEmail("x".repeat(300) + "@ex.com")).toBe(false);
    expect(isValidEmail("no-at")).toBe(false);
  });

  it("bounds platform", () => {
    expect(boundPlatformInterest("macos")).toBe("macos");
    expect(boundPlatformInterest("foo")).toBe("windows");
  });

  it("bounds connectors and dedupes", () => {
    const res = boundConnectorInterest(["github", "github", "notion", "invalid"]);
    expect(res).toEqual(["github", "notion"]);
  });

  it("rejects oversized referral", () => {
    expect(boundReferralCode("a".repeat(33))).toBeUndefined();
    expect(boundReferralCode("good_ref-123")).toBe("good_ref-123");
  });

  it("detects honeypot", () => {
    expect(isHoneypotFilled(" ")).toBe(false);
    expect(isHoneypotFilled("bot")).toBe(true);
  });

  it("consent version format", () => {
    expect(isValidConsentVersion("2026-07-03-waitlist-v0.1")).toBe(true);
    expect(isValidConsentVersion("2026-07-03")).toBe(false);
  });

  it("marketing consent must be true", () => {
    expect(isValidConsentMarketing(true)).toBe(true);
    expect(isValidConsentMarketing(false)).toBe(false);
  });
});
