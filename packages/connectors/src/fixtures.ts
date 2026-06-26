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
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "github",
    name: "GitHub",
    status: "fixture",
    permissions: ["read repositories", "prepare draft pull requests"],
    healthSummary: "Fixture repo josh-arden is available",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "vercel",
    name: "Vercel",
    status: "fixture",
    permissions: ["read deployments", "prepare preview links"],
    healthSummary: "Preview deployment fixtures loaded",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "google-drive",
    name: "Google Drive",
    status: "needs-auth",
    permissions: ["read selected docs"],
    healthSummary: "Needs OAuth before live import",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "slack",
    name: "Slack",
    status: "needs-auth",
    permissions: ["read selected channels"],
    healthSummary: "Adapter boundary ready",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "notion",
    name: "Notion",
    status: "needs-auth",
    permissions: ["read selected pages"],
    healthSummary: "Adapter boundary ready",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  },
  {
    id: "linear",
    name: "Linear",
    status: "needs-auth",
    permissions: ["read teams and issues"],
    healthSummary: "Adapter boundary ready",
    lastCheckedAt: "2026-06-25T21:00:00.000Z"
  }
] satisfies ConnectorManifest[];

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
