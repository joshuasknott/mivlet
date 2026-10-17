import { DurableObject } from "cloudflare:workers";
import {
  hostedTaskSha256, HOSTED_TEXT_TASK_LIMITS as L,
  type HostedTaskAdmission, type HostedTaskCapability, type HostedTaskResult,
  type HostedTaskSnapshot, type HostedTaskStatus,
  type HostedCodingTaskBinding, type HostedCodingChunk, type HostedCodingOutputRead,
  type HostedRepositoryFile, type HostedCodingProgress,
} from "@mivlet/protocol";
import type { TaskEnv } from "./environment";
import { CodingFiles } from "./coding-custody";
import { codingJournal, codingState, type CodingState, type CodingStep } from "./coding-journal";

interface StoredTask {
  accountId: string; digest: string; admission?: HostedTaskAdmission;
  snapshot: HostedTaskSnapshot; text?: string; attemptNonce?: string; purgeAt?: number;
  deviceId?: string; transfers?: HostedTaskCapability[];
}
const terminal = (status: HostedTaskStatus) => status !== "queued" && status !== "running";

/** Immutable mode-specific admission, dispatch journal and monotonic Stop. */
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
      if (value.binding.expiresAt <= Date.now()) throw new Error("task-admission-expired");
      const snapshot: HostedTaskSnapshot = { binding: value.binding, generation: 1, status: "queued", sequence: 1,
        resultBytes: 0, createdAt: now, updatedAt: now, retainedUntil: now + L.retentionMs };
      await tx.put("task", { accountId: cap.accountId, deviceId: cap.deviceId, digest, admission: value, snapshot } satisfies StoredTask);
      await tx.setAlarm(value.binding.version === 3 ? value.binding.expiresAt : now + 1);
      return snapshot;
    });
  }

  async read(cap: HostedTaskCapability): Promise<HostedTaskResult> {
    const row = await this.ctx.storage.get<StoredTask>("task");
    if (!row) throw new Error("task-not-found"); this.owner(row, cap);
    if (row.snapshot.retainedUntil <= Date.now()) { await this.expire(); const expired = await this.ctx.storage.get<StoredTask>("task"); if (!expired) throw new Error("task-not-found"); return { snapshot: expired.snapshot, text: "" }; }
    return { snapshot: row.snapshot, text: ["completed", "needs-review"].includes(row.snapshot.status) ? row.text ?? "" : "" };
  }

  async transfer(cap: HostedTaskCapability, consumed: boolean): Promise<boolean> {
    return await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
      if (row.snapshot.binding.version !== 3 || row.deviceId !== cap.deviceId || cap.expiresAt <= Date.now() || row.snapshot.retainedUntil <= Date.now() || !["task:input", "task:output"].includes(cap.scope)) throw new Error("task-scope-mismatch");
      if (cap.scope === "task:input" ? row.snapshot.status !== "queued" : !["completed", "needs-review"].includes(row.snapshot.status)) throw new Error("coding-task-not-current");
      row.transfers = (row.transfers ?? []).filter(value => value.expiresAt > Date.now());
      const prior = row.transfers.find(value => value.nonce === cap.nonce);
      if (prior) { if (await hostedTaskSha256(prior) !== await hostedTaskSha256(cap)) throw new Error("task-scope-mismatch"); return true; }
      if (!consumed) return false;
      if (row.transfers.length >= 8) throw new Error("task-capability-rate-limited");
      row.transfers.push(cap); await tx.put("task", row); return true;
    });
  }
  async inputChunk(cap: HostedTaskCapability, value: HostedCodingChunk, manifest: unknown): Promise<void> {
    const row = await this.ctx.storage.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
    if (row.snapshot.binding.version !== 3 || row.snapshot.binding.repository.snapshot.manifestSha256 !== manifest) throw new Error("invalid-coding-manifest");
    await this.files(cap.accountId, row.digest, ["queued"]).putInput(value);
  }
  async sealInput(cap: HostedTaskCapability, snapshotId: unknown, manifest: unknown): Promise<HostedTaskSnapshot> {
    const row = await this.ctx.storage.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
    if (row.snapshot.binding.version !== 3 || row.snapshot.binding.repository.snapshot.manifestSha256 !== manifest || row.snapshot.binding.repository.snapshot.snapshotId !== snapshotId) throw new Error("invalid-coding-manifest");
    await this.files(cap.accountId, row.digest, ["queued"]).sealInput();
    return await this.ctx.storage.transaction(async tx => { const current = await tx.get<StoredTask>("task"); this.codingOwner(current, cap.accountId, row.digest, ["queued"]); await tx.setAlarm(Date.now() + 1); return current!.snapshot; });
  }
  async outputChunk(cap: HostedTaskCapability, value: HostedCodingOutputRead) {
    const row = await this.ctx.storage.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
    return await this.files(cap.accountId, row.digest, ["completed", "needs-review"]).outputChunk(value);
  }
  // Internal RPCs are reachable only through the same private Worker binding.
  // Each operation checks durable task identity/status before touching bytes.
  async codingManifest(account: string, digest: string) { return await this.files(account, digest).manifest(); }
  async codingBytes(account: string, digest: string, file: HostedRepositoryFile) {
    const files = this.files(account, digest); const manifest = await files.manifest(); const current = manifest.find(entry => entry.path === file.path && entry.sha256 === file.sha256 && entry.sizeBytes === file.sizeBytes);
    if (!current) throw new Error("coding-candidate-changed"); return await files.currentBytes(current);
  }
  async codingRead(account: string, digest: string, path: string, offset: number, length: number) { return await this.files(account, digest).read(path, offset, length); }
  async codingWrite(account: string, digest: string, path: string, expected: string | null, content: string | null) { return await this.files(account, digest).write(path, expected, content); }
  async codingSealOutput(account: string, digest: string) { return await this.files(account, digest).sealOutput(); }
  async codingStartStep(account: string, digest: string, kind: CodingStep["kind"], hash: string, tokens = 0) { return await this.journal(account, digest).then(journal => journal.start(kind, hash, tokens)); }
  async codingFinishStep(account: string, digest: string, id: string, hash: string, check?: HostedCodingProgress["completedChecks"][number]) { await (await this.journal(account, digest)).finish(id, hash, check); }
  async codingProgress(account: string, digest: string) { return await (await this.journal(account, digest)).progress(); }

  async cancel(cap: HostedTaskCapability, generation: number): Promise<HostedTaskSnapshot> {
    const cancelled = await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row) throw new Error("task-not-found"); this.owner(row, cap);
      if (row.snapshot.generation !== generation) throw new Error("task-generation-mismatch");
      if (row.snapshot.status !== "cancelled" && row.snapshot.status !== "expired") {
        row.snapshot = { ...row.snapshot, generation: row.snapshot.generation + 1, status: "cancelled", sequence: row.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: 0 };
        delete row.text; delete row.admission; delete row.attemptNonce;
        delete row.snapshot.resultSha256; delete row.snapshot.usage;
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
      if (row.purgeAt !== undefined && row.purgeAt <= now) return { purge: true as const, row };
      if (row.snapshot.status === "expired" && row.purgeAt !== undefined) { await tx.setAlarm(row.purgeAt); return undefined; }
      if (row.snapshot.retainedUntil <= now) return { expire: true as const, row };
      if (terminal(row.snapshot.status)) { await tx.setAlarm(row.snapshot.retainedUntil); return undefined; }
      if (row.snapshot.binding.version === 3 && !await tx.get("code:sealed") && row.snapshot.binding.expiresAt > now) { await tx.setAlarm(row.snapshot.binding.expiresAt); return undefined; }
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
      if (row.snapshot.binding.version === 3) await tx.put("code:journal", codingState(row.snapshot.binding.budget.maxElapsedMs));
      await tx.put("task", row);
      await tx.setAlarm(now + row.snapshot.binding.budget.maxElapsedMs + 1000);
      return { run: true as const, row };
    });
    if (!start) return;
    if ("purge" in start) {
      // SQLite DO deleteAll also reclaims its storage/billing metadata. Hold
      // only this small storage critical section, then re-read so a concurrent
      // admission/read cannot be erased by a stale purge decision.
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.ctx.storage.get<StoredTask>("task");
        if (current?.purgeAt !== undefined && current.purgeAt <= Date.now()) {
          await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll();
        }
      });
      return;
    }
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
        const valid = result.ok && bytes!.length <= current.snapshot.binding.budget.maxResultBytes
          && (current.snapshot.binding.version !== 3 || !!result.result.coding);
        current.snapshot = { ...current.snapshot, status: valid ? result.ok && result.result.coding?.proposal ? "needs-review" : "completed" : result.ok || result.uncertain ? "uncertain" : "failed",
          sequence: current.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: valid ? bytes!.length : 0,
          ...(valid ? { resultSha256, usage: result.ok ? result.result.usage : undefined } : { errorCode: result.ok ? "hosted-result-limit" : result.code }) };
        if (valid && result.ok && result.result.research) current.snapshot.research = result.result.research;
        if (valid && result.ok && result.result.coding) current.snapshot.coding = result.result.coding;
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
  private codingOwner(row: StoredTask | undefined, account: string, digest: string, statuses: HostedTaskStatus[]): HostedCodingTaskBinding {
    if (!row || row.accountId !== account || row.digest !== digest || row.snapshot.binding.version !== 3 || !statuses.includes(row.snapshot.status)
      || row.snapshot.retainedUntil <= Date.now() || (row.snapshot.status === "queued" && row.snapshot.binding.expiresAt <= Date.now())) throw new Error("coding-task-not-current");
    return row.snapshot.binding;
  }
  private files(account: string, digest: string, statuses: HostedTaskStatus[] = ["running"]): CodingFiles {
    return new CodingFiles(this.ctx.storage, async tx => this.codingOwner(await tx.get<StoredTask>("task"), account, digest, statuses));
  }
  private async journal(account: string, digest: string) {
    const binding = this.codingOwner(await this.ctx.storage.get<StoredTask>("task"), account, digest, ["running"]);
    return codingJournal(binding, operation => this.ctx.storage.transaction(async tx => {
      this.codingOwner(await tx.get<StoredTask>("task"), account, digest, ["running"]);
      const state = await tx.get<CodingState>("code:journal"); if (!state) throw new Error("coding-step-not-current");
      const value = operation(state); await tx.put("code:journal", state); return value;
    }));
  }
  private async expire(): Promise<void> {
    // Research bindings and source receipts contain public URL/query data,
    // which may derive from the disclosed task. Do not retain them as a text
    // mode's seven-day hash-only tombstone after their 24-hour disclosure.
    const candidate = await this.ctx.storage.get<StoredTask>("task");
    if (candidate && candidate.snapshot.binding.version !== 1 && candidate.snapshot.retainedUntil <= Date.now()) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.ctx.storage.get<StoredTask>("task");
        if (current?.digest === candidate.digest && current.snapshot.retainedUntil <= Date.now()) {
          await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll();
        }
      });
      await this.env.PROVIDER_CUSTODY.getByName(candidate.accountId).release(candidate.accountId, candidate.snapshot.binding.taskId, candidate.digest).catch(() => undefined);
      return;
    }
    const expired = await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<StoredTask>("task"); if (!row || row.snapshot.retainedUntil > Date.now()) return undefined;
      if (row.purgeAt !== undefined) return undefined;
      row.snapshot = { ...row.snapshot, generation: row.snapshot.generation + 1, status: "expired", sequence: row.snapshot.sequence + 1, updatedAt: Date.now(), resultBytes: 0 };
      delete row.snapshot.resultSha256; delete row.snapshot.usage;
      delete row.admission; delete row.text; delete row.attemptNonce;
      row.purgeAt = Date.now() + L.receiptRetentionMs;
      await tx.put("task", row); await tx.setAlarm(row.purgeAt); return row;
    });
    if (expired) await this.env.PROVIDER_CUSTODY.getByName(expired.accountId).release(expired.accountId, expired.snapshot.binding.taskId, expired.digest).catch(() => undefined);
  }
}
