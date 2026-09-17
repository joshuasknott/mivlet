import { describe, expect, it } from "vitest";
import { accountRoute } from "./routes";

describe("account routing", () => {
  it("keeps SDK password, recovery and verification subroutes in their flow", () => {
    expect(accountRoute("/sign-in/factor-one")).toBe("sign-in");
    expect(accountRoute("/sign-in/reset-password")).toBe("sign-in");
    expect(accountRoute("/sign-up/verify-email-address")).toBe("sign-up");
  });
  it("does not mistake lookalike paths for authentication or consent", () => {
    expect(accountRoute("/sign-in-malicious")).toBe("not-found");
    expect(accountRoute("/oauth-consent/extra")).toBe("not-found");
    expect(accountRoute("/oauth-consent")).toBe("consent");
  });
});
