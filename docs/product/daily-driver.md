# Plugins and daily-driver assessment

Assessed 7 September 2026 against the current working tree. Implemented changes
and their evidence are recorded below. Container checks, native unit tests,
browser previews and direct provider probes are separate evidence classes;
they do not establish repeated completion through the packaged application.
The complete daily-driver criteria remain the assessment target. Implementation
was stopped at the user's requested handoff; outstanding criteria are not closed.

## Recommended plugin model

Make Browser and Computer Use built-in plugins backed by the existing isolated
computer. Both use the same agent browser session, filesystem, generation and
human-control lease. Do not create competing browser profiles or another agent
loop. Providers supply reasoning; Mivlet owns tool discovery, execution and policy.

A plugin should package an identity/version, task instructions, tool references,
runtime dependencies, supported input/output modalities, permissions and health
checks. An app connector is one possible plugin component. Model-provider login
stays separate. Personal agent skills can remain in the agent editor while a
plugin contributes its own versioned workflow instructions.

| Plugin | Existing foundation | Proposed experience |
| --- | --- | --- |
| Browser | `local-browser`, observe/action/tab, uploads and downloads in the computer | Enable, open websites, read structured page state, navigate tabs, fill forms, download and return files; use visual fallback when structured state is insufficient |
| Computer Use | Desktop observe/action, application launch, terminal, file operations and artifact publication | Enable, watch, take control for sign-in, return control, resume from a fresh observation, receive verified outputs |

Keep installation distinct from readiness. A built-in plugin can be enabled but
require Docker, a started computer or a compatible model. Show one actionable
prerequisite. Disabling either plugin removes its tools and invalidates pending
authority without deleting the computer or browser profile. Both plugins share
one lazy-started runtime, with concurrency controlled by the existing lease.
Browser-only access must not silently grant shell or desktop access.

The marketplace now exposes both built-ins. Enabled + ready/lazily startable +
compatible capability resolution is shared by submission and retry. Native
admission checks enforce enablement, generation and control lease; disabling
revokes admitted authority and pauses/drains the shared computer. Browser-only
access includes scoped artifact publication, without shell or desktop access.

## What makes it effective

Use structured browser observations first, then screenshots for canvas, unusual
widgets and desktop applications. Return stable element references, tab identity,
URL, bounded content and freshness information. Act on observed targets and
verify the resulting state. Preserve the current generation and single-use
observation fences. Never blindly repeat a submission after an ambiguous failure.

Load task instructions and detailed schemas when relevant rather than advertising
every integration at full size. Maintain a common result envelope for text,
images, sources, artifacts and recoverable errors across provider adapters.
Preserve secret-free native image delivery when adding additional visual providers.

Recovery now distinguishes stale observations, lost tabs, loading and uncertain
writes. It uses bounded class-specific recovery, keeps uncertain writes blocked
against replay, and preserves task intent plus successful-result evidence for
explicit continuation. Historical authority identifiers are stripped; unused
persisted permits are invalidated during crash recovery. Live crash/side-effect
acceptance remains required.

KasmVNC is already in the current Dockerfile and viewer. Evaluate Browser Use or
Cua only against concrete failures in the present adapters, behind Mivlet-owned
contracts. The earlier research is not evidence that either library is integrated.
A dependency swap alone does not establish better task success.

## Daily-driver gaps, in priority order

| Priority | Area | Current evidence and gap | Completion criterion |
| --- | --- | --- | --- |
| P0 | Everyday web research | Public URL fetching is advertised without Docker. The selected Codex app-server route now enables provider-owned live search and preserves its non-approvable activity/results, with direct ephemeral app-server evidence for fresh search, selected-result reading and linked citation. Packaged ordinary-chat acceptance remains unverified, and other provider routes have URL fetch but no dedicated search backend | Fresh search, page reading and traceable citations work repeatedly from packaged ordinary conversation on every advertised route, while unsupported routes explain the limitation |
| P0 | Consistent tool access | Submission and retry now share capability resolution; retry uses its original provider/model and retains working instructions. Native visual delivery still supports only a connected vision-capable Codex route | Every supported provider route is tested or clearly reports its limitation |
| P0 | Browser/computer completion | Real tools and control leases exist; the verification log still leaves repeated complete workflows and external artifact opening unverified | Research, sign-in takeover, download, file creation and opening succeed repeatedly through the packaged native app |
| P0 | Useful deliverables | Native PDF/PPTX validation and publication added; guest adds Impress/PptxGenJS. Real generated/rendered DOCX/PDF/PPTX fixtures pass structural and visual checks; XLSX formula cache equals expected 5. Packaged conversation publication/opening remains unverified | Generate, validate, preview/open and export PDF, DOCX, XLSX and slides; verify layout and formulas, not just file existence |
| P0 | Reliable continuation | Durable conversations and retry exist, but work is tied to an open app and awake PC | Stop/resume and crash recovery preserve progress, explain uncertain external writes and avoid duplicate actions |
| P1 | Coding workflow | Native ZIP chooser imports an isolated bounded snapshot and excludes common credential/dependency files. Native archive tests and a guest Git worktree/edit/test/diff/preservation probe pass. Ordinary-chat execution and approved GitHub PR creation remain unverified | Import or attach an approved repo, edit, test, inspect diffs, create a PR and preserve unrelated work without exposing the host shell |
| P1 | Plugin completeness | Current marketplace handles authenticated app integrations; skills live separately and generic built-in runtime plugins are not represented | Install/enable/disable, health, permissions, skill loading and tool discovery work consistently for apps and built-ins |
| P1 | Context and projects | Settings now exposes memory inspection, correction, disabling and forgetting; targeted native updates reject stale edits and resurrection. Full project organization and bounded long-session recall remain incomplete | Resume multi-day work with correct files, instructions and sources; inspect/correct memory; handle context limits without losing commitments |
| P1 | Media and voice | Bounded PNG/JPEG/WebP input is wired for a connected image-capable Codex route, with native staging and metadata-only persistence. Failed runs retain attachments; retries require reattachment. Other image routes, generation/editing and full voice remain incomplete | Validate image understanding, image generation/editing, audio transcription and interruptible voice through supported providers |
| P1 | Scheduled and delegated work | Multiple named profiles and hosted foundations do not prove autonomous background execution | Persistent local scheduling, independent task state, cancellation, recovery and meaningful notifications; clearly explain sleep/close limitations |
| P2 | Distribution and mobility | README marks signed installers, updater channels, multi-device sync and mobile control incomplete | Reliable upgrade/recovery path; add cross-device access only when intentionally expanding the local-first scope |

Primary code evidence: `apps/desktop/src/shell/ChatWorkspace.tsx`,
`apps/desktop/src/lib/computer-tools.ts`,
`apps/desktop/src/lib/desktop-tool-runtime.ts`,
`apps/desktop/src/components/PluginPanel.tsx`,
`packages/connectors/src/native-api/tools.ts`,
`apps/desktop/src-tauri/src/codex_app_server.rs`, and the local-computer Dockerfile.
See [native acceptance evidence](../development/local-computer-verification.md)
and [computer architecture](../architecture/local-teammate-computer.md).

## How to measure parity

Compare outcomes on the same representative tasks, not catalogue size. Use a
fixed set covering cited research, inbox/calendar work, browser upload/download,
private sign-in takeover, spreadsheet analysis, document/PDF creation, a repo fix
with tests, image work, a long conversation and interrupted-task recovery.
Run each repeatedly on a stated model/provider and record success, human rescue,
elapsed time, tool errors, artifact correctness and duplicate side effects.
Use approved test accounts for writes. Treat mocks, container probes and full
native tasks as separate evidence classes.

Build order: fix ordinary-chat capability reachability and retry consistency;
package the two built-ins; complete files/research and repeated native acceptance;
then expand projects, coding, media and durable background work. This order targets
the reasons a person would currently switch back to ChatGPT/Codex mid-task.

## Official comparison baseline

OpenAI documents plugins as bundles of skills and/or connectors, supporting the
package/component distinction above: [Plugins](https://learn.chatgpt.com/docs/plugins).
Its [feature index](https://learn.chatgpt.com/docs/features) lists browser,
computer use, web search, image inputs/generation, files and scheduled work.
[Projects](https://learn.chatgpt.com/docs/projects) describes shared context,
local folders and repository workflows. These are comparison dimensions, not
a promise that every feature is available on every account or platform.
The [computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
documents the action/observation loop; an API tool is not the complete desktop product.

## Reusable repositories and adoption decisions

Repository documentation inspected on 7 September 2026. These are candidate
components and engineering references, not installed dependencies or verified
Mivlet integrations. Pin and audit a concrete release before adoption; repository
activity and upstream benchmarks do not establish task success in Mivlet.

| Area | Repository | Recommendation for Mivlet |
| --- | --- | --- |
| Browser execution and verification | [Playwright](https://github.com/microsoft/playwright) | Preferred library to evaluate for robust locators, actionability waits and browser tests. Run inside the isolated computer through the existing native gateway; do not expose unrestricted evaluation, cookies or a new public CDP port. |
| Browser agent workflows | [Browser Use](https://github.com/browser-use/browser-use) | Evaluate observation/action and recovery quality against current structured tools. Its full agent loop and cloud/profile-sync features are not automatic dependencies. Keep Mivlet's model route and approvals authoritative. |
| Desktop drivers and evaluation | [Cua](https://github.com/trycua/cua) | Evaluate Linux driver and benchmark components if they improve measured desktop failures. Do not replace the computer or introduce a second authority model. Optional components have different licenses. |
| Desktop viewing | [KasmVNC](https://github.com/kasmtech/KasmVNC) | Already used. Keep the native-authenticated viewer and control lease; this is the display layer, not reasoning or task recovery. |
| Document ingestion | [MarkItDown](https://github.com/microsoft/markitdown) | Candidate for extracting Office/PDF content into model-readable text inside the guest. Extraction does not preserve full layout or supply editing/export. |
| Slide output | [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | The guest pins MIT-licensed 4.0.1 with a build-time generation smoke test and LibreOffice Impress for editing/rendering. Native PPTX publication rejects macros, embedded programs, duplicate or invalid package paths, and external relationships. Rendered-slide QA remains required before claiming a presentation is correct. |
| PDF preview | [PDF.js](https://github.com/mozilla/pdf.js) | Still a candidate for a bounded, isolated in-app viewer. Native PDF export now uses MIT-licensed lopdf 0.44.0 as a strict, resource-bounded structural validator and rejects active or ambiguous documents before host opening; this is rejection, not sanitization. |
| Search | [SearXNG](https://github.com/searxng/searxng) | Optional self-hosted search service, with operational and upstream-engine reliability costs. A supported search API behind a native adapter is the alternative; public instances are not a dependable product backend. |
| Research orchestration | [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | Reference for research decomposition and reporting. Avoid adding a parallel credential store or duplicating Mivlet's conversation execution loop. |
| Durable execution | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | Reference/evaluation candidate for checkpoints and interrupted workflows. First extend Mivlet's existing encrypted execution records; adopting another persistence layer must have a demonstrated benefit. It cannot execute while the PC is asleep. |
| Voice | [Pipecat](https://github.com/pipecat-ai/pipecat) | Candidate for a provider-neutral voice pipeline with turn handling and interruptions. Requires microphone lifecycle, native credential mediation and a supported audio provider; it does not inherit consumer subscription entitlements. |
| MCP interoperability | [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Use for compatibility tests or new adapter components where it improves the existing implementation. Main is a changing v2 line; choose the supported release deliberately. Keep Mivlet's native OAuth custody. |
| Coding workflow | [OpenHands](https://github.com/OpenHands/OpenHands) | Reference for sandboxed development workflows, not a replacement UI/runtime. Mivlet still needs its own repo attachment, diff review, worktree and PR experience. |
| Native coding runtime | [Codex](https://github.com/openai/codex) | User-selected reference for repository workflows, native tool delivery, checkpoints and context handling. Apache-2.0 licensed; inspect the relevant version and retain required notices for any reused code. Mivlet's provider adapters, isolated computer and approval authority remain the integration boundaries. |
| Capability evaluations | [promptfoo](https://github.com/promptfoo/promptfoo) | Candidate for repeatable prompt/tool/provider comparisons. Pair with actual native workflow tests; an evaluation configuration alone does not prove parity. |

Retain the existing guest Python document/data libraries for DOCX and XLSX.
Use supported provider APIs for image generation/editing and speech; an open-source
wrapper cannot supply model weights, account access or free inference. Project
organization, memory correctness, notifications, signing/updating and multi-device
behavior need Mivlet product engineering even when libraries cover individual parts.

A gap closes only when its completion criterion is met, including relevant
native/live evidence. The entries below distinguish implemented work from that
remaining acceptance work.

## Implementation evidence — 7 September 2026

- Public URL fetching is included in ordinary conversation tool discovery without
  requiring Docker. Existing native URL, SSRF and exact approval checks remain.
  The selected Codex route also enables its provider-owned live web search. A
  direct ephemeral app-server probe completed a fresh search, selected and opened
  one structured result, and returned a linked citation without an approval
  request. This does not establish the packaged Mivlet conversation flow or add a
  search backend to other provider routes.
- New turns and retries share `conversationToolsForModel`. Retry resolves the
  original attempt's provider/model rather than the currently selected model's
  visual capabilities. Unsupported visual routes remain excluded.
- Retry receives the agent's current instructions plus conversation/computer
  instructions instead of silently reverting to conversation style alone.
- 68 focused tests passed across computer tool selection, native-agent retry,
  desktop execution and official connector execution. Desktop typecheck and
  production build passed. These are local/mocked checks, not live parity proof.

## Handoff status — implementation stopped at user request

All changes remain uncommitted in the isolated worktree. No push, deployment,
external message, or metered media demonstration was performed.

Implemented during this pass:

- Built-in Browser/Computer plugin controls, safer retry/recovery, readable URL
  extraction and Codex-native search, repository ZIP import, and stricter
  document/image artifact validation.
- Local research schedules with durable claims, memory inspection/correction,
  bounded conversation-context admission, native image generation/editing
  boundaries, and recording review with native OpenAI transcription custody.
- The selected shared project room: private encrypted projects, create/edit/archive,
  shared conversation/instructions/imported reference links, explicit all-agent
  or individual recipients, each agent's configured model, and immutable native
  run authorship. Sequential contributions reload canonical history and suppress
  synthetic handoff messages in the human conversation. Individual chats remain.
- A development-only project preview at
  `http://localhost:1431/design-preview.html?view=projects` uses sample data and
  explicitly does not send model requests or persist projects.

Evidence actually obtained:

- Earlier package tests, workspace typecheck, quality checks and production build
  passed before the final project additions. They were not repeated at wrap-up
  and are not claimed as gates for the complete final diff.
- Project native tests passed 4/4; native-agent hook tests passed 43/43, including
  queued author-binding failure, cancellation fences, and fresh shared history.
- Final project route/feed regressions passed 10/10. Desktop TypeScript checking
  passed after integration. The final native library passed `cargo check`.
- The project preview was visually inspected at the available desktop viewport;
  a concrete unused grid-column defect was fixed. Full reference-fidelity,
  responsive, and packaged-native project acceptance remain unverified.

Still incomplete or blocked:

- Binary artifact handoff between agents is **unavailable**. The unreachable draft
  was removed during consolidation; it remains in commit 8a15da1. Native
  approval/run binding, integration, and regression tests are still required
  before exposing this capability.
- Project reference-file preview, historical author lookup beyond the recent
  500-entry UI list, automatic delegation, and full multi-agent interruption/restart
  acceptance remain unfinished. Unknown historical authors display a neutral label
  rather than being attributed to the currently selected agent.
- Full interruptible voice, automatic long-session compaction/recall, repeated
  packaged workflows, and the remaining assessment criteria are not complete.
- Live media/transcription calls were not exercised. Packaged GUI automation is
  unavailable in this session; GitHub write acceptance needs an authorized test
  destination; signed upgrades need signing credentials, an updater feed and
  clean-machine upgrade verification.
- Bundle limits still fail on the last measured pre-project build: total JS
  1,117,319 B versus 1,086,261 B; gzip 311,705 B versus 300,382 B; initial JS
  477,502 B versus 472,877 B. CSS passed. No limits were weakened, and no new
  bundle investigation or full-suite rerun was started after the wrap-up request.
