import {
  automationFixtures,
  chatThreadFixtures,
  connectorFixtures,
  directiveFixtures,
  knowledgeSourceFixtures,
  projectFixtures
} from "@praxis/connectors";
import type { ApprovalRequest, MemoryRecord } from "@praxis/protocol";

export const workspaceDirectives = directiveFixtures;
export const connectors = connectorFixtures;
export const chatThreads = chatThreadFixtures;
export const projects = projectFixtures;
export const knowledgeSources = knowledgeSourceFixtures;
export const automations = automationFixtures;

export const memoryRecords: MemoryRecord[] = [
  {
    id: "concise-updates",
    kind: "preference",
    title: "Concise updates",
    value: "Josh prefers concise updates with concrete next actions.",
    source: "Approved durable memory",
    freshness: "Updated 2 days ago",
    approved: true,
    pinned: true
  },
  {
    id: "praxis-research",
    kind: "fact",
    title: "Praxis research workspace",
    value: "The current workspace contains Codex, OpenCode, Cursor, ChatGPT, and Grok research.",
    source: "Project brief",
    freshness: "Current",
    approved: true,
    pinned: false
  },
  {
    id: "selected-direction",
    kind: "imported",
    title: "Selected design direction",
    value: "Praxis should feel closer to Cursor, ChatGPT, and Codex: minimal dark gray chrome, off-white canvas, fewer nav items, and contextual directives below the composer.",
    source: "Approved product-design direction",
    freshness: "Updated today",
    approved: true,
    pinned: true
  },
  {
    id: "workspace-status",
    kind: "inference",
    title: "Current build status",
    value: "The desktop shell has fixture connectors and local persistence; live OAuth and shared realtime state are still behind adapter boundaries.",
    source: "Runtime inspection",
    freshness: "Current",
    approved: false,
    pinned: false
  }
];

export const pendingApprovals: ApprovalRequest[] = [
  {
    id: "github-draft-pr",
    service: "GitHub",
    action: "Create draft PR for feature-memory",
    mode: "trusted-scope",
    dataUsed: ["branch diff", "screenshots", "test summary"],
    consequence: "Creates a private draft PR that can later be shared or merged.",
    requestedAt: "2026-06-25T21:00:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"]
  },
  {
    id: "weekly-digest-rule",
    service: "Praxis Automations",
    action: "Enable weekly workspace digest",
    mode: "trusted-scope",
    dataUsed: ["pinned memory", "active projects", "connector health", "open approvals"],
    consequence: "Creates a scheduled summary that can inspect selected workspace context each week.",
    requestedAt: "2026-06-25T21:20:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"]
  }
];
