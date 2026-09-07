# Plugins and daily-driver assessment

Assessed 7 September 2026 against the current working tree. The label rename and
the capability fixes recorded below are implemented; the wider architecture and
priorities remain proposals, not a claim of product parity. Existing uncommitted work was
preserved. No live provider or native computer acceptance run was performed here.

## Recommended plugin model

Make Browser and Computer Use built-in plugins backed by the existing isolated
computer. Both use the same agent browser session, filesystem, generation and
human-control lease. Do not create competing browser profiles or another agent
loop. Providers supply reasoning; Fable owns tool discovery, execution and policy.

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

Implementation would extend the current marketplace beyond its connector-only
manifest/connection assumptions, then replace readiness-only advertisement in
`apps/desktop/src/lib/computer-tools.ts` with enabled + healthy + compatible
capability resolution. Use the same resolver for submission, retry and resume.
Keep final authorization checks in Rust; hiding tools in React is insufficient.

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

The current instruction stops after two unsuccessful attempts at a step. Replace
that blunt limit with bounded recovery classes: re-observe stale state, reacquire
a lost tab, wait for a loading page, or request human control for private steps.
Budgets and cancellation still apply. Task checkpoints should retain intent and
verified progress, never reusable approvals or stale observation identifiers.

KasmVNC is already in the current Dockerfile and viewer. Evaluate Browser Use or
Cua only against concrete failures in the present adapters, behind Fable-owned
contracts. The earlier research is not evidence that either library is integrated.
A dependency swap alone does not establish better task success.

## Daily-driver gaps, in priority order

| Priority | Area | Current evidence and gap | Completion criterion |
| --- | --- | --- | --- |
| P0 | Everyday web research | Public URL fetching is now advertised without Docker; dedicated search and citation handling remain incomplete, and inherited Codex web search is disabled | Fresh search, page reading and traceable citations work from ordinary conversation, without manually opening the computer |
| P0 | Consistent tool access | Submission and retry now share capability resolution; retry uses its original provider/model and retains working instructions. Native visual delivery still supports only a connected vision-capable Codex route | Every supported provider route is tested or clearly reports its limitation |
| P0 | Browser/computer completion | Real tools and control leases exist; the verification log still leaves repeated complete workflows and external artifact opening unverified | Research, sign-in takeover, download, file creation and opening succeed repeatedly through the packaged native app |
| P0 | Useful deliverables | Guest includes Writer, Calc, Python, pandas, python-docx, openpyxl and reportlab; `computer-artifact` explicitly excludes PDF and does not offer a slide format | Generate, validate, preview/open and export PDF, DOCX, XLSX and slides; verify layout and formulas, not just file existence |
| P0 | Reliable continuation | Durable conversations and retry exist, but work is tied to an open app and awake PC | Stop/resume and crash recovery preserve progress, explain uncertain external writes and avoid duplicate actions |
| P1 | Coding workflow | Git, shell and files exist in the isolated guest; these do not establish a usable local repository/review/worktree workflow | Import or attach an approved repo, edit, test, inspect diffs, create a PR and preserve unrelated work without exposing the host shell |
| P1 | Plugin completeness | Current marketplace handles authenticated app integrations; skills live separately and generic built-in runtime plugins are not represented | Install/enable/disable, health, permissions, skill loading and tool discovery work consistently for apps and built-ins |
| P1 | Context and projects | Local memory, attachments and durable conversations exist; full project organization and long-session recall need acceptance evidence | Resume multi-day work with correct files, instructions and sources; inspect/correct memory; handle context limits without losing commitments |
| P1 | Media and voice | Current user-facing voice is OS dictation; artifact display is not image generation or full spoken conversation | Validate image understanding, image generation/editing, audio transcription and interruptible voice through supported providers |
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
Fable integrations. Pin and audit a concrete release before adoption; repository
activity and upstream benchmarks do not establish task success in Fable.

| Area | Repository | Recommendation for Fable |
| --- | --- | --- |
| Browser execution and verification | [Playwright](https://github.com/microsoft/playwright) | Preferred library to evaluate for robust locators, actionability waits and browser tests. Run inside the isolated computer through the existing native gateway; do not expose unrestricted evaluation, cookies or a new public CDP port. |
| Browser agent workflows | [Browser Use](https://github.com/browser-use/browser-use) | Evaluate observation/action and recovery quality against current structured tools. Its full agent loop and cloud/profile-sync features are not automatic dependencies. Keep Fable's model route and approvals authoritative. |
| Desktop drivers and evaluation | [Cua](https://github.com/trycua/cua) | Evaluate Linux driver and benchmark components if they improve measured desktop failures. Do not replace the computer or introduce a second authority model. Optional components have different licenses. |
| Desktop viewing | [KasmVNC](https://github.com/kasmtech/KasmVNC) | Already used. Keep the native-authenticated viewer and control lease; this is the display layer, not reasoning or task recovery. |
| Document ingestion | [MarkItDown](https://github.com/microsoft/markitdown) | Candidate for extracting Office/PDF content into model-readable text inside the guest. Extraction does not preserve full layout or supply editing/export. |
| Slide output | [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | Strong candidate for generating editable PPTX in the guest. Add artifact validation/publication and rendered-slide QA before claiming support. |
| PDF preview | [PDF.js](https://github.com/mozilla/pdf.js) | Candidate for a bounded, isolated viewer of verified immutable artifact bytes. Keep scripting and external actions disabled. PDF export also needs structural validation; do not merely remove the current rejection. |
| Search | [SearXNG](https://github.com/searxng/searxng) | Optional self-hosted search service, with operational and upstream-engine reliability costs. A supported search API behind a native adapter is the alternative; public instances are not a dependable product backend. |
| Research orchestration | [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | Reference for research decomposition and reporting. Avoid adding a parallel credential store or duplicating Fable's conversation execution loop. |
| Durable execution | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | Reference/evaluation candidate for checkpoints and interrupted workflows. First extend Fable's existing encrypted execution records; adopting another persistence layer must have a demonstrated benefit. It cannot execute while the PC is asleep. |
| Voice | [Pipecat](https://github.com/pipecat-ai/pipecat) | Candidate for a provider-neutral voice pipeline with turn handling and interruptions. Requires microphone lifecycle, native credential mediation and a supported audio provider; it does not inherit consumer subscription entitlements. |
| MCP interoperability | [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Use for compatibility tests or new adapter components where it improves the existing implementation. Main is a changing v2 line; choose the supported release deliberately. Keep Fable's native OAuth custody. |
| Coding workflow | [OpenHands](https://github.com/OpenHands/OpenHands) | Reference for sandboxed development workflows, not a replacement UI/runtime. Fable still needs its own repo attachment, diff review, worktree and PR experience. |
| Capability evaluations | [promptfoo](https://github.com/promptfoo/promptfoo) | Candidate for repeatable prompt/tool/provider comparisons. Pair with actual native workflow tests; an evaluation configuration alone does not prove parity. |

Retain the existing guest Python document/data libraries for DOCX and XLSX.
Use supported provider APIs for image generation/editing and speech; an open-source
wrapper cannot supply model weights, account access or free inference. Project
organization, memory correctness, notifications, signing/updating and multi-device
behavior need Fable product engineering even when libraries cover individual parts.

The intended scope remains every gap in this assessment. A gap closes only when
its completion criterion is met, including relevant native/live evidence.

## Implementation evidence — 7 September 2026

- Public URL fetching is included in ordinary conversation tool discovery without
  requiring Docker. Existing native URL, SSRF and exact approval checks remain.
  This is URL fetching, not a new search engine or completed research feature.
- New turns and retries share `conversationToolsForModel`. Retry resolves the
  original attempt's provider/model rather than the currently selected model's
  visual capabilities. Unsupported visual routes remain excluded.
- Retry receives the agent's current instructions plus conversation/computer
  instructions instead of silently reverting to conversation style alone.
- 68 focused tests passed across computer tool selection, native-agent retry,
  desktop execution and official connector execution. Desktop typecheck and
  production build passed. These are local/mocked checks, not live parity proof.
