import { canonicalHostedTaskJson, hostedTaskSha256, hostedTextContentFailure, HOSTED_TEXT_TASK_LIMITS as L, type HostedTaskAdmission, type HostedTaskCapability, type HostedTextProviderId } from "@mivlet/protocol";
export const PROVIDERS = ["openai", "anthropic", "gemini", "xai", "deepseek"] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("invalid-task-target");
  return value;
}
export function provider(value: unknown): HostedTextProviderId {
  if (!PROVIDERS.includes(value as HostedTextProviderId)) throw new Error("hosted-api-provider-required");
  return value as HostedTextProviderId;
}
export function boundedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-task-request");
  return value as Record<string, unknown>;
}
export function exactKeys(value: object, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("invalid-task-request");
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("invalid-task-budget");
  return value;
}
export async function admission(value: unknown, capability: HostedTaskCapability, now = Date.now()): Promise<HostedTaskAdmission> {
  const input = boundedObject(value); exactKeys(input, ["binding", "input"]);
  const b = boundedObject(input.binding); const text = boundedObject(input.input);
  exactKeys(b, ["version", "taskId", "admissionId", "runId", "workspaceId", "agentId", "workId", "workGeneration", "conversationId", "conversationGeneration", "expectedSequence", "inputSha256", "providerId", "model", "credentialId", "credentialRevision", "budget", "expiresAt"], ["expectedHeadId", "reasoningEffort"]);
  for (const field of ["taskId", "admissionId", "runId", "workspaceId", "agentId", "workId", "conversationId", "credentialId"]) identifier(b[field]);
  if (b.expectedHeadId !== undefined) identifier(b.expectedHeadId);
  if (b.version !== 1 || b.workspaceId !== capability.workspaceId || b.agentId !== capability.agentId || b.taskId !== capability.resourceId) throw new Error("task-scope-mismatch");
  integer(b.workGeneration, 1, 0xffff_ffff); integer(b.conversationGeneration, 1, 0xffff_ffff); integer(b.expectedSequence, 0, Number.MAX_SAFE_INTEGER); integer(b.credentialRevision, 1, 0xffff_ffff);
  provider(b.providerId);
  if (typeof b.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(b.model)) throw new Error("invalid-task-model");
  if (b.reasoningEffort !== undefined && (typeof b.reasoningEffort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh"].includes(b.reasoningEffort))) throw new Error("invalid-task-reasoning");
  integer(b.expiresAt, now + 1, now + L.capabilityMs);
  const budget = boundedObject(b.budget); exactKeys(budget, ["maxModelCalls", "maxOutputTokens", "maxElapsedMs", "maxResultBytes"]);
  if (budget.maxModelCalls !== 1) throw new Error("invalid-task-budget");
  integer(budget.maxOutputTokens, 1, L.outputTokens); integer(budget.maxElapsedMs, 1000, L.elapsedMs); integer(budget.maxResultBytes, 1, L.resultBytes);
  exactKeys(text, ["messages"]);
  if (!Array.isArray(text.messages) || !text.messages.length || text.messages.length > 32) throw new Error("invalid-task-input");
  for (const raw of text.messages) {
    const message = boundedObject(raw); exactKeys(message, ["role", "content"]);
    if (!["system", "user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" || message.content.includes("\0")) throw new Error("hosted-text-only");
    const rejected = hostedTextContentFailure(message.content); if (rejected) throw new Error(rejected);
  }
  if (new TextEncoder().encode(canonicalHostedTaskJson(text)).length > L.inputBytes || await hostedTaskSha256(text) !== b.inputSha256 || await hostedTaskSha256(input) !== capability.requestSha256) throw new Error("task-input-mismatch");
  return value as HostedTaskAdmission;
}
export async function readJson(request: Request, maximum = L.inputBytes * 2): Promise<unknown> {
  if (!request.body) throw new Error("task-body-required");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > maximum) { await reader.cancel(); throw new Error("task-body-too-large"); } chunks.push(item.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
