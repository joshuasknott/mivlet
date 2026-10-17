import { redactSecretText, secretMarkerSurvives } from "../secret-redaction";

/** Explicitly delegated hosted text Work. These records grant no native tools. */
export const HOSTED_TEXT_TASK_LIMITS = {
  inputBytes: 65_536,
  resultBytes: 65_536,
  outputTokens: 4_096,
  elapsedMs: 120_000,
  retentionMs: 24 * 60 * 60_000,
  activePerAccount: 2,
  admissionsPerDay: 20,
  retainedPerAccount: 40,
  capabilityMs: 120_000,
  credentialBytes: 512,
  credentialsPerAccount: 8,
  credentialRetentionMs: 30 * 24 * 60 * 60_000,
} as const;

export type HostedTextProviderId = "openai" | "anthropic" | "gemini" | "xai" | "deepseek";
export type HostedTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain" | "expired";
export interface HostedTaskBudget {
  maxModelCalls: 1;
  maxOutputTokens: number;
  maxElapsedMs: number;
  maxResultBytes: number;
}
export interface HostedTaskBinding {
  version: 1;
  taskId: string;
  admissionId: string;
  runId: string;
  workspaceId: string;
  agentId: string;
  workId: string;
  workGeneration: number;
  conversationId: string;
  conversationGeneration: number;
  expectedHeadId?: string;
  expectedSequence: number;
  inputSha256: string;
  providerId: HostedTextProviderId;
  model: string;
  reasoningEffort?: string;
  credentialId: string;
  credentialRevision: number;
  budget: HostedTaskBudget;
  /** Latest time at which the admitted request may START, not retention. */
  expiresAt: number;
}
export interface HostedTaskTextInput {
  /** Explicitly disclosed captured text only; no image, tool, path or secret. */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}
export interface HostedTaskAdmission {
  binding: HostedTaskBinding;
  input: HostedTaskTextInput;
}
export interface HostedTaskUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd: number;
  costEstimated: boolean;
  costUnknown: boolean;
}
export interface HostedTaskSnapshot {
  binding: HostedTaskBinding;
  generation: number;
  status: HostedTaskStatus;
  sequence: number;
  resultSha256?: string;
  resultBytes: number;
  usage?: HostedTaskUsage;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
  retainedUntil: number;
}
/** Returned only by authenticated native fetch; renderer cannot attest success. */
export interface HostedTaskResult {
  snapshot: HostedTaskSnapshot;
  text: string;
}
export interface HostedWorkExecution {
  version: 1;
  binding: HostedTaskBinding;
  phase: "dispatching" | "accepted" | "stop-pending" | "reconcile-required" | "reconciled";
  /** Public status only; no token, credential value or provider request. */
  snapshot?: HostedTaskSnapshot;
}
export interface HostedProviderConnection {
  credentialId: string;
  providerId: HostedTextProviderId;
  revision: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
export interface HostedCredentialEnrollment {
  credentialId: string;
  providerId: HostedTextProviderId;
  /** Explicit replacement must advance the stored revision by exactly one. */
  revision: number;
}

/** Reject, rather than silently redact, data the exact consent cannot send. */
export function hostedTextContentFailure(content: string): string | undefined {
  if (content.includes("\0") || secretMarkerSurvives(content) || redactSecretText(content) !== content) return "hosted-secret-content";
  if (/(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|root|mnt|media|private)\/)/im.test(content)) return "hosted-local-path-content";
  return undefined;
}
export type HostedTaskCapabilityScope = "task:admit" | "task:read" | "task:cancel" | "credential:enroll" | "credential:read" | "credential:revoke";
/** Native/Convex/Worker wire only. Never display, persist, or send to a model. */
export interface HostedTaskCapability {
  version: 1;
  accountId: string;
  workspaceId: string;
  agentId: string;
  deviceId: string;
  scope: HostedTaskCapabilityScope;
  resourceId: string;
  /** Exact canonical admission/enrollment body digest; read/cancel bind target. */
  requestSha256: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}
export interface HostedTaskCapabilityReceipt {
  runnerUrl: string;
  token: string;
  expiresAt: number;
}

/** Stable cross-runtime digest; all native producers must use this key order. */
export function canonicalHostedTaskJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(canonical);
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)]));
    return entry;
  };
  return JSON.stringify(canonical(value));
}
export async function hostedTaskSha256(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalHostedTaskJson(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
}
