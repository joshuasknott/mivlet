# Memory and bounded conversation context

The operator surface is **Settings → Memory**. There is no Knowledge settings
tab. `packages/knowledge` is the ingest/retrieve library for sources and
compaction; durable facts live as Memory records. Persisted sidebar ids
`Knowledge`, `Plugins`, `Connectors`, `Automations`, and `Schedules` reopen
Settings (`normalizeActiveItem` in `apps/desktop/src/lib/helpers.ts`).

Mivlet keeps a quiet conversation with named agents, so a model turn must not
replay the whole lifetime transcript. This document describes the P6 boundary:
explicit context budgets, recent turns, incremental durable summaries, scoped
retrieval of older history, and deliberate promotion into durable Memory.

Raw transcript records remain the source of truth. Summaries and retrieved
excerpts are derived, bounded, and labelled as untrusted prior evidence; they
never become user authority, approval, or tool permission.

## Context assembly

Renderer/package:

- `packages/knowledge/src/context/history.ts` splits a sanitized provider
  history into a verbatim recent suffix, the elided older range, durable
  summaries covering that range, and query-scoped retrieval excerpts. Slicing
  happens at turn boundaries and expands backwards so a retained tool result
  keeps the assistant call that produced it.
- `packages/knowledge/src/context/compaction.ts` folds only newly elided
  messages into a new bounded summary revision. It records the raw
  message/revision ids it covered, the derived memory ids, and monotonic
  revision numbers.
- `packages/knowledge/src/context/assemble.ts` accepts live summaries and
  retrieved history as additional prefix inputs, subject to their own explicit
  character budget, audience authorization and scope satisfaction.
- `apps/desktop/src/lib/conversation-compaction.ts` is the interactive
  orchestrator. When `planConversationContext` rejects a turn for
  `model-context-window` or `native-history-envelope`, it persists a summary
  revision through the native account store and retries with a bounded request.
  A persistence failure fails the turn closed; the full transcript is never
  sent as a fallback.
- `apps/desktop/src/lib/conversation-context.ts` remains the envelope planner:
  it estimates input tokens locally, reserves output tokens, and enforces the
  provider's reported context window and the Codex 64 KiB history envelope.

Budgets are explicit: recent turns, recent characters, summary characters, and
retrieval characters (`COMPACTED_CONTEXT_BUDGET` plus a tighter derived retry
budget). Character budgets split the history; the token estimator remains the
authority for the provider envelope. Provider-reported usage stays
authoritative over the local estimate.

## Durable stores and scopes

`apps/desktop/src-tauri/src/context_summaries.rs` owns derived summary
revisions in the account's encrypted private-document store
(`context-summaries.json`). No SQL migration is introduced; ownership is the
authenticated account scope, and scope levels are `thread`, `agent`, `project`,
`work`, or `global` with mandatory exact owner ids. A thread-scoped summary must
name its own thread. `live_summaries` excludes every stale record.

Raw history, summaries and durable Memory are separate stores:

- raw history: encrypted conversation repository (`conversation_*`);
- derived summaries: encrypted private document above;
- durable Memory: `memory-state.json` plus the owner-qualified `memory_record`
  repository, with the existing correction, disable, forget and export
  controls.

Memory scopes enforced by `collaboration/context.rs` and
`packages/knowledge/src/store.ts`:

- Agent Side Chats inherit account-global, Agent, and own-Chat memory;
- Project Chats inherit Project and own-Chat memory, not Agent/global memory;
- sibling conversations never inherit each other;
- Work captures additionally never inherit `work` memory for an id that does
  not exist yet.

## Corrections, forgetting and invalidation

`correct_memory_record` and `change_memory_record_state` invalidate derived
summaries before the memory write. A summary that ever folded a changed memory
record is marked stale with a reason and is permanently excluded from context
and inspection surfaces. Over-invalidation is safe: raw history remains, and an
explicit re-compaction writes a fresh revision from current records.
`removeMemory`/`forgetMemory` in the knowledge store continue to block
resurrection of forgotten records. The Memory settings view states that
corrections and forgetting invalidate derived summaries.

## Deliberate promotion

`packages/knowledge/src/memory/promotion.ts` provides the baseline interfaces
P3/P4/P5 call from an explicit user action:

- `promoteSideChatOutcome` selects a bounded set of decisions, corrections,
  preferences and facts from one Side Chat;
- `promoteCompletedWorkOutcome` selects the bounded request and public terminal
  results of completed Work only — never the execution history or raw tool
  payloads;
- `resolvePromotionScope` requires the exact owner id for narrow scopes and only
  widens to global when the caller explicitly chooses it;
- every returned record carries `approved: true`, `approvalState: "approved"`,
  provenance (`chat`/`run`), the owning scope, and a stable source label. The
  existing native save path remains the only writer.

## Failure recovery

- A compaction that cannot persist fails the turn closed with an explicit
  prerequisite; the original history is unchanged and the next attempt rebuilds
  from raw messages.
- A stale summary is never revived; the next fold inherits prior
  `derivedMemoryIds` so invalidation propagates across revisions.
- If even the bounded request exceeds the window, the turn fails with the
  existing continuation-handoff guidance instead of sending more history.
- Retry budgets only shrink the request; compaction never enlarges the history
  it sends.

## Provider boundary

### Explicit provider continuation

The conversation composer offers **Continue with selected model…** after the
user writes the next request. Select another connected model in the ordinary
picker to switch providers, or retain it for a fresh session. Stop active Work
first. The preview shows the actual native selection and requires review of
saved results and uncertain effects before admission. Draft attachments must be
removed for this text-only action; historical attachment bytes are never copied,
and the preview reports their missing references.

`collaboration/provider_continuation.rs` reads the canonical account/member
conversation and current scoped context. It preserves complete user/assistant
records, roles, sequence, revision provenance, partial public replies, and
completed `repository-run` results. It excludes tool calls, approvals, reasoning,
redacted records and other raw tool payloads. Original user constraints have
priority, followed by recent messages. Omitted records remain in the source
conversation. Tool-capable routes advertise `continuation-read`: native live Work
and run/generation checks fence paginated public source reads. Source edits or
redaction invalidate retrieval; it cannot select a different conversation.

The native budget charges UTF-8 bytes, JSON and attribution conservatively, caps
history at 16,000 bytes, reserves at least 8,192 tokens or a quarter of the window,
and accounts for the intact new request and captured context. Unknown model
windows use a labelled 32,768-token fallback. These are admission estimates,
not billed usage or guarantees for arbitrary tokenizers. The actual request is
checked again against the current model catalogue, actual tools and instructions
before dispatch. Prior-provider usage is never reused for a fresh session.

A fingerprint binds the preview to account, workspace, conversation generation,
source revisions, selected agent/model, request, admitted context and Work state.
The existing native Work command checks it atomically and persists the packet
with the ordinary encrypted Work record. Reusing an admission ID cannot enqueue
another run. Stop, provider prerequisites, current identity, execution generation,
approval and attachment authority remain in the existing worker. Restoring saved
Work does not itself run a provider or replay effects.

The currently installed desktop adapters do not expose a durable native-resume
contract. In particular, native Codex startup explicitly uses ephemeral threads;
its shared adapter's `resumeThread` method does not establish persisted native
resume. Continuation therefore uses **portable-fresh-session**, with truthful
wording rather than claiming native resume. No dependency or SQL migration is
needed.

Reference review: T3 Code commit
`a4c9494b0e3606775cc5fc929fc138399288bd43`, specifically
`ContextHandoffService.ts`, `ContextHandoffBudget.ts`,
`ContextHandoffDelivery.ts`, their tests and `docs/user/portable-handoffs.md`.
The official path history identifies introduction in merged PR #2829, commit
`de343914273eceb852a1d1d739cd1d38df7796ee`.
This is a Mivlet implementation of the behavior, not copied source. Official
[Codex App Server](https://developers.openai.com/codex/app-server/) and
[Claude session](https://platform.claude.com/docs/en/agent-sdk/sessions)
contracts were reviewed; their resumability does not override Mivlet's current
ephemeral native session policy.

Concurrent integration: this branch starts at `77f661c3`, independently of the
conversation UI branch. Continuation consumes the context capture's
`contextSelection.includeHistory` flag when present. When integrating that
branch's selected-history repository, change the two continuation source reads
to its canonical selected-branch reader alongside context capture; do not allow
unselected alternative answers into continuation. Preserve the UI branch's
native exclusion checks and its existing context control. Read-only review of
`codex/conversation-upgrade` at `c5b90d0c` confirmed the compatible signature
`message::list_selected(conn, store, scope, thread_id)`. Replace `message::list`
in `provider_continuation::prepare` and `provider_continuation_read::read` with
that function during integration. Preview fingerprints and retrieval digests
must both cover the same selected path. Add an integration regression with two
alternative answers and an excluded-history selection before merging; the
standalone baseline has neither branch selection nor that control.

Local validation checkpoint (2026-10-08): desktop typecheck and production
build, protocol parity/build, connector build and 79 distinct focused tests
passed, including single-worker continuation, worker, recovery, cancellation
and provider runs. Desktop and
390px review controls were inspected with synthetic native responses; no live
provider was called. Security lint, explicit-any, formatting, dead-code and
dependency-cycle checks passed.
The initial native compilation was interrupted and the pre-stack bundle
exceeded its ceiling. After inheriting the separate dependency-audit and style
compaction fixes, exact revision `93fb8ab7` passed
[full validation](https://github.com/joshuasknott/mivlet/actions/runs/37837485639),
including native tests/Clippy, encrypted-store close/reopen/recovery and unchanged
performance budgets. Those earlier gates are resolved.

Subsequent focused acceptance compiled the real control and application CSS
through the production style transform in an isolated 42-module fixture.
Desktop (1280px) and narrow (390px), light/dark, long provenance, empty history,
empty draft, delayed stale preview, preview failure, admission denial, review
gating, Cancel, simulated Stop and successful simulated admission were inspected.
A keyboard focus loss after denial was reproduced and fixed: review completion
focuses the preview region, while preview/admission failure returns focus to the
trigger. Five focused component tests pass after that correction. No horizontal
overflow or browser errors were observed; action targets remain 44px high.
Transport and provider were explicitly simulated. Selected-branch integration,
installed-app behavior and live-provider acceptance remain separate requirements.

Summarisation is deterministic and local. No provider is called by the
compaction pipeline, so a conversation can never be summarised by a different
provider than the one that owns the turn. Provider credentials remain in native
custody and never enter the renderer through these paths. A future
provider-backed summarizer must route through the exact conversation provider
and record its own derivation metadata.
