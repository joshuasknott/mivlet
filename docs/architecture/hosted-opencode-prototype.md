# OpenCode hosted-agent evaluation

Status: **local compatibility gate blocked**, evaluated 2026-09-10. No deployment,
paid resources, real provider calls or native Windows changes are part of this
work. The [reproducer](../../apps/hosted-runner/prototypes/opencode/README.md)
is retained separately from the production runner. No verified agent-generated
artifact was produced; the implementation design below remains proposed.

## Existing foundation and choice

The [hosted computer architecture](hosted-teammate-computer.md) already provides
deployment-gated Sandbox process execution and Browser Rendering operations,
computer/browser Durable Object authorities, request deduplication, generation
checks, signed short-lived computer capabilities and service authentication.
It does not provide a durable hosted conversation loop, account-to-task ownership,
provider delegation, recurring execution or desktop-offline continuation.

The local OpenCode integration is a native-managed, authenticated loopback CLI
server with session/event transport and Mivlet approvals. It is not an embedded
Worker SDK. Reusing that process, local credential store or desktop conversation
data would cross a boundary that this prototype has not been authorized to cross.

| Approach | Adds | Mivlet still owns | Decision |
| --- | --- | --- | --- |
| Embedded OpenCode V2 in a dedicated DO | Session storage, model/tool loop, events and SDK interruption | Account/task ownership, delegated provider access, exact approvals, budgets, effect receipts and recovery policy | Test in isolation; defer adoption at this pin |
| Extend existing Mivlet runtime | A thin durable task controller and portable provider-loop adapter | The same security and scheduling boundaries, plus checkpoint/replay/event implementation | Viable fallback; audit portability before moving local loop code into a Worker |
| Existing Sandbox worker alone | Linux process/browser execution | The entire hosted agent lifecycle | Execution tool plane, not an agent orchestrator |

The embedded SDK was selected for the compatibility experiment because it offers
the missing session loop without launching a CLI process. Its substantial preview
dependency graph and failed model-hook path currently outweigh that benefit for
production. Keep the existing runner intact. Resolve the minimal reproduction
against a supported SDK configuration or a newer explicit pin before adopting it;
do not patch npm internals or weaken Mivlet controls to force it to run.

## Verified compatibility and limits

The published `@opencode/sdk` and `@opencode/plugin` dev tag resolved to
`0.0.0-dev-19417`. This is the V2 embedded package, distinct from the V1
`@opencode-ai/sdk` network client. The probe pins those exact versions, Effect
`4.0.0-rc.112` transitively, TypeScript `5.9.2`, Wrangler `4.130.0` and workers
types `5.20260908.1` in its own lockfile.

The existing runner's installed Wrangler `4.105.0` could bundle the initial probe,
but its local workerd supported compatibility dates only through 2026-07-02 and
could not boot the configured 2026-08-28 date. The isolated newer Wrangler boots
that date. The existing runner's pin and compatibility date were not changed.

The SDK host boots, creates a session and persists it, but the selected synthetic
AISDK plugin path fails before a model invocation:

```text
pluginSetups: 1
modelCalls: 0
toolCalls: 0
outcome: failed
SessionRunnerModel.UnsupportedPackageError: aisdk:mivlet-synthetic
```

Both global plugin registration and documented per-session `instances.configure`
were tried in the scratch probe with awaited registration. Setup executed; neither
reached the synthetic SDK/language hook. The retained reproducer uses global
registration. This establishes a blocker for this credential-free adapter path
at this pin; it does **not** establish that every built-in provider is incompatible.
The underlying cause has not been attributed to an upstream defect.

An earlier scratch configuration used unprefixed `@ai-sdk/openai-compatible` as
a provider package and entered `Npm.add`/`Provider.loadPackage`, failing with
`ReferenceError: __dirname is not defined`. V2 uses `aisdk:` for AISDK packages
and has its own native provider modules. That configuration error is not the
retained blocker and must not be used to justify a global `__dirname` shim.

A second confirmed constraint: creating a Mivlet SQL table before first SDK boot
caused `Database is not empty and has no session table`. The installed SDK's
database migration checks for existing non-internal tables. Keep a dedicated SDK
database and a separate Mivlet authority DO; do not depend on migration order or
write Mivlet records into SDK-owned SQL tables. The reproducer only adds diagnostic
KV markers after SDK initialization.

Evidence from the final local run:

| Check | Result |
| --- | --- |
| Probe TypeScript | Pass |
| Probe Wrangler dry-run | Pass; 20,923.30 KiB raw / 3,642.86 KiB gzip |
| Worker input/origin rejection and duplicate request fence | Pass |
| Cancel endpoint after failed session | Pass; active-turn cancellation unverified |
| Actual SDK model/tool loop | **Fail**, gate exits 1 and `/run` returns 422 |
| Full local dev-process restart | Pass: new object boot, same session ID, SDK reads saved session, zero model/tool calls |
| Active-turn eviction, resume, exact artifact write | Unverified; blocked before model execution |
| Existing hosted-runner tests | 28 pass |
| Existing hosted-runner typecheck | Pass |
| Existing hosted-runner build | Pass |

Persistence of a failed session is not automatic continuation. The SDK's installed
Workerd API comment describes a boot-time suspended-session replay sweep; that
behavior was not proven by the restart test. A future task controller must fence
replayed model and tool callbacks before they can spend or affect external state.

## Bounded task implementation design

The following is the smallest proposed functional slice after the gate is fixed.
It requires no Sandbox, browser, R2, real account, conversation or provider key.

Use a fixed synthetic fixture with three records: `alpha=2`, `beta=3`, `gamma=5`.
The model receives only that fixture and the instruction to call `write_summary`
with `{dataset: "fixture-v1"}`. The tool validates this exact argument, calculates
the three-record total of 10 itself and proposes one UTF-8 Markdown artifact.
Verification compares the exact bytes and SHA-256 against an independently
calculated expected summary. Generated prose is not the success condition.

1. A Mivlet `TaskAuthority` DO owns a task and its SQL ledger. Bind account,
   workspace, conversation, agent, task, immutable attempt ID and monotonically
   increasing generation. In the local fixture these IDs are fixed synthetic
   constants; in production only verified account authorization creates them.
2. An `AgentAttempt` DO owns only the SDK database. Derive its name from the
   authority-issued immutable attempt ID, never from an untrusted session ID.
   A new attempt uses a new SDK session. Expose only the summary tool and remove
   shell, browser, filesystem, network tools, delegation, MCP and dynamic plugins.
3. Before every provider/model call, obtain authority for that exact attempt and
   generation. Limit the fixture to three model steps, one artifact write, 256
   output tokens per step and 15 seconds of active execution. Production also
   reserves a monetary budget before a provider call. Persist usage across retries.
4. Before the tool effect, store `paused_approval` with approval ID, principal,
   task/attempt/generation, exact tool name, canonical argument hash, proposed
   artifact hash, one-use nonce and expiry. Return this state to Mivlet and stop
   the SDK turn. A model-supplied approval or a different conversation cannot grant
   it. The pause consumes no active execution lease and cannot silently resume.
5. An authorized approval consumes that exact pending decision once. Resume as a
   new fenced attempt with a newly bound one-use write authorization. Expired,
   stale, mismatched or already consumed approvals do not perform a write.
6. The authority synchronously checks the live generation and consumes the write
   authorization in the same SQL transaction that inserts the artifact and receipt.
   Key the logical effect by task/tool/argument hash, independently of SDK call ID.
   An exact duplicate returns its existing receipt and bytes; conflicting arguments
   fail. This is atomic only because the artifact is in the authority's own SQL
   storage. Future Sandbox/connector effects need an outbox and reconciliation;
   an unknown result is never automatically retried.
7. Cancel increments the generation and invalidates the active lease and pending
   approval before requesting SDK interruption. Late model/tool callbacks must
   fail the authority check. On authority restart, running work becomes
   `interrupted`; paused work stays paused and unconsumed approvals are revalidated.
   On attempt restart, replay cannot obtain an execution lease automatically.
   Only an explicit Mivlet resume creates the next authorized attempt. If the
   artifact transaction committed before interruption, reconcile its receipt and
   finish without repeating the write.

Minimum regression matrix: initial pause/no artifact, exact approval/write/hash,
approval replay, wrong owner/workspace/conversation/agent/task/generation/arguments,
expired approval, concurrent duplicates, cancellation before and during a delayed
model/tool call, deadline/step budget across retries, crash before write, crash after
commit before response, and restart while paused. Use real local workerd storage
for transaction/restart tests. A synthetic model proves orchestration only; live
provider acceptance is a distinct later gate.

## Production boundaries and smallest deployment plan

Mivlet account identity remains in its account/Convex boundary. The existing
computer capability does not establish conversation ownership or authorize
provider spend; introduce a scoped task delegation contract rather than repurpose
it. Credentials remain in native or deployment secret storage. A hosted task needs
an explicit short-lived, revocable provider delegation with account, provider,
scope, budget and expiry. Neither local OpenCode authentication nor a local API key
may be copied implicitly. SDK transcripts, raw diagnostics and storage exports
must not contain secrets.

Mivlet owns canonical conversation ordering, consent to upload selected context,
task status and durable effect receipts. SDK session IDs are internal mappings,
not account identifiers. Define retention/deletion, encryption, region, tenant
isolation, event redaction and reconnect reconciliation before real user data.
Define CPU/wall-time/cost limits, provider retry policy, abuse controls, monitoring,
SDK schema upgrades and rollback before background execution.

The smallest reviewable deployment proposal, after the local gate and regression
matrix pass, is one private staging Worker with two SQLite DO classes
(`TaskAuthority`, `AgentAttempt`), the fixed fixture and a synthetic provider.
Use a separate staging name/namespace, no public route, no Sandbox/Browser/R2
bindings and no real credentials. Review the exact Wrangler manifest, bundle size,
required account plan, quotas, migration, authentication and rollback/cleanup
before requesting deployment authorization. Then verify staged pause/approve,
cancel, deduplication, artifact hash and controlled restarts. Only a separately
authorized next slice should add one delegated real provider and measured spend.
No part of this deployment plan was executed.

OpenCode and Durable Objects do not supply a desktop. Sandbox provides a separate
Linux execution environment if added later; it does not control native Windows or
an offline user's PC. Native computer approvals, focus/control leases and Stop
remain independent.

## Current sources

- [OpenCode V2 embedded SDK](https://opencode.ai/v2/docs/build/sdk/)
- [OpenCode Cloudflare SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare/)
- [OpenCode plugin API](https://opencode.ai/v2/docs/build/plugins/)
- [Durable Object state and lifecycle](https://developers.cloudflare.com/durable-objects/api/state/)
- [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)

Package behavior above is based on the installed exact preview pin, not a promise
that a later dev tag has the same API or failure.
