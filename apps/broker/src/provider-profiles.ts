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
 * How a provider wants PKCE handled by the broker.
 * - `none`: the provider flow in use does not document PKCE; omit it.
 * - `broker-pkce`: the broker generates its own verifier/challenge and presents it
 *   to the provider, then uses the verifier in the confidential exchange.
 */
export type BrokerPkceMode = "none" | "broker-pkce";

export type ProviderTokenRequestStyle = "form" | "form-without-grant-type" | "json-basic";
export type ProviderRevocationStyle = "none" | "form" | "github-oauth-app";

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
  /** Extra fixed authorization parameters required by the provider. */
  authorizationParams?: Readonly<Record<string, string>>;
  /** Optional env var values needed in addition to client id/secret. */
  requiredEnv?: readonly string[];
  /** Environment variable holding the confidential client id (display only here). */
  clientIdEnv: string;
  /** Environment variable holding the confidential client secret. */
  clientSecretEnv: string;
  /** Whether the provider accepts/needs PKCE on the confidential exchange. */
  pkce: BrokerPkceMode;
  /** How scopes are represented on the authorization URL. */
  scopeParameter?: "scope" | "omit";
  /** Separator for multi-scope provider authorization values. Defaults to space. */
  scopeSeparator?: " " | ",";
  /** Whether the provider returns refresh tokens for this flow. */
  supportsRefresh: boolean;
  /** Token exchange body/authentication convention. */
  tokenRequestStyle: ProviderTokenRequestStyle;
  /** Revocation convention. */
  revocationStyle: ProviderRevocationStyle;
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
  revocationEndpoint: `https://api.github.com/applications/${"{clientId}"}/token`,
  identityEndpoint: "https://api.github.com/user",
  scopes: ["read:user", "read:org", "repo"],
  clientIdEnv: "FABLE_BROKER_GITHUB_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_GITHUB_CLIENT_SECRET",
  pkce: "broker-pkce",
  supportsRefresh: false,
  tokenRequestStyle: "form",
  revocationStyle: "github-oauth-app",
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
  revocationEndpoint: "",
  identityEndpoint: "https://api.vercel.com/v2/user",
  scopes: ["user:read", "team:read", "project:read", "deployment:read", "deployment:write"],
  clientIdEnv: "FABLE_BROKER_VERCEL_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_VERCEL_CLIENT_SECRET",
  pkce: "broker-pkce",
  supportsRefresh: false,
  tokenRequestStyle: "form-without-grant-type",
  revocationStyle: "none",
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
  authorizationEndpoint: "https://linear.app/oauth/authorize",
  tokenEndpoint: "https://api.linear.app/oauth/token",
  revocationEndpoint: "https://api.linear.app/oauth/revoke",
  identityEndpoint: "https://api.linear.app/graphql",
  scopes: ["read", "write", "issues:create", "comments:create"],
  clientIdEnv: "FABLE_BROKER_LINEAR_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_LINEAR_CLIENT_SECRET",
  pkce: "broker-pkce",
  scopeSeparator: ",",
  supportsRefresh: true,
  tokenRequestStyle: "form",
  revocationStyle: "form",
  normalizeIdentity(payload) {
    // Identity endpoint is GraphQL; the broker posts the viewer query and the
    // normalized payload arrives here as { data: { viewer: {...} } }.
    const data = asObject(payload, "data");
    const viewer = asObject(data, "viewer");
    const id = pickString(viewer, "id");
    const organization = asObject(viewer, "organization");
    if (!id) throw identityError("Linear");
    return {
      id,
      displayName: pickString(viewer, "name") ?? id,
      email: pickString(viewer, "email"),
      avatarUrl: pickString(viewer, "avatarUrl"),
      workspace: pickString(organization, "name")
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
  authorizationParams: { owner: "user" },
  clientIdEnv: "FABLE_BROKER_NOTION_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_NOTION_CLIENT_SECRET",
  pkce: "none",
  supportsRefresh: true,
  tokenRequestStyle: "json-basic",
  revocationStyle: "none",
  normalizeIdentity(payload) {
    const p = asObject(payload);
    const bot = asObject(p, "bot");
    const owner = asObject(bot, "owner");
    const workspaceId = pickString(p, "workspace_id") ?? pickString(bot, "workspace_id") ?? pickString(owner, "workspace_id");
    const id = workspaceId ?? pickString(p, "id");
    if (!id) throw identityError("Notion");
    return {
      id,
      displayName: pickString(p, "workspace_name") ?? pickString(bot, "workspace_name") ?? "Notion workspace",
      workspace: pickString(p, "workspace_name") ?? pickString(bot, "workspace_name")
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
    "channels:history",
    "groups:history",
    "im:read",
    "mpim:read",
    "users:read",
    "chat:write",
    "reactions:write"
  ],
  clientIdEnv: "FABLE_BROKER_SLACK_CLIENT_ID",
  clientSecretEnv: "FABLE_BROKER_SLACK_CLIENT_SECRET",
  pkce: "none",
  scopeSeparator: ",",
  supportsRefresh: false,
  tokenRequestStyle: "form",
  revocationStyle: "form",
  normalizeIdentity(payload) {
    const p = asObject(payload);
    if (p.ok === false) throw identityError("Slack");
    const userId = pickString(p, "user_id") ?? pickString(p, "bot_id");
    const teamId = pickString(p, "team_id");
    if (!userId) throw identityError("Slack");
    const id = teamId ? teamId + ":" + userId : userId;
    return {
      id,
      displayName: pickString(p, "user") ?? pickString(p, "team") ?? "Slack account",
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

/**
 * Environment shape the broker reads credentials from. Runtime-neutral: Node's
 * `process.env` and a Cloudflare Worker `env` binding both satisfy it. Only the
 * configured provider id/secret env vars are read; nothing here is serialized,
 * logged, or returned.
 */
export type BrokerEnv = Record<string, string | undefined>;

export function providerProfile(provider: BrokerProviderId): ProviderProfile {
  return PROFILES[provider];
}

/**
 * Resolve a profile endpoint, substituting any `{clientId}` placeholder with the
 * confidential client id. GitHub's token deletion endpoint is keyed by
 * the application's client id (`/applications/{clientId}/token`); other providers
 * have static endpoints and resolve unchanged. The client id is not a secret.
 */
export function resolveEndpoint(
  endpoint: string,
  credentials: ProviderCredentials
): string {
  if (!endpoint.includes("{clientId}")) return endpoint;
  return endpoint.replaceAll("{clientId}", credentials.clientId);
}

export function configuredProviders(
  env: BrokerEnv
): BrokerProviderId[] {
  const configured: BrokerProviderId[] = [];
  for (const [provider, profile] of Object.entries(PROFILES) as Array<
    [BrokerProviderId, ProviderProfile]
  >) {
    if (isProfileConfigured(profile, env)) {
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
  env: BrokerEnv,
  profile?: ProviderProfile
): ProviderCredentials {
  const resolved = profile ?? providerProfile(provider);
  const clientId = env[resolved.clientIdEnv];
  const clientSecret = env[resolved.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new Error(`${resolved.label} is not configured on the broker.`);
  }
  return { clientId, clientSecret };
}

export function isProfileConfigured(profile: ProviderProfile, env: BrokerEnv): boolean {
  return Boolean(
    env[profile.clientIdEnv]
    && env[profile.clientSecretEnv]
    && (profile.requiredEnv ?? []).every((name) => Boolean(env[name]))
  );
}

export function resolveAuthorizationEndpoint(
  profile: ProviderProfile,
  _env: BrokerEnv,
  credentials: ProviderCredentials
): string {
  return resolveEndpoint(profile.authorizationEndpoint, credentials);
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
