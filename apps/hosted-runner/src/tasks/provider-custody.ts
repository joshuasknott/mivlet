import { DurableObject } from "cloudflare:workers";
import {
  canonicalHostedTaskJson, hostedTaskSha256, HOSTED_TEXT_TASK_LIMITS as L,
  type HostedCredentialEnrollment, type HostedProviderConnection,
  type HostedTaskBinding, type HostedTaskCapability, type HostedTaskTextInput,
} from "@mivlet/protocol";
import { ProviderFailure, runRealText, type ProviderResult } from "./provider";
import type { TaskEnv } from "./environment";

interface Credential extends HostedProviderConnection {
  workspaceId: string; agentId: string; iv: number[]; encrypted: number[];
}
interface Reservation {
  taskId: string; admissionId: string; digest: string; binding: HostedTaskBinding;
  createdAt: number; retainedUntil: number; active: boolean;
  /** Persisted BEFORE provider egress; recovery never repeats this request. */
  dispatched: boolean;
}
interface Account {
  accountId: string; credentials: Credential[]; reservations: Reservation[];
  nonces: { id: string; until: number }[]; days: { day: number; count: number }[];
}
export type CustodyResult = { ok: true; result: ProviderResult } | { ok: false; code: string; uncertain: boolean };

/** Encrypted cloud-only credentials and account quotas. No raw-key RPC exists. */
export class ProviderCustody extends DurableObject<TaskEnv> {
  private readonly running = new Map<string, AbortController>();

  async consume(cap: HostedTaskCapability): Promise<void> {
    await this.change(cap.accountId, row => {
      const now = Date.now();
      if (cap.expiresAt <= now || cap.issuedAt > now + 5000) throw new Error("task-capability-expired");
      row.nonces = row.nonces.filter(n => n.until > now);
      if (row.nonces.some(n => n.id === cap.nonce)) throw new Error("task-capability-replayed");
      if (row.nonces.length >= 256) throw new Error("task-capability-rate-limited");
      row.nonces.push({ id: cap.nonce, until: cap.expiresAt });
    });
  }

  async enroll(cap: HostedTaskCapability, metadata: HostedCredentialEnrollment, secret: string): Promise<HostedProviderConnection> {
    if (secret.length < 16 || new TextEncoder().encode(secret).length > L.credentialBytes || !/^[\x21-\x7e]+$/.test(secret)) throw new Error("invalid-hosted-api-key");
    const now = Date.now(); const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = this.aad(cap, metadata.credentialId, metadata.providerId, metadata.revision);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await this.key(), new TextEncoder().encode(secret));
    const saved = await this.change(cap.accountId, row => {
      row.credentials = row.credentials.filter(c => c.expiresAt > now);
      const prior = row.credentials.find(c => c.credentialId === metadata.credentialId);
      if (prior && (prior.workspaceId !== cap.workspaceId || prior.agentId !== cap.agentId || prior.providerId !== metadata.providerId)) throw new Error("credential-scope-mismatch");
      if (metadata.revision !== (prior?.revision ?? 0) + 1) throw new Error("credential-revision-mismatch");
      if (!prior && row.credentials.length >= L.credentialsPerAccount) throw new Error("hosted-credential-limit");
      const value: Credential = { ...metadata, workspaceId: cap.workspaceId, agentId: cap.agentId, enabled: true,
        createdAt: prior?.createdAt ?? now, updatedAt: now, expiresAt: now + L.credentialRetentionMs,
        iv: Array.from(iv), encrypted: Array.from(new Uint8Array(encrypted)) };
      row.credentials = [...row.credentials.filter(c => c.credentialId !== value.credentialId), value];
      // A replacement is also revocation of the previous in-flight key.
      return { connection: this.publicCredential(value), tasks: row.reservations.filter(r => r.binding.credentialId === value.credentialId).map(r => r.taskId) };
    });
    for (const id of saved.tasks) this.running.get(id)?.abort();
    return saved.connection;
  }

  async connections(cap: HostedTaskCapability): Promise<HostedProviderConnection[]> {
    return await this.change(cap.accountId, row => row.credentials.filter(c => c.workspaceId === cap.workspaceId && c.agentId === cap.agentId && c.expiresAt > Date.now()).map(c => this.publicCredential(c)));
  }
  async revoke(cap: HostedTaskCapability, revision: number): Promise<HostedProviderConnection> {
    const result = await this.change(cap.accountId, row => {
      const c = row.credentials.find(c => c.credentialId === cap.resourceId && c.workspaceId === cap.workspaceId && c.agentId === cap.agentId);
      if (!c || c.revision !== revision) throw new Error("credential-revision-mismatch");
      c.enabled = false; c.revision += 1; c.updatedAt = Date.now(); c.encrypted = []; c.iv = [];
      return { connection: this.publicCredential(c), tasks: row.reservations.filter(r => r.binding.credentialId === c.credentialId).map(r => r.taskId) };
    });
    for (const id of result.tasks) this.running.get(id)?.abort();
    return result.connection;
  }

  async reserve(cap: HostedTaskCapability, binding: HostedTaskBinding, digest: string): Promise<void> {
    await this.change(cap.accountId, row => {
      const now = Date.now(); this.prune(row, now);
      const prior = row.reservations.find(r => r.taskId === binding.taskId);
      if (prior) {
        if (prior.digest !== digest || prior.admissionId !== binding.admissionId) throw new Error("task-admission-conflict");
        return;
      }
      const credential = row.credentials.find(c => c.credentialId === binding.credentialId);
      this.requireCredential(credential, binding, now);
      const day = Math.floor(now / 86_400_000); const count = row.days.find(d => d.day === day);
      if ((count?.count ?? 0) >= L.admissionsPerDay || row.reservations.filter(r => r.active).length >= L.activePerAccount || row.reservations.length >= L.retainedPerAccount) throw new Error("hosted-task-quota");
      if (count) count.count++; else row.days.push({ day, count: 1 });
      row.reservations.push({ taskId: binding.taskId, admissionId: binding.admissionId, digest, binding, active: true, dispatched: false, createdAt: now, retainedUntil: now + L.retentionMs });
    });
  }

  async run(accountId: string, binding: HostedTaskBinding, input: HostedTaskTextInput, digest: string): Promise<CustodyResult> {
    let encrypted: Credential;
    try {
      if (await hostedTaskSha256(input) !== binding.inputSha256) throw new Error("task-input-mismatch");
      encrypted = await this.change(accountId, row => {
        const r = row.reservations.find(r => r.taskId === binding.taskId && r.digest === digest);
        if (!r || !r.active || r.dispatched || canonicalHostedTaskJson(r.binding) !== canonicalHostedTaskJson(binding) || r.retainedUntil <= Date.now() || binding.expiresAt <= Date.now()) throw new Error("hosted-dispatch-not-current");
        const c = row.credentials.find(c => c.credentialId === binding.credentialId);
        this.requireCredential(c, binding, Date.now());
        r.dispatched = true;
        return c!;
      });
    } catch { return { ok: false, code: "hosted-dispatch-not-current", uncertain: true }; }
    const controller = new AbortController(); this.running.set(binding.taskId, controller);
    const timer = setTimeout(() => controller.abort(), binding.budget.maxElapsedMs);
    let secret = "";
    try {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(encrypted.iv), additionalData: this.aad({ accountId, workspaceId: binding.workspaceId, agentId: binding.agentId }, encrypted.credentialId, encrypted.providerId, encrypted.revision) }, await this.key(), new Uint8Array(encrypted.encrypted));
      const bytes = new Uint8Array(plaintext);
      try { secret = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } finally { bytes.fill(0); }
      // Recheck revocation/cancel after decryption and before the one send.
      await this.change(accountId, row => {
        const r = row.reservations.find(r => r.taskId === binding.taskId && r.digest === digest);
        this.requireCredential(row.credentials.find(c => c.credentialId === binding.credentialId), binding, Date.now());
        if (!r?.active || controller.signal.aborted || binding.expiresAt <= Date.now()) throw new Error("hosted-dispatch-not-current");
      });
      const result = await runRealText(binding, input, secret, controller.signal);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, code: error instanceof ProviderFailure ? error.code : "hosted-dispatch-outcome-uncertain", uncertain: !(error instanceof ProviderFailure) || error.uncertain };
    } finally {
      secret = ""; clearTimeout(timer);
      if (this.running.get(binding.taskId) === controller) this.running.delete(binding.taskId);
    }
  }

  async release(accountId: string, taskId: string, digest: string): Promise<void> {
    await this.change(accountId, row => {
      const r = row.reservations.find(r => r.taskId === taskId && r.digest === digest);
      if (!r) throw new Error("task-reservation-missing"); r.active = false;
    });
    this.running.get(taskId)?.abort();
  }

  async alarm(): Promise<void> {
    const row = await this.ctx.storage.get<Account>("account"); if (!row) return;
    await this.change(row.accountId, value => this.prune(value, Date.now()));
  }
  private prune(row: Account, now: number): void {
    row.credentials = row.credentials.filter(c => c.expiresAt > now);
    row.reservations = row.reservations.filter(r => r.retainedUntil > now);
    row.nonces = row.nonces.filter(n => n.until > now);
    row.days = row.days.filter(d => d.day >= Math.floor(now / 86_400_000) - 1);
  }
  private async change<T>(accountId: string, update: (row: Account) => T): Promise<T> {
    return await this.ctx.storage.transaction(async tx => {
      const row = await tx.get<Account>("account") ?? { accountId, credentials: [], reservations: [], nonces: [], days: [] };
      if (row.accountId !== accountId) throw new Error("task-account-mismatch");
      const result = update(row); await tx.put("account", row);
      const next = [...row.credentials.map(c => c.expiresAt), ...row.reservations.map(r => r.retainedUntil), ...row.nonces.map(n => n.until)];
      if (next.length) await tx.setAlarm(Math.max(Date.now() + 1000, Math.min(...next))); else await tx.deleteAlarm();
      return result;
    });
  }
  private requireCredential(c: Credential | undefined, b: HostedTaskBinding, now: number): void {
    if (!c || !c.enabled || c.workspaceId !== b.workspaceId || c.agentId !== b.agentId || c.providerId !== b.providerId || c.revision !== b.credentialRevision || c.expiresAt <= now) throw new Error("hosted-provider-connection-required");
  }
  private publicCredential(c: Credential): HostedProviderConnection {
    const { credentialId, providerId, revision, enabled, createdAt, updatedAt, expiresAt } = c;
    return { credentialId, providerId, revision, enabled, createdAt, updatedAt, expiresAt };
  }
  private aad(scope: Pick<HostedTaskCapability, "accountId" | "workspaceId" | "agentId">, credentialId: string, providerId: string, revision: number): ArrayBuffer {
    return new TextEncoder().encode(canonicalHostedTaskJson({ accountId: scope.accountId, workspaceId: scope.workspaceId, agentId: scope.agentId, credentialId, providerId, revision })).buffer;
  }
  private async key(): Promise<CryptoKey> {
    const secret = this.env.MIVLET_HOSTED_TASK_ENCRYPTION_KEY;
    if (!secret || secret.length < 32 || secret === this.env.MIVLET_HOSTED_TASK_SIGNING_KEY) throw new Error("task-custody-configuration-required");
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mivlet-cloud-provider-custody:v1:${secret}`));
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
}
