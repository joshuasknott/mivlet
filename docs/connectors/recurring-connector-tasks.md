# Recurring Connector Tasks and Schedules

Fable schedules durable workflow definitions in the desktop runtime. The local
runtime owns persistence, queue leases, retries, permissions, cancellation, and
history; there is no hosted runner.

## Create a schedule

Open **Schedules**, enter a name and prompt, then choose one of:

- `Daily`, with a local time.
- `Weekly`, with one or more weekdays and a local time.
- `Monthly`, with a day of month and a local time.
- `Once`, with a local date and time.

Recurring rules use the device's IANA timezone. The `/schedule` command creates
the same durable job through the same runtime boundary.

The optional **Data sources** list contains connected connectors that implement
Fable's search contract. Selecting one adds a `connector-read` step before the
prompt. It does not grant write access or reuse a write-oriented connector
action as a read.

The Schedule page creates a versioned workflow definition and a scheduled job.
A simplified persisted definition looks like this:

```json
{
  "schemaVersion": 1,
  "id": "workflow-daily-issue-digest",
  "version": 1,
  "name": "Daily issue digest",
  "description": "Summarize open issues",
  "steps": [
    {
      "kind": "connector-read",
      "id": "read-github",
      "connectorId": "github",
      "capability": "search",
      "input": { "query": "Summarize open issues" },
      "outputVar": "github"
    },
    {
      "kind": "prompt",
      "id": "prompt",
      "prompt": "Summarize open issues"
    }
  ],
  "createdAt": "2026-07-01T08:00:00.000Z",
  "updatedAt": "2026-07-01T08:00:00.000Z"
}
```

The connector search executes through the existing desktop connector
infrastructure. Connector sessions and credentials remain behind the native
boundary; workflow records contain only redacted results.

## Permission profiles

Every job captures an execution route containing a permission mode and its
matching profile.

| Profile ID | Mode | Schedule behavior |
| --- | --- | --- |
| `read-only` | `read-only` | Blocks schedule configuration and execution. |
| `trusted` | `trusted-scope` | Allows schedules and connector reads; consequential effects still require approval. Blocks shell execution and cache mutation. |
| `full-with-approvals` | `full-access` | Allows the full effect set, but consequential effects still pass through approval and audit boundaries. |

Permissions are enforced at multiple boundaries:

1. The Schedule UI checks `schedule-mutation` before changing configuration.
2. Native job normalization validates that the captured mode/profile pair may
   configure a schedule.
3. The native queue revalidates `schedule-execution` when an occurrence is
   leased.
4. The workflow runner revalidates the captured profile at run start and before
   every step. A step-level profile cannot elevate the run profile.

A blocked native lease becomes `dead` with a redacted permission error and an
action-history event.

## Queue and occurrence semantics

Each occurrence has a durable key:

```text
<job-id>:<scheduled-at-ISO-timestamp>
```

The native queue rejects a second entry with the same key. A lease includes a
fencing token, so a stale worker cannot report over a newer lease. Terminal
`done`, `dead`, and `cancelled` entries ignore later reports.

At startup, active schedules apply their missed-run policy:

- `skip` ignores missed occurrences.
- `run-once` enqueues only the most recent missed occurrence.
- `run-all` enqueues missed occurrences up to the engine's safety bound.

The same occurrence-key boundary makes repeated startup delivery idempotent.

## Pause, resume, retry, and cancel

### Pause and resume

Pausing sets the job to `paused`, clears its next-run timestamp, and transitions
non-terminal queued work for that job to `cancelled`. The scheduler will not
create future work for the paused job.

Resuming sets the job to `active`, calculates the next future occurrence, and
enqueues it through the same deduplication boundary. Startup catch-up, rather
than the resume button, is where missed-run policies are applied.

### Retry

Each occurrence snapshots a bounded retry policy:

```json
{
  "maxAttempts": 3,
  "initialBackoffMs": 30000,
  "backoffMultiplier": 2,
  "maxBackoffMs": 900000
}
```

`maxAttempts` includes the initial attempt. Transient failures use capped
exponential backoff. The queue exposes `availableAt`, attempt numbers, errors,
and the terminal `dead` state. Run History offers a confirmed manual retry only
for unhealthy terminal runs whose job is still active.

### Cancel

Queued, leased, and running entries can be cancelled. Cancellation is persisted
before the runtime emits a cooperative cancel request. Active execution receives
an `AbortSignal`, downstream workflow steps stop, and late reports cannot revive
the cancelled entry.

## Run History and audit

**Run History** lists persisted workflow runs and resolves their display state
with the durable queue:

- `queued`
- `running`
- `retrying`
- `succeeded`
- `failed`
- `cancelled`
- `interrupted`

Run details include start/update/finish timestamps, duration, workflow version,
attempt history, per-step output or error, and related notifications. Retry and
cancel controls are shown only for supported states.

Schedule configuration changes, workflow definition changes, lease policy
blocks, attempt outcomes, and cancellations are recorded in the unified action
history. Workflow runs and queue attempts are persisted separately so execution
history remains inspectable after restart.

## Recovery and one-time schedules

On startup, native scheduler entries left `leased` or `running` are requeued.
Workflow journals left `running` are changed to `queued` with an interruption
reason. The occurrence lease can then be acquired again with a new fencing
token.

A `once` trigger uses the same persistence and queue path. After its single
occurrence completes, no next occurrence is calculated.

## Secret handling and idempotency

Workflow inputs, step outputs, errors, audit details, and the Run History
inspection view are redacted. Known credential keys such as `token`,
`accessToken`, `secretToken`, `clientSecret`, `api_key`, `password`, and
`authorization`, plus common credential-shaped strings, are replaced with
`[REDACTED]`. Inspection output is also size-bounded.

Connector writes supported by the workflow runner receive an idempotency key
derived from the run ID, step ID, capability, and a stable serialization of the
step input. A host must still supply the connector-write boundary and its fresh
approval flow; the current Schedule form composes connector reads and a prompt.
