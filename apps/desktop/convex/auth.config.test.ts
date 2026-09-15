import { describe, expect, it } from "vitest";
import { createConvexAuthConfig } from "./auth.config";

describe("Convex auth configuration", () => {
  it("fails closed when Clerk issuer or audience is missing", () => {
    expect(() => createConvexAuthConfig({})).toThrow(/FABLE_CLERK_ISSUER and FABLE_CLERK_AUDIENCE/);
    expect(() => createConvexAuthConfig({ FABLE_CLERK_ISSUER: "https://example.clerk.accounts.dev" }))
      .toThrow(/FABLE_CLERK_ISSUER and FABLE_CLERK_AUDIENCE/);
    expect(() => createConvexAuthConfig({ FABLE_CLERK_AUDIENCE: "convex" }))
      .toThrow(/FABLE_CLERK_ISSUER and FABLE_CLERK_AUDIENCE/);
  });

  it("refuses the mock Clerk issuer unless explicitly allowed for tests", () => {
    expect(() => createConvexAuthConfig({
      FABLE_CLERK_ISSUER: "https://mock-clerk.fable.local",
      FABLE_CLERK_AUDIENCE: "fable-convex-test"
    })).toThrow(/mock Clerk issuer/);
    expect(createConvexAuthConfig({
      FABLE_CLERK_ISSUER: "https://mock-clerk.fable.local",
      FABLE_CLERK_AUDIENCE: "fable-convex-test",
      FABLE_CLERK_ALLOW_MOCK: "1"
    }).providers).toEqual([
      { domain: "https://mock-clerk.fable.local", applicationID: "fable-convex-test" }
    ]);
  });

  it("loads a real Clerk issuer and audience", () => {
    expect(createConvexAuthConfig({
      FABLE_CLERK_ISSUER: "https://example.clerk.accounts.dev",
      FABLE_CLERK_AUDIENCE: "convex"
    }).providers).toEqual([
      { domain: "https://example.clerk.accounts.dev", applicationID: "convex" }
    ]);
  });
});
