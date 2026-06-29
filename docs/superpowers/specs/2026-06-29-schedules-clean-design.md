# Fable Local Schedules — clean rebuild on the runtime adapter

**Branch:** `codex/runtime-schedules-clean` (based on `codex/runtime-codex-app-server` @ `92b5cff`)
**Date:** 2026-06-29
**Goal:** Complete local desktop schedules so scheduled prompts execute through `AgentBackend`, without introducing hosted cron and without making Codex the foundation.

## 1. The gap

On `92b5cff` the durable scheduler store, 5 s tick loop, lease/dedup, recurrence
math, and the `AgentBackend` runtime contract all exist. The **last mile is
unwired**: `App.tsx` drives scheduled runs through `runPrompt` (the interactive
composer), which hijacks the user's active thread and shares
cancellation/approval state with interactive runs. The Codex adapter coexists on
base but is unreachable by schedules.

This build closes exactly that gap and hardens the durability edges. No new
scheduler, no hosted cron, no schedule-page redesign.

## 2. Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Execution path | **Dedicated headless runner** — new `useScheduledAgent` + pure `executeScheduledPrompt()`. Scheduled runs never touch the active thread or the interactive agent state. |
| Backend/model routing | **Pin at create, fallback at run** — capture `backendId`/`modelId`/`permissionMode` into a `ScheduledExecutionRoute` at create time; at run time use the pinned backend if still connected, else fall back to the current default. |
| Blocked auth | **Auto-requeue on reconnect** — park the occurrence in `blocked-auth`, then re-attempt once the backend reports connected again. |

## 3. Architecture

```
RUST (authority: durability + leases + secrets)
  scheduler.rs (extend)
    - fencing lease tokens (lease_token) + renew_job_lease
    - retry backoff (available_at)
    - startup recovery (recover_store_at) + occurrence_ledger
    - cancel_job_run, requeue_blocked_job_run commands
    - expanded state vocabulary (queued|leased|running|done|dead|
      failed|blocked-auth|cancelled)
  Connector + execution-permit gates UNCHANGED (runs pass through them)

PURE TS (@fable/connectors/scheduler) — no Tauri, no network
  execution.ts (NEW)
    - executeScheduledPrompt({route, prompt, provider, backend, deps,
      shouldCancel, execute, onToolCall, onRetry}) -> ScheduledExecutionResult
    - resolves AgentBackend via factory, drives run() stream, maps outcomes
    - pure + injectable -> deterministic tests with fake backends
  queue.ts (extend: available_at / lease token awareness)
  route.ts (NEW) — resolveExecutionRoute(pinned, connected)

DESKTOP SHELL (apps/desktop/src)
  useScheduledAgent.ts (NEW hook) — dedicated headless runner
    - consumes pendingWorkflowRuns, NOT the composer
    - owns its own AgentBackend, approval routing, cancel, lease renewal
  useShellRuntime.ts (extend)
    - captures ScheduledExecutionRoute at create time
    - blocked-auth auto-requeue effect on reconnect
    - startup reconciliation via recover
  App.tsx (simplify) — REMOVE composer hijack; delegate to headless runner
  runtime.ts — typed wrappers for new commands + expanded event payload
```

## 4. New / extended types

### Protocol (`packages/protocol/src/index.ts`)

```ts
// New: the frozen, non-secret execution route captured at schedule create time.
export interface ScheduledExecutionRoute {
  /** "pinned" = use backendId/modelId below; "current-default" = resolve live. */
  policy: "pinned" | "current-default";
  backendId: string;
  modelId: string;
  permissionMode: PermissionMode;
}

// ScheduledJob gains: execution?: ScheduledExecutionRoute
// SchedulerQueueEntry gains: leaseToken, availableAt, lastError
// JobAttempt gains: leaseToken?, retryable?
// JobAttemptStatus gains: "blocked-auth"
// SchedulerJobState gains: "running" | "completed" | "failed" | "blocked-auth" | "cancelled"
// BackendAgentEvent.error gains optional: code?: string; retryable?: boolean
```

### Rust (`models.rs`) — mirrors with `#[serde(default)]` for backward compat

Scheduler store schema version stays 1 (additive serde defaults), matching the
existing migration philosophy. Constants added:
`RUNNING_LEASE_MS = 15 * 60 * 1000`, `RETRY_BASE_MS = 30_000`,
`MAX_OCCURRENCE_LEDGER = 200`.

## 5. Scheduler state machine (Rust authority)

```
queued ──(tick leases)──▶ leased ──(running ack)──▶ running
                            │                          │
                            │                     (succeeded/cancelled)
                            │                          ▼
                            │                       done
                            │
                       (failed)
                            │
              ┌─────────────┴──────────────┐
        fails <= MAX_RETRIES          fails > MAX_RETRIES
              ▼                            ▼
       queued (available_at=now+backoff) dead
              │
       (blocked-auth: provider unavailable)
              ▼
         blocked-auth ──(requeue on reconnect)──▶ queued
```

Lease tokens are fencing tokens: `renew_job_lease` and `report_job_attempt`
reject calls whose token doesn't match the current `lease_token`, so a stale
response from a crashed run can't mutate a freshly-re-leased occurrence.

## 6. Secrets hygiene (reuses existing logic)

- `ScheduledExecutionRoute` carries only provider/model ids + permission mode —
  never keys/tokens.
- Schedule records, queue entries, attempts, and the occurrence ledger never
  carry secrets; they store only the frozen route + error strings (truncated).
- AgentBackend already carries no secrets (contract invariant); execution errors
  are classified by `code` ("authentication" → blocked-auth) without surfacing
  credential material.
- Existing `redact_connector_text` / `is_sensitive_payload_key` are reused for
  any prompt-derived text that might leak.

## 7. Approval + connector boundaries (unchanged)

Scheduled runs flow through `executeScheduledPrompt` → `AgentBackend.run` → tool
calls routed to Fable's shared approval gate via `options.execute` /
`onToolCall`. Connector writes still require a fresh per-action approval
(`validate_connector_execution_request` rejects session/rule decisions for
writes) and one-time permit consumption
(`verify_and_consume_execution_approval`). A scheduled run cannot bypass these.

## 8. Tests (deterministic, clock-based)

- **Rust** (`scheduler.rs` `mod tests`): lease token fencing, backoff
  `available_at`, startup `recover_store_at` re-queues stale leased/running
  entries, occurrence ledger dedup, cancel transitions to cancelled, blocked-auth
  requeue, max-retries → dead.
- **Pure TS** (`@fable/connectors`):
  - `execution.test.ts` — fake `AgentBackend` streams (completed / cancelled /
    error-auth → blocked-auth / error-transient → failed retryable / no backend
    → blocked-auth), deterministic injected clock.
  - `queue.test.ts` — `availableAt` honored, lease token validated, new states.
  - `route.test.ts` — pinned-then-disconnected → current-default fallback,
    pinned-then-reconnected → pinned honored.

## 9. Out of scope

SchedulesPage/SchedulePanel redesign, JSON-store → SQLite migration, cron
expressions, multi-step workflows beyond single prompt.
