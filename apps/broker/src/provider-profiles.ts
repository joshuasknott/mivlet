/**
 * Provider OAuth profiles: the broker's knowledge of each confidential provider's
 * OAuth contract. Client IDs/secrets are read from the broker process environment
 * at startup and never serialized, logged, or returned.
 *
 * Each profile describes how the broker talks to the provider's OAuth server. The
 * broker is the ONLY process that holds these secrets; the desktop never sees them.
 */

import type { BrokerProviderId } from "@fable/connectors";

/**
 * How a provider wants the broker's own PKCE verifier handled.
 * - `none`: provider does PKCE against the desktop-supplied challenge (GitHub App).
 * - `broker-pkce`: the broker generates its own verifier/challenge and presents it
 *   to the provider, then uses the verifier in the confidential exchange (Vercel,
 *   Linear, Notion, Slack accept PKCE on the confidential client).
 */
export type BrokerPkceMode = "none" | "broker-pkce";

export interface ProviderProfile {
  /** Display only; never a secret. */
  label: string;
  /** Provider authorization endpoint. */
  authorizationEndpoint: string;
  /** Provider token endpoint (exchange + refresh). */
  tokenEndpoint: string;
  /** Provider revocation endpoint. */
  revocationEndpoint: string;
  /** Endpoint the broker hits to resolve connected account identity. */
  identityEndpoint: string;
  /** Scopes the broker requests on the desktop's behalf. */
  scopes: readonly string[];
  /** Environment variable holding the confidential client id (display only here). */
  clientIdEnv: string;
  /** Environment variable holding the confidential client secret. */
  clientSecretEnv: string;
  /** Whether the provider accepts/needs PKCE on the confidential exchange. */
  pkce: BrokerPkceMode;
  /**
   * Normalizes a provider identity payload into a stable account summary.
   * Provider-specific because each returns a different shape.
   */
  normalizeIdentity(payload: unknown): {
    id: string;
    displayName: string;
    handle?: string;
    email?: string;
    workspace?: string;
    avatarUrl?: string;
  };
}

const GITHUB_PROFILE: ProviderProfile = {
  label: "GitHub",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  revocationEndpoint: `https://api.github.com/applications/${"{clientId}"}/grant`,
  identityEndpoint: "https://api.github.com/user",
  scopes: ["read:user", "read:org", "repo", "workflow"],
  clientIdEnv: "FABLE_BROKER_GITHUB_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_GITHUB_CLIENT_SECRET",
  pkce: "broker-pkce",
  normalizeIdentity(payload) {
    const p = asObject(payload);
    const id = pickString(p, "id") ?? pickString(p, "node_id");
    if (!id) throw identityError("GitHub");
    return {
      id,
      displayName: pickString(p, "name") ?? pickString(p, "login") ?? id,
      handle: pickString(p, "login"),
      email: pickString(p, "email"),
      avatarUrl: pickString(p, "avatar_url")
    };
  }
};

const VERCEL_PROFILE: ProviderProfile = {
  label: "Vercel",
  authorizationEndpoint: "https://api.vercel.com/oauth/authorize",
  tokenEndpoint: "https://api.vercel.com/v2/oauth/access_token",
  revocationEndpoint: "https://api.vercel.com/v2/oauth/revoke",
  identityEndpoint: "https://api.vercel.com/v2/user",
  scopes: ["user:read", "team:read", "project:read", "deployment:read", "deployment:write"],
  clientIdEnv: "FABLE_BROKER_VERCEL_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_VERCEL_CLIENT_SECRET",
  pkce: "broker-pkce",
  normalizeIdentity(payload) {
    const p = asObject(asObject(payload, "user"), undefined) ?? asObject(payload);
    const root = asObject(payload, "user") ?? p;
    const id = pickString(root, "uid") ?? pickString(root, "id");
    if (!id) throw identityError("Vercel");
    return {
      id,
      displayName: pickString(root, "name") ?? pickString(root, "email") ?? id,
      email: pickString(root, "email"),
      avatarUrl: pickString(root, "avatar")
    };
  }
};

const LINEAR_PROFILE: ProviderProfile = {
  label: "Linear",
  authorizationEndpoint: "https://api.linear.app/oauth/authorize",
  tokenEndpoint: "https://api.linear.app/oauth/token",
  revocationEndpoint: "https://api.linear.app/oauth/revoke",
  identityEndpoint: "https://api.linear.app/graphql",
  scopes: ["read", "write", "issues:create", "comments:create"],
  clientIdEnv: "FABLE_BROKER_LINEAR_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_LINEAR_CLIENT_SECRET",
  pkce: "broker-pkce",
  normalizeIdentity(payload) {
    // Identity endpoint is GraphQL; the broker posts the viewer query and the
    // normalized payload arrives here as { data: { viewer: {...} } }.
    const data = asObject(payload, "data");
    const viewer = asObject(data, "viewer");
    const id = pickString(viewer, "id");
    if (!id) throw identityError("Linear");
    return {
      id,
      displayName: pickString(viewer, "name") ?? id,
      email: pickString(viewer, "email"),
      avatarUrl: pickString(viewer, "avatarUrl")
    };
  }
};

const NOTION_PROFILE: ProviderProfile = {
  label: "Notion",
  authorizationEndpoint: "https://api.notion.com/v1/oauth/authorize",
  tokenEndpoint: "https://api.notion.com/v1/oauth/token",
  revocationEndpoint: "https://api.notion.com/v1/oauth/revoke",
  identityEndpoint: "https://api.notion.com/v1/users/me",
  scopes: [],
  clientIdEnv: "FABLE_BROKER_NOTION_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_NOTION_CLIENT_SECRET",
  pkce: "broker-pkce",
  normalizeIdentity(payload) {
    const p = asObject(payload);
    const bot = asObject(p, "bot");
    const owner = asObject(bot, "owner");
    const workspaceId = pickString(bot, "workspace_id");
    const id = pickString(p, "id") ?? workspaceId ?? pickString(owner, "workspace_id");
    if (!id) throw identityError("Notion");
    return {
      id,
      displayName: pickString(bot, "workspace_name") ?? "Notion workspace",
      workspace: pickString(bot, "workspace_name")
    };
  }
};

const SLACK_PROFILE: ProviderProfile = {
  label: "Slack",
  authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.access",
  revocationEndpoint: "https://slack.com/api/auth.revoke",
  identityEndpoint: "https://slack.com/api/auth.test",
  scopes: [
    "channels:read",
    "groups:read",
    "im:read",
    "mpim:read",
    "users:read",
    "search:read",
    "chat:write",
    "reactions:write"
  ],
  clientIdEnv: "FABLE_BROKER_SLACK_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_SLACK_CLIENT_SECRET",
  pkce: "broker-pkce",
  normalizeIdentity(payload) {
    const p = asObject(payload);
    if (p.ok === false) throw identityError("Slack");
    const id = pickString(p, "user_id") ?? pickString(p, "bot_id");
    if (!id) throw identityError("Slack");
    return {
      id,
      displayName: pickString(p, "user") ?? "Slack account",
      workspace: pickString(p, "team"),
      handle: pickString(p, "url")
    };
  }
};

const PROFILES: Record<BrokerProviderId, ProviderProfile> = {
  github: GITHUB_PROFILE,
  vercel: VERCEL_PROFILE,
  linear: LINEAR_PROFILE,
  notion: NOTION_PROFILE,
  slack: SLACK_PROFILE
};

export function providerProfile(provider: BrokerProviderId): ProviderProfile {
  return PROFILES[provider];
}

export function configuredProviders(
  env: NodeJS.ProcessEnv
): BrokerProviderId[] {
  const configured: BrokerProviderId[] = [];
  for (const [provider, profile] of Object.entries(PROFILES) as Array<
    [BrokerProviderId, ProviderProfile]
  >) {
    if (env[profile.clientIdEnv] && env[profile.clientSecretEnv]) {
      configured.push(provider);
    }
  }
  return configured;
}

/** Resolved provider credentials. Held only in broker memory; never serialized. */
export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export function resolveCredentials(
  provider: BrokerProviderId,
  env: NodeJS.ProcessEnv
): ProviderCredentials {
  const profile = providerProfile(provider);
  const clientId = env[profile.clientIdEnv];
  const clientSecret = env[profile.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(`${profile.label} is not configured on the broker.`);
  }
  return { clientId, clientSecret };
}

function identityError(provider: string): Error {
  return new Error(`${provider} did not return a stable account identity.`);
}

function asObject(value: unknown, key?: string): Record<string, unknown> {
  const target = key === undefined ? value : (value as Record<string, unknown>)?.[key];
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return target as Record<string, unknown>;
  }
  return {};
}

function pickString(value: unknown, key: string): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate) return candidate;
    if (typeof candidate === "number") return String(candidate);
  }
  return undefined;
}
