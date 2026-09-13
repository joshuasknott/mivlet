# Memory and bounded conversation context

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

Summarisation is deterministic and local. No provider is called by the
compaction pipeline, so a conversation can never be summarised by a different
provider than the one that owns the turn. Provider credentials remain in native
custody and never enter the renderer through these paths. A future
provider-backed summarizer must route through the exact conversation provider
and record its own derivation metadata.
