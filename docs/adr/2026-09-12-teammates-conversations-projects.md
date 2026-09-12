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

## Tabs and splits

Use a small React two-pane layout over durable conversation/artifact IDs. Closing a
view only changes layout. An app-level activity list remains discoverable and can
stop hidden work. Drafts are conversation-owned; scroll/focus are view-owned. Two
views of one conversation share the same in-memory subscription and execution.
Narrow windows show the active pane without overwriting the saved desktop split.

Dockview 8.3.1 was evaluated from its published packages, not assumed from its name.
`dockview` and `dockview-core` ship MIT `LICENCE.md` files; React uses the separate
`dockview-react` package. The core supports serialization, tab/panel ARIA semantics,
live announcements and resizable groups. Its optional enterprise package has a
commercial license, and advanced keyboard docking uses an accessibility module.
Mivlet needs only two panes, accessible reorder/move/resize controls, and quiet tabs.
A local reducer avoids adding arbitrary docking, popouts, module configuration and
bundle weight. Both approaches are browser DOM compatible with Tauri WebView2; native
acceptance must still be measured. Existing performance ceilings are unchanged.

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
| Hidden work and Stop | A real running response continued after its last tab closed, stayed discoverable in Activity and cancelled from its Stop button. Reopening showed the stopped response without a follow-up run. |
| Recovery and failure | Native restart restored a paused exchange and explicit continuation completed it. Deterministic fixtures cover interruption during active work, no replay, denial, budgets, resource contention, missing providers and stale callbacks. |
| Migration and membership | Native adoption retained legacy history in the encrypted QA copy. Deterministic v41-to-v42 fixtures verify original ciphertext/thread/authorship preservation; membership and scope fixtures reject stale/cross-conversation work. |
| Artifact preview and schedules | Scoped artifact preview and project schedule binding have deterministic coverage. Live artifact publication was unavailable because the QA computer did not reach readiness: its inspector reported that the native Stop button/shortcut was unavailable and computer control remained off. The installed app was preserved. No always-on or hosted execution was tested. |

The final production build is 1,078,721 raw JS/CSS bytes and 311,064 gzip bytes.
Raw total, initial entry (396,191 bytes), CSS and named route ceilings pass. The
compressed total exceeds the unchanged 300,382-byte ceiling by 10,682 bytes
(10.4 KiB), so full performance readiness is not claimed. Superseded global
composer, sequential project and computer-rail conversation code was removed;
no dependency, licence exception or budget increase was added to pass the gate.

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
