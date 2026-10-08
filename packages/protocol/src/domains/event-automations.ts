import type { PermissionMode } from "../index.js";

/** Events are untrusted context. This contract carries no credentials or permits. */
export type AutomationEventSource =
  | { kind: "signed-json"; sourceId: string }
  | { kind: "github-issues"; repository: string }
  | { kind: "github-workflow-run"; repository: string };

export interface AutomationEventDraft {
  source: AutomationEventSource;
  fields: string[];
  maxAgeSeconds: number;
  validUntil: string;
}

export interface AutomationEventTrigger extends AutomationEventDraft {
  kind: "event";
  routeId: string;
  keyVersion: number;
  signingKeyId: string;
}

export interface EventAutomationInput {
  workspaceId: string;
  id: string;
  agentId: string;
  providerId: string;
  model: string;
  reasoningEffort?: string;
  permissionMode: PermissionMode;
  prompt: string;
  event: AutomationEventDraft;
}

export interface EventTemplatePreview {
  prompt: string;
  selectedFields: Record<string, string | number | boolean>;
  missing: string[];
}

export interface EventDelivery {
  id: string;
  scheduleId: string;
  receivedAt: string;
  expiresAt: string;
  state: string;
  reason: string;
  source: AutomationEventSource;
  selectedFields: Record<string, string | number | boolean>;
  prompt?: string;
  occurrenceId?: string;
  workId?: string;
  threadId?: string;
}

export interface EventIngressStatus {
  enabled: boolean;
  port: number;
  listening: boolean;
  baseUrl?: string;
  prerequisite?: string;
  availability: "app-open";
  cloudHolding: false;
}
