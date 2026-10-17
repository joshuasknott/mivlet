import { DurableObject } from "cloudflare:workers";
import {
  hostedTaskSha256, HOSTED_TEXT_TASK_LIMITS as L,
  type HostedTaskAdmission, type HostedTaskCapability, type HostedTaskResult,
  type HostedTaskSnapshot, type HostedTaskStatus,
} from "@mivlet/protocol";
import type { TaskEnv } from "./environment";

interface StoredTask {
  accountId: string; digest: string; admission?: HostedTaskAdmission;
  snapshot: HostedTaskSnapshot; text?: string; attemptNonce?: string;
}
const terminal = (status: HostedTaskStatus) => status !== "queued" && status !== "running";

/** One immutable admission, one possible provider send, monotonic cancellation. */
export class TaskAuthority extends DurableObject<TaskEnv> {
  async admit(cap: HostedTaskCapability, value: HostedTaskAdmission): Promise<HostedTaskSnapshot> {
    const digest = await hostedTaskSha256(value); const now = Date.now();
    return await this.ctx.storage.transaction(async tx => {
      const existing = await tx.get<StoredTask>("task");
      if (existing) {
        this.owner(existing, cap);
        if (existing.digest !== digest) throw new Error("task-admission-conflict");
        return existing.snapshot;
      }
      if (value.binding.expiresAt <= now) throw new Error("task-admission-expired");
      const snapshot: HostedTaskSnapshot = { binding: value.binding, generation: 1, status: "queued", sequence: 1,
        resultBytes: 0, createdAt: now, updatedAt: now, retainedUntil: now + L.retentionMs };
      await tx.put("task", { accountId: cap.accountId, digest, admission: value, snapshot } satisfies StoredTask);
      await tx.setAlarm(now + 1);
      return snapshot;
    });
  }

  async read(cap: HostedTaskCapability): Promise<HostedTaskResult> {
    const row = await this.ctx.storage.get<StoredTask>("task");
    if (!row) throw new Error("task-not-found"); this.owner(row, cap);
    if (row.snapshot.retainedUntil <= Date.now()) { await this.expire(); const expired = await this.ctx.storage.get<StoredTask>("task"); return { snapshot: expired!.snapshot, text: "" }; }
    return { snapshot: row.snapshot, text: row.snapshot.status === "completed" ? row.text ?? "" : "" };
  }

  async cancel(cap: HostedTaskCapability, generation: number): Promise<HostedTaskSnapshot> {
    const cancelled = await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
      if (row.snapshot.generation !== generation) throw new Error("task-generation-mismatch");
      if (row.snapshot.status !== "cancelled" && row.snapshot.status !== "expired") {
        row.snapshot = { ...row.snapshot, generation: row.snapshot.generation + 1, status: "cancelled", sequence: row.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: 0 };
        delete row.text; delete row.admission; delete row.attemptNonce;
        await tx.put("task", row); await tx.setAlarm(row.snapshot.retainedUntil);
      }
      return row;
    });
    // The durable generation is already advanced before a remote abort. If
    // the abort RPC fails, native sees stop-pending and must read/reconcile.
    await this.env.PROVIDER_CUSTODY.getByName(cancelled.accountId).release(cancelled.accountId, cancelled.snapshot.binding.taskId, cancelled.digest);
    return cancelled.snapshot;
  }

  async alarm(): Promise<void> {
    const now = Date.now(); const nonce = crypto.randomUUID();
    const start = await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row) return undefined;
      if (row.snapshot.retainedUntil <= now) return { expire: true as const, row };
      if (terminal(row.snapshot.status)) { await tx.setAlarm(row.snapshot.retainedUntil); return undefined; }
      if (row.snapshot.status === "running") {
        // A recovered alarm has no proof of what the old provider accepted.
        // Never replay that possibly billed send, even if its text was lost.
        row.snapshot = { ...row.snapshot, generation: row.snapshot.generation + 1, status: "uncertain", errorCode: "hosted-dispatch-outcome-uncertain", sequence: row.snapshot.sequence + 1, updatedAt: now };
        delete row.admission; delete row.attemptNonce;
        await tx.put("task", row); await tx.setAlarm(row.snapshot.retainedUntil); return undefined;
      }
      if (!row.admission || row.snapshot.binding.expiresAt <= now) {
        row.snapshot = { ...row.snapshot, status: "expired", errorCode: "task-admission-expired", sequence: row.snapshot.sequence + 1, updatedAt: now };
        delete row.admission; await tx.put("task", row); await tx.setAlarm(row.snapshot.retainedUntil);
        return { release: true as const, row };
      }
      row.snapshot = { ...row.snapshot, status: "running", sequence: row.snapshot.sequence + 1, updatedAt: now };
      row.attemptNonce = nonce;
      await tx.put("task", row);
      await tx.setAlarm(now + row.snapshot.binding.budget.maxElapsedMs + 1000);
      return { run: true as const, row };
    });
    if (!start) return;
    if ("expire" in start) { await this.expire(); return; }
    const custody = this.env.PROVIDER_CUSTODY.getByName(start.row.accountId);
    if ("release" in start) { await custody.release(start.row.accountId, start.row.snapshot.binding.taskId, start.row.digest); return; }
    const row = start.row;
    try {
      const result = await custody.run(row.accountId, row.snapshot.binding, row.admission!.input, row.digest);
      const bytes = result.ok ? new TextEncoder().encode(result.result.text) : undefined;
      const resultSha256 = bytes ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("") : undefined;
      const settled = await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<StoredTask>("task");
        if (!current || current.snapshot.status !== "running" || current.snapshot.generation !== row.snapshot.generation || current.attemptNonce !== nonce) return false;
        const valid = result.ok && bytes!.length <= current.snapshot.binding.budget.maxResultBytes;
        current.snapshot = { ...current.snapshot, status: valid ? "completed" : result.ok || result.uncertain ? "uncertain" : "failed",
          sequence: current.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: valid ? bytes!.length : 0,
          ...(valid ? { resultSha256, usage: result.ok ? result.result.usage : undefined } : { errorCode: result.ok ? "hosted-result-limit" : result.code }) };
        if (valid && result.ok) current.text = result.result.text;
        delete current.admission; delete current.attemptNonce;
        await tx.put("task", current); await tx.setAlarm(current.snapshot.retainedUntil);
        return current.snapshot.status !== "uncertain";
      });
      if (settled) await custody.release(row.accountId, row.snapshot.binding.taskId, row.digest);
    } catch {
      // Durable watchdog will turn running into uncertain. A provider effect
      // might have happened, so a failed RPC is never a retry invitation.
    }
  }

  private owner(row: StoredTask, cap: HostedTaskCapability): void {
    const b = row.snapshot.binding;
    if (row.accountId !== cap.accountId || b.workspaceId !== cap.workspaceId || b.agentId !== cap.agentId || b.taskId !== cap.resourceId) throw new Error("task-scope-mismatch");
  }
  private async expire(): Promise<void> {
    const expired = await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row || row.snapshot.retainedUntil > Date.now()) return undefined;
      row.snapshot = { ...row.snapshot, generation: row.snapshot.generation + 1, status: "expired", sequence: row.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: 0 };
      delete row.snapshot.resultSha256; delete row.snapshot.usage;
      delete row.admission; delete row.text; delete row.attemptNonce;
      await tx.put("task", row); await tx.deleteAlarm(); return row;
    });
    if (expired) await this.env.PROVIDER_CUSTODY.getByName(expired.accountId).release(expired.accountId, expired.snapshot.binding.taskId, expired.digest).catch(() => undefined);
  }
}
