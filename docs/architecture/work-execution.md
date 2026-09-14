# Bounded Work execution and presentation

P4 owns the local Work surface: Chat-to-Work handoff, execution ownership, safe
recovery, and reusable presentation components. This is local behavior only;
hosted execution, general scheduled execution and new providers are out of
scope. See the [parallel roadmap contract](../development/roadmap-parallel-contract.md)
for the shared interfaces and track ownership.

## Handoff: explicit Chat-to-Work

Sending a message in a conversation submits a Work request through
`WorkspaceExecution.submit` (`apps/desktop/src/lib/workspace-execution.ts`),
which issues `start-work` against the encrypted collaboration repository. The
record captures, in one native transaction:

- the **request** verbatim as `userRequest` (the agent receives `prompt`, which
  may append discussion framing),
- the **relevant context** as a frozen `capturedContext` snapshot
  (bounded transcript, agent instructions/learned tasks, project
  instructions/confirmed facts, approved scoped memory; see
  `collaboration/context.rs`),
- **durable attachment references** (`Work.attachments`): composer-level
  metadata at submission, refreshed at dispatch (`bind-work`) with the staged
  account-root path for workspace files and the exact source id for knowledge
  inputs,
- the **expected result**: the original user request itself, preserved and
  shown separately from any delegated assignment.

The expected result is the request: nothing in the record overwrites
`userRequest`, and delegation children inherit it from their parent.

## Execution ownership

`WorkspaceExecution` is an app-lifetime service created at the workspace root
and shared through subscription snapshots. `ExecutionWorker` mounts once per
admitted session at the workspace root, never inside a tab. Closing views,
switching panes, or closing every tab of a conversation neither stops nor
detaches Work; it stays discoverable and cancellable from the History details
and the reusable Work components. View actions only change view state.

Unrelated Chat never enters a running request: the transcript is frozen at
admission, later messages are excluded from captured context and run
attribution, and membership/model changes bump generations so late results are
rejected (`ensure_run_current`, `work::current`).

## States and presentation

| Native status | Label | Meaning |
| --- | --- | --- |
| `queued` | Queued | Waiting for an available execution slot |
| `running` | Working | A bound provider attempt is executing |
| `waiting` | Waiting | Delegated dependencies are not finished |
| `blocked` | Blocked | A dependency is unresolved |
| `awaiting-approval` | Awaiting approval | A consequential tool waits on the exact approval gate |
| `awaiting-user` | Needs review | Interrupted/steered/uncertain; saved evidence must be reviewed |
| `completed` | Completed | A saved provider result and assistant message exist |
| `failed` | Failed | Terminal without a verified result; never authorizes retry alone |
| `cancelled` | Stopped | Stopped by the user; completed external actions are not undone |

Schedule-derived Work carries `origin: "schedule"` and is labelled Scheduled.
The label is provenance, not a new execution mode: schedule occurrences
integrate into the unified Work list and details without claiming general
scheduled execution.

Richer internal recovery reasons and uncertain external outcomes are preserved:
`reason`, `runIds`/`currentRunId`, `outputs` with agent-report evidence, and
steering history all render in Work details. `awaiting-user` after provider
activity is explained as uncertain rather than presented as a failure.

## Steering, Stop, approvals

- **Steering** (`steer-work`) records a deliberate update with an idempotent
  event id under the expected generation and applies it at a safe boundary.
  After provider activity it moves Work to `awaiting-user`, invalidates the
  run and fences active descendants; nothing is replayed.
- **Stop** (`stop-work`/`stop-project`) is immediate: renderer sessions freeze
  streams and revoke computer control before the native fence cancels the
  request and its descendants; unrelated Work stays current.
- **Approvals** stay contextual and exact: each session holds its own
  approval gate scoped to the request key and permission mode; approval
  requests keep their action, data-used and consequence, and are cleared when
  the session ends.

## Restart recovery and attachments

At startup, `collaboration::recover` moves active Work to `awaiting-user`,
bumps the generation and records the reason; no provider attempt, approval or
external effect is replayed. `continue-work` requires an explicit
reconciliation acknowledgment and starts a fresh attempt with current context.

Attachment recovery distinguishes durable references from in-memory inputs:

- staged workspace files (`Attachments/...` under the account root) and
  knowledge sources are durable references; a continuation restages them
  without user action,
- image inputs and not-yet-staged uploads existed only in memory; after a
  restart (or when staged files were cleaned up) admission fails closed with
  the exact prerequisite ("Reattach the original images/files before
  continuing") before any dispatch.

## Schedules and Memory promotion

Project schedule occurrences become read-only Work through
`bind_schedule`/`finish_schedule` with the frozen prompt and exact attempt;
occurrences without a project never enter the Work surface.

Saved results can be promoted into Memory through the baseline Memory
interface (`save_memory_state`) with an explicit user action, a `work`-scoped
record and run provenance. P4 creates no separate outcome store; P6 owns
Memory internals and capture inheritance.

## Reusable Work components

`apps/desktop/src/components/work/` provides the P8 integration surfaces:

- `WorkStatusBadge` — status and origin labels,
- `WorkCard` — compact card (request, status, reason, attachments count,
  Stop/retry/steer; started Work never offers blind retry here),
- `WorkList` — unified sorted list over the same narrow callbacks,
- `WorkDetails` — original request, captured-context summary, steering
  history, attachments with recovery notes, runs/budget, saved results with
  promote-to-memory, and continue-with-reconciliation.

Components expose narrow callbacks (`onOpen`, `onStop`, `onContinue`,
`onSteer`, `onPromote`); the shell routes them. `components/projects/WorkItems.tsx`
keeps its service-based props for existing surfaces (History details, project
context, Work mode) and now renders the same badges, attachment notes and
steering.

## Verification

Native tests cover bounded attachment references, bind refresh, old-record
decode, schedule origin, recovery retention without replay, steering fences and
suspension. TypeScript tests cover captured-context isolation, steer command
shape, detached execution, approval freshness, Stop, restart recovery,
attachment retention and partial outcomes (see `collaboration/tests.rs`,
`lib/execution-attachments.test.ts`, `lib/work-memory.test.ts`,
`components/work/*.test.tsx`, `components/projects/WorkItems.test.tsx`).