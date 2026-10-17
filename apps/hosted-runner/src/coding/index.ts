import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox, Sandbox, type ExecOptions, type SandboxCommand } from "@cloudflare/sandbox";
import { hostedTaskSha256, validateHostedCodingScope, HOSTED_CODING_IMAGE, HOSTED_CODING_LIMITS as L } from "@mivlet/protocol";
import { byteSha256, codingEntries, codingSource, hex, utf8 } from "../tasks/coding-contracts";
import type { CodingCheckResult, CodingCheckStart, CodingRuntimeBinding } from "../tasks/coding-runtime-contract";
import { NETWORK_PROBE, CHILD_ISOLATION_PROBE, RUN_CHECK } from "./scripts";

interface CodingEnv extends HostedCodingBindings {}
// This is fixed before any start. There are deliberately no allowed hosts,
// outbound handlers, mounts, exposed ports or provider/account secrets.
export class OfflineCodingSandbox extends Sandbox<CodingEnv> {
  enableInternet = false;
  private async admitted<T>(effect: () => Promise<T>): Promise<T> {
    // SDK file/process operations may wake a stopped runtime. Serialize these
    // admitted operations with the permanent retirement bit so a delayed file
    // stage cannot recreate an already-cancelled scratch container.
    return await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get("scratch-retired")) throw new Error("coding-lease-retired");
      return await effect();
    });
  }
  override async mkdir(path: string, options?: { recursive?: boolean }) { return await this.admitted(() => super.mkdir(path, options)); }
  override async writeFile(path: string, content: string | ReadableStream<Uint8Array>, options?: { encoding?: string }) { return await this.admitted(() => super.writeFile(path, content, options)); }
  override async exec(command: SandboxCommand, options?: ExecOptions) { return await this.admitted(() => super.exec(command, options)); }
  async retire(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => { if (!await this.ctx.storage.get("scratch-retired")) await this.ctx.storage.put("scratch-retired", Date.now() + 24 * 60 * 60_000); });
    try { await super.destroy(); } finally { await this.ctx.storage.setAlarm(Date.now() + 1000); }
  }
  override async alarm(props?: AlarmInvocationInfo): Promise<void> {
    const retired = await this.ctx.storage.get<number>("scratch-retired");
    if (retired !== undefined) {
      await super.destroy();
      if (retired <= Date.now()) await this.ctx.blockConcurrencyWhile(async () => { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); });
      else await this.ctx.storage.setAlarm(retired);
      return;
    }
    await super.alarm(props);
  }
}
/** Trusted fixed positive-control code only; never receives project input. */
export class CodingNetworkBaseline extends OfflineCodingSandbox { enableInternet = true; }
interface Lease { value: CodingCheckStart; phase: "staging" | "dispatching" | "finished" | "cancelled"; received: string[] }
interface Probe { nonce: string; deadline: number }
const leaseId = (value: string) => { if (!hex(value, 48)) throw new Error("invalid-coding-lease"); return value; };
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  if (milliseconds <= 0) throw new Error("coding-deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("coding-runtime-timeout")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** Private named entrypoint. Public fetch has no runtime/control route. */
export class CodingRuntime extends WorkerEntrypoint<CodingEnv> implements CodingRuntimeBinding {
  async prerequisites(image: string) {
    if (image !== HOSTED_CODING_IMAGE) throw new Error("coding-image-mismatch");
    return await this.env.CODING_AUTHORITY.getByName("fixed-network-proof-v2").prove();
  }
  async begin(value: CodingCheckStart) { await this.env.CODING_AUTHORITY.getByName(leaseId(value.leaseId)).begin(value); }
  async file(id: string, path: string, content: string) { await this.env.CODING_AUTHORITY.getByName(leaseId(id)).file(path, content); }
  async run(id: string, checkId: string) { return await this.env.CODING_AUTHORITY.getByName(leaseId(id)).run(checkId); }
  async cancel(id: string) { await this.env.CODING_AUTHORITY.getByName(leaseId(id)).cancel(); }
}

export class CodingAuthority extends DurableObject<CodingEnv> {
  private sandbox(id: string) { return getSandbox(this.env.OFFLINE_CODING, `scratch-${id}`, { keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 10_000, portReadyTimeoutMS: 10_000 } }); }
  async prove() {
    const receipt = { image: HOSTED_CODING_IMAGE, network: "disabled" as const, proof: "positive-and-negative-v1" as const, processIsolation: "uid-seccomp-v1" as const };
    const nonce = crypto.randomUUID();
    const cached = await this.ctx.storage.transaction(async tx => {
      const prior = await tx.get<{ image: string; until: number; processIsolation?: string }>("proof");
      if (await tx.get("probe")) throw new Error("coding-network-proof-in-progress");
      if (prior?.image === HOSTED_CODING_IMAGE && prior.processIsolation === receipt.processIsolation && prior.until > Date.now()) return true;
      await tx.put("probe", { nonce, deadline: Date.now() + L.elapsedMs } satisfies Probe);
      await tx.setAlarm(Date.now() + L.elapsedMs); return false;
    });
    if (cached) return receipt;
      const options = { keepAlive: false, containerTimeouts: { instanceGetTimeoutMS: 10_000, portReadyTimeoutMS: 10_000 } };
      const baseline = getSandbox(this.env.CODING_NETWORK_BASELINE, `fixed-baseline-${nonce}`, options);
      const offline = getSandbox(this.env.OFFLINE_CODING, `fixed-denial-${nonce}`, options);
      // No files or model data reach either probe. An unavailable positive
      // control is an unmet prerequisite, never evidence of isolation.
      try {
        const observe = async (sandbox: typeof baseline) => {
          const process = await bounded(sandbox.exec(["/usr/bin/python3", "-I", "-c", NETWORK_PROBE], { timeout: 15_000 }), 25_000);
          const output = await process.output({ encoding: "utf8", maxBytes: 2048, timeout: 16_000 });
          if (output.exitCode !== 0 || output.timedOut || output.truncated) throw new Error("coding-network-proof-required");
          const result = JSON.parse(output.stdout) as Record<string, unknown>;
          if (Object.keys(result).sort().join(",") !== "http,https,privateTcp,resolverDns,udpDns" || Object.values(result).some(value => typeof value !== "boolean")) throw new Error("coding-network-proof-required");
          return result;
        };
        const positive = await observe(baseline);
        if (!positive.http || !positive.https || !positive.udpDns || !positive.resolverDns) throw new Error("coding-network-positive-control-unavailable");
        const negative = await observe(offline);
        if (Object.values(negative).some(value => value !== false)) throw new Error("coding-network-proof-required");
        const child = await bounded(offline.exec(["/usr/bin/python3", "-I", "-c", CHILD_ISOLATION_PROBE], { timeout: 12_000 }), 15_000);
        const childOutput = await child.output({ encoding: "utf8", maxBytes: 2048, timeout: 13_000 });
        if (childOutput.exitCode !== 0 || childOutput.timedOut || childOutput.truncated) throw new Error("coding-process-isolation-required");
        const isolation = JSON.parse(childOutput.stdout);
        if (isolation.loopbackControlBaseline !== true || isolation.unixControlBaseline !== true || isolation.uidSeccomp !== receipt.processIsolation) throw new Error("coding-process-isolation-required");
      } finally {
        // Cleanup is part of the prerequisite. Failed teardown cannot issue a
        // successful proof or silently leave internet-enabled resources live.
        try { await bounded(Promise.all([baseline.retire(), offline.retire()]), 15_000); }
        catch (error) { await this.ctx.storage.setAlarm(Date.now() + 1000); throw error; }
      }
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<Probe>("probe");
        if (current?.nonce !== nonce || current.deadline <= Date.now()) throw new Error("coding-network-proof-required");
        await tx.put("proof", { image: HOSTED_CODING_IMAGE, processIsolation: receipt.processIsolation, until: Date.now() + 8 * 60 * 60_000 });
        await tx.delete("probe"); await tx.deleteAlarm();
      });
      return receipt;
  }
  async begin(value: CodingCheckStart): Promise<void> {
    leaseId(value.leaseId);
    validateHostedCodingScope(value.scope);
    codingEntries(value.files, value.files.reduce((sum, file) => sum + file.sizeBytes, 0));
    if (!hex(value.taskSha256) || !hex(value.candidateSha256) || value.candidateSha256 !== await hostedTaskSha256(value.files)
      || typeof value.stepId !== "string" || value.stepId.length > 200 || !Number.isSafeInteger(value.deadline)
      || value.deadline <= Date.now() || value.deadline > Date.now() + L.elapsedMs) throw new Error("invalid-coding-lease");
    await this.ctx.storage.transaction(async tx => {
      // An uncertain begin/run is never replayed, even with identical input.
      if (await tx.get("lease") || await tx.get("retired")) throw new Error("coding-lease-already-used");
      await tx.put("lease", { value, phase: "staging", received: [] } satisfies Lease);
      await tx.setAlarm(value.deadline);
    });
  }
  async file(path: string, content: string): Promise<void> {
    const lease = await this.current("staging"); const file = lease.value.files.find(file => file.path === path);
    const bytes = utf8.encode(content);
    if (!file || bytes.length !== file.sizeBytes || await byteSha256(bytes) !== file.sha256 || codingSource(bytes) !== content) throw new Error("coding-file-hash-mismatch");
    const sandbox = this.sandbox(lease.value.leaseId);
    const slash = path.lastIndexOf("/"); const parent = slash < 0 ? "" : path.slice(0, slash);
    await this.current("staging");
    await bounded(sandbox.mkdir(`/workspace/task${parent ? `/${parent}` : ""}`, { recursive: true }), lease.value.deadline - Date.now());
    await this.current("staging");
    await bounded(sandbox.writeFile(`/workspace/task/${path}`, content), lease.value.deadline - Date.now());
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Lease>("lease"); this.same(current, lease, "staging");
      if (!current!.received.includes(path)) current!.received.push(path);
      await tx.put("lease", current!);
    });
  }
  async run(checkId: string): Promise<CodingCheckResult> {
    const lease = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Lease>("lease");
      if (!current || current.phase !== "staging" || current.value.deadline <= Date.now()
        || current.received.length !== current.value.files.length || !current.value.scope.checks.some(check => check.id === checkId)) throw new Error("coding-check-not-current");
      current.phase = "dispatching"; await tx.put("lease", current); return current;
    });
    const sandbox = this.sandbox(lease.value.leaseId);
    try {
      await this.current("dispatching");
      // Exact argv is staged separately, so SDK process-command/error logs
      // contain only the fixed wrapper, never task arguments or project bytes.
      await bounded(sandbox.mkdir("/workspace/task", { recursive: true }), lease.value.deadline - Date.now());
      await this.current("dispatching");
      const duration = Math.min(L.checkMs, lease.value.deadline - Date.now());
      const check = lease.value.scope.checks.find(check => check.id === checkId)!;
      await bounded(sandbox.writeFile("/workspace/.mivlet-check.json", JSON.stringify({ argv: check.argv, seconds: duration / 1000 })), lease.value.deadline - Date.now());
      await this.current("dispatching");
      const process = await bounded(sandbox.exec(["/usr/bin/python3", "-I", "-c", RUN_CHECK], { timeout: duration + 2000 }), duration + 2000);
      await this.current("dispatching");
      const output = await bounded(process.output({ encoding: "utf8", maxBytes: 64 * 1024, timeout: duration + 1000 }), lease.value.deadline - Date.now());
      if (output.exitCode !== 0 || output.timedOut || output.truncated) throw new Error("coding-check-outcome-uncertain");
      const result = JSON.parse(output.stdout) as Omit<CodingCheckResult, "leaseId" | "stepId" | "candidateSha256" | "id">;
      if (Object.keys(result).sort().join(",") !== "exitCode,stderr,stdout,timedOut,truncated" || !Number.isSafeInteger(result.exitCode)
        || typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.truncated !== "boolean" || typeof result.timedOut !== "boolean"
        || utf8.encode(result.stdout + result.stderr).length > L.toolOutputBytes * 3) throw new Error("coding-check-outcome-uncertain");
      await this.ctx.storage.transaction(async tx => {
        const current = await tx.get<Lease>("lease"); this.same(current, lease, "dispatching"); current!.phase = "finished";
        await tx.put("lease", current!); await tx.setAlarm(Date.now() + 1000);
      });
      return { ...result, leaseId: lease.value.leaseId, stepId: lease.value.stepId, candidateSha256: lease.value.candidateSha256, id: checkId };
    } finally { await bounded(sandbox.retire(), 15_000); }
  }
  async cancel(): Promise<void> {
    const row = await this.ctx.storage.transaction(async tx => {
      if (!await tx.get("retired")) await tx.put("retired", Date.now() + 24 * 60 * 60_000);
      const row = await tx.get<Lease>("lease"); if (row) { row.phase = "cancelled"; await tx.put("lease", row); }
      await tx.setAlarm(Date.now() + 1000); return row;
    });
    if (row) await bounded(this.sandbox(row.value.leaseId).retire(), 15_000);
  }
  async alarm(): Promise<void> {
    const probe = await this.ctx.storage.get<Probe>("probe");
    if (probe) {
      await bounded(Promise.all([
        getSandbox(this.env.CODING_NETWORK_BASELINE, `fixed-baseline-${probe.nonce}`, { keepAlive: false }).retire(),
        getSandbox(this.env.OFFLINE_CODING, `fixed-denial-${probe.nonce}`, { keepAlive: false }).retire(),
      ]), 15_000);
      await this.ctx.storage.transaction(async tx => { if ((await tx.get<Probe>("probe"))?.nonce === probe.nonce) await tx.delete("probe"); });
    }
    const row = await this.ctx.storage.get<Lease>("lease");
    if (row) { await this.cancel(); await this.ctx.storage.delete("lease"); }
    const retired = await this.ctx.storage.get<number>("retired");
    if (retired !== undefined) {
      if (retired <= Date.now()) await this.ctx.blockConcurrencyWhile(async () => { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); });
      else await this.ctx.storage.setAlarm(retired);
    }
  }
  private async current(phase: Lease["phase"]): Promise<Lease> {
    const row = await this.ctx.storage.get<Lease>("lease");
    if (!row || row.phase !== phase || row.value.deadline <= Date.now()) throw new Error("coding-check-not-current");
    return row;
  }
  private same(current: Lease | undefined, previous: Lease, phase: Lease["phase"]): void {
    if (!current || current.phase !== phase || current.value.deadline <= Date.now() || current.value.taskSha256 !== previous.value.taskSha256 || current.value.stepId !== previous.value.stepId) throw new Error("coding-check-not-current");
  }
}
export default { fetch: () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }) };
