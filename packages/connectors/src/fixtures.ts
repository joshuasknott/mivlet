/**
 * Preview/demo fixture catalogs for the Fable connectors package.
 *
 * These are static, fixture-only catalogs used to render the workspace before
 * real OAuth-backed connectors are wired up. They contain no credentials, live
 * API responses, or user secrets. Logic (local-file import, knowledge search)
 * lives in local-files.ts and knowledge-search.ts; this file is data only.
 */

import type {
  AutomationRule,
  ConnectorManifest,
  ConnectorSearchItem,
  FirstWaveConnectorId,
  KnowledgeSource,
  ProjectWorkspace,
  ThreadSummary,
  WorkspaceDirective
} from "@fable/protocol";
import {
  googleConfigurationMessage,
  googleConnectorPermissions
} from "./providers/google-shared";

export const connectorFixtures = [
  {
    id: "local-files",
    name: "Local Files",
    status: "connected",
    permissions: ["read files you explicitly select", "index imported source metadata"],
    healthSummary: "Native text-file import ready",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "none",
    health: {
      state: "healthy",
      summary: "Native text-file import ready",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    supportsSearch: false,
    supportsImport: true,
    supportedActions: []
  },
  {
    id: "github",
    name: "GitHub",
    status: "fixture",
    permissions: ["Read repositories and files", "Prepare draft pull requests and comments"],
    healthSummary: "Preview mode active; requires GitHub App authorization on your Cloudflare Workers broker.",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: [
      { id: "contents:read", label: "Repository contents", access: "read", required: true, granted: false },
      { id: "issues:read", label: "Issues", access: "read", required: true, granted: false },
      { id: "pull_requests:write", label: "Draft pull requests", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Preview mode only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Authorize this connector using a GitHub App set up on your Cloudflare Workers broker.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["github.draft-pull-request", "github.comment"]
  },
  {
    id: "vercel",
    name: "Vercel",
    status: "fixture",
    permissions: ["Read projects and deployments", "Promote or rollback deployments"],
    healthSummary: "Preview mode active; requires Vercel Integration authorization on your Cloudflare Workers broker.",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "provider-installation",
    scopes: [
      { id: "project:read", label: "Projects", access: "read", required: true, granted: false },
      { id: "deployment:read", label: "Deployments", access: "read", required: true, granted: false },
      { id: "deployment:write", label: "Promote or rollback", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Preview mode only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Authorize this connector using a Vercel Integration set up on your Cloudflare Workers broker.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["vercel.promote", "vercel.rollback"]
  },
  {
    id: "google-drive",
    name: "Google Drive",
    status: "fixture",
    permissions: ["read files explicitly selected with Google Picker"],
    healthSummary: "Preview data loaded; Google OAuth setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: googleConnectorPermissions("google-drive"),
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: googleConfigurationMessage("google-drive"),
    supportsSearch: true,
    supportsImport: true,
    supportedActions: []
  },
  {
    id: "notion",
    name: "Notion",
    status: "fixture",
    permissions: ["read user-selected pages and databases"],
    healthSummary: "Preview data loaded; Notion connection setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: [
      { id: "read_content", label: "Read selected content", access: "read", required: true, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Create a Notion public connection and broker callback.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: []
  },
  {
    id: "gmail",
    name: "Gmail",
    status: "fixture",
    permissions: ["read selected search results", "prepare email drafts; never send by default"],
    healthSummary: "Preview data loaded; Google OAuth setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: googleConnectorPermissions("gmail"),
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: googleConfigurationMessage("gmail"),
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["gmail.create-draft", "gmail.send"]
  },
  {
    id: "slack",
    name: "Slack",
    status: "fixture",
    permissions: ["read selected conversations", "prepare messages; never post by default"],
    healthSummary: "Preview data loaded; Slack app setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: [
      { id: "channels:read", label: "Channel list", access: "read", required: true, granted: false },
      { id: "channels:history", label: "Selected channel history", access: "read", required: true, granted: false },
      { id: "chat:write", label: "Post approved messages", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Create a Slack app and configure its HTTPS broker callback.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["slack.create-draft", "slack.post"]
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    status: "fixture",
    permissions: ["read calendars and events", "prepare event create or update requests"],
    healthSummary: "Preview data loaded; Google OAuth setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: googleConnectorPermissions("google-calendar"),
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: googleConfigurationMessage("google-calendar"),
    supportsSearch: true,
    supportsImport: true,
    supportedActions: [
      "google-calendar.create-draft",
      "google-calendar.update-draft",
      "google-calendar.cancel-event",
      "google-calendar.delete-event"
    ]
  },
  {
    id: "linear",
    name: "Linear",
    status: "fixture",
    permissions: ["read workspace data", "create and update approved issues and comments"],
    healthSummary: "Preview data loaded; Linear OAuth setup required",
    lastCheckedAt: "2026-06-25T21:00:00.000Z",
    authMode: "oauth-broker",
    scopes: [
      { id: "read", label: "Workspace data", access: "read", required: true, granted: false },
      { id: "write", label: "Issue updates", access: "write", required: false, granted: false },
      { id: "comments:create", label: "Comments", access: "write", required: false, granted: false }
    ],
    health: { state: "unknown", summary: "Fixture adapter only", checkedAt: "2026-06-27T09:00:00.000Z" },
    setupMessage: "Create a Linear OAuth application and configure the Fable auth broker callback.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["linear.create-issue", "linear.update-issue", "linear.comment"]
  }
] satisfies ConnectorManifest[];

export const connectorSearchFixtures: Record<FirstWaveConnectorId, ConnectorSearchItem[]> = {
  github: [
    {
      id: "github-repo-fable",
      connectorId: "github",
      title: "fable",
      kind: "repository",
      summary: "Desktop workspace repository with connector and approval foundations.",
      provenance: "GitHub fixture · acme/fable",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "README: Fable is a local-first AI workspace for real work.",
      providerMetadata: { owner: "acme", defaultBranch: "main", visibility: "private" }
    },
    {
      id: "github-pr-42",
      connectorId: "github",
      title: "PR #42 · Add connector foundations",
      kind: "pull-request",
      summary: "Synthetic draft pull request used to verify read and approval boundaries.",
      provenance: "GitHub fixture · acme/fable",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      providerMetadata: { repository: "acme/fable", number: "42", state: "draft" }
    }
  ],
  vercel: [
    {
      id: "vercel-project-fable",
      connectorId: "vercel",
      title: "fable-web",
      kind: "project",
      summary: "Synthetic Vercel project with preview and production deployments.",
      provenance: "Vercel fixture · Acme team",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      providerMetadata: { framework: "vite", team: "Acme", productionBranch: "main" }
    },
    {
      id: "vercel-deployment-preview",
      connectorId: "vercel",
      title: "fable-web-preview",
      kind: "deployment",
      summary: "Ready preview deployment for connector UI verification.",
      provenance: "Vercel fixture · fable-web",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      url: "https://example.invalid/fable-preview",
      providerMetadata: { environment: "preview", state: "READY", commitRef: "connector-wave" }
    }
  ],
  "google-drive": [
    {
      id: "drive-launch-brief",
      connectorId: "google-drive",
      title: "Connector launch brief",
      kind: "file",
      summary: "Synthetic Google Doc selected through the fixture picker.",
      provenance: "Google Drive fixture · selected file",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Launch checklist: provider setup, permission review, redaction, and rollback.",
      providerMetadata: { mimeType: "application/vnd.google-apps.document", selected: "true" }
    }
  ],
  notion: [
    {
      id: "notion-connector-plan",
      connectorId: "notion",
      title: "Connector rollout plan",
      kind: "page",
      summary: "Synthetic page shared with the Fable fixture connection.",
      provenance: "Notion fixture · selected page",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Rollout phases cover read-only imports before approval-gated actions.",
      providerMetadata: { workspace: "Acme", object: "page" }
    }
  ],
  gmail: [
    {
      id: "gmail-message-release",
      connectorId: "gmail",
      title: "Release readiness notes",
      kind: "message",
      summary: "Synthetic message metadata and redacted preview.",
      provenance: "Gmail fixture · selected search result",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Synthetic preview: confirm scopes, callbacks, and approval checks before release.",
      providerMetadata: { threadId: "fixture-thread-1", labels: "INBOX,IMPORTANT", from: "sender@example.invalid" }
    }
  ],
  slack: [
    {
      id: "slack-message-connectors",
      connectorId: "slack",
      title: "#product · connector rollout",
      kind: "message",
      summary: "Synthetic channel snippet for import-flow testing.",
      provenance: "Slack fixture · selected #product conversation",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Synthetic snippet: keep live setup states explicit and writes approval-gated.",
      providerMetadata: { channelId: "C_FIXTURE", channelName: "product", timestamp: "fixture-1" }
    }
  ],
  "google-calendar": [
    {
      id: "calendar-event-review",
      connectorId: "google-calendar",
      title: "Connector security review",
      kind: "event",
      summary: "Synthetic calendar event with no attendee data.",
      provenance: "Google Calendar fixture · selected calendar",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Review provider scopes, token storage, and approval boundaries.",
      providerMetadata: { calendarId: "fixture-primary", status: "confirmed", start: "2026-07-01T10:00:00Z" }
    }
  ],
  linear: [
    {
      id: "linear-issue-fable-12",
      connectorId: "linear",
      title: "FBL-12 · Ship developer connectors",
      kind: "issue",
      summary: "Synthetic Linear issue used only by preview and tests.",
      provenance: "Linear fixture · Fable",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "Implement authenticated GitHub, Vercel, and Linear adapters.",
      providerMetadata: { workspace: "Fable", team: "FBL", state: "In Progress" }
    }
  ]
};

export const directiveFixtures: WorkspaceDirective[] = [];

export const chatThreadFixtures: ThreadSummary[] = [];

export const projectFixtures: ProjectWorkspace[] = [];

export const knowledgeSourceFixtures: KnowledgeSource[] = [];

export const automationFixtures: AutomationRule[] = [];
