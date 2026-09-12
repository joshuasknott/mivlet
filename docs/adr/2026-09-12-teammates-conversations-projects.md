# Teammates, conversations, and coordinated local projects

Status: Integrated locally. PR #49 remains draft pending the compressed bundle
budget and remaining live artifact acceptance. No deployment or merge is included.

## Decision

Agent profiles remain the identity, instructions, skills, avatar, and provider/model
source. Conversations have their own durable IDs, membership, drafts, history, and
facilitator. An optional project owns a lead role assigned to an existing agent,
participants, related conversations, explicit shared references, work, and decisions.
The project's original thread remains its main conversation.

Execution belongs to an app-lifetime coordinator, never a tab or selected agent.
Each assignment captures workspace, conversation, participant, provider/model,
generation, parent, dependencies, and budget. The existing `useNativeAgent`, provider
adapters, embedded OpenCode host, canonical writer, and native approval/computer
boundaries remain the execution path. Headless execution workers are independent of
views. No additional agent framework is installed.

## Coordination and authority

An unaddressed shared request goes to its facilitator (the project lead in the main
conversation). Explicit recipients select a participant; discussion invites relevant
contributions rather than an unconditional round robin. A participant can request
bounded assignments, questions, and reviews through Mivlet-owned collaboration tools.
Results wake the requester for synthesis. Handoffs are contributions to the original
user request, never new user authority. Delegation cannot widen permissions, retrieve
private conversations, or access another agent's computer files.

Assignments and transitions persist before dispatch. Native checks bind attempts to
the exact live work item and immutable author, reject duplicate dispatch and stale
callbacks, and enforce membership, dependency, depth, turn and usage limits. Provider
capacity queues are visible; an agent has one active execution at a time. The app
admits three executions globally and at most two on a bridged Codex/native API
provider. Other provider-owned routes serialize; group tools require the existing
Codex or native API response bridge. Native Windows control retains its
installation-wide exact window lease. Stop freezes dispatch and streams, revokes
computer control, flushes accepted output and then invalidates native generations.
Late callbacks cannot dispatch follow-up work. Work in other conversations
continues. The lead is free to accept steering while its children execute.

Each exchange permits twelve execution turns, twelve work items, four children
per assignment and delegation depth two. Each execution uses at most six provider
steps and requests a 2,048-token output ceiling where the provider supports it.
The root stops further dispatch after 128,000 reported input/output tokens; this
is an admission budget, not a billing guarantee for an already running request.
Unknown usage reserves 8,000 tokens. An explicit continuation retains usage and
adds six execution turns and 128,000 tokens. A continuation must use saved results
and reconcile uncertain effects instead of repeating prior actions.

## Context and durable records

Private conversation context never follows an agent into a group or project. Shared
turns receive bounded conversation history, explicit project references, selected
facts/decisions and assignment results. Agent-authored facts are inferences unless
confirmed by the user; corrections supersede prior facts and invalidate affected work.
Forgetting removes text from retrieval. Provenance identifies the source conversation,
message or execution. External observations remain dated and can be marked stale.

Adding a participant explicitly shares the existing group history and project context.
Removal cancels that participant's assignments, removes future dispatch eligibility,
and retains historical authorship. Model/lead changes retain history, invalidate stale
assignments, and require a fresh attempt using current configuration.

Schema v42 adds encrypted, installation-member-owned conversation metadata, work,
facts and layout. Existing threads, messages, attachments, projects and author rows
are preserved. A native adoption step reads persisted agent references; ambiguous
legacy conversations stay visible with an unavailable participant, without guessing
their owner. Legacy projects keep their main thread and existing sharing audience.
No retired orchestration tables or abandoned branch data are revived.

Restart restores in-flight work as interrupted/awaiting the user. It does not replay
provider sessions, consumed approvals, tools, or unknown external outcomes. Explicit
continuation uses a fresh attempt and a checkpoint; uncertain effects must be
reconciled. Local schedules retain their occurrence ledger and supported research
route. Local persistence does not imply execution while the app is closed, Windows
is asleep, or the machine is offline. Hosted execution remains deployment-gated.

## Navigation, tabs and grid

One shared sidebar lists projects, groups with all participant avatars, and agents.
Selecting an entry opens its conversation directly. A shared right panel contains
timestamped, searchable History and the current conversation's Details, including
project work, files, facts and team. Active or blocked work remains discoverable
there, with Stop available for running work even after its last tab closes.

The native title bar holds one global tab strip. A new workspace starts with one
pane. Dragging a history item onto the strip opens a tab; dragging a tab to a pane
edge creates a split. A bounded binary tree supports horizontal and vertical splits
up to eight panes. Dragging tabs back together or closing the last view collapses
empty branches. The plus button creates a conversation using the current agent or
team and project context. Dedicated group and project actions use contextual forms
without an additional conversation-type chooser. Recipient controls name the lead
and offer Team discussion in an accessible in-app menu. Team discussion asks the
lead to coordinate relevant participants, each using their own model selection.

Tabs support arrow-key navigation, Alt+Shift+Left/Right reordering and
Ctrl+Alt+Arrow docking. Dividers support arrow-key resizing. Ctrl+Shift+Backslash
returns to one pane while retaining all tabs; Ctrl+Shift+T reopens a closed tab.
Pointer capture provides drag behavior in native WebView2, including cancellation
on Escape, pointer cancellation or loss of window focus. No docking library is added.

Layout v2 persists the tree and validates pane count, unique leaves, split ratios
and workspace ownership in Rust. Reading v1 preserves its tabs in the new single
pane default. Closing a view only changes layout. Drafts are conversation-owned;
scroll/focus are view-owned. Duplicate views share history, drafts and execution.
Narrow windows show the active pane without overwriting the saved desktop grid.
No SQL migration or change to execution authority is required. Existing performance
ceilings are unchanged.

## Acceptance evidence (2026-09-12)

The native development app used a separate encrypted copy of the local workspace;
its enabled schedules were paused before launch. The installed app and original
checkout were preserved. These checks are not signed-installer acceptance.

| Scenario | Evidence |
| --- | --- |
| Separate private conversations | Two real Codex conversations with the same agent retained different history, responses and unsent drafts. A marker in A was absent from B. Closing/reopening A retained its draft. |
| Standalone group | Chief of Staff assigned Researcher a capacity calculation, received the actual provider result and synthesized 72 places and 8 waiting-list places. Product was not dispatched. |
| Project coordination | Chief delegated capacity and catering to Researcher and Product in distinct focused conversations. Both real executions returned results; the lead synthesized them and requested the unresolved venue dependency. A user steering message was accepted. |
| Shared correction | A user-confirmed budget from the catering conversation was superseded from GBP500 to GBP450. The lead's next real response compared the current decision with the saved GBP482 result and reported a GBP32 shortfall. |
| Views and layout | Native tabs, keyboard reorder, duplicate conversation views, pointer/keyboard divider resize, close/reopen and reload were inspected. Duplicate views shared one draft/history. Narrow native windows showed one pane and accessible navigation, then restored the desktop split. |
| Revised navigation and grid | Native pointer dragging opened a history item as a new tab, built an eight-pane grid, retained all eight panes after reload, resized a row, and collapsed an empty branch when a tab moved back. A 643-pixel native window showed one pane and accessible navigation while retaining the grid. The UK-keyboard single-pane shortcut, contextual creation, right-side project details and dark recipient menu were inspected. |
| Hidden work and Stop | Before the UI revision, a real running response continued after its last tab closed, stayed discoverable in Activity and cancelled from its Stop button. Reopening showed the stopped response without a follow-up run. The revision moves discoverability and Stop into shared History; it does not change execution ownership. |
| Recovery and failure | Native restart restored a paused exchange and explicit continuation completed it. Deterministic fixtures cover interruption during active work, no replay, denial, budgets, resource contention, missing providers and stale callbacks. |
| Migration and membership | Native adoption retained legacy history in the encrypted QA copy. Deterministic v41-to-v42 fixtures verify original ciphertext/thread/authorship preservation; membership and scope fixtures reject stale/cross-conversation work. |
| Artifact preview and schedules | Scoped artifact preview and project schedule binding have deterministic coverage. Live artifact publication was unavailable because the QA computer did not reach readiness: its inspector reported that the native Stop button/shortcut was unavailable and computer control remained off. The installed app was preserved. No always-on or hosted execution was tested. |

After the navigation revision, the production build is 1,086,221 raw JS/CSS bytes
and 313,003 gzip bytes. Raw total, initial entry (399,777 bytes), CSS and named route
ceilings pass. The compressed total exceeds the unchanged 300,382-byte ceiling by
12,621 bytes (12.3 KiB), so full performance readiness is not claimed. Superseded global
composer, sequential project and computer-rail conversation code was removed;
no dependency, licence exception or budget increase was added to pass the gate.

## Audit follow-up (38 items)

The following changes address the subsequent native-development audit. The live
acceptance evidence above predates these fixes; it does not establish their visual,
OAuth, provider, scheduled-execution or packaged acceptance. No live model requests
were sent during implementation. The audit's requests used GPT-5.6-Luna Low or Medium.

| Item | Implemented behavior |
| --- | --- |
| 1. Computer readiness | Initial query and execution preflight share an in-flight capability read. Missing status, a disabled plugin and unavailable native runtime have distinct explanations. Refresh recovers visible status after a failure; Stop and scope/generation fences remain enforced. |
| 2. Lost failed request | An unstarted request is reconstructed in chat from its durable work record, including its original prompt. |
| 3. Hidden failure | Chat shows the failure and recovery controls, with a link to relevant computer or connection setup. |
| 4. Attention summary | Failed work is included alongside blocked and active work. |
| 5. Editor model menu | Responsive CSS retains the model trigger's positioning anchor so measured viewport/clipping placement can run. |
| 6. Narrow side panels | History and Computer use the available narrow viewport with modal focus handling. History starts closed in a narrow workspace. |
| 7. Stale options menu | Outside clicks, Escape and opening an action close the conversation options menu. |
| 8. Hidden active tab | Window and strip resizing reveal the active tab again. |
| 9. File delivery | Validated publication receipts produce file cards. A successful file-write tool result also exposes the agent's workspace files, which load on opening and support bounded text preview and copying. Generated prose alone cannot create a file card. |
| 10. Reconnection cause | Remote discovery/restore errors retain their redacted cause; setup prerequisites and native connector health are visible beside connection actions. |
| 11. Model guidance | The editor describes automatic selection only while Automatic is selected. |
| 12. Group recipient semantics | Team discussion explains that the lead invites relevant participants. |
| 13. Lead changes | A new lead replaces the automatically selected previous lead, preserving participants explicitly selected by the user. Editing an existing team retains its membership. |
| 14. Project lead default | New projects start with the current conversation's agent. |
| 15. New agent discovery | Creating an agent opens its conversation and reveals it in navigation. |
| 16. Group model scope | Model help identifies whose selection is being changed and explains participants' separate selections. |
| 17. Effort levels | Every supported reasoning level is labelled and directly selectable. |
| 18. Composer model placement | The model menu keeps its trigger anchor in narrow and empty-conversation layouts. |
| 19. Model accessibility | The trigger's accessible name includes the selected model and current effort. |
| 20. Schedule effort | The editor saves effort with the encrypted schedule and occurrence payload; dispatch uses that saved value independently of later agent changes. Older records retain provider default. |
| 21. Timezone selection | Searchable browser suggestions include IANA zones with readable city names; native timezone validation remains authoritative. |
| 22. Next-run preview | The form previews the next execution using the same native civil-time evaluator as dispatch and includes the chosen timezone. |
| 23. Similar tabs | Tab labels omit repetitive prefixes and distinguish duplicates; the overflow list includes full titles, project and participant context. |
| 24. Tab overflow | Search open tabs by title or context and select or dismiss the menu with the keyboard. |
| 25. Search scope | Navigation and History placeholders describe their respective search targets. |
| 26. Empty search sections | Empty navigation groups disappear while searching, with a useful overall empty state. |
| 27. Plugin readiness | Available, Connected, Needs attention and Planned filters use current connection state. |
| 28. Planned catalogue | Planned entries are separated from the default Available view. |
| 29. Installed names | Installed plugin names remain visible beside their icons. |
| 30. Recoverable prompt text | Work details expand the complete original request and offer Copy. |
| 31. Continuation layout | Recovery forms take a full row instead of sharing a narrow column with navigation actions. |
| 32. Recovery guidance | No-attempt failures offer retry; work with an attempt/result requires outcome review. Exact native generation and reconciliation checks remain in place. Same-session unstarted retries retain attachments; after restart, users are directed to restore the prompt and reattach files. |
| 33. Attachment wording | Composer and chat describe files as attached to the message, saved to the project, or available as text/image input. |
| 34. Unspecified currency | Conversation instructions require preserving supplied units/currency and explicitly identifying assumptions. This is response guidance, not a guarantee of model accuracy. |
| 35. Code actions | Fenced code displays its language and a Copy control. |
| 36. Message actions | User messages offer Copy and Edit/resend; completed responses offer Copy and Retry. Edit/retry restores a draft for review before sending. |
| 37. Timing | Messages show a compact time with the complete local timestamp available in its tooltip. |
| 38. Shared decisions | Confirmed project facts/decisions from this conversation appear as compact durable context events with source and status. |

Focused regression coverage includes readiness races and recovery, Stop and stale
scope rejection, attachment retention, failure recovery, tab search/resize, participant
defaults, model accessibility, connection errors, message/file/decision presentation,
and the saved schedule effort at both the editor and dispatcher boundary.

Final local validation for this follow-up:

| Check | Result |
| --- | --- |
| Focused desktop Vitest runs | 154 tests passed across 20 affected files. |
| `pnpm --filter @fable/desktop typecheck` | Passed. |
| `pnpm quality` | Passed: lint, required formatting, dead-code and cycle checks. |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -j 1` | 548 passed, 0 failed, 5 ignored. The ignored tests require live credentials or explicitly prepared fixtures. |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -j 1 -- -D warnings` | Passed. |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | Passed. |
| `pnpm --filter @fable/desktop build` | Passed, including application and build-tool typechecks. |
| `pnpm perf:check` | Failed on total raw and gzip JS/CSS; entry, CSS and named route ceilings pass. |

The follow-up build contains 1,105,677 raw JS/CSS bytes and 317,995 gzip bytes.
It exceeds the unchanged raw ceiling by 19,416 bytes and the gzip ceiling by
17,613 bytes. Compared with the preceding navigation build recorded above, this
adds 19,456 raw bytes and 4,992 gzip bytes. The gzip overrun predates this follow-up;
the raw overrun is new. Initial entry JS is 411,314 bytes and CSS is 177,467 bytes.
No performance ceiling was changed, and full performance readiness is not claimed.

Interactive post-change inspection is currently blocked: Computer Use automatic
approval review could not establish the current browser URL and disabled UI actions
for this turn. No alternate UI automation was used to bypass that restriction.
Live OAuth completion, file publication, real scheduled execution, and signed
installer acceptance are therefore still unverified for this follow-up.

These local changes are layered over the existing teammates/projects/tabs worktree
and its pre-existing uncommitted revision. Integrating the other active provider,
plugin, voice and avatar tasks requires selective reconciliation of shared renderer
files, styles and native command registration. Do not replace whole files across
those checkouts; the existing conversation authority and Stop paths must be retained.

## September 12 integration

The workspace and audit changes are integrated with voice, vector avatars and
native provider/token-plugin setup. Calls use ConversationPane and the app-lifetime
execution service, retaining draft isolation, exact approvals and Stop. Gemini
tool continuations preserve opaque signatures, including a separate terminal
stream frame. OpenRouter discovery only enables models registered by native
admission; dynamic model admission remains deferred.

The earlier performance measurements above describe this PR in isolation. The
combined feature set has an explicit additional total allowance of 96 KiB raw
and 40 KiB gzip; startup, CSS and existing lazy route ceilings remain unchanged.
This is a recorded feature-size increase, not a claimed speed improvement.

## References

- [Cursor Projects](https://cursor.com/blog/projects): persistent purpose and a lead.
- [Grok messaging](https://docs.x.ai/grok-bot/chat-and-collaboration): named recipients,
  shared discussions and asynchronous handoffs.
- [Chrome split view](https://support.google.com/chrome/answer/16971124?hl=en): clear
  active pane, swap and return to one pane.
- [Dockview](https://dockview.dev) and [package licensing](https://github.com/dockview/dockview/blob/master/LICENCE.md).
- [AutoGen selection](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
  and [termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html):
  bounded speaker selection, result handoffs and external stop; reference only.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  and [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts): durable
  checkpoints and side-effect recovery; reference only, no replay engine adopted.
- [WAI-ARIA tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): roving focus,
  selection, panel associations and sensible focus after closing.
