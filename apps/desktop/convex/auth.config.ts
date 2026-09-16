/**
 * Convex JWT issuer configuration.
 *
 * Missing Clerk issuer/audience is a deploy and availability failure: the
 * deployment cannot authenticate real Clerk-backed sessions. It is not a
 * token-forgery identity bypass. Mock issuer values stay test-only.
 */

import { readMivletEnvValue } from "@mivlet/protocol";

export interface ConvexAuthProviderConfig {
  domain: string;
  applicationID: string;
}

export interface ConvexAuthConfig {
  providers: ConvexAuthProviderConfig[];
}

const MOCK_CLERK_ISSUER = "https://mock-clerk.mivlet.local";
const MOCK_CLERK_AUDIENCE = "mivlet-convex-test";

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
  if (issuer === MOCK_CLERK_ISSUER && !allowMock) {
    throw new Error(
      "Convex auth refuses the mock Clerk issuer unless MIVLET_CLERK_ALLOW_MOCK=1."
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
