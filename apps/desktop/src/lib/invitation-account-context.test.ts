import { describe, expect, it } from "vitest";
import { invitationAccountContextKey } from "./invitation-account-context";

const base = {
  provider: "clerk",
  normalizedIssuer: "https://issuer-a.example",
  subject: "shared-subject",
  identityState: "signed-in",
  internalUserId: "user-a",
  accountState: "ready"
};

describe("invitation account context key", () => {
  it("changes for any canonical external identity tuple change", () => {
    const current = invitationAccountContextKey(base);
    expect(invitationAccountContextKey({ ...base, provider: "other" })).not.toBe(current);
    expect(invitationAccountContextKey({ ...base, normalizedIssuer: "https://issuer-b.example" })).not.toBe(current);
    expect(invitationAccountContextKey({ ...base, subject: "other-subject" })).not.toBe(current);
  });

  it("ignores workspace selection while retaining native owner changes", () => {
    expect(invitationAccountContextKey(base)).toBe(invitationAccountContextKey({ ...base }));
    expect(invitationAccountContextKey({ ...base, internalUserId: "user-b" })).not.toBe(
      invitationAccountContextKey(base)
    );
  });
});
