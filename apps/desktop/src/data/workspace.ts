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

export type ProfileFixture = {
  name: string;
  email: string;
  photoInitials: string;
  photoTone: string;
  passwordUpdatedAt: string;
};

export type SubscriptionProvider = {
  id: string;
  name: string;
  description: string;
  credentialType: "subscription" | "api-key";
  status: "connected" | "needs-key" | "available";
  accountLabel: string;
  maskedCredential: string;
  includedModels: string[];
};

export type ModelPreference = {
  id: string;
  label: string;
  description: string;
  selectedModel: string;
  recommended?: boolean;
};

export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  context: string;
  strengths: string;
};

export type SettingsToggle = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
};

export const profileFixture: ProfileFixture = {
  name: "Arden User",
  email: "user@example.com",
  photoInitials: "AU",
  photoTone: "sage",
  passwordUpdatedAt: "Updated 18 days ago"
};

export const subscriptionProviders: SubscriptionProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "Primary Codex-style planning, writing, and coding models.",
    credentialType: "subscription",
    status: "connected",
    accountLabel: "ChatGPT Plus",
    maskedCredential: "Connected account",
    includedModels: ["GPT-5", "GPT-5 Thinking", "GPT-4.1"]
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models for long-context review and careful editing.",
    credentialType: "api-key",
    status: "needs-key",
    accountLabel: "API key required",
    maskedCredential: "sk-ant-... not stored yet",
    includedModels: ["Claude Opus 4", "Claude Sonnet 4"]
  },
  {
    id: "google",
    name: "Google AI",
    description: "Gemini models for multimodal work and large-context reads.",
    credentialType: "api-key",
    status: "available",
    accountLabel: "Optional provider",
    maskedCredential: "No key added",
    includedModels: ["Gemini 2.5 Pro", "Gemini 2.5 Flash"]
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "One API key for testing multiple hosted model families.",
    credentialType: "api-key",
    status: "available",
    accountLabel: "Optional routing",
    maskedCredential: "No key added",
    includedModels: ["DeepSeek", "Qwen", "Mistral"]
  }
];

export const modelOptions: ModelOption[] = [
  {
    id: "gpt-5-thinking",
    name: "GPT-5 Thinking",
    provider: "OpenAI",
    context: "Large",
    strengths: "planning, architecture, high-risk changes"
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "OpenAI",
    context: "Large",
    strengths: "general work, writing, code edits"
  },
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "Anthropic",
    context: "Large",
    strengths: "review, refactors, long documents"
  },
  {
    id: "gemini-2-5-pro",
    name: "Gemini 2.5 Pro",
    provider: "Google AI",
    context: "Very large",
    strengths: "multimodal context, broad research"
  }
];

export const modelPreferences: ModelPreference[] = [
  {
    id: "default",
    label: "Default model",
    description: "Used when Arden picks the model automatically.",
    selectedModel: "gpt-5",
    recommended: true
  },
  {
    id: "reasoning",
    label: "Reasoning model",
    description: "Used for plans, audits, and complex multi-step changes.",
    selectedModel: "gpt-5-thinking"
  },
  {
    id: "fast",
    label: "Fast model",
    description: "Used for small edits, summaries, and low-risk drafts.",
    selectedModel: "gpt-5"
  },
  {
    id: "review",
    label: "Review model",
    description: "Used for second-pass critique and larger context checks.",
    selectedModel: "claude-sonnet-4"
  }
];

export const settingsToggles: SettingsToggle[] = [
  {
    id: "auto-model",
    label: "Let Arden choose models",
    description: "Prefer the best available model for each task, within connected providers.",
    enabled: true
  },
  {
    id: "confirm-spend",
    label: "Confirm paid provider actions",
    description: "Ask before tasks use metered API keys or subscription-only features.",
    enabled: true
  },
  {
    id: "local-redaction",
    label: "Redact secrets before sending",
    description: "Mask likely keys, tokens, and private values before provider calls.",
    enabled: true
  },
  {
    id: "usage-telemetry",
    label: "Show model usage in chats",
    description: "Display provider, model, and approximate cost metadata after each run.",
    enabled: false
  }
];

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
    service: "Arden Schedules",
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
