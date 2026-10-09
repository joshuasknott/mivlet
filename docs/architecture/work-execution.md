# Bounded Work execution and presentation

The local Work surface owns Chat-to-Work handoff, execution ownership, safe
recovery, and reusable presentation components. This is local behavior only;
hosted execution is out of scope. Local automations share the ordinary Work
executor. See the [parallel roadmap contract](../development/roadmap-parallel-contract.md)
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
The provider receives the current assignment's `prompt`. A child also receives
the full native-bounded original request as an authority ceiling, so a handoff
cannot drop the user's restrictions or reinterpret the lead's delegation as a
new instruction to delegate again. Returning a response completes that child's
contribution; it does not require a handoff back to the lead.

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

### Opt-in native background text execution on Windows

General settings can start, inspect, stop and restart an account-scoped native
worker. The same packaged executable runs `--mivlet-background-worker` without
creating a WebView. It continues after the desktop window closes; it is not a
Windows service and does not register at login. Windows must remain awake and
the account session must stay valid. An inherited launcher job is rejected
instead of bypassing its containment. Start acknowledges the authenticated
worker before the UI reports it running.

This initial route accepts new Read Only text requests with no attachments,
project, delegation, knowledge sources or connectors. It uses the shipped Codex,
Claude and supported native API adapters (Gemini is excluded). Read Only agent
schedules with the same restrictions use the existing occurrence ledger, frozen
prompt and exact claim/bind/renew/finish path. Legacy research schedules retain
their existing runner. Requests with unsupported capabilities stay with the
desktop executor. This autonomous provider route exposes no command, file,
computer or connector tools, and it never approves an action. A provider tool or approval request
interrupts the attempt for explicit review and Continue in the app.
Follow-ups and steering also require the foreground Continue path; a native
turn never marks a new instruction delivered without actually supplying it.

`Work.executionOwner = "native-background"` selects this owner. Claiming,
checkpoints and completion check canonical Work identity and generation in the
same encrypted SQLite transaction; completion saves the assistant message and
terminal Work together. The renderer does not dispatch these records and its
disposal does not stop them. Reopening the app reads the same records. Stop
still changes the canonical generation, and the native loop observes that fence
at its next 250 ms check. It never publishes a result from a superseded attempt.
Completion checks durable background revocation in its storage transaction too,
so a terminal provider event cannot bypass Stop between polling ticks.
Views also discover new native schedules while idle, retry failed transcript
reads, and can refresh durable results if the control pipe disconnects. Account
suspension revokes background admission in its existing storage transaction;
an expired credential or failed Stop IPC cannot retain that authority.

An exclusive Windows file handle prevents duplicate account owners; a second
handle marks readiness only after startup recovery. An account-derived local
named pipe permits the current Windows logon SID, rejects remote clients and
verifies peer process image and logon session in both directions. Its bounded
control protocol carries only status and Stop. An owned
Windows Job contains the worker and its provider descendants, with 48-process
and 3 GiB limits and kill-on-close. No shell fallback, elevated service or job
breakaway is used. Restore/delete holds the owner fence and requires the worker
to stop before touching its storage.

Approved native commands use the lifecycle from PR #140, on which this PR is
explicitly stacked. `repository-run`, `repository-start`, `workspace-run`,
`workspace-start` and command inspection/Stop route to the same native tool
boundary inside the worker while background execution is enabled. The originating
provider's transient binding is checked before handoff; the worker independently
verifies the exact tool/arguments/workspace/agent/computer generation and consumes
the existing single-use permit. It cannot mint approval or enable a host shell.
A separate authenticated, generation-bound pipe carries these closed requests,
with 128 KiB request and 1 MiB response limits, eight connections and four
concurrent tool dispatches. Status/Stop has its own channel. An uncertain or lost
receipt requires inspecting the existing job; the bridge never retries it.

General settings refuses ownership transfer while foreground operations or jobs
are active. Idle job scopes release their existing owner leases before the
worker starts. Repository locks now include a cross-process file lease, retained
by persistent jobs for their entire lifetime. Computer generations and operation
IDs use short file fences; operation lifetime leases make Stop/drain observe
both processes. A new worker incarnation increments computer generations, while
reconnecting desktop views read them without revoking running jobs. Closing the
window cancels its own operations, leaving worker-owned tickets alive; explicit
computer Stop revokes the shared generation. Plugin disable, account expiry,
global pause and worker Stop are monitored independently of provider activity.
The worker's final launch/import commits also check durable worker revocation
inside the store transaction. The shared executor's snapshot/import/timeout and
descendant containment rules remain authoritative. Library uses the same native
job history/output/Stop implementation through this bridge.
An approved foreground tool can keep running after its originating provider view
closes, but that does not migrate the foreground provider conversation. On
reconnect, inspect its saved job and any imported output before continuing the
interrupted Work; neither the tool nor the provider request is automatically replayed.

There is one background attempt at a time, a 30-minute attempt limit, a 60 KiB
context limit and a 128 KiB output limit. Buffered provider events are bounded.
Output checkpoints are encrypted once per second. Stop, account revocation,
sleep gaps, provider errors, approval requests and process crashes require
review; no uncertain provider request is retried automatically. Restart fences
the previous generation and closes active attempts while retaining checkpoints.
There is no automatic crash relaunch or account-token refresh in this worker.
Those lifecycle extensions remain separate work. Native provider turns still
pause for tool/approval requests; command handoff covers already approved desktop
tool calls and their native job lifetime, not an unattended approval loop. The
stacked integration needs native compilation and real closed-window command and
provider acceptance; unit tests alone do not establish those capabilities.

The design was reviewed against T3 Code commit
`a4c9494b0e3606775cc5fc929fc138399288bd43`, especially
`docs/user/background-service.md`, `docs/internals/connection-runtime.md`,
`ProviderRuntimeRecoveryService.ts` and `BackgroundWorkStop.integration.test.ts`.
T3's documented service installer excludes Windows. Mivlet's implementation uses
its own Work records and Windows primitives; see Microsoft's
[named-pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
documentation. Cross-process fences use Rust's native
[file locking API](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock).

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
| `awaiting-approval` | Awaiting approval | Review the exact proposed action |
| `awaiting-user` | Waiting for you / Interrupted | Restart reasons show Interrupted; saved evidence must be reviewed before continuation |
| `completed` | Completed | A saved provider result and assistant message exist |
| `failed` | Failed | Terminal without a verified result; never authorizes retry alone |
| `cancelled` | Cancelled | Stopped by the user; completed external actions are not undone |

Schedule-derived Work carries `origin: "schedule"` and is labelled Scheduled
only while queued. Running and terminal occurrences show their actual state,
with schedule provenance as secondary detail. Agent automation occurrences
integrate into the unified Work list and details with their captured schedule
context and ordinary execution controls.

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
- **Dispose** is Stop for renderer-owned work: it freezes streams, rejects new
  serial work, and issues native `stop-work` immediately for `running` /
  `awaiting-approval` assignments, including orphans with no renderer session.
  Native background Work is excluded; explicit Stop still fences either owner.
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

Native confirmation runs off the command thread so Stop remains responsive while
the operating-system dialog is open. On resolution, a connection-first SQLite
transaction holds the native identity generation through commit. The audit,
standing rule (when requested), and exact execution permit commit atomically;
stale account generations or persistence errors cannot leave a usable partial
approval. Action history is observation after that commit. Tool consumption still
checks the exact request, target freshness and current execution generation, so a
late dialog answer cannot revive stopped work.

## Restart recovery and attachments

At startup, `collaboration::recover` leaves Work with a live native background
owner running and moves other active Work to `awaiting-user`,
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

New schedules default to agent workflows on connected shared-tool routes
(Codex, Claude SDK and direct APIs). A native occurrence stages private Work
with its frozen prompt, provider, model and reasoning effort. The permission
ceiling is the lower of the saved schedule and current agent levels; the global
mode and each exact tool approval still apply. The existing executor owns
tools, connectors, delegation, deliverables, Activity approvals and Stop.

Before provider egress the dispatcher binds the exact durable queued attempt
to its claimed occurrence. Every descendant checks the root occurrence lease
and enabled schedule before tool effects. Completion must match durable Work,
including fresh turns after delegation. Paused, expired or abandoned claims
cannot resume automatically; explicit continuation after reconciliation removes
the schedule claim and uses current user Work authority. Claim tokens remain
ephemeral and are never recorded in Work or model context.

Ordinary schedules run while Mivlet is open, online and the computer is awake;
the opt-in worker can own the restricted Read Only agent schedules above. The native
lease and occurrence ledger coalesce missed recurring slots and prevent replay;
this does not provide an offline or hosted worker. Existing schedules without an
execution kind default to read-only research and retain their restricted Codex
runner. Their project occurrences continue using `bind_schedule`/`finish_schedule`.

### Authenticated event triggers

Agent schedule settings include event source, selected payload fields, task
preview, protected signing-key reference, expiry, delivery history and
pause/remove controls. New triggers are paused. The main native window owns
configuration; a browser preview cannot receive events or save triggers.
Signing keys belong to the native protected-secret consumer for the exact
account/workspace/agent/trigger target. No plaintext key crosses the renderer.
This workstream builds on protected-secret checkpoint
`d95f0e4ced3ed9da0306c126c9eba0d5e8927f78`. Its narrow native consumer also
scrubs arbitrary signing values and their JSON spelling from selected event
text before the receipt is committed. Removing a bound key pauses the trigger;
key availability is checked again before claim and Work staging. The event
workstream adds no key getter or signer.

The opt-in listener binds `127.0.0.1` on the account's configured port. It
accepts only bounded JSON POSTs at `/events/<trigger-id>/<route-id>`, rejects
browser origins and query strings, and requires a signature even when a route
is known. Configuration changes serialize, and account teardown closes the
listener. Mivlet must be open, signed in, awake, and have the target workspace
active. Public sources require an independently configured HTTPS forwarder to
this loopback endpoint; Mivlet provisions no tunnel, cloud holding or remote
worker. Closed/sleeping/disconnected computers miss deliveries. Sources must
retry while their signed event is still fresh; no retrospective replay is
performed.

| Source | Authenticated identity and freshness |
| --- | --- |
| Signed JSON | `x-mivlet-event-source` equals the configured source ID; ID and Unix-seconds event time are covered with the raw body by HMAC-SHA256. |
| GitHub issues | GitHub raw-body HMAC; exact signed `repository.full_name` and `issue.updated_at`; issue payloads containing `pull_request` are excluded. |
| GitHub workflow runs | GitHub raw-body HMAC; exact signed repository and `workflow_run.updated_at`. |

For signed JSON, sign these UTF-8 bytes followed immediately by the exact raw
request bytes: `v1\n<source-id>\n<event-id>\n<unix-seconds>\n`. Set
`x-mivlet-signature: v1=<64-hex-HMAC>`, the three corresponding
`x-mivlet-event-*` headers, and `Content-Type: application/json`. Reuse the same
ID and body on redelivery. IDs accept ASCII letters/numbers/dots/underscores/
hyphens (128 bytes maximum). GitHub uses `x-hub-signature-256: sha256=<hex>`;
its delivery/event headers are not cryptographic proof, so replay identity
comes from the authenticated body. This follows
[GitHub's raw-body validation contract](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

Templates expose at most 12 unique dotted scalar paths (160 bytes, eight
segments maximum), using `{{body.issue.title}}` syntax. Arrays allow explicit
numeric indices. Whole objects, raw bodies, headers, query strings, scripts,
credential paths and unknown placeholders are excluded. Bodies are limited to
256 KiB, each selected string to 2,048 bytes, templates to 16,000 bytes and
produced requests to 32,000 bytes. Values are redacted and JSON quoted as
untrusted evidence; they grant no permission. A preview starts no Work. Events
older than the configured 1 minute–24 hour window or more than 30 seconds in
the future fail closed. Trigger expiry is absolute and must be configured
within 90 days.

Authenticated delivery inserts an encrypted, scoped pending receipt. A native
transaction claims it once through the existing occurrence lease and serial
capacity reservation. Ordinary Work then freezes the produced request,
provider/model/effort, event origin and minimum permission ceiling. Stop,
approvals, tool authority and recovery remain with the existing executor.
Changing a trigger invalidates old revisions; key/source changes or explicit
rotation replace the route. Paused/removed/expired deliveries do not replay on
resume. An expired claimed occurrence becomes interrupted, with no automatic
retry. Event receipt and trigger expiry are rechecked at admission and by the
root Work fence before effects. Unavailable providers leave pending receipts
until their freshness deadline.

History shows the latest 50 redacted deliveries, produced request, rejection
reason and canonical Work outcome/conversation link. No raw request, headers,
signature or signing key is persisted. Preview content expires after 24 hours
or displacement from the newest 50 entries; minimal replay digests remain for
seven days. Each trigger caps pending receipts at 128 and replay records at
10,000, refusing new delivery when full rather than evicting fresh replay
protection. Ingress additionally caps concurrent requests at eight, rate at
60 per trigger per minute, headers at 16 KiB/64 entries, and body reads at five
seconds. Retention sweeps run in the authenticated app for the active workspace
and at history/delivery access. The feature migration uses
`schema_meta['feature:event-automations']='1'`, preserving core schema v42 and
existing clock rows, relationships and indexes.

Behavioral references were reviewed in MIT-licensed T3 Code at snapshot
`a4c9494b0e3606775cc5fc929fc138399288bd43`; no T3 implementation was copied.
The server/relay/mobile/web chain is
[#15085](https://github.com/pingdotgg/t3code/pull/15085)
(`7dfb86a32be6ec064dd8988e1a3b44cc046ff958`),
[#15086](https://github.com/pingdotgg/t3code/pull/15086)
(`b070e52d3e6b49c98117249e5b3f0d46edce173a`),
[#15087](https://github.com/pingdotgg/t3code/pull/15087)
(`aee889b0e043fdc652e48850698d08ebc563d5bc`) and
[#15088](https://github.com/pingdotgg/t3code/pull/15088)
(`ea4b44343d3c8f71cf49a72a266d00eac7389435`). The offline-holding follow-up
[#15487](https://github.com/pingdotgg/t3code/pull/15487)
(`f33b060cafc96d7c3229744315c230a3b8d1f631`) was considered; this local-first
implementation has no corresponding relay or holding capability.

Saved results retain their originating conversation branch, assistant message,
and immutable message revision when available. The Work history action uses
that provenance to reopen the exact source; legacy results are resolved against
their run's saved assistant message when the workspace is loaded. Results can
be promoted into Memory through the baseline Memory interface
(`save_memory_state`) with explicit user-confirmed conclusion text, an owning
Agent or Project scope and run provenance. Only the new record is submitted,
preserving concurrent corrections and forget tombstones. P4 creates no
separate outcome store; P6 owns Memory internals and capture inheritance.

## Reusable Work components

`apps/desktop/src/components/work/` provides the P8 integration surfaces:

- `WorkStatusBadge` — status and origin labels,
- `WorkCard` — compact card (request, status, reason, attachments count,
  Stop/retry/steer; started Work never offers blind retry here),
- `WorkList` — unified sorted list over the same narrow callbacks,
- `WorkDetails` — original request, captured-context summary, steering
  history, attachments with recovery notes, runs/budget, saved results with
  promote-to-memory, and continue-with-reconciliation.

Components expose narrow callbacks (`onOpen` carries optional source branch,
message and revision provenance; `onStop`, `onContinue`,
`onSteer`, `onPromote`); the shell routes them. Chat shows compact Work cards;
Work mode provides the scoped list and Right Nav opens the selected Work details.
The obsolete History and Project WorkItems implementations have been removed.

## Verification

### Provider usage and reset continuation

The account Usage view shows only connected account providers and their reported
subscription windows, with percent used and reported reset times. API-key and
custom routes are excluded. Missing measurements remain unavailable; stale
measurements are explicitly marked. Its Settings link opens Usage breakdowns,
where token, model, cost and attempt details remain available.

Usage breakdowns are a derived view of the canonical encrypted attempt ledger, covering the
last 30 days including partial failed and interrupted attempts. It adds no
conversation or output store. Repeated streaming frames replace the current
provider turn's snapshot; distinct tool turns accumulate within that attempt.
Cached reads are included in input, cache writes are additive, and reasoning is
included in output. Missing categories remain unknown. Provider-reported amounts,
API-equivalent estimates and unpriced attempts stay separate. OpenRouter's
documented response `usage.cost` is provider-reported; Claude/OpenCode SDK prices
are estimates. Optional user-entered rates require an exact model, HTTPS source,
observation date and separate nonzero cache-category rates.
The ordinary embedded API host observes usage in the existing native response
stream and passes the same bytes/headers to its SDK. This observer keeps partial
receipts before failure, replaces per-call snapshots and deduplicates completed
steps; older unsupported wire data can retain SDK token measurements with unknown
cost. It does not add a remote call, buffer entire responses or collect transcripts.

The model-picker entry reads only cached allowance, and full history aggregation
is lazy. Each provider refresh is independent, retaining stale saved measurements
when collection fails. The native probe launches only the account-owned managed
Codex app-server (`account/read`, `account/rateLimits/read`) or Claude SDK
(`get_usage` control request); it submits no user prompt. Personal CLI profiles,
auth files and transcripts are never searched. Unknown protocol/runtime support
or unsupported routes report unavailable. Codex preserves provider-reported
bucket durations and optional reset dates; Claude's supported five-hour, weekly
and model-scoped windows are normalized to UTC. Measurements expire after five
minutes and reconnect/account changes invalidate their authority. Identity is an
opaque native hash; where no stable provider account ID is reported, the UI says
that only the managed connection is identified.

After a native typed provider limit failure, the user can request one continuation
for an exact exhausted allowance/reset opportunity and reconcile prior effects.
This choice is saved on existing Work. At the reset, fresh post-reset allowance,
provider identity and connection revision, latest failed run, Work/conversation generations, model,
project revision, participant and parent validity are checked. Admission consumes
the choice in the same transaction and calls ordinary `ContinueWork`, retaining
permission lowering, frozen context, fresh attempts and normal approvals. Stop,
steering, manual continuation, failed validation and restart require renewed
review. The app must remain open. There is no quota-turn retry loop or background
replay of external effects.

Behavior references were inspected at T3 Code commit
`a4c9494b0e3606775cc5fc929fc138399288bd43`: provider usage mapping and one-shot
reset recovery, plus PRs [15108](https://github.com/pingdotgg/t3code/pull/15108)
(model/category costs), [15149](https://github.com/pingdotgg/t3code/pull/15149)
(warm cached data), [16970](https://github.com/pingdotgg/t3code/pull/16970)
(provider filtering), and [17147](https://github.com/pingdotgg/t3code/pull/17147)
(independent loading). Mivlet retains its own native custody and Work authority.
Protocol sources: [Codex app-server](https://learn.chatgpt.com/docs/app-server)
and [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).
Fixture tests establish parsing, storage and admission fences; authenticated
provider/runtime acceptance and packaged desktop behavior remain separate gates.
### Interactive response presentation

The conversation renders one optional `openui` block using OpenUI's language
renderer and Mivlet's approved catalogue. The provider-neutral text profile is
`mivlet-v1`: comparisons, options, validated clarification forms, searchable
tables, labelled bar charts, checklists and draft previews. It uses existing
provider connections and ordinary streamed assistant text; no provider-specific
JSON mode, gateway or telemetry is required. Text-only clients retain the fenced
source. Providers still need an available authenticated text route; the renderer
does not provide one. Rich provider-native tool UI is handled separately by the
MCP Apps host.

The pre-parser rejects expressions, queries, mutations, unknown components,
cycles and excessive expansion before OpenUI interprets the content. Limits are
48,000 characters, 128 statements, 12 levels and 2,048 parsed/expanded nodes;
individual catalogue components have stricter row, field and string limits.
Incomplete streams remain display-only. Invalid source remains inspectable.
Generated forms cannot request credentials. The OpenUI renderer receives no tool
provider and observability publishing is disabled.

Interactive answers belong to an exact saved terminal message revision and its
native conversation/agent owner. The encrypted `conversation_ui` repository uses
compare-and-swap revisions. A deliberate review checks current branch ownership,
rejects duplicate selections and active-work races, then stages attributed text
in the composer. It never dispatches a tool automatically. Reopening a response
restores answers without generating another response or replaying actions.

Selection actions validate the literal passage against the saved revision before
staging Quote, Explain or Refine. Save to memory is an explicit call to the
existing scoped memory service. Work states come from durable runtime events;
restart-interrupted work requires review and reconciliation before continuation.
Handoff detail identifies sender, recipient and the frozen shared snapshot.

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
