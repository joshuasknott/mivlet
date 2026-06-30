import type {
  ConnectorAccountSummary,
  ConnectorError,
  ConnectorHealth,
  ConnectorId,
  ConnectorPermission,
  ConnectorStatus,
  ConnectorTokenSet,
  FirstWaveConnectorId
} from "@fable/protocol";

export const GOOGLE_CONNECTOR_IDS = [
  "google-drive",
  "gmail",
  "google-calendar"
] as const satisfies readonly FirstWaveConnectorId[];

export type GoogleConnectorId = (typeof GOOGLE_CONNECTOR_IDS)[number];

export interface GoogleScopeDefinition {
  id: string;
  label: string;
  access: "read" | "write";
  required: boolean;
  description: string;
}

export interface GoogleConnectorProfile {
  id: GoogleConnectorId;
  name: string;
  requiredApis: readonly string[];
  scopes: readonly GoogleScopeDefinition[];
  identityScope: string;
}

export type GoogleTokenLifecycleState =
  | "connected"
  | "needs-auth"
  | "expired"
  | "stale"
  | "configuration-required"
  | "provider-unavailable"
  | "partial-failure"
  | "revoked";

export interface GoogleConnectionMetadata {
  connectorId: GoogleConnectorId;
  account?: ConnectorAccountSummary;
  grantedScopes: readonly string[];
  expiresAt?: string;
  refreshedAt?: string;
  lastCheckedAt: string;
  lastError?: ConnectorError;
  revokedAt?: string;
}

const GOOGLE_IDENTITY_SCOPE = "openid email profile";

const GOOGLE_PROFILES: Record<GoogleConnectorId, GoogleConnectorProfile> = {
  "google-drive": {
    id: "google-drive",
    name: "Google Drive",
    requiredApis: ["Google Drive API"],
    identityScope: GOOGLE_IDENTITY_SCOPE,
    scopes: [
      {
        id: "https://www.googleapis.com/auth/drive.file",
        label: "Selected Drive files",
        access: "read",
        required: true,
        description: "See, create, and edit only Google Drive files the user opens or creates with Fable."
      }
    ]
  },
  gmail: {
    id: "gmail",
    name: "Gmail",
    requiredApis: ["Gmail API"],
    identityScope: GOOGLE_IDENTITY_SCOPE,
    scopes: [
      {
        id: "https://www.googleapis.com/auth/gmail.readonly",
        label: "Read mail",
        access: "read",
        required: true,
        description: "Search and read Gmail messages the user asks Fable to inspect."
      },
      {
        id: "https://www.googleapis.com/auth/gmail.compose",
        label: "Create drafts",
        access: "write",
        required: false,
        description: "Create and update Gmail drafts after Fable approval."
      },
      {
        id: "https://www.googleapis.com/auth/gmail.send",
        label: "Send approved mail",
        access: "write",
        required: false,
        description: "Send one explicitly approved Gmail message."
      }
    ]
  },
  "google-calendar": {
    id: "google-calendar",
    name: "Google Calendar",
    requiredApis: ["Google Calendar API"],
    identityScope: GOOGLE_IDENTITY_SCOPE,
    scopes: [
      {
        id: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        label: "Calendar list",
        access: "read",
        required: true,
        description: "List calendars the account can access."
      },
      {
        id: "https://www.googleapis.com/auth/calendar.events.readonly",
        label: "Calendar events",
        access: "read",
        required: true,
        description: "Read calendar events and availability."
      },
      {
        id: "https://www.googleapis.com/auth/calendar.events",
        label: "Create or update events",
        access: "write",
        required: false,
        description: "Create, update, cancel, or delete calendar events after Fable approval."
      }
    ]
  }
};

export function isGoogleConnectorId(value: unknown): value is GoogleConnectorId {
  return typeof value === "string" && (GOOGLE_CONNECTOR_IDS as readonly string[]).includes(value);
}

export function googleConnectorProfile(connectorId: GoogleConnectorId): GoogleConnectorProfile {
  return GOOGLE_PROFILES[connectorId];
}

export function googleScopeIds(connectorId: GoogleConnectorId): string[] {
  const profile = googleConnectorProfile(connectorId);
  return [...profile.identityScope.split(" "), ...profile.scopes.map((scope) => scope.id)];
}

export function googleRequiredScopeIds(connectorId: GoogleConnectorId): string[] {
  const profile = googleConnectorProfile(connectorId);
  return [
    ...profile.identityScope.split(" "),
    ...profile.scopes.filter((scope) => scope.required).map((scope) => scope.id)
  ];
}

export function assertGoogleScopes(
  connectorId: GoogleConnectorId,
  tokens: ConnectorTokenSet,
  anyOf: readonly string[]
): void {
  const granted = tokens.scopes ?? [];
  const allowed = anyOf.some((required) => granted.some((scope) =>
    scope === required || scope.endsWith(`/${required}`)
  ));
  if (!allowed) {
    throw {
      connectorId,
      code: "permission-denied",
      message: `This operation needs additional ${googleConnectorProfile(connectorId).name} permission.`,
      retryable: false
    } satisfies ConnectorError;
  }
}

export function googleOAuthEndpoints(authBaseUrl?: string) {
  if (authBaseUrl) {
    const base = new URL(authBaseUrl);
    return {
      authorizationEndpoint: new URL("o/oauth2/v2/auth", base).toString(),
      tokenEndpoint: new URL("o/oauth2/token", base).toString(),
      identityEndpoint: new URL("oauth2/v3/userinfo", base).toString(),
      revocationEndpoint: new URL("o/oauth2/revoke", base).toString()
    };
  }
  return {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    identityEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke"
  };
}

export function googleConnectorPermissions(
  connectorId: GoogleConnectorId,
  grantedScopes: readonly string[] = []
): ConnectorPermission[] {
  const granted = new Set(grantedScopes);
  return googleConnectorProfile(connectorId).scopes.map((scope) => ({
    id: scope.id,
    label: scope.label,
    access: scope.access,
    required: scope.required,
    granted: granted.has(scope.id)
  }));
}

export function googleScopeDescriptions(connectorId: GoogleConnectorId): string[] {
  return googleConnectorProfile(connectorId).scopes.map((scope) => `${scope.label}: ${scope.description}`);
}

export function mergeGoogleTokenRefresh(
  previous: ConnectorTokenSet,
  refreshed: ConnectorTokenSet
): ConnectorTokenSet {
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? previous.refreshToken,
    scopes: refreshed.scopes.length ? refreshed.scopes : previous.scopes
  };
}

export function resolveGoogleLifecycleState(
  metadata: GoogleConnectionMetadata,
  nowMs = Date.now()
): GoogleTokenLifecycleState {
  if (metadata.revokedAt) return "revoked";
  if (metadata.lastError) {
    if (metadata.lastError.code === "configuration-required") return "configuration-required";
    if (metadata.lastError.code === "provider-unavailable" || metadata.lastError.retryable) return "partial-failure";
    if (metadata.lastError.code === "needs-auth" || metadata.lastError.code === "expired-auth") return "needs-auth";
  }
  if (!metadata.account) return "needs-auth";
  const missingRequired = googleConnectorProfile(metadata.connectorId).scopes
    .some((scope) => scope.required && !metadata.grantedScopes.includes(scope.id));
  if (missingRequired) return "stale";
  if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= nowMs) return "expired";
  return "connected";
}

export function googleStatusFromLifecycle(state: GoogleTokenLifecycleState): ConnectorStatus {
  switch (state) {
    case "connected":
      return "connected";
    case "expired":
      return "expired";
    case "configuration-required":
      return "unavailable";
    case "partial-failure":
    case "provider-unavailable":
    case "stale":
      return "error";
    case "needs-auth":
    case "revoked":
      return "needs-auth";
  }
}

export function googleHealthFromLifecycle(
  connectorId: GoogleConnectorId,
  state: GoogleTokenLifecycleState,
  checkedAt: string
): ConnectorHealth {
  const profile = googleConnectorProfile(connectorId);
  const summary: Record<GoogleTokenLifecycleState, string> = {
    connected: `${profile.name} account connected.`,
    "needs-auth": `${profile.name} needs Google authorization.`,
    expired: `${profile.name} token expired; reconnect or refresh is required.`,
    stale: `${profile.name} is missing required Google scopes.`,
    "configuration-required": `${profile.name} is not configured on the Fable auth broker.`,
    "provider-unavailable": "Google is temporarily unavailable.",
    "partial-failure": `${profile.name} had a recoverable Google provider failure.`,
    revoked: `${profile.name} was disconnected.`
  };
  return {
    state: state === "connected" ? "healthy" : state === "partial-failure" || state === "provider-unavailable" ? "degraded" : "error",
    summary: summary[state],
    checkedAt
  };
}

export function googleReconnectMessage(connectorId: GoogleConnectorId): string {
  const profile = googleConnectorProfile(connectorId);
  return `Reconnect ${profile.name} through Google to refresh account identity and scopes.`;
}

export function googleConfigurationMessage(connectorId: GoogleConnectorId): string {
  const profile = googleConnectorProfile(connectorId);
  return `Enable ${profile.requiredApis.join(", ")}, configure OAuth consent, create a desktop OAuth client, and set FABLE_GOOGLE_OAUTH_CLIENT_ID.`;
}

export function assertGoogleConnectorId(connectorId: ConnectorId): asserts connectorId is GoogleConnectorId {
  if (!isGoogleConnectorId(connectorId)) {
    throw new Error(`Unsupported Google connector: ${connectorId}`);
  }
}
