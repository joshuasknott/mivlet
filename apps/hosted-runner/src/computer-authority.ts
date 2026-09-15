import { getSandbox } from "@cloudflare/sandbox";
import type {
  HostedComputerLifecycle,
  HostedComputerSnapshot,
  HostedProcessLaunchRequest,
  HostedProcessLifecycle,
  HostedProcessSnapshot
} from "@fable/protocol";
import { DurableObject } from "cloudflare:workers";
import {
  validateComputerId,
  validateLaunchRequest,
  validateProcessId
} from "./contracts";
import { consumeCapabilityNonceRecord, nextEnsureGeneration } from "./capability-nonce";

interface ComputerRow extends Record<string, SqlStorageValue> {
  computer_id: string;
  lifecycle: HostedComputerLifecycle;
  keep_alive: number;
  generation: number;
  updated_at: string;
}

interface ProcessRow extends Record<string, SqlStorageValue> {
  request_key: string;
  run_id: string;
  process_id: string | null;
  pid: number | null;
  lifecycle: HostedProcessLifecycle;
  launch_json: string;
  generation: number;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  timed_out: number | null;
  error_code: string | null;
  updated_at: string;
}

export class ComputerAuthority extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async ensure(rawComputerId: string): Promise<HostedComputerSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const previous = this.readComputer();
    const generation = nextEnsureGeneration(previous?.generation);
    const now = new Date().toISOString();
    this.writeComputer({ computerId, lifecycle: "provisioning", keepAlive: true, generation, updatedAt: now });
    const sandbox = this.sandbox(computerId);
    try {
      await sandbox.setKeepAlive(true);
      await sandbox.mkdir("/workspace/.fable", { recursive: true });
      await sandbox.writeFile("/workspace/.fable/computer.json", JSON.stringify({ computerId, generation, provisionedAt: now }));
      if (!this.isCurrentGeneration(generation)) {
        await sandbox.destroy();
        return this.snapshot(false);
      }
      this.writeComputer({ computerId, lifecycle: "ready", keepAlive: true, generation, updatedAt: new Date().toISOString() });
      return this.snapshot(true);
    } catch (error) {
      if (this.isCurrentGeneration(generation)) {
        this.writeComputer({ computerId, lifecycle: "degraded", keepAlive: false, generation, updatedAt: new Date().toISOString() });
      }
      throw this.operationError("computer-provision-failed", error);
    }
  }

  async status(rawComputerId: string): Promise<HostedComputerSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const row = this.readComputer();
    if (!row) return emptySnapshot(computerId);
    let runtimeActive = false;
    try {
      runtimeActive = await this.sandbox(computerId).isRuntimeActive();
    } catch {
      runtimeActive = false;
    }
    return this.snapshot(runtimeActive);
  }

  /** Generation fence for sibling computer-scoped services such as Browser Run. */
  async requireReady(rawComputerId: string, expectedGeneration: number): Promise<number> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const computer = this.readComputer();
    if (!computer) throw this.operationError("capability-stale");
    return computer.generation;
  }

  async consumeCapabilityNonce(
    rawComputerId: string,
    nonce: string,
    expectedGeneration: number,
    expiresAt: number
  ): Promise<void> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    consumeCapabilityNonceRecord(
      (query, ...params) => {
        this.ctx.storage.sql.exec(query, ...params);
      },
      nonce,
      expiresAt,
      Date.now()
    );
  }

  async launch(rawComputerId: string, rawRequest: unknown, expectedGeneration: number): Promise<HostedProcessSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const request = validateLaunchRequest(rawRequest);
    return this.launchValidated(computerId, request);
  }

  private async launchValidated(computerId: string, request: HostedProcessLaunchRequest): Promise<HostedProcessSnapshot> {
    const replay = this.readProcessByRequestKey(request.requestKey);
    if (replay) return processSnapshot(replay);
    const computer = this.readComputer();
    if (!computer || computer.lifecycle !== "ready" || !computer.keep_alive) {
      throw this.operationError("computer-not-ready");
    }
    const generation = computer.generation;
    const now = new Date().toISOString();
    this.insertLaunchingProcess(request, generation, now);
    const sandbox = this.sandbox(computerId);
    try {
      const process = await sandbox.exec(request.argv, {
        cwd: request.cwd ?? "/workspace",
        timeout: request.timeoutMs ?? 5 * 60_000
      });
      if (!this.isCurrentGeneration(generation)) {
        await process.kill();
        this.markProcess(request.requestKey, "stale", { processId: process.id, pid: process.pid, errorCode: "computer-generation-changed" });
        return processSnapshot(this.readRequiredProcess(request.requestKey));
      }
      this.markProcess(request.requestKey, "running", {
        processId: process.id,
        pid: process.pid,
        startedAt: now
      });
      return processSnapshot(this.readRequiredProcess(request.requestKey));
    } catch (error) {
      this.markProcess(request.requestKey, "failed", { errorCode: errorCode(error), endedAt: new Date().toISOString() });
      throw this.operationError("process-launch-failed", error);
    }
  }

  async inspect(rawComputerId: string, rawProcessId: string, expectedGeneration: number): Promise<HostedProcessSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const processId = validateProcessId(rawProcessId);
    const stored = this.readProcessByProcessId(processId);
    if (!stored) throw this.operationError("process-not-found");
    const process = await this.sandbox(computerId).getProcess(processId);
    if (!process) {
      this.markProcess(stored.request_key, "stale", { errorCode: "process-container-replaced", endedAt: new Date().toISOString() });
      return processSnapshot(this.readRequiredProcess(stored.request_key));
    }
    const status = await process.status();
    if (status.state === "running") {
      this.markProcess(stored.request_key, stored.lifecycle === "cancelling" ? "cancelling" : "running", {});
      return processSnapshot(this.readRequiredProcess(stored.request_key));
    }
    const endedAt = status.endedAt;
    if (status.state === "error") {
      this.markProcess(stored.request_key, "failed", { errorCode: status.error.code, endedAt });
    } else {
      this.markProcess(stored.request_key, status.exit.code === 0 ? "completed" : "failed", {
        exitCode: status.exit.code,
        timedOut: status.exit.timedOut,
        endedAt,
        ...(status.exit.code === 0 ? {} : { errorCode: status.exit.timedOut ? "process-timeout" : "process-exit-nonzero" })
      });
    }
    const output = await process.output({ encoding: "utf8", maxBytes: 256 * 1024, timeout: 5_000 });
    return {
      ...processSnapshot(this.readRequiredProcess(stored.request_key)),
      stdout: output.stdout,
      stderr: output.stderr,
      outputTruncated: output.truncated
    };
  }

  async kill(rawComputerId: string, rawProcessId: string, expectedGeneration: number): Promise<HostedProcessSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const processId = validateProcessId(rawProcessId);
    const stored = this.readProcessByProcessId(processId);
    if (!stored) throw this.operationError("process-not-found");
    const process = await this.sandbox(computerId).getProcess(processId);
    if (!process) {
      this.markProcess(stored.request_key, "stale", { errorCode: "process-container-replaced", endedAt: new Date().toISOString() });
      return processSnapshot(this.readRequiredProcess(stored.request_key));
    }
    this.markProcess(stored.request_key, "cancelling", {});
    await process.kill(15);
    return processSnapshot(this.readRequiredProcess(stored.request_key));
  }

  async destroy(rawComputerId: string): Promise<HostedComputerSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const current = this.readComputer();
    const generation = (current?.generation ?? 0) + 1;
    this.writeComputer({ computerId, lifecycle: "destroying", keepAlive: false, generation, updatedAt: new Date().toISOString() });
    const sandbox = this.sandbox(computerId);
    try {
      await sandbox.setKeepAlive(false);
      await sandbox.destroy();
      this.ctx.storage.sql.exec(
        "UPDATE processes SET lifecycle = 'stale', error_code = 'computer-destroyed', ended_at = ?, updated_at = ? WHERE lifecycle IN ('launching', 'running', 'cancelling')",
        new Date().toISOString(),
        new Date().toISOString()
      );
      this.writeComputer({ computerId, lifecycle: "destroyed", keepAlive: false, generation, updatedAt: new Date().toISOString() });
      return this.snapshot(false);
    } catch (error) {
      this.writeComputer({ computerId, lifecycle: "degraded", keepAlive: false, generation, updatedAt: new Date().toISOString() });
      throw this.operationError("computer-destroy-failed", error);
    }
  }

  private sandbox(computerId: string) {
    return getSandbox(this.env.Sandbox, computerId, { keepAlive: true, normalizeId: true });
  }

  private requireCapabilityGeneration(expectedGeneration: number): void {
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      throw this.operationError("capability-stale");
    }
    const computer = this.readComputer();
    if (
      !computer
      || computer.lifecycle !== "ready"
      || !computer.keep_alive
      || computer.generation !== expectedGeneration
    ) {
      throw this.operationError("capability-stale");
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS computer (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        computer_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        keep_alive INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processes (
        request_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        process_id TEXT,
        pid INTEGER,
        lifecycle TEXT NOT NULL,
        launch_json TEXT NOT NULL,
        generation INTEGER NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        timed_out INTEGER,
        error_code TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_process_id ON processes(process_id) WHERE process_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_processes_run_id ON processes(run_id);
      CREATE TABLE IF NOT EXISTS consumed_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2);
    `);
  }

  private readComputer(): ComputerRow | null {
    return this.ctx.storage.sql.exec<ComputerRow>("SELECT * FROM computer WHERE singleton = 1").toArray()[0] ?? null;
  }

  private writeComputer(value: { computerId: string; lifecycle: HostedComputerLifecycle; keepAlive: boolean; generation: number; updatedAt: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO computer (singleton, computer_id, lifecycle, keep_alive, generation, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET computer_id = excluded.computer_id, lifecycle = excluded.lifecycle,
         keep_alive = excluded.keep_alive, generation = excluded.generation, updated_at = excluded.updated_at`,
      value.computerId,
      value.lifecycle,
      value.keepAlive ? 1 : 0,
      value.generation,
      value.updatedAt
    );
  }

  private snapshot(runtimeActive: boolean): HostedComputerSnapshot {
    const row = this.readComputer();
    if (!row) throw this.operationError("computer-not-found");
    return {
      computerId: row.computer_id,
      lifecycle: row.lifecycle,
      runtimeActive,
      keepAlive: row.keep_alive === 1,
      generation: row.generation,
      updatedAt: row.updated_at
    };
  }

  private isCurrentGeneration(generation: number): boolean {
    const row = this.readComputer();
    return row?.generation === generation && row.lifecycle !== "destroying" && row.lifecycle !== "destroyed";
  }

  private insertLaunchingProcess(request: HostedProcessLaunchRequest, generation: number, at: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO processes (request_key, run_id, lifecycle, launch_json, generation, updated_at)
       VALUES (?, ?, 'launching', ?, ?, ?)`,
      request.requestKey,
      request.runId,
      JSON.stringify(request),
      generation,
      at
    );
  }

  private readProcessByRequestKey(requestKey: string): ProcessRow | null {
    return this.ctx.storage.sql.exec<ProcessRow>("SELECT * FROM processes WHERE request_key = ?", requestKey).toArray()[0] ?? null;
  }

  private readProcessByProcessId(processId: string): ProcessRow | null {
    return this.ctx.storage.sql.exec<ProcessRow>("SELECT * FROM processes WHERE process_id = ?", processId).toArray()[0] ?? null;
  }

  private readRequiredProcess(requestKey: string): ProcessRow {
    const row = this.readProcessByRequestKey(requestKey);
    if (!row) throw this.operationError("process-not-found");
    return row;
  }

  private markProcess(
    requestKey: string,
    lifecycle: HostedProcessLifecycle,
    values: { processId?: string; pid?: number; startedAt?: string; endedAt?: string; exitCode?: number; timedOut?: boolean; errorCode?: string }
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE processes SET lifecycle = ?, process_id = COALESCE(?, process_id), pid = COALESCE(?, pid),
       started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at), exit_code = COALESCE(?, exit_code),
       timed_out = COALESCE(?, timed_out), error_code = COALESCE(?, error_code), updated_at = ? WHERE request_key = ?`,
      lifecycle,
      values.processId ?? null,
      values.pid ?? null,
      values.startedAt ?? null,
      values.endedAt ?? null,
      values.exitCode ?? null,
      values.timedOut === undefined ? null : values.timedOut ? 1 : 0,
      values.errorCode ?? null,
      new Date().toISOString(),
      requestKey
    );
  }

  private operationError(code: string, cause?: unknown): Error {
    const error = new Error(code, cause === undefined ? undefined : { cause });
    error.name = "HostedComputerOperationError";
    return error;
  }
}

function emptySnapshot(computerId: string): HostedComputerSnapshot {
  return {
    computerId,
    lifecycle: "unprovisioned",
    runtimeActive: false,
    keepAlive: false,
    generation: 0,
    updatedAt: new Date(0).toISOString()
  };
}

function processSnapshot(row: ProcessRow): HostedProcessSnapshot {
  return {
    requestKey: row.request_key,
    runId: row.run_id,
    lifecycle: row.lifecycle,
    ...(row.process_id === null ? {} : { processId: row.process_id }),
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.timed_out === null ? {} : { timedOut: row.timed_out === 1 }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code })
  };
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = Reflect.get(error, "code");
  return typeof value === "string" && /^[A-Z0-9_-]{1,80}$/i.test(value) ? value : "unknown";
}
