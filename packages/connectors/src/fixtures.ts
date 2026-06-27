/**
 * Preview/demo fixture catalogs for the Arden connectors package.
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
} from "@arden/protocol";

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
    permissions: ["read repositories and selected files", "prepare draft pull requests and comments"],
    healthSummary: "Preview data loaded; live GitHub App setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "oauth-broker",
    scopes: [
      { id: "contents:read", label: "Repository contents", access: "read", required: true, granted: false },
      { id: "issues:read", label: "Issues", access: "read", required: true, granted: false },
      { id: "pull_requests:write", label: "Draft pull requests", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Register a GitHub App and configure the Arden auth broker.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["github.draft-pull-request", "github.comment"]
  },
  {
    id: "vercel",
    name: "Vercel",
    status: "fixture",
    permissions: ["read projects and deployments", "prepare promote or rollback requests"],
    healthSummary: "Preview data loaded; live integration setup required",
    lastCheckedAt: "2026-06-27T09:00:00.000Z",
    authMode: "provider-installation",
    scopes: [
      { id: "project:read", label: "Projects", access: "read", required: true, granted: false },
      { id: "deployment:read", label: "Deployments", access: "read", required: true, granted: false },
      { id: "deployment:write", label: "Promote or rollback", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Create a Vercel integration and configure its External Flow redirect.",
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
    authMode: "oauth-pkce",
    scopes: [
      { id: "drive.file", label: "Selected Drive files", access: "read", required: true, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Enable Drive API and create a desktop OAuth client.",
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
    authMode: "oauth-pkce",
    scopes: [
      { id: "gmail.readonly", label: "Read mail", access: "read", required: true, granted: false },
      { id: "gmail.compose", label: "Create drafts", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Enable Gmail API, create a desktop OAuth client, and complete Google verification.",
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
    authMode: "oauth-pkce",
    scopes: [
      { id: "calendar.calendarlist.readonly", label: "Calendar list", access: "read", required: true, granted: false },
      { id: "calendar.events.readonly", label: "Calendar events", access: "read", required: true, granted: false },
      { id: "calendar.events", label: "Create or update events", access: "write", required: false, granted: false }
    ],
    health: {
      state: "unknown",
      summary: "Fixture adapter only",
      checkedAt: "2026-06-27T09:00:00.000Z"
    },
    setupMessage: "Enable Calendar API and create a desktop OAuth client.",
    supportsSearch: true,
    supportsImport: true,
    supportedActions: ["google-calendar.create-draft", "google-calendar.update-draft"]
  },
  {
    id: "linear",
    name: "Linear",
    status: "needs-auth",
    permissions: ["read teams and issues"],
    healthSummary: "Adapter boundary ready",
    lastCheckedAt: "2026-06-25T21:00:00.000Z",
    authMode: "oauth-broker",
    setupMessage: "Linear remains a later-wave adapter.",
    supportsSearch: false,
    supportsImport: false,
    supportedActions: []
  }
] satisfies ConnectorManifest[];

export const connectorSearchFixtures: Record<FirstWaveConnectorId, ConnectorSearchItem[]> = {
  github: [
    {
      id: "github-repo-arden",
      connectorId: "github",
      title: "arden",
      kind: "repository",
      summary: "Desktop workspace repository with connector and approval foundations.",
      provenance: "GitHub fixture · acme/arden",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      contentPreview: "README: Arden is a local-first AI workspace for real work.",
      providerMetadata: { owner: "acme", defaultBranch: "main", visibility: "private" }
    },
    {
      id: "github-pr-42",
      connectorId: "github",
      title: "PR #42 · Add connector foundations",
      kind: "pull-request",
      summary: "Synthetic draft pull request used to verify read and approval boundaries.",
      provenance: "GitHub fixture · acme/arden",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      providerMetadata: { repository: "acme/arden", number: "42", state: "draft" }
    }
  ],
  vercel: [
    {
      id: "vercel-project-arden",
      connectorId: "vercel",
      title: "arden-web",
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
      title: "arden-web-preview",
      kind: "deployment",
      summary: "Ready preview deployment for connector UI verification.",
      provenance: "Vercel fixture · arden-web",
      freshness: "Fixture updated 2026-06-27",
      trust: "untrusted",
      url: "https://example.invalid/arden-preview",
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
      summary: "Synthetic page shared with the Arden fixture connection.",
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
  ]
};

export const directiveFixtures = [
  {
    id: "codex-launch-plan",
    label: "Turn Codex notes into a launch plan",
    source: "From OpenAI Codex Manual + PRD",
    prompt:
      "Turn the Codex notes and PRD into a launch plan with milestones, risks, owner decisions, and the next three implementation steps.",
    connectorIds: ["local-files", "github"]
  },
  {
    id: "review-draft-pr",
    label: "Review the draft PR before GitHub publish",
    source: "josh-arden / feature-memory",
    prompt:
      "Review the draft PR for the feature-memory branch before publishing. Check screenshots, tests, secrets, and remaining work.",
    connectorIds: ["github"]
  },
  {
    id: "market-research",
    label: "Summarize market-research.pdf into decisions",
    source: "Added 2 days ago",
    prompt:
      "Summarize market-research.pdf into product decisions, unresolved assumptions, and citations I should keep attached to this workspace.",
    connectorIds: ["local-files"]
  },
  {
    id: "weekly-digest",
    label: "Schedule a weekly workspace digest",
    source: "Uses Memory + Automations",
    prompt:
      "Schedule a weekly workspace digest that summarizes active projects, new memory, connector issues, approvals, and next actions.",
    connectorIds: ["local-files", "vercel"]
  }
] satisfies WorkspaceDirective[];

export const chatThreadFixtures = [
  {
    id: "daily-catchup",
    title: "Daily catch-up",
    kind: "chat",
    description: "A loose workspace thread for non-project updates, reminders, and follow-through.",
    updatedAt: "Today",
    pinnedContextIds: ["concise-updates"]
  },
  {
    id: "market-notes",
    title: "Market research notes",
    kind: "chat",
    description: "Notes and citations that are not yet attached to a project.",
    updatedAt: "Yesterday",
    pinnedContextIds: ["market-research-pdf"]
  },
  {
    id: "voice-drafts",
    title: "Voice drafts",
    kind: "chat",
    description: "Captured dictation and follow-up prompts from voice sessions.",
    updatedAt: "2d ago",
    pinnedContextIds: []
  }
] satisfies ThreadSummary[];

export const projectFixtures = [
  {
    id: "arden",
    title: "Arden desktop",
    description: "Initial desktop workspace, memory, approvals, and connector foundations.",
    threads: [
      {
        id: "arden-initial-build",
        title: "Initial build",
        kind: "project",
        description: "Selected visual direction, shell implementation, checks, and desktop packaging.",
        updatedAt: "Active",
        pinnedContextIds: ["prd", "codex-manual", "selected-concept"]
      },
      {
        id: "arden-memory",
        title: "Memory and approvals",
        kind: "project",
        description: "Durable memory controls, consequence-aware approvals, and audit history.",
        updatedAt: "Today",
        pinnedContextIds: ["concise-updates", "github-draft-pr"]
      }
    ]
  },
  {
    id: "site",
    title: "Marketing site",
    description: "Arden positioning, security narrative, demos, downloads, and docs.",
    threads: [
      {
        id: "site-positioning",
        title: "Positioning",
        kind: "project",
        description: "Homepage story, use cases, and brand voice.",
        updatedAt: "Queued",
        pinnedContextIds: []
      },
      {
        id: "site-security",
        title: "Security page",
        kind: "project",
        description: "Permissions, local-first privacy, approvals, and connector trust model.",
        updatedAt: "Queued",
        pinnedContextIds: ["threat-model"]
      }
    ]
  }
] satisfies ProjectWorkspace[];

export const knowledgeSourceFixtures = [
  {
    id: "prd",
    title: "Arden product brief",
    kind: "document",
    connectorId: "local-files",
    provenance: "Goal objective file",
    freshness: "Read this session",
    pinned: true,
    trust: "trusted",
    origin: "fixture"
  },
  {
    id: "selected-concept",
    title: "Selected visual direction",
    kind: "document",
    connectorId: "local-files",
    provenance: "Product Design mockup",
    freshness: "Updated today",
    pinned: true,
    trust: "trusted",
    origin: "fixture"
  },
  {
    id: "codex-manual",
    title: "OpenAI Codex Manual",
    kind: "web",
    connectorId: "local-files",
    provenance: "Research source",
    freshness: "Fixture",
    pinned: false,
    trust: "trusted",
    origin: "fixture"
  },
  {
    id: "market-research-pdf",
    title: "market-research.pdf",
    kind: "document",
    connectorId: "local-files",
    provenance: "Imported source fixture",
    freshness: "Added 2 days ago",
    pinned: false,
    trust: "untrusted",
    origin: "fixture"
  }
] satisfies KnowledgeSource[];

export const automationFixtures = [
  {
    id: "weekly-digest",
    title: "Weekly workspace digest",
    trigger: "Every Friday morning",
    destination: "Josh chat",
    status: "draft",
    requiresApproval: true
  },
  {
    id: "stale-approval-nudge",
    title: "Nudge stale approvals",
    trigger: "When an approval waits 24 hours",
    destination: "Notifications",
    status: "active",
    requiresApproval: false
  },
  {
    id: "connector-health",
    title: "Connector health check",
    trigger: "Daily when Arden opens",
    destination: "Knowledge log",
    status: "active",
    requiresApproval: false
  }
] satisfies AutomationRule[];
