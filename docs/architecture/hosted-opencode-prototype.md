# Embedded agents and optional hosted coordination

Status, 2026-09-10: the pinned OpenCode V2 native-provider path passes compiled
Windows and local Workerd fixture acceptance. The hosted fixture also passes
Agents scheduling, exact approval, cancellation and durable receipt recovery.
These results do not establish live provider access, deployment or continuation
of ordinary conversations while the desktop is offline.

## Runtime ownership

The native-only package `packages/agent-host` embeds OpenCode SDK/plugin
`0.0.0-dev-19449` in a Bun 1.3.3 executable. Rust verifies and launches it,
owns provider credentials and egress, binds screenshots, and stops the child.
OpenCode owns one model/tool loop per attempt. Mivlet supplies canonical history
and routes tools through existing authority and effect-receipt boundaries.
SDK state is ephemeral; conversations remain in the encrypted vault. The
[provider ADR](../adr/2026-09-03-provider-driver-registry.md) records retained
provider-owned and visual routes.

The independently installed hosted fixture has two SQLite Durable Objects:

- `FixtureTask extends Agent`, using Cloudflare Agents `0.22.0`, owns the fixed
  task, schedule, generation, approval and artifact receipt through durable state.
- `CompatibilityProbe` embeds `OpenCodeWorkerd` and owns the SDK session database
  and synthetic diagnostic markers. Its name comes from the immutable attempt ID.

They do not share storage. OpenCode's first migration rejects unrelated tables;
Agents creates its own schedule/state tables. No Mivlet product tables are
inserted into an SDK database.

## Compatibility resolution

The earlier custom `aisdk:mivlet-synthetic` hook failed before model execution
with `SessionRunnerModel.UnsupportedPackageError`, at both the earlier
`0.0.0-dev-19417` pin and selected `19449` pin. Native
`@opencode/ai/providers/openai-compatible` and
`@opencode/ai/providers/anthropic` work in the compiled Windows host. The
compatible native module also works in Workerd. No dependency internals or
Node compatibility shims were patched. The superseded custom Vercel language
hook and scratch Bun probe were removed. There is no second Vercel agent loop.

The Workerd fixture intercepts standard Fetch at an exact unique URL per attempt.
Only active registered fixture URLs are accepted; unknown network requests fail.
This deterministic transport is confined to the fixture and never supplies
production provider authentication.

## Bounded hosted task

The local API accepts fixed synthetic task IDs and exact approval payloads.
It accepts no prompts, credentials, account context, file paths or provider URLs.
The dataset is `alpha=2`, `beta=3`, `gamma=5`; the sole tool proposal is
`write_summary({dataset:"fixture-v1"})`.

1. The coordinator creates an immutable attempt and uses `Agent.schedule`.
   Explicit resume can recover a scheduled task.
2. A separate OpenCode DO performs two native model requests and one tool proposal.
   The tool returns an approval-required result without writing anything.
3. The coordinator persists an approval bound to task, attempt, generation,
   fixed account/workspace/agent, tool, argument hash, artifact hash and expiry.
4. Exact approval consumption writes the fixed UTF-8 artifact and receipt in one
   synchronous durable-state transaction. Replayed or changed approvals fail;
   repeated status reads return the same receipt.
5. Cancellation increments generation and removes approval authority before
   cancelling the schedule or SDK attempt. Late callbacks cannot commit.
6. Pending approvals and completed receipts survive restart. The SDK can read its
   saved session with zero new model/tool calls. Explicit resume of a task left
   running invalidates that attempt instead of replaying an uncertain action.

The independently checked artifact contains four lines (`alpha=2`, `beta=3`,
`gamma=5`, `total=10`) and a final newline. No arbitrary file write, Sandbox
process, browser action or Windows access is exposed by the fixture.

## Verification and limits

The [fixture README](../../apps/hosted-runner/prototypes/opencode/README.md)
contains installation, typecheck, packaging, acceptance and restart commands.
Checks cover actual SDK invocation, scheduling and explicit resume, exact and
changed/replayed/cross-scope approvals, cancellation, artifact bytes/hash and
durable approval/receipt recovery. Windows fixtures cover both native wire
families, denial, failure, delayed cancellation and plaintext-canary checks.
Native computer authority retains its Rust regression coverage.

The production hosted computer/browser runner remains separate. Its tokens
authorize computer operations; they do not establish task ownership, provider
delegation, budgets, canonical conversations or background approval.
Real hosted continuation still requires those contracts, hosted secret custody,
tools, retention policy, deployment and live validation. Local credentials are
never copied there. The fixture's loopback CLI guard is not production authentication.

Official contracts checked: [embedded SDK](https://opencode.ai/v2/docs/build/sdk/),
[Workerd](https://opencode.ai/v2/docs/build/sdk/cloudflare/),
[plugins](https://opencode.ai/v2/docs/build/plugins/),
[Agents scheduling](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
and [durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/),
alongside the selected packages' shipped declarations and implementation.
