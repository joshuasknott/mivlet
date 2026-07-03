import { describe, it, expect } from "vitest";
import { verifyConsent, isKnownConsentVersion, computeConsentTextHash } from "./consent.js";

describe("consent manifest (server owned)", () => {
  it("knows the draft version", () => {
    expect(isKnownConsentVersion("2026-07-03-waitlist-v0.1")).toBe(true);
  });

  it("recomputes deterministic hash from manifest", async () => {
    const h = await computeConsentTextHash("2026-07-03-waitlist-v0.1");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // Same input same hash
    const h2 = await computeConsentTextHash("2026-07-03-waitlist-v0.1");
    expect(h2).toBe(h);
  });

  it("rejects unknown version", async () => {
    const res = await verifyConsent("2025-01-01-waitlist-v9.9");
    expect(res.ok).toBe(false);
  });
});
