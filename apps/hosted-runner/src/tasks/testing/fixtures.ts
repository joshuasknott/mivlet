import type { HostedTaskAdmission, HostedTaskCapability } from "@mivlet/protocol";

export function taskFixture(now = Date.now()): HostedTaskAdmission {
  return { binding: { version: 1, taskId: "task-unit", admissionId: "admission-unit", runId: "run-unit", workspaceId: "workspace-unit", agentId: "agent-unit", workId: "work-unit", workGeneration: 2, conversationId: "conversation-unit", conversationGeneration: 2, expectedSequence: 1, inputSha256: "0".repeat(64), providerId: "openai", model: "gpt-4.1-mini", credentialId: "credential-unit", credentialRevision: 1,
    budget: { maxModelCalls: 1, maxOutputTokens: 100, maxElapsedMs: 1000, maxResultBytes: 1024 }, expiresAt: now + 60_000 }, input: { messages: [{ role: "user", content: "Explain the seasons in one sentence." }] } };
}
export function capabilityFixture(now = Date.now()): HostedTaskCapability {
  return { version: 1, accountId: "account-unit", workspaceId: "workspace-unit", agentId: "agent-unit", deviceId: "device-unit", scope: "task:admit", resourceId: "task-unit", requestSha256: "0".repeat(64), issuedAt: now, expiresAt: now + 60_000, nonce: "nonce-unit" };
}

/** Test-only DO storage, not part of the task Worker entry graph. */
export class MemoryTaskStorage {
  readonly values = new Map<string, unknown>(); alarmAt?: number;
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async setAlarm(at: number): Promise<void> { this.alarmAt = at; }
  async deleteAlarm(): Promise<void> { this.alarmAt = undefined; }
  async transaction<T>(fn: (tx: MemoryTaskStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values); const alarm = this.alarmAt;
    try { return await fn(this); } catch (error) { this.values.clear(); for (const [k, v] of before) this.values.set(k, v); this.alarmAt = alarm; throw error; }
  }
  context(): DurableObjectState { return { storage: this, blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => await fn() } as unknown as DurableObjectState; }
}
