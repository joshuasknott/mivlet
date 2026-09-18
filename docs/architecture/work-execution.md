# Bounded Work execution and presentation

The local Work surface owns Chat-to-Work handoff, execution ownership, safe
recovery, and reusable presentation components. This is local behavior only;
hosted execution, general scheduled execution and new providers are out of
scope. See the [parallel roadmap contract](../development/roadmap-parallel-contract.md)
for the account and collaboration contracts.

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

Workspace agent mentions use this same execution owner and native repository.
`start-work.recipientIds` contains explicitly resolved stable workspace IDs;
it does not change conversation or project membership. The composer persists
selected mentions as `@[label](agent:id)` and displays them as avatar chips.
Exact pasted names must resolve uniquely. Only a leading address followed by an
assignment dispatches to a mentioned agent; quotes, inline references and an
agent name alone do not. Removed or ambiguous recipients fail visibly.

Supported model routes receive `workspace-agents`, `teammate-assign`, and
`teammate-message` in ordinary conversations as well as project conversations.
Discovery returns profile identity, model availability and skill titles, never
private instructions, credentials or conversation history. Each assignment uses
its recipient's instructions and native access checks. Agent messages are
durable task data and are never stored as user steering. Questions wake the
addressed assignment at a safe turn boundary, with the existing effort's turn,
depth and token limits. A lead is an ordinary agent, not a separate runtime.

Activity is an expandable disclosure in the originating conversation. It shows
attributed assignments and exchanges, detailed failures, individual cancellation
and Stop effort. Files keep their existing access checks; native durable write
reservations additionally prevent concurrent assignments from silently replacing
the same resource. Opaque connector writes reserve the connected service
conservatively. Reservations never convey approval or filesystem access.

Follow up selects an existing assignment and persists its ID with the Chat draft.
`reply-work` records an idempotent user steering event, so a question can resume
in the same effort. Running provider attempts finish their current turn before
seeing the reply. Interrupted work and unknown external outcomes still use the
existing explicit Continue/Reconcile flow; replying does not replay old tools.

`WorkspaceExecution` is an app-lifetime service created at the workspace root
and shared through subscription snapshots. `ExecutionWorker` mounts once per
admitted session at the workspace root, never inside a tab. Closing views,
switching panes, or closing every tab of a conversation neither stops nor
detaches Work; it stays discoverable and cancellable from Work mode and the
contextual Right Nav. View actions only change view state.

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
| `blocked` | Waiting | A dependency is unresolved |
| `awaiting-approval` | Working | Awaiting approval appears as secondary detail; the exact approval gate remains required |
| `awaiting-user` | Waiting | Needs outcome review appears as secondary detail; saved evidence must be reviewed |
| `completed` | Completed | A saved provider result and assistant message exist |
| `failed` | Failed | Terminal without a verified result; never authorizes retry alone |
| `cancelled` | Stopped | Stopped by the user; completed external actions are not undone |

Schedule-derived Work carries `origin: "schedule"` and is labelled Scheduled
only while queued. Running and terminal occurrences show their actual state,
with schedule provenance as secondary detail. Schedule occurrences
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
- **Dispose** is Stop for the whole workspace: it freezes streams, rejects new
  serial work, and issues native `stop-work` immediately for `running` /
  `awaiting-approval` assignments, including orphans with no renderer session.
  Dispose binds each `stop-work` to the generation captured at freeze
  (`expectedGeneration`). Pending account refresh unmounts the owner; the next
  mount waits for that dispose to settle before remount recovery. If remount
  recovery or Continue already bumped that generation, the late stop is a no-op
  and cannot cancel the newer assignment. Remount recovery
  (`recover_interrupted_execution_attempts`) fences leftover executing Work to
  `awaiting-user`, bumps generation, and clears `current_run_id` so late
  checkpoints fail `ensure_run_current`. Terminal attempts stay immutable
  against non-identical overwrites.
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
interface (`save_memory_state`) with explicit user-confirmed conclusion text,
an owning Agent or Project scope and run provenance. Only the new record is
submitted, preserving concurrent corrections and forget tombstones. P4 creates no separate outcome store; P6 owns
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
`onSteer`, `onPromote`); the shell routes them. Chat shows compact Work cards;
Work mode provides the scoped list and Right Nav opens the selected Work details.
The obsolete History and Project WorkItems implementations have been removed.

## Verification

Native tests cover bounded attachment references, bind refresh, old-record
decode, schedule origin, recovery retention without replay, steering fences,
suspension, remount orphan fencing, and terminal-attempt immutability.
TypeScript tests cover captured-context isolation, steer command shape,
detached execution, approval freshness, Stop, dispose≡Stop, restart recovery,
attachment retention and partial outcomes (see `collaboration/tests.rs`,
`execution_attempts.rs`, `lib/workspace-execution.test.ts`,
`lib/execution-attachments.test.ts`, `lib/work-memory.test.ts`,
`components/work/*.test.tsx`, `components/navigation/*.test.tsx`).

The captured transcript includes recent raw messages and a cached, revision-checked
local extract of omitted terminal text. The extract has an 8,000-character ceiling,
is untrusted prior evidence, and is not a semantic model summary. Native capture
currently reads the raw Chat to validate that cache; the output budget does not
establish constant-cost capture for very long Chats. Delegated Work in the same
Chat inherits the parent's frozen capture. Explicit Project shares are recipient
checked and frozen at admission; live resolution supports Chats, Work and files.
