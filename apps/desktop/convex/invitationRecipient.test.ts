import { describe, expect, it } from "vitest";
import {
  hashInvitationEmail,
  hashInvitationEmailForRetainedVersions,
  maskInvitationEmail,
  normalizeInvitationEmail,
  parseInvitationRecipientKeyring,
} from "./invitationRecipient";

const keyring = () => parseInvitationRecipientKeyring(JSON.stringify({
  active: "v2",
  keys: {
    v2: "11".repeat(32),
    v1: "22".repeat(32),
  },
}));

describe("verified invitation recipients", () => {
  it("normalizes conservatively without provider-specific rewriting", () => {
    expect(normalizeInvitationEmail("  Jo.Sh+Work@Example.COM  ")).toBe("jo.sh+work@example.com");
    expect(maskInvitationEmail("jo.sh+work@example.com")).toBe("j***@example.com");
    expect(normalizeInvitationEmail("Josh@Ｅxample.com")).toBe("josh@example.com");
  });

  it.each([
    "", "missing-domain", "a@@example.com", ".a@example.com", "a..b@example.com",
    "a@localhost", "a@-example.com", "a@example-.com", "a @example.com", "ü@example.com",
  ])("rejects unsupported or ambiguous input without echoing it: %s", (email) => {
    expect(() => normalizeInvitationEmail(email)).toThrow("Verified-email invitations are unavailable");
  });

  it("requires a small versioned 256-bit keyring", () => {
    expect(() => parseInvitationRecipientKeyring(undefined)).toThrow(/unavailable/i);
    expect(() => parseInvitationRecipientKeyring('{"active":"v1","keys":{"v1":"aa"}}')).toThrow(/unavailable/i);
    expect(() => parseInvitationRecipientKeyring(JSON.stringify({ active: "v3", keys: { v2: "11".repeat(32) } }))).toThrow(/unavailable/i);
    expect(keyring().activeVersion).toBe("v2");
  });

  it("uses domain-separated keyed hashes and retained versions", async () => {
    const active = await hashInvitationEmail("Person@Example.com", keyring());
    expect(active).toEqual({
      attributeKind: "email",
      hashVersion: "v2",
      normalizedValueHash: "662e83f8ed270fcf3b4dcf24e99e1b90df9d7fbc337168d6b1f37b5ff81768a3",
      displayHint: "p***@example.com",
    });
    const retained = await hashInvitationEmailForRetainedVersions("person@example.com", keyring());
    expect(retained.map((entry) => entry.hashVersion)).toEqual(["v2", "v1"]);
    expect(new Set(retained.map((entry) => entry.normalizedValueHash)).size).toBe(2);
    expect(JSON.stringify(retained)).not.toContain("person@example.com");
  });
});
