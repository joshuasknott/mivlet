import type {
  ConnectorManifest,
  ConnectorPermission,
  SupportedConnectorId
} from "@fable/protocol";

export const SUPPORTED_CONNECTOR_IDS = [
  "github",
  "vercel",
  "google-drive",
  "notion",
  "gmail",
  "slack",
  "google-calendar",
  "linear"
] as const satisfies readonly SupportedConnectorId[];

const NOT_CHECKED = "Not checked";

function permission(
  id: string,
  label: string,
  access: ConnectorPermission["access"],
  required: boolean
): ConnectorPermission {
  return { id, label, access, required, granted: false };
}

function disconnectedConnector(
  connector: Omit<ConnectorManifest, "status" | "healthSummary" | "lastCheckedAt" | "health">
): ConnectorManifest {
  return {
    ...connector,
    status: "unconfigured",
    healthSummary: "Provider configuration required",
    lastCheckedAt: NOT_CHECKED,
    health: {
      state: "unknown",
      summary: "Provider configuration required",
      checkedAt: NOT_CHECKED
    },
    supportsSearch: false,
    supportsImport: false,
    supportedActions: []
  };
}

/**
 * Secret-free catalogue used before the native boundary returns live status.
 * Entries are deliberately unavailable until the installed app proves its
 * provider configuration and an authorized connection.
 */
export const connectorCatalog: ConnectorManifest[] = [
  {
    id: "local-files",
    name: "Local Files",
    status: "connected",
    permissions: ["read files you explicitly select"],
    healthSummary: "Available on this device",
    lastCheckedAt: NOT_CHECKED,
    authMode: "none",
    health: {
      state: "healthy",
      summary: "Available on this device",
      checkedAt: NOT_CHECKED
    },
    supportsSearch: false,
    supportsImport: true,
    supportedActions: []
  },
  disconnectedConnector({
    id: "github",
    name: "GitHub",
    permissions: ["read repositories, issues, and pull requests"],
    authMode: "oauth-broker",
    scopes: [
      permission("read:user", "Account identity", "read", true),
      permission("repo", "Repositories, issues, and pull requests", "read", true),
      permission("read:org", "Organization membership", "read", false)
    ],
    setupMessage: "Register a GitHub OAuth App and configure the Mivlet auth broker."
  }),
  disconnectedConnector({
    id: "vercel",
    name: "Vercel",
    permissions: ["read projects and deployments", "prepare approved deployment changes"],
    authMode: "provider-installation",
    scopes: [
      permission("project:read", "Projects", "read", true),
      permission("deployment:read", "Deployments", "read", true),
      permission("deployment:write", "Deployment changes", "write", false)
    ],
    setupMessage: "Create a Vercel integration and configure its External Flow redirect."
  }),
  disconnectedConnector({
    id: "google-drive",
    name: "Google Drive",
    permissions: ["read and change files covered by the granted Drive scope"],
    authMode: "oauth-pkce",
    scopes: [
      permission(
        "https://www.googleapis.com/auth/drive.file",
        "Selected Drive files",
        "read",
        true
      )
    ],
    setupMessage:
      "Enable the Drive API, create a desktop OAuth client, and configure its client ID."
  }),
  disconnectedConnector({
    id: "notion",
    name: "Notion",
    permissions: ["read selected pages and databases", "prepare approved content changes"],
    authMode: "oauth-broker",
    scopes: [
      permission("read_content", "Read selected content", "read", true),
      permission("insert_content", "Create content", "write", false),
      permission("update_content", "Update content", "write", false)
    ],
    setupMessage: "Create a Notion public integration and configure the Mivlet auth broker."
  }),
  disconnectedConnector({
    id: "gmail",
    name: "Gmail",
    permissions: ["read selected mail", "create drafts and send only after approval"],
    authMode: "oauth-pkce",
    scopes: [
      permission("https://www.googleapis.com/auth/gmail.readonly", "Read mail", "read", true),
      permission("https://www.googleapis.com/auth/gmail.compose", "Create drafts", "write", false),
      permission("https://www.googleapis.com/auth/gmail.send", "Send approved mail", "write", false)
    ],
    setupMessage:
      "Enable the Gmail API, create a desktop OAuth client, and complete required Google verification."
  }),
  disconnectedConnector({
    id: "slack",
    name: "Slack",
    permissions: ["read selected conversations", "post or change messages only after approval"],
    authMode: "oauth-broker",
    scopes: [
      permission("channels:read", "Channel list", "read", true),
      permission("channels:history", "Selected channel history", "read", true),
      permission("users:read", "Workspace users", "read", true),
      permission("chat:write", "Post approved messages", "write", false)
    ],
    setupMessage: "Create a Slack app and configure the Mivlet auth broker."
  }),
  disconnectedConnector({
    id: "google-calendar",
    name: "Google Calendar",
    permissions: ["read calendars and events", "change events only after approval"],
    authMode: "oauth-pkce",
    scopes: [
      permission(
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "Calendar list",
        "read",
        true
      ),
      permission(
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "Calendar events",
        "read",
        true
      ),
      permission(
        "https://www.googleapis.com/auth/calendar.events",
        "Change events",
        "write",
        false
      )
    ],
    setupMessage:
      "Enable the Calendar API and create a desktop OAuth client for Mivlet."
  }),
  disconnectedConnector({
    id: "linear",
    name: "Linear",
    permissions: ["read workspace data", "change issues and comments only after approval"],
    authMode: "oauth-broker",
    scopes: [
      permission("read", "Workspace data", "read", true),
      permission("write", "Issue changes", "write", false),
      permission("comments:create", "Create comments", "write", false)
    ],
    setupMessage: "Create a Linear OAuth application and configure the Mivlet auth broker."
  })
];

export function listSupportedConnectors(): ConnectorManifest[] {
  return connectorCatalog.map((connector) => ({
    ...connector,
    permissions: [...connector.permissions],
    scopes: connector.scopes?.map((scope) => ({ ...scope })),
    supportedActions: [...(connector.supportedActions ?? [])]
  }));
}
