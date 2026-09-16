/**
 * Convex JWT issuer configuration.
 *
 * Missing Clerk issuer/audience is a deploy and availability failure: the
 * deployment cannot authenticate real Clerk-backed sessions. It is not a
 * token-forgery identity bypass. Mock issuer values stay test-only.
 *
 * `MIVLET_CLERK_ALLOW_MOCK=1` (legacy `FABLE_CLERK_ALLOW_MOCK`) may pair with
 * the mock issuer for local Convex `anonymous:` / `dev:` backends and unit
 * tests. Production, preview, and staging deployments refuse that combination
 * at config load. CI scans tracked env/workflow files for the same pair.
 */

import { readMivletEnvValue } from "@mivlet/protocol";

export interface ConvexAuthProviderConfig {
  domain: string;
  applicationID: string;
}

export interface ConvexAuthConfig {
  providers: ConvexAuthProviderConfig[];
}

export const MOCK_CLERK_ISSUER = "https://mock-clerk.mivlet.local";
const LEGACY_MOCK_CLERK_ISSUER = "https://mock-clerk.fable.local";
export const MOCK_CLERK_AUDIENCE = "mivlet-convex-test";

const LOCAL_OR_DEV_DEPLOYMENT = /^(anonymous|dev):/i;
const NON_LOCAL_DEPLOYMENT = /^(prod|preview):/i;
const NON_LOCAL_ENV_LABELS = new Set(["production", "prod", "staging", "preview"]);

function isMockClerkIssuer(issuer: string | undefined): boolean {
  const value = issuer?.trim();
  return value === MOCK_CLERK_ISSUER || value === LEGACY_MOCK_CLERK_ISSUER;
}

/**
 * Production-like Convex and CI environments cannot use the mock Clerk issuer.
 * Explicit `anonymous:` / `dev:` deployment names stay local/dev even when
 * `NODE_ENV=production` is inherited from a parent tool.
 */
export function isNonLocalClerkMockEnvironment(
  env: Record<string, string | undefined>
): boolean {
  const deployment = env.CONVEX_DEPLOYMENT?.trim() ?? "";
  if (NON_LOCAL_DEPLOYMENT.test(deployment)) return true;
  if (LOCAL_OR_DEV_DEPLOYMENT.test(deployment)) return false;

  const label = (
    readMivletEnvValue(env, "CONVEX_ENVIRONMENT") ??
    env.CONVEX_ENV ??
    ""
  )
    .trim()
    .toLowerCase();
  if (NON_LOCAL_ENV_LABELS.has(label)) return true;

  if (env.NODE_ENV?.trim().toLowerCase() === "production") return true;
  return env.GITHUB_ACTIONS === "true";
}

export function createConvexAuthConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): ConvexAuthConfig {
  const issuer = readMivletEnvValue(env, "CLERK_ISSUER")?.trim();
  const audience = readMivletEnvValue(env, "CLERK_AUDIENCE")?.trim();
  const allowMock = readMivletEnvValue(env, "CLERK_ALLOW_MOCK") === "1";

  if (!issuer || !audience) {
    throw new Error(
      "Convex auth is not configured: set MIVLET_CLERK_ISSUER and MIVLET_CLERK_AUDIENCE. Missing values fail closed at deploy/startup (availability), not as an identity-bypass control."
    );
  }
  if (isMockClerkIssuer(issuer) && !allowMock) {
    throw new Error(
      "Convex auth refuses the mock Clerk issuer unless MIVLET_CLERK_ALLOW_MOCK=1."
    );
  }
  if (isMockClerkIssuer(issuer) && allowMock && isNonLocalClerkMockEnvironment(env)) {
    throw new Error(
      "Convex auth refuses MIVLET_CLERK_ALLOW_MOCK=1 with the mock Clerk issuer on production or non-local deployments."
    );
  }
  return {
    providers: [
      {
        domain: issuer,
        applicationID: audience
      }
    ]
  };
}

export default {
  get providers() {
    return createConvexAuthConfig().providers;
  }
};
