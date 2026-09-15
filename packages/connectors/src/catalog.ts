import { tokenPluginDefinitions } from "./providers/token-plugins";
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
  "linear",
  "outlook",
  "microsoft-teams",
  "zoom",
  "linkedin",
  "instagram",
  "youtube",
  "google-ads",
  "meta-ads",
  "shopify",
  "docusign",
  "greenhouse",
  "lever",
  "workday"
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
    permissions: [
      "read authenticated account identity and organization membership",
      "read public repositories, issues, and pull requests; private repositories are not granted"
    ],
    authMode: "oauth-broker",
    scopes: [
      permission("read:user", "Account identity", "read", true),
      permission("read:org", "Organization membership", "read", true)
    ],
    setupMessage:
      "Register a classic GitHub OAuth App (not a GitHub App) and configure the Mivlet auth broker. The broker requests `read:user` and `read:org` only. Classic `repo` is not requested. Public-repository REST may work; private-repository reads are not granted."
  }),
  disconnectedConnector({
    id: "vercel",
    name: "Vercel",
    permissions: [
      "read projects and deployments",
      "change deployments, projects, and domains only after approval"
    ],
    authMode: "provider-installation",
    scopes: [
      permission("project:read", "Projects", "read", true),
      permission("deployment:read", "Deployments", "read", true),
      permission("deployment:write", "Approved deployment, project, and domain changes", "write", true)
    ],
    setupMessage:
      "Create a Vercel integration with read and write access and configure its External Flow redirect. Mivlet requests `deployment:write` because native promote, rollback, create, cancel, project, and domain actions exist."
  }),
  disconnectedConnector({
    id: "google-drive",
    name: "Google Drive",
    permissions: ["read and change files covered by the granted Drive scope"],
    authMode: "oauth-pkce",
    scopes: [
      permission(
        "https://www.googleapis.com/auth/drive.file",
        "Selected Drive files you create or change",
        "write",
        true
      )
    ],
    setupMessage:
      "Enable the Drive API, create a desktop OAuth client, and configure its client ID."
  }),
  disconnectedConnector({
    id: "notion",
    name: "Notion",
    permissions: [
      "read pages and databases shared with the integration",
      "prepare approved content changes using Notion console capabilities"
    ],
    authMode: "oauth-broker",
    scopes: [],
    setupMessage:
      "Create a Notion public integration and configure the Mivlet auth broker. Notion does not take OAuth scope query parameters; capabilities are set in the Notion console, and sharing is Notion's page-sharing model."
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
      permission("groups:read", "Private channel list", "read", false),
      permission("groups:history", "Selected private channel history", "read", false),
      permission("im:read", "Direct message list", "read", false),
      permission("mpim:read", "Group direct message list", "read", false),
      permission("users:read", "Workspace users", "read", true),
      permission("chat:write", "Post, reply, edit, or delete after approval", "write", true),
      permission("reactions:write", "Add or remove reactions after approval", "write", true)
    ],
    setupMessage:
      "Create a Slack app with bot scopes for channel reads plus `chat:write` and `reactions:write`, and configure the Mivlet auth broker. Those write scopes match native post, reply, edit, delete, and reaction actions."
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
      permission("write", "Create or change issues and comments after approval", "write", true)
    ],
    setupMessage:
      "Create a Linear OAuth application with `read` and `write` and configure the Mivlet auth broker. `write` is requested because native issue create, issue update, and comment actions exist; create-only Linear scopes are not requested separately."
  }),
  ...tokenPluginDefinitions.map((plugin) => disconnectedConnector({
    id: plugin.id, name: plugin.name, authMode: "api-token", permissions: [plugin.description],
    scopes: [permission("token-read", "Read operations permitted by this token", "read", true)],
    setupMessage: plugin.setup,
  })),
];

export function listSupportedConnectors(): ConnectorManifest[] {
  return connectorCatalog.map((connector) => ({
    ...connector,
    permissions: [...connector.permissions],
    scopes: connector.scopes?.map((scope) => ({ ...scope })),
    supportedActions: [...(connector.supportedActions ?? [])]
  }));
}
