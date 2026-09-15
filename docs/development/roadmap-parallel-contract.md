# Parallel roadmap implementation contract

This records the account and collaboration contracts used by the September 2026
roadmap integration. The P1–P8 ownership allocations below describe that completed
integration, not instructions to restart those workstreams. Use the current
README for delivered behaviour and remaining limitations; hosted sync remains
deployment-gated.

## Account ownership

`apps/desktop/src-tauri/src/account_session.rs` pins one native process to the
validated Clerk issuer + subject from `native_identity_generation_snapshot`.
The renderer cannot supply account authority. `paths::app_data_dir` resolves
`accounts/<binding>` beneath the effective installation/portable data root.
Native invoke admission and `Store::{with_conn,transaction}` revalidate identity;
transactions check again before commit. `authorized_scope::resolve` supplies the
private principal. Workspace/object IDs select within that authority, never grant it.

Agents, Projects, Chats, Work, Memory, sources/files, settings, drafts, layouts,
history, schedules and search inputs use the account's database/root. Vault,
provider, connector and MCP secrets use account-keyed OS credential entries.
Native renderer state never adopts or mirrors installation localStorage; theme
uses encrypted `account_theme` preferences. Preview storage remains fixture-only.

Logout/switch/expiry blocks admission, destroys the WebView (voice, callbacks and
caches), cancels provider activity, closes supervised provider trees, releases
computer control, invalidates saved approvals, pauses enabled schedules and marks
unfinished Work `awaiting-user` with a new generation. The app then restarts;
a different account cannot activate in the outgoing process. OAuth/refresh writes
compare identity generations. Suspension failure exits instead of opening another
workspace. Switching currently requires sign out/restart/sign in, not hot switching.

Ambiguous installation data, files, backups and keys remain untouched in their
original locations. Signing in never claims them. Account backup/restore/deletion
resolves the bound root; a different account's backup fails vault authentication. Restored backups pause
schedules and invalidate saved permits before activation.
Local-data deletion does not delete another account or ambiguous legacy data;
provider disconnection/credential deletion remains a separate existing operation.

Provider custody: Codex uses private `CODEX_HOME` and required keyring auth; Claude
on Windows/Linux uses private `CLAUDE_CONFIG_DIR` with inherited auth overrides
removed; Antigravity retains its private `GEMINI_HOME`/file credentials. Windows
children use `provider_process::SupervisedChild` kill-on-close Jobs. Cursor, Grok,
OpenCode managed routes and macOS Claude fail admission until their provider-owned
credential stores have verified isolation. They never fall back to personal CLI
authentication. Direct API credentials remain account-keyed. References:
[Codex auth](https://learn.chatgpt.com/docs/auth),
[Codex keyring namespace](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs),
[Claude auth](https://code.claude.com/docs/en/authentication).
These are data/credential boundaries: native computer use still shares the user's
Windows desktop and retains exact approvals, foreground rules and immediate Stop.

## Shared interfaces and decisions

Below, renderer paths are relative to `apps/desktop/src/`; native paths are relative
to `apps/desktop/src-tauri/src/`.

- `packages/protocol/src/domains/collaboration.ts` exports `ChatBinding`,
  `ConversationRoom`, `ProjectTeam`, `CollaborationWorkItem`, `WorkSteering`,
  `CapturedWorkContext`, `ContextShare`, `ObjectReference`, `CollaborationCommand`
  and `CollaborationSnapshot`. Native equivalents are in `collaboration/models.rs`.
- `runtime/domains/collaboration.ts` exposes `loadCollaboration(workspaceId)` and
  `commandCollaboration(workspaceId, command)`. Native `collaboration_load` and
  `collaboration_command` transact through the encrypted repository.
  `lib/workspace-execution.ts` supplies the observable service, `submit`, `steer`,
  stop/continue and generic command operations. Components consume its snapshot;
  no parallel Work queue or direct renderer record replacement.
- `open-main-chat` validates the Agent and atomically opens one deterministic Chat
  in `collaboration/chats.rs`, including concurrent opens. `create-conversation`
  creates Agent/Project Side Chats. A proven Project `threadId` is its main Chat;
  its Team belongs to that Project. Unclassified old Chats are not guessed to be main.
- Project coordinator is optional (`leadAgentId`/`facilitatorId`). Without one,
  the submitter explicitly chooses a current Team participant. Native `start-work`
  requires and validates `agentId`; no automatic all-member response, round-robin
  or provider fallback. P5 supplies selection UI.
- `start-work` preserves the original request separately from a context snapshot,
  captured transactionally by `collaboration/context.rs`: at most 24 terminal
  messages/20k characters from this Chat, Agent instructions (8k), 12 learned tasks
  (500 each), Project instructions (6k), 12 confirmed Project facts (500 each) and
  12 approved scoped memories (500 each). A final 200k-byte ceiling bounds serialized metadata too; these are not token guarantees.
- Agent Side Chats inherit that Agent's durable instructions/learned tasks, approved
  account-global/Agent memory and own-Chat memory. Project Chats inherit Project
  instructions/confirmed facts, approved Project/own-Chat memory and the selected
  Agent's instructions/learned tasks. No sibling transcripts or automatic memory
  promotion. P6 summaries must retain these scopes, provenance and bounds.
- `ExecutionWorker` consumes captured context plus this Work's own run history.
  Later unrelated Chat is excluded. Same-Chat delegation inherits the parent's
  frozen transcript/Project facts; focused Side Chat delegation receives its bounded
  assignment and own context, not the parent's transcript. Explicit related Work
  results remain live dependency edges within that root request.
- `steer-work` checks an expected generation and idempotent event ID, preserves the
  original request, appends steering and invalidates descendants. Already-dispatched
  Work requires outcome review. `continue-work` requires reconciliation of the latest
  generation and a fresh attempt, never replay of old effects. Legacy Work without
  a capture gets one only on explicit reviewed continuation.
- `awaiting-user` plus saved reason/attempt evidence represents uncertain effects or
  interruption. `failed` alone never authorizes retry. Safely retryable means native
  evidence proves dispatch/effects did not occur; otherwise reconcile outcomes.
  Preserve run IDs, outputs and usage. Closing views cannot change execution ownership.
- `ExecutionContextScope`/`KnowledgeScope` support account `global`, `agent`,
  `project`, `thread` and `work`; narrower levels require exact nonempty IDs.
  `packages/knowledge/src/store.ts` filters retrieval; native `memory.rs` validates
  scope rather than widening records to global. Promotion/sharing requires explicit
  user action and retained provenance, never summarization/close/completion alone.
- `ObjectReference = {workspaceId, kind, id}` identifies a domain object, not a title,
  pane or permission. Resolve only in the active native account; cross-session caches
  require the validated account binding and transition clearing.
  `lib/conversation-layout.ts::referenceForView` bridges existing Chat/file views.
  Current file identity is Agent + output path inside the account root, not an
  arbitrary readable host path. P7 returns these references; P8 routes them.
- `ContextShare` distinguishes immutable snapshot bytes/source revision from an
  explicit live reference resolved/authorized on each deliberate use. Source edits
  cannot alter a snapshot; live references can become unavailable. Neither conveys
  tool authority, follows siblings or promotes memory. Work transcript uses snapshots;
  selected Project sources and related Work results remain explicit scoped live reads.
  This is a shared type, not a new generic sharing/lookup service.

## Exclusive implementation ownership

Each row owns its leaf code and colocated tests. New leaves stay in that domain.
P8 owns final global layout styling; feature leaf styles belong to their track.

| Track | Owned paths (renderer/native shorthand above) |
| --- | --- |
| P1 Plugins | Renderer `components/marketplace/**`, `components/PluginPanel.tsx`, `components/pages/MarketplacePage.tsx`, `styles/marketplace.css`, `lib/builtin-plugins.ts`; native `token_plugins.rs`, `local_computer/plugins.rs`. Catalogue/cards/modals here; credential custody stays frozen. |
| P2 Composer/Voice | Renderer `components/Composer.tsx`, `components/ComposerInput.tsx`, `components/ModelPicker.tsx`, `components/voice/**`, `hooks/useComposerVoice.ts`, `hooks/useVoice.ts`, `hooks/useScopedComposer.ts`, `shell/composer-models.ts`; native `native_voice.rs`, `native_speech.rs` feature behavior, preserving account shutdown. |
| P3 Main/Side Chats | Renderer `shell/ConversationPane.tsx`, `hooks/useDurableConversation.ts`, `hooks/useConversationScroll.ts`, `lib/conversation-runtime.ts`, `lib/conversation-presentation.ts`, `components/conversation/**` except P8 Tabs; native `conversations.rs`, `collaboration/chats.rs`, `store/repos/thread.rs`, `store/repos/message.rs`, `store/repos/draft.rs`. P3 integrates P2 controls through props. |
| P4 Work | Renderer `lib/workspace-execution.ts`, `shell/ExecutionWorker.tsx`, `shell/useExecutionController.ts`, `hooks/useLocalScheduleDispatcher.ts`, `components/projects/WorkItems.tsx`, `components/settings/LocalSchedules.tsx`, `components/agents/SchedulesDialog.tsx`, `runtime/domains/local-schedules.ts`; native `collaboration/work.rs`, `collaboration/schedules.rs`, `local_schedules.rs`, `store/repos/local_schedule.rs`. New Work UI: `components/work/**`. |
| P5 Projects/Teams | Renderer `hooks/useLocalProjects.ts`, `runtime/domains/local-projects.ts`, `components/projects/ConversationDialogs.tsx`, `components/projects/ProjectContextPanel.tsx`, `components/projects/ProjectFiles.tsx`, `components/projects/projects.css`; native `local_projects.rs`, `store/repos/local_project.rs`. New Team/Project leaves stay in these domains. |
| P6 Memory/compaction | `packages/knowledge/src/**`; renderer `lib/collaboration-context.ts`, `components/settings/MemoryRecords.tsx`, new `components/memory/**`; native `memory.rs`, `collaboration/context.rs`, `store/repos/memory_record.rs`. |
| P7 Search | New renderer `lib/search/**`, `runtime/domains/search.ts`, `components/search/**`; new native `search.rs`/`search/**` if needed. Scoped reads over existing repositories, stable references and reusable results, no replacement stores. |
| P8 Navigation/activity | Renderer `App.tsx`, `shell/DesktopShell.tsx`, `shell/TeammateWorkspace.tsx`, `shell/teammate-workspace.css`, `components/agents/AgentSidebar.tsx`, `shell/ConversationPane.tsx`, `components/conversation/ConversationTabs.tsx`, `lib/conversation-layout.ts`, `hooks/useConversationDrag.ts`, global/navigation layout styles. |

P8 composes P1 catalogue, P2 controls and P3–P7 reusable domain components through
props/services. It must not reimplement their modals, stores, Work dispatch, context,
compaction, search or authority. Components expose narrow open-object/submit/steer
callbacks; the shell routes them. View actions only change view state.

## Shared seams, migrations and integration

Baseline-stable files: native `account_session.rs`, `authorized_scope.rs`, `paths.rs`,
Store core/keys, credential namespaces and `provider_process.rs`. No track weakens
account authority to make a feature work. Renderer `hooks/useShellRuntime.ts`,
`hooks/useNativeAgent.ts`, native `collaboration.rs`, `collaboration/commands.rs`,
protocol/native models and runtime adapters/ports are integration seams, not jointly
rewritten files. Put behavior in owned leaves. The introducing track owns only its
additive imports/exports, command variant/dispatch arm and adapter method. P4 owns
execution glue, P6 context assembly glue, P8 shell composition. P2 supplies a small
agreed integration hunk to P3's pane. Rebase shared hunks and retain existing variants.
Native registration `src-tauri/src/lib.rs` receives only the introducing track's
additive module/handler entry; preserve the central invoke guard.

The inspected SQL schema is **42** (`store/schema.rs`, `store/migrations/mod.rs`).
No new SQL version is needed here: Chat binding and captured/steered Work extend
existing encrypted `collaboration_record` payloads with optional/defaulted fields;
main Chat uniqueness uses transactional primary keys. Existing v41-to-v42 behavior
remains. Account partitioning happens before opening the database, not through a
migration assigning old rows to the next signer.

P1–P8 may add compatible optional domain payload fields without changing old field
meaning. Native handlers load/modify/write their fields; do not overwrite records
with partial renderer snapshots. Add old-record decode/round-trip tests. SQL schemas,
migrations, generated Convex/Tauri schemas and the lockfile are serialized resources:
no speculative migration numbers, parallel DDL or hand-edited generated schemas.
If needed, land a separate prerequisite migration PR based on the then-current schema
head before affected tracks use it; they rebase on that migration. P7 starts with
scoped reads rather than an uncoordinated index migration. Dependencies are added
only by the introducing track through pnpm and a reconciled lockfile.

All tracks can start against these interfaces from the merged baseline. P8 can
build immediately, but final integrated acceptance depends on P1–P7 components;
placeholder UI is not final acceptance. Merge PRs sequentially, reconcile shared
seams and run affected gates. This contract does not create an ongoing coordinator.

## Verification boundary

Native tests cover separate account vaults/backups, preserved ambiguous legacy data,
unauthenticated Store denial, identity generation rejection, main Chat concurrency,
bounded transcript capture, optional coordinator, steering/suspension and Windows
process descendant cleanup. TypeScript covers native localStorage non-adoption and
exact Memory scope retrieval. Existing migration/recovery/approval tests remain.

Real two-account Clerk login/logout/expiry, provider OAuth/keyring profiles, microphone
teardown and packaged restart remain separate manual/live acceptance. Tests do not
establish those outcomes. Blocked managed provider routes above cannot receive live
acceptance until custody is implemented; domain tracks can start using available
validated routes. No services or installers are deployed/published by this baseline.
