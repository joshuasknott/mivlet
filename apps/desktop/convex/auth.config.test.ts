import { describe, expect, it } from "vitest";
import {
  MOCK_CLERK_AUDIENCE,
  MOCK_CLERK_ISSUER,
  createConvexAuthConfig,
  isNonLocalClerkMockEnvironment
} from "./auth.config";

const mockLocal = {
  MIVLET_CLERK_ISSUER: MOCK_CLERK_ISSUER,
  MIVLET_CLERK_AUDIENCE: MOCK_CLERK_AUDIENCE,
  MIVLET_CLERK_ALLOW_MOCK: "1"
} as const;

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
      MIVLET_CLERK_ISSUER: MOCK_CLERK_ISSUER,
      MIVLET_CLERK_AUDIENCE: MOCK_CLERK_AUDIENCE
    })).toThrow(/mock Clerk issuer/);
    expect(createConvexAuthConfig(mockLocal).providers).toEqual([
      { domain: MOCK_CLERK_ISSUER, applicationID: MOCK_CLERK_AUDIENCE }
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
      MIVLET_CLERK_ISSUER: MOCK_CLERK_ISSUER,
      MIVLET_CLERK_AUDIENCE: MOCK_CLERK_AUDIENCE,
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

  it("keeps the mock issuer on local and dev Convex deployments", () => {
    for (const deployment of ["anonymous:anonymous-mivlet", "dev:team-mivlet"]) {
      expect(createConvexAuthConfig({
        ...mockLocal,
        CONVEX_DEPLOYMENT: deployment,
        NODE_ENV: "production"
      }).providers).toEqual([
        { domain: MOCK_CLERK_ISSUER, applicationID: MOCK_CLERK_AUDIENCE }
      ]);
    }
  });

  it("refuses the mock issuer on production and preview Convex deployments even when allowed", () => {
    for (const deployment of ["prod:mivlet-prod", "preview:pr-12"]) {
      expect(() => createConvexAuthConfig({
        ...mockLocal,
        CONVEX_DEPLOYMENT: deployment
      })).toThrow(/production or non-local/);
    }
  });

  it("refuses the mock issuer when the environment label is production-like", () => {
    expect(() => createConvexAuthConfig({
      ...mockLocal,
      CONVEX_ENV: "production"
    })).toThrow(/production or non-local/);
    expect(() => createConvexAuthConfig({
      ...mockLocal,
      MIVLET_CONVEX_ENVIRONMENT: "staging"
    })).toThrow(/production or non-local/);
    expect(() => createConvexAuthConfig({
      ...mockLocal,
      FABLE_CONVEX_ENVIRONMENT: "preview"
    })).toThrow(/production or non-local/);
  });

  it("refuses the mock issuer under NODE_ENV=production without a local deployment name", () => {
    expect(() => createConvexAuthConfig({
      ...mockLocal,
      NODE_ENV: "production"
    })).toThrow(/production or non-local/);
  });

  it("honors legacy FABLE_CLERK_ALLOW_MOCK locally and still refuses it in production", () => {
    expect(createConvexAuthConfig({
      FABLE_CLERK_ISSUER: MOCK_CLERK_ISSUER,
      FABLE_CLERK_AUDIENCE: MOCK_CLERK_AUDIENCE,
      FABLE_CLERK_ALLOW_MOCK: "1",
      CONVEX_DEPLOYMENT: "anonymous:local"
    }).providers).toEqual([
      { domain: MOCK_CLERK_ISSUER, applicationID: MOCK_CLERK_AUDIENCE }
    ]);
    expect(() => createConvexAuthConfig({
      FABLE_CLERK_ISSUER: MOCK_CLERK_ISSUER,
      FABLE_CLERK_AUDIENCE: MOCK_CLERK_AUDIENCE,
      FABLE_CLERK_ALLOW_MOCK: "1",
      CONVEX_DEPLOYMENT: "prod:mivlet-prod"
    })).toThrow(/production or non-local/);
  });

  it("treats GitHub Actions as non-local unless the Convex deployment is local or dev", () => {
    expect(isNonLocalClerkMockEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isNonLocalClerkMockEnvironment({
      GITHUB_ACTIONS: "true",
      CONVEX_DEPLOYMENT: "dev:team-mivlet"
    })).toBe(false);
    expect(isNonLocalClerkMockEnvironment({})).toBe(false);
  });
});
