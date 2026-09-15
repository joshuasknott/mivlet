import { describe, expect, it } from "vitest";
import { createConvexAuthConfig } from "./auth.config";

describe("Convex auth configuration", () => {
  it("fails closed when Clerk issuer or audience is missing", () => {
    expect(() => createConvexAuthConfig({})).toThrow(/MIVLET_CLERK_ISSUER and MIVLET_CLERK_AUDIENCE/);
    expect(() => createConvexAuthConfig({ MIVLET_CLERK_ISSUER: "https://example.clerk.accounts.dev" }))
      .toThrow(/MIVLET_CLERK_ISSUER and MIVLET_CLERK_AUDIENCE/);
    expect(() => createConvexAuthConfig({ MIVLET_CLERK_AUDIENCE: "convex" }))
      .toThrow(/MIVLET_CLERK_ISSUER and MIVLET_CLERK_AUDIENCE/);
  });

  it("refuses the mock Clerk issuer unless explicitly allowed for tests", () => {
    expect(() => createConvexAuthConfig({
      MIVLET_CLERK_ISSUER: "https://mock-clerk.mivlet.local",
      MIVLET_CLERK_AUDIENCE: "mivlet-convex-test"
    })).toThrow(/mock Clerk issuer/);
    expect(createConvexAuthConfig({
      MIVLET_CLERK_ISSUER: "https://mock-clerk.mivlet.local",
      MIVLET_CLERK_AUDIENCE: "mivlet-convex-test",
      MIVLET_CLERK_ALLOW_MOCK: "1"
    }).providers).toEqual([
      { domain: "https://mock-clerk.mivlet.local", applicationID: "mivlet-convex-test" }
    ]);
  });

  it("accepts legacy FABLE_* Clerk aliases when MIVLET_* is unset", () => {
    expect(createConvexAuthConfig({
      FABLE_CLERK_ISSUER: "https://example.clerk.accounts.dev",
      FABLE_CLERK_AUDIENCE: "convex"
    }).providers).toEqual([
      { domain: "https://example.clerk.accounts.dev", applicationID: "convex" }
    ]);
  });

  it("does not fall through to FABLE_* when a MIVLET_* value is present", () => {
    expect(() => createConvexAuthConfig({
      MIVLET_CLERK_ISSUER: "https://mock-clerk.mivlet.local",
      MIVLET_CLERK_AUDIENCE: "mivlet-convex-test",
      MIVLET_CLERK_ALLOW_MOCK: "",
      FABLE_CLERK_ALLOW_MOCK: "1"
    })).toThrow(/mock Clerk issuer/);
  });

  it("loads a real Clerk issuer and audience", () => {
    expect(createConvexAuthConfig({
      MIVLET_CLERK_ISSUER: "https://example.clerk.accounts.dev",
      MIVLET_CLERK_AUDIENCE: "convex"
    }).providers).toEqual([
      { domain: "https://example.clerk.accounts.dev", applicationID: "convex" }
    ]);
  });
});
