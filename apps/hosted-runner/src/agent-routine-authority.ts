import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type {
  HostedAgentRoutineRequest,
  HostedAgentRoutineRunSnapshot,
  HostedAgentRoutineSnapshot,
  HostedAgentRoutineToolRunSnapshot,
  HostedScheduleLifecycle
} from "@fable/protocol";
import { executeHostedAgentRoutine } from "./agent-routine-execution";
import {
  validateAgentRoutineCapabilities,
  validateAgentRoutineRequest,
  validateComputerId,
  validateRoutineId
} from "./contracts";
import { nextRecurringOccurrence } from "./schedule-logic";

interface RoutineRow extends Record<string, SqlStorageValue> {
  computer_id: string;
  routine_id: string;
  request_key: string;
  run_id: string;
  title: string;
  instruction: string;
  lifecycle: HostedScheduleLifecycle;
  capabilities_json: string;
  max_steps: number;
  first_run_at: number;
  interval_seconds: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  last_run_lifecycle: "running" | "completed" | "failed" | "stale" | null;
  last_result: string | null;
  last_error_code: string | null;
  generation: number;
  updated_at: string;
}

interface RoutineRunRow extends Record<string, SqlStorageValue> {
  occurrence_id: string;
  routine_id: string;
  run_id: string;
  scheduled_at: number;
  lifecycle: "running" | "completed" | "failed" | "stale";
  result: string | null;
  error_code: string | null;
  tools_json: string;
  started_at: string;
  ended_at: string | null;
  generation: number;
  updated_at: string;
}

export class AgentRoutineAuthority extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.markInterruptedRuns();
      await this.resetAlarm();
    });
  }

  async schedule(
    rawComputerId: string,
    rawRoutineId: string,
    rawRequest: unknown,
    generation: number
  ): Promise<HostedAgentRoutineSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    const routineId = validateRoutineId(rawRoutineId);
    const request = validateAgentRoutineRequest(rawRequest);
    if (request.routineId !== routineId) throw this.operationError("routine-id-mismatch");
    await this.requireReady(computerId, generation);
    const replay = this.readByRequestKey(request.requestKey);
    if (replay) {
      if (replay.routine_id !== routineId) throw this.operationError("routine-conflict");
      return routineSnapshot(replay);
    }
    if (this.readRoutine(routineId)) throw this.operationError("routine-conflict");
    const liveRoutineCount = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM routines WHERE lifecycle IN ('active', 'paused')"
    ).toArray()[0]?.count ?? 0;
    if (liveRoutineCount >= 50) throw this.operationError("routine-limit-reached");
    const now = new Date().toISOString();
    const firstRunAt = Date.parse(request.firstRunAt);
    this.ctx.storage.sql.exec(
      `INSERT INTO routines
       (computer_id, routine_id, request_key, run_id, title, instruction, lifecycle, capabilities_json, max_steps,
        first_run_at, interval_seconds, next_run_at, generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      computerId,
      routineId,
      request.requestKey,
      request.runId,
      request.title,
      request.instruction,
      JSON.stringify(request.capabilities),
      request.maxSteps,
      firstRunAt,
      request.intervalSeconds,
      firstRunAt,
      generation,
      now
    );
    await this.resetAlarm();
    return routineSnapshot(this.readRequiredRoutine(routineId));
  }

  async status(rawComputerId: string, rawRoutineId: string, generation: number): Promise<HostedAgentRoutineSnapshot> {
    await this.requireReady(validateComputerId(rawComputerId), generation);
    return routineSnapshot(this.readRequiredRoutine(validateRoutineId(rawRoutineId)));
  }

  async list(rawComputerId: string, generation: number): Promise<HostedAgentRoutineSnapshot[]> {
    await this.requireReady(validateComputerId(rawComputerId), generation);
    return this.ctx.storage.sql.exec<RoutineRow>(
      "SELECT * FROM routines ORDER BY updated_at DESC, routine_id LIMIT 50"
    ).toArray().map(routineSnapshot);
  }

  async listRuns(rawComputerId: string, generation: number): Promise<HostedAgentRoutineRunSnapshot[]> {
    await this.requireReady(validateComputerId(rawComputerId), generation);
    return this.ctx.storage.sql.exec<RoutineRunRow>(
      "SELECT * FROM routine_runs ORDER BY scheduled_at DESC, routine_id LIMIT 50"
    ).toArray().map(routineRunSnapshot);
  }

  async cancel(rawComputerId: string, rawRoutineId: string, generation: number): Promise<HostedAgentRoutineSnapshot> {
    await this.requireReady(validateComputerId(rawComputerId), generation);
    const routineId = validateRoutineId(rawRoutineId);
    this.readRequiredRoutine(routineId);
    this.ctx.storage.sql.exec(
      "UPDATE routines SET lifecycle = 'cancelled', next_run_at = NULL, updated_at = ? WHERE routine_id = ?",
      new Date().toISOString(),
      routineId
    );
    await this.resetAlarm();
    return routineSnapshot(this.readRequiredRoutine(routineId));
  }

  async pause(rawComputerId: string, rawRoutineId: string, generation: number): Promise<HostedAgentRoutineSnapshot> {
    await this.requireReady(validateComputerId(rawComputerId), generation);
    const routineId = validateRoutineId(rawRoutineId);
    const row = this.readRequiredRoutine(routineId);
    if (row.lifecycle === "cancelled" || row.lifecycle === "stale") throw this.operationError("routine-not-controllable");
    if (row.lifecycle === "active") {
      this.ctx.storage.sql.exec(
        "UPDATE routines SET lifecycle = 'paused', next_run_at = NULL, updated_at = ? WHERE routine_id = ? AND lifecycle = 'active'",
        new Date().toISOString(),
        routineId
      );
      await this.resetAlarm();
    }
    return routineSnapshot(this.readRequiredRoutine(routineId));
  }

  async resume(rawComputerId: string, rawRoutineId: string, generation: number): Promise<HostedAgentRoutineSnapshot> {
    const computerId = validateComputerId(rawComputerId);
    await this.requireReady(computerId, generation);
    const routineId = validateRoutineId(rawRoutineId);
    const row = this.readRequiredRoutine(routineId);
    if (row.lifecycle === "cancelled" || row.lifecycle === "stale") throw this.operationError("routine-not-controllable");
    if (row.generation !== generation) throw this.operationError("capability-stale");
    if (row.lifecycle === "paused") {
      const nextRunAt = nextRecurringOccurrence(row.first_run_at, row.interval_seconds, Date.now());
      this.ctx.storage.sql.exec(
        "UPDATE routines SET lifecycle = 'active', next_run_at = ?, updated_at = ? WHERE routine_id = ? AND lifecycle = 'paused'",
        nextRunAt,
        new Date().toISOString(),
        routineId
      );
      await this.resetAlarm();
    }
    return routineSnapshot(this.readRequiredRoutine(routineId));
  }

  async destroy(): Promise<void> {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "UPDATE routines SET lifecycle = 'stale', next_run_at = NULL, last_error_code = 'computer-destroyed', updated_at = ? WHERE lifecycle IN ('active', 'paused')",
      now
    );
    this.ctx.storage.sql.exec(
      "UPDATE routine_runs SET lifecycle = 'stale', error_code = 'computer-destroyed', ended_at = ?, updated_at = ? WHERE lifecycle = 'running'",
      now,
      now
    );
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql.exec<RoutineRow>(
      "SELECT * FROM routines WHERE lifecycle = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT 5",
      now
    ).toArray();
    for (const row of due) await this.runOccurrence(row, now);
    await this.resetAlarm();
  }

  private async runOccurrence(row: RoutineRow, now: number): Promise<void> {
    const scheduledAt = row.next_run_at;
    if (scheduledAt === null) return;
    const occurrenceId = `occurrence-${scheduledAt}`;
    const runId = `${row.run_id}:${scheduledAt}`;
    if (this.readRun(row.routine_id, occurrenceId)) {
      await this.advanceAfterOccurrence(row, scheduledAt, now);
      return;
    }
    const startedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO routine_runs
       (occurrence_id, routine_id, run_id, scheduled_at, lifecycle, tools_json, started_at, generation, updated_at)
       VALUES (?, ?, ?, ?, 'running', '[]', ?, ?, ?)`,
      occurrenceId,
      row.routine_id,
      runId,
      scheduledAt,
      startedAt,
      row.generation,
      startedAt
    );
    // Advance the recurrence before inference. A Worker retry therefore sees
    // the occurrence fence and never starts the same autonomous turn twice.
    await this.advanceAfterOccurrence(row, scheduledAt, now);

    let lifecycle: "completed" | "failed" = "completed";
    let result: string | null = null;
    let errorCode: string | null = null;
    let tools: HostedAgentRoutineToolRunSnapshot[] = [];
    try {
      await this.requireReady(row.computer_id, row.generation);
      const request = rowToRequest(row);
      const execution = await executeHostedAgentRoutine({
        ai: this.env.AI,
        sandbox: getSandbox(this.env.Sandbox, row.computer_id, { keepAlive: true, normalizeId: true }),
        request
      });
      result = execution.result;
      tools = execution.tools;
    } catch (error) {
      lifecycle = "failed";
      errorCode = safeErrorCode(error);
    }
    const endedAt = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE routine_runs SET lifecycle = ?, result = ?, error_code = ?, tools_json = ?, ended_at = ?, updated_at = ?
       WHERE routine_id = ? AND occurrence_id = ? AND lifecycle = 'running'`,
      lifecycle,
      result,
      errorCode,
      JSON.stringify(tools.slice(0, row.max_steps)),
      endedAt,
      endedAt,
      row.routine_id,
      occurrenceId
    );
    this.ctx.storage.sql.exec(
      `UPDATE routines SET last_run_at = ?, last_run_id = ?, last_run_lifecycle = ?, last_result = ?,
       last_error_code = ?, updated_at = ? WHERE routine_id = ? AND generation = ?`,
      scheduledAt,
      runId,
      lifecycle,
      result,
      errorCode,
      endedAt,
      row.routine_id,
      row.generation
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM routine_runs WHERE routine_id = ? AND occurrence_id NOT IN (
        SELECT occurrence_id FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_at DESC LIMIT 20
      )`,
      row.routine_id,
      row.routine_id
    );
  }

  private async advanceAfterOccurrence(row: RoutineRow, scheduledAt: number, now: number): Promise<void> {
    try {
      const nextRunAt = nextRecurringOccurrence(scheduledAt, row.interval_seconds, now);
      this.ctx.storage.sql.exec(
        "UPDATE routines SET next_run_at = ?, updated_at = ? WHERE routine_id = ? AND lifecycle = 'active' AND generation = ?",
        nextRunAt,
        new Date().toISOString(),
        row.routine_id,
        row.generation
      );
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE routines SET lifecycle = 'stale', next_run_at = NULL, last_error_code = 'invalid-routine-state', updated_at = ? WHERE routine_id = ?",
        new Date().toISOString(),
        row.routine_id
      );
    }
  }

  private async requireReady(computerId: string, generation: number): Promise<void> {
    await this.env.COMPUTER_AUTHORITY.getByName(computerId).requireReady(computerId, generation);
  }

  private readRoutine(routineId: string): RoutineRow | null {
    return this.ctx.storage.sql.exec<RoutineRow>("SELECT * FROM routines WHERE routine_id = ?", routineId).toArray()[0] ?? null;
  }

  private readByRequestKey(requestKey: string): RoutineRow | null {
    return this.ctx.storage.sql.exec<RoutineRow>("SELECT * FROM routines WHERE request_key = ?", requestKey).toArray()[0] ?? null;
  }

  private readRequiredRoutine(routineId: string): RoutineRow {
    const row = this.readRoutine(routineId);
    if (!row) throw this.operationError("routine-not-found");
    return row;
  }

  private readRun(routineId: string, occurrenceId: string): RoutineRunRow | null {
    return this.ctx.storage.sql.exec<RoutineRunRow>(
      "SELECT * FROM routine_runs WHERE routine_id = ? AND occurrence_id = ?",
      routineId,
      occurrenceId
    ).toArray()[0] ?? null;
  }

  private async resetAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ next_run_at: number }>(
      "SELECT next_run_at FROM routines WHERE lifecycle = 'active' AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 1"
    ).toArray()[0]?.next_run_at;
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  private markInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      "UPDATE routine_runs SET lifecycle = 'stale', error_code = 'routine-worker-interrupted', ended_at = ?, updated_at = ? WHERE lifecycle = 'running'",
      now,
      now
    );
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        computer_id TEXT NOT NULL,
        routine_id TEXT PRIMARY KEY,
        request_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instruction TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        first_run_at INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_run_id TEXT,
        last_run_lifecycle TEXT,
        last_result TEXT,
        last_error_code TEXT,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_routines_due ON routines(lifecycle, next_run_at);
      CREATE TABLE IF NOT EXISTS routine_runs (
        occurrence_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        result TEXT,
        error_code TEXT,
        tools_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (routine_id, occurrence_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_routine_runs_recent ON routine_runs(routine_id, scheduled_at DESC);
    `);
  }

  private operationError(code: string): Error {
    const error = new Error(code);
    error.name = "HostedAgentRoutineOperationError";
    return error;
  }
}

function rowToRequest(row: RoutineRow): HostedAgentRoutineRequest {
  return {
    requestKey: row.request_key,
    routineId: row.routine_id,
    runId: row.run_id,
    title: row.title,
    instruction: row.instruction,
    firstRunAt: new Date(row.first_run_at).toISOString(),
    intervalSeconds: row.interval_seconds,
    capabilities: parseCapabilities(row.capabilities_json),
    maxSteps: row.max_steps
  };
}

function routineSnapshot(row: RoutineRow): HostedAgentRoutineSnapshot {
  return {
    routineId: row.routine_id,
    requestKey: row.request_key,
    runId: row.run_id,
    title: row.title,
    instruction: row.instruction,
    lifecycle: row.lifecycle,
    firstRunAt: new Date(row.first_run_at).toISOString(),
    intervalSeconds: row.interval_seconds,
    capabilities: parseCapabilities(row.capabilities_json),
    maxSteps: row.max_steps,
    ...(row.next_run_at === null ? {} : { nextRunAt: new Date(row.next_run_at).toISOString() }),
    ...(row.last_run_at === null ? {} : { lastRunAt: new Date(row.last_run_at).toISOString() }),
    ...(row.last_run_id === null ? {} : { lastRunId: row.last_run_id }),
    ...(row.last_run_lifecycle === null ? {} : { lastRunLifecycle: row.last_run_lifecycle }),
    ...(row.last_result === null ? {} : { lastResult: row.last_result }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    generation: row.generation,
    updatedAt: row.updated_at
  };
}

function routineRunSnapshot(row: RoutineRunRow): HostedAgentRoutineRunSnapshot {
  return {
    occurrenceId: row.occurrence_id,
    routineId: row.routine_id,
    runId: row.run_id,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    lifecycle: row.lifecycle,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    tools: parseTools(row.tools_json),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    generation: row.generation,
    updatedAt: row.updated_at
  };
}

function parseCapabilities(value: string): HostedAgentRoutineRequest["capabilities"] {
  const parsed = JSON.parse(value) as unknown;
  return validateAgentRoutineCapabilities(parsed);
}

function parseTools(value: string): HostedAgentRoutineToolRunSnapshot[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 8).filter((item): item is HostedAgentRoutineToolRunSnapshot => {
    if (!item || typeof item !== "object") return false;
    const tool = Reflect.get(item, "tool");
    const status = Reflect.get(item, "status");
    const summary = Reflect.get(item, "summary");
    return ["workspace-list", "workspace-read", "workspace-write", "process-run"].includes(String(tool))
      && (status === "completed" || status === "failed")
      && typeof summary === "string"
      && summary.length <= 240;
  });
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error) || !/^[a-z0-9-]{1,80}$/u.test(error.message)) return "agent-routine-failed";
  return error.message;
}
