import { getSandbox } from "@cloudflare/sandbox";
import type {
  HostedComputerLifecycle,
  HostedComputerSnapshot,
  HostedProcessLaunchRequest,
  HostedProcessLifecycle,
  HostedProcessScheduleRunSnapshot,
  HostedProcessScheduleRequest,
  HostedProcessScheduleSnapshot,
  HostedProcessSnapshot
} from "@fable/protocol";
import { DurableObject } from "cloudflare:workers";
import {
  validateComputerId,
  validateLaunchRequest,
  validateProcessId,
  validateProcessScheduleRequest,
  validateScheduleId
} from "./contracts";
import { nextRecurringOccurrence } from "./schedule-logic";

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

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  request_key: string;
  run_id: string;
  lifecycle: "active" | "paused" | "cancelled" | "stale";
  launch_json: string;
  first_run_at: number;
  interval_seconds: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_process_id: string | null;
  last_error_code: string | null;
  generation: number;
  updated_at: string;
}

interface ScheduleRunRow extends Record<string, SqlStorageValue> {
  occurrence_id: string;
  schedule_id: string;
  scheduled_at: number;
  request_key: string;
  run_id: string;
  error_code: string | null;
  generation: number;
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
    const generation = previous?.generation ?? 1;
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
  async requireReady(rawComputerId: string, expectedGeneration?: number): Promise<number> {
    validateComputerId(rawComputerId);
    const computer = this.readComputer();
    if (
      !computer
      || computer.lifecycle !== "ready"
      || !computer.keep_alive
      || (expectedGeneration !== undefined && computer.generation !== expectedGeneration)
    ) {
      throw this.operationError(expectedGeneration === undefined ? "computer-not-ready" : "capability-stale");
    }
    return computer.generation;
  }

  async launch(rawComputerId: string, rawRequest: unknown, expectedGeneration?: number): Promise<HostedProcessSnapshot> {
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

  async schedule(
    rawComputerId: string,
    rawScheduleId: string,
    rawRequest: unknown,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const scheduleId = validateScheduleId(rawScheduleId);
    const request = validateProcessScheduleRequest(rawRequest);
    if (request.scheduleId !== scheduleId) throw this.operationError("schedule-id-mismatch");
    const replay = this.readScheduleByRequestKey(request.requestKey);
    if (replay) {
      if (replay.schedule_id !== scheduleId) throw this.operationError("schedule-conflict");
      return scheduleSnapshot(replay);
    }
    if (this.readSchedule(scheduleId)) throw this.operationError("schedule-conflict");
    const computer = this.readComputer();
    if (!computer || computer.lifecycle !== "ready" || !computer.keep_alive) {
      throw this.operationError("computer-not-ready");
    }
    const now = new Date().toISOString();
    const firstRunAt = Date.parse(request.firstRunAt);
    this.ctx.storage.sql.exec(
      `INSERT INTO schedules (schedule_id, request_key, run_id, lifecycle, launch_json, first_run_at,
       interval_seconds, next_run_at, generation, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      scheduleId,
      request.requestKey,
      request.runId,
      JSON.stringify(request),
      firstRunAt,
      request.intervalSeconds,
      firstRunAt,
      computer.generation,
      now
    );
    await this.resetAlarm();
    return scheduleSnapshot(this.readRequiredSchedule(scheduleId));
  }

  async scheduleStatus(
    rawComputerId: string,
    rawScheduleId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    return scheduleSnapshot(this.readRequiredSchedule(validateScheduleId(rawScheduleId)));
  }

  async listSchedules(
    rawComputerId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot[]> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    return this.ctx.storage.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules ORDER BY updated_at DESC, schedule_id LIMIT 100"
    ).toArray().map(scheduleSnapshot);
  }

  async listScheduleRuns(
    rawComputerId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleRunSnapshot[]> {
    const computerId = validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const recent = this.readRecentScheduleRuns();
    let refreshed = 0;
    for (const row of recent) {
      const process = this.readProcessByRequestKey(row.request_key);
      if (
        refreshed < 20
        && process?.process_id
        && (process.lifecycle === "launching" || process.lifecycle === "running" || process.lifecycle === "cancelling")
      ) {
        refreshed += 1;
        await this.refreshProcessStatus(computerId, process).catch(() => undefined);
      }
    }
    return this.readRecentScheduleRuns().map((row) =>
      scheduleRunSnapshot(row, this.readProcessByRequestKey(row.request_key))
    );
  }

  async cancelSchedule(
    rawComputerId: string,
    rawScheduleId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const scheduleId = validateScheduleId(rawScheduleId);
    this.readRequiredSchedule(scheduleId);
    this.ctx.storage.sql.exec(
      "UPDATE schedules SET lifecycle = 'cancelled', next_run_at = NULL, updated_at = ? WHERE schedule_id = ?",
      new Date().toISOString(),
      scheduleId
    );
    await this.resetAlarm();
    return scheduleSnapshot(this.readRequiredSchedule(scheduleId));
  }

  async pauseSchedule(
    rawComputerId: string,
    rawScheduleId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const scheduleId = validateScheduleId(rawScheduleId);
    const schedule = this.readRequiredSchedule(scheduleId);
    if (schedule.lifecycle === "cancelled" || schedule.lifecycle === "stale") {
      throw this.operationError("schedule-not-controllable");
    }
    if (schedule.lifecycle === "active") {
      this.ctx.storage.sql.exec(
        "UPDATE schedules SET lifecycle = 'paused', next_run_at = NULL, updated_at = ? WHERE schedule_id = ? AND lifecycle = 'active'",
        new Date().toISOString(),
        scheduleId
      );
      await this.resetAlarm();
    }
    return scheduleSnapshot(this.readRequiredSchedule(scheduleId));
  }

  async resumeSchedule(
    rawComputerId: string,
    rawScheduleId: string,
    expectedGeneration?: number
  ): Promise<HostedProcessScheduleSnapshot> {
    validateComputerId(rawComputerId);
    this.requireCapabilityGeneration(expectedGeneration);
    const scheduleId = validateScheduleId(rawScheduleId);
    const schedule = this.readRequiredSchedule(scheduleId);
    if (schedule.lifecycle === "cancelled" || schedule.lifecycle === "stale") {
      throw this.operationError("schedule-not-controllable");
    }
    if (schedule.lifecycle === "paused") {
      const computer = this.readComputer();
      if (!computer || computer.lifecycle !== "ready" || !computer.keep_alive || computer.generation !== schedule.generation) {
        throw this.operationError("computer-not-ready");
      }
      const nextRunAt = nextRecurringOccurrence(schedule.first_run_at, schedule.interval_seconds, Date.now());
      this.ctx.storage.sql.exec(
        "UPDATE schedules SET lifecycle = 'active', next_run_at = ?, updated_at = ? WHERE schedule_id = ? AND lifecycle = 'paused'",
        nextRunAt,
        new Date().toISOString(),
        scheduleId
      );
      await this.resetAlarm();
    }
    return scheduleSnapshot(this.readRequiredSchedule(scheduleId));
  }

  async alarm(): Promise<void> {
    const computer = this.readComputer();
    if (!computer || computer.lifecycle !== "ready" || !computer.keep_alive) return;
    const now = Date.now();
    const due = this.ctx.storage.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules WHERE lifecycle = 'active' AND generation = ? AND next_run_at <= ? ORDER BY next_run_at LIMIT 10",
      computer.generation,
      now
    ).toArray();
    for (const row of due) {
      const scheduledAt = row.next_run_at;
      if (scheduledAt === null) continue;
      const occurrenceId = `occurrence-${scheduledAt}`;
      const requestKey = `scheduled:${row.schedule_id}:${scheduledAt}`;
      const runId = `${row.run_id}:${scheduledAt}`;
      this.insertScheduleRun(row, occurrenceId, scheduledAt, requestKey, runId);
      let nextRunAt: number;
      try {
        nextRunAt = nextRecurringOccurrence(scheduledAt, row.interval_seconds, now);
      } catch {
        this.markScheduleRun(row.schedule_id, occurrenceId, "invalid-schedule-state");
        this.ctx.storage.sql.exec(
          "UPDATE schedules SET lifecycle = 'stale', next_run_at = NULL, last_error_code = 'invalid-schedule-state', updated_at = ? WHERE schedule_id = ?",
          new Date().toISOString(),
          row.schedule_id
        );
        continue;
      }
      let lastProcessId: string | null = null;
      let lastErrorCode: string | null = null;
      try {
        const stored = JSON.parse(row.launch_json) as HostedProcessScheduleRequest;
        const launch = validateLaunchRequest({
          requestKey,
          runId,
          argv: stored.argv,
          ...(stored.cwd ? { cwd: stored.cwd } : {}),
          ...(stored.timeoutMs ? { timeoutMs: stored.timeoutMs } : {})
        });
        const process = await this.launchValidated(computer.computer_id, launch);
        lastProcessId = process.processId ?? null;
      } catch (error) {
        lastErrorCode = errorCode(error);
      }
      this.markScheduleRun(row.schedule_id, occurrenceId, lastErrorCode);
      this.ctx.storage.sql.exec(
        `UPDATE schedules SET next_run_at = ?, last_run_at = ?, last_process_id = ?, last_error_code = ?, updated_at = ?
         WHERE schedule_id = ? AND lifecycle = 'active' AND generation = ?`,
        nextRunAt,
        scheduledAt,
        lastProcessId,
        lastErrorCode,
        new Date().toISOString(),
        row.schedule_id,
        computer.generation
      );
    }
    await this.resetAlarm();
  }

  async inspect(rawComputerId: string, rawProcessId: string, expectedGeneration?: number): Promise<HostedProcessSnapshot> {
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

  async kill(rawComputerId: string, rawProcessId: string, expectedGeneration?: number): Promise<HostedProcessSnapshot> {
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
      this.ctx.storage.sql.exec(
        "UPDATE schedules SET lifecycle = 'stale', next_run_at = NULL, updated_at = ? WHERE lifecycle IN ('active', 'paused')",
        new Date().toISOString()
      );
      await this.ctx.storage.deleteAlarm();
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

  private requireCapabilityGeneration(expectedGeneration: number | undefined): void {
    if (expectedGeneration === undefined) return;
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
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        launch_json TEXT NOT NULL,
        first_run_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_process_id TEXT,
        last_error_code TEXT,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(lifecycle, generation, next_run_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        occurrence_id TEXT NOT NULL,
        schedule_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        request_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        error_code TEXT,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (schedule_id, occurrence_id)
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_recent ON schedule_runs(schedule_id, scheduled_at DESC);
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

  private readSchedule(scheduleId: string): ScheduleRow | null {
    return this.ctx.storage.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules WHERE schedule_id = ?",
      scheduleId
    ).toArray()[0] ?? null;
  }

  private readScheduleByRequestKey(requestKey: string): ScheduleRow | null {
    return this.ctx.storage.sql.exec<ScheduleRow>(
      "SELECT * FROM schedules WHERE request_key = ?",
      requestKey
    ).toArray()[0] ?? null;
  }

  private readRequiredSchedule(scheduleId: string): ScheduleRow {
    const row = this.readSchedule(scheduleId);
    if (!row) throw this.operationError("schedule-not-found");
    return row;
  }

  private readRecentScheduleRuns(): ScheduleRunRow[] {
    return this.ctx.storage.sql.exec<ScheduleRunRow>(
      "SELECT * FROM schedule_runs ORDER BY scheduled_at DESC, schedule_id LIMIT 100"
    ).toArray();
  }

  private insertScheduleRun(
    schedule: ScheduleRow,
    occurrenceId: string,
    scheduledAt: number,
    requestKey: string,
    runId: string
  ): void {
    const updatedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO schedule_runs
       (occurrence_id, schedule_id, scheduled_at, request_key, run_id, generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      occurrenceId,
      schedule.schedule_id,
      scheduledAt,
      requestKey,
      runId,
      schedule.generation,
      updatedAt
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM schedule_runs WHERE schedule_id = ? AND occurrence_id NOT IN (
        SELECT occurrence_id FROM schedule_runs WHERE schedule_id = ? ORDER BY scheduled_at DESC LIMIT 20
      )`,
      schedule.schedule_id,
      schedule.schedule_id
    );
  }

  private markScheduleRun(scheduleId: string, occurrenceId: string, error: string | null): void {
    this.ctx.storage.sql.exec(
      "UPDATE schedule_runs SET error_code = ?, updated_at = ? WHERE schedule_id = ? AND occurrence_id = ?",
      error,
      new Date().toISOString(),
      scheduleId,
      occurrenceId
    );
  }

  private async refreshProcessStatus(computerId: string, stored: ProcessRow): Promise<void> {
    if (!stored.process_id) return;
    const process = await this.sandbox(computerId).getProcess(stored.process_id);
    if (!process) {
      this.markProcess(stored.request_key, "stale", {
        errorCode: "process-container-replaced",
        endedAt: new Date().toISOString()
      });
      return;
    }
    const status = await process.status();
    if (status.state === "running") {
      this.markProcess(stored.request_key, stored.lifecycle === "cancelling" ? "cancelling" : "running", {});
      return;
    }
    if (status.state === "error") {
      this.markProcess(stored.request_key, "failed", { errorCode: status.error.code, endedAt: status.endedAt });
      return;
    }
    this.markProcess(stored.request_key, status.exit.code === 0 ? "completed" : "failed", {
      exitCode: status.exit.code,
      timedOut: status.exit.timedOut,
      endedAt: status.endedAt,
      ...(status.exit.code === 0 ? {} : { errorCode: status.exit.timedOut ? "process-timeout" : "process-exit-nonzero" })
    });
  }

  private async resetAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ next_run_at: number }>(
      "SELECT next_run_at FROM schedules WHERE lifecycle = 'active' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1"
    ).toArray()[0]?.next_run_at;
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
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

function scheduleSnapshot(row: ScheduleRow): HostedProcessScheduleSnapshot {
  return {
    scheduleId: row.schedule_id,
    requestKey: row.request_key,
    runId: row.run_id,
    lifecycle: row.lifecycle,
    firstRunAt: new Date(row.first_run_at).toISOString(),
    intervalSeconds: row.interval_seconds,
    ...(row.next_run_at === null ? {} : { nextRunAt: new Date(row.next_run_at).toISOString() }),
    ...(row.last_run_at === null ? {} : { lastRunAt: new Date(row.last_run_at).toISOString() }),
    ...(row.last_process_id === null ? {} : { lastProcessId: row.last_process_id }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    generation: row.generation,
    updatedAt: row.updated_at
  };
}

function scheduleRunSnapshot(
  row: ScheduleRunRow,
  process: ProcessRow | null
): HostedProcessScheduleRunSnapshot {
  const fallbackLifecycle: HostedProcessLifecycle = row.error_code ? "failed" : "stale";
  return {
    occurrenceId: row.occurrence_id,
    scheduleId: row.schedule_id,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    requestKey: row.request_key,
    runId: row.run_id,
    lifecycle: process?.lifecycle ?? fallbackLifecycle,
    ...(process?.process_id ? { processId: process.process_id } : {}),
    ...(process?.started_at ? { startedAt: process.started_at } : {}),
    ...(process?.ended_at ? { endedAt: process.ended_at } : {}),
    ...(process?.exit_code === null || process?.exit_code === undefined ? {} : { exitCode: process.exit_code }),
    ...(process?.timed_out === null || process?.timed_out === undefined ? {} : { timedOut: process.timed_out === 1 }),
    ...(process?.error_code || row.error_code ? { errorCode: process?.error_code ?? row.error_code ?? "unknown" } : {}),
    generation: row.generation,
    updatedAt: process && process.updated_at > row.updated_at ? process.updated_at : row.updated_at
  };
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const value = Reflect.get(error, "code");
  return typeof value === "string" && /^[A-Z0-9_-]{1,80}$/i.test(value) ? value : "unknown";
}
