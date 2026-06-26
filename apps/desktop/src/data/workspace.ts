/**
 * Desktop shell preview/demo data.
 *
 * This module is the single ownership boundary for the demo data the Arden
 * desktop shell renders before any live connectors are wired up. It does two
 * things:
 *
 * 1. Re-exports the shared fixture catalogs owned by `@arden/connectors`
 *    (connector manifests, directives, threads, projects, knowledge sources,
 *    and automations) under the plain names the shell components use.
 * 2. Owns the desktop-local fixtures that have no place in the connectors
 *    package: durable `memoryRecords` and `pendingApprovals`.
 *
 * Everything here is preview/demo data. It must not contain real credentials,
 * live API responses, or user-specific secrets. When real connectors and a
 * durable store land, these exports are replaced with hydrated runtime state.
 */

import {
  automationFixtures,
  chatThreadFixtures,
  connectorFixtures,
  directiveFixtures,
  knowledgeSourceFixtures,
  projectFixtures
} from "@arden/connectors";
import type { ApprovalRequest, MemoryRecord } from "@arden/protocol";

// Shared fixture catalogs — owned by @arden/connectors, re-exported here so
// shell components import demo data from one place.
export const workspaceDirectives = directiveFixtures;
export const connectors = connectorFixtures;
export const chatThreads = chatThreadFixtures;
export const projects = projectFixtures;
export const knowledgeSources = knowledgeSourceFixtures;
export const automations = automationFixtures;

// Desktop-local preview fixtures — owned here (no connector equivalent).
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
    id: "arden-research",
    kind: "fact",
    title: "Arden research workspace",
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
    value: "Arden should feel closer to Cursor, ChatGPT, and Codex: minimal dark gray chrome, off-white canvas, fewer nav items, and contextual directives below the composer.",
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
    riskLevel: "medium",
    dataUsed: ["branch diff", "screenshots", "test summary"],
    consequence: "Creates a private draft PR that can later be shared or merged.",
    requestedAt: "2026-06-25T21:00:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"]
  },
  {
    id: "weekly-digest-rule",
    service: "Arden Automations",
    action: "Enable weekly workspace digest",
    mode: "trusted-scope",
    riskLevel: "medium",
    dataUsed: ["pinned memory", "active projects", "connector health", "open approvals"],
    consequence: "Creates a scheduled summary that can inspect selected workspace context each week.",
    requestedAt: "2026-06-25T21:20:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"]
  },
  {
    id: "vercel-production-release",
    service: "Vercel",
    action: "Promote Arden preview to production",
    mode: "full-access",
    riskLevel: "high",
    dataUsed: ["production project", "deployment metadata", "domain routing"],
    consequence: "Makes the selected deployment public at the production domain.",
    requestedAt: "2026-06-26T00:30:00.000Z",
    decisions: ["once", "session", "rule", "modify", "deny"],
    confirmationPhrase: "publish Arden"
  }
];
