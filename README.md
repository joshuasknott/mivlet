# Mivlet

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/public/brand/mivlet-lockup-dark.png">
  <img src="apps/desktop/public/brand/mivlet-lockup-light.png" alt="Mivlet" width="280">
</picture>

*One place for your AI agents.*

Mivlet is a provider-neutral, local-first workspace built around a quiet desktop
conversation with named agents. Connections, files, approvals, and an agent's
computer appear only when the work needs them.

Mivlet is local-first: conversations and workspace data are stored on the device,
provider credentials stay in native secure storage, and the default agent computer
runs locally. Connected providers and apps receive the context needed for their
requests. Signed-out users authenticate with a Mivlet account. Authenticated
users connect a supported AI provider before entering their local workspace.
Returning users with a usable provider open chat directly; app connections are optional.

## Maturity

**Experimental / pre-release.** This is a source release for developers, not a
supported production service or a signed installer release. See [LICENSE](LICENSE),
[third-party notices](THIRD_PARTY_NOTICES.md), and the [security policy](SECURITY.md).
Public source access does not provide a hosted Mivlet account service, provider
subscriptions, or connector credentials; configure your own services as described below.

Mivlet is pre-release Windows desktop software. The local workspace has optional
cloud task and phone services, deployed against the existing development account
setup. Production tenancy and full signed-in service acceptance remain unverified.

### Implemented locally

- Interactive conversation answers through OpenUI: reactive calculators, quizzes,
  planners and comparisons, reusable layouts/cards/tabs, charts, searchable tables
  and verified published images. The selected provider emits the same text format;
  no additional UI-generation service or subscription is required. Inputs restore
  from the exact saved response; local changes are immediate and follow-up actions
  stage a reply for review. Legacy interactive responses remain supported.
- Custom interactive HTML previews for simulations, diagrams and small games.
  OpenUI remains the first choice; bespoke HTML opens only on a deliberate click
  in an isolated native guest with no network or tool access. Guest edits reset
  when closed, while the saved response source remains in the conversation.
- Managed coding repositories for named agents: attach a local Git repository,
  edit a separate copy, run native Windows checks in a restricted snapshot, review
  the actual diff, commit an approved snapshot and optionally open a GitHub PR.
  Requires Windows x64, Git and one-time native execution setup in Library.
  Node/npm and isolated Python/pip are bundled; publication additionally requires GitHub CLI login. Available through
  Codex, Claude SDK and direct API routes that bridge Mivlet tools. See the
  [coding workflow and its limits](docs/architecture/coding-workflow.md).
  File checkpoints save named code states in the private copy, preview real file
  changes, and restore an explicitly approved tree with a recoverable before-restore
  checkpoint. Connected undo can restore the associated conversation branch and
  private-copy files together, with explicit Finish/Revert recovery after an
  uncertain result. Original checkouts and Git HEAD stay intact; restored files
  need fresh verification. Work keeps its exact repository copy across continuations.
  See [checkpoint limits and recovery](docs/architecture/coding-workflow.md#file-checkpoints).
- Bounded live command logs and native persistent jobs for repository snapshots
  or selected workspace files. Library's Commands section shows status and Stop.
  Persistent jobs require an explicit lifetime, retain isolation and repository
  locks, and discard every file change. Desktop-owned jobs end with the app;
  the opt-in [background owner](docs/architecture/work-execution.md#opt-in-native-background-text-execution-on-windows)
  retains approved commands after the window closes. Restart never replays jobs.
  See the [native lifecycle](docs/architecture/native-execution.md#live-output-and-controlled-jobs).
- Approved interactive jobs accept bounded line input with reconnectable output
  and independent Stop. Native Node HTTP previews can open beside a command
  result; selecting an element stages a revision request with validated evidence.
  Preview transport remains isolated, and installed WebView network enforcement
  must pass its native probe. Sessions use a fixed snapshot: stop, edit and restart
  to see repository changes. Full-screen terminal/resize support is not offered.
- Conversation queues can be held, edited and reordered before admission. Explicit
  goals record success criteria and turn/token limits; continuation checks fresh
  reports before scheduling another turn. Codex supports live turn guidance;
  other routes retain guidance for the next supported boundary. These controls
  operate on the same encrypted Work records as foreground/background execution.
- GitHub PR review for attached repositories: paginated changes, checks and
  comments, revision-aware viewed files, local review drafts, explicitly approved
  managed-branch updates and review actions, and bounded optional PR watches
  that wake existing Work while the desktop is open. Uncertain writes require
  read-only reconciliation; credentials stay native. See the
  [PR workflow](docs/architecture/coding-workflow.md#pull-request-review-and-updates).
- A Tauri 2 desktop app with a compact React conversation shell, named agent
  profiles, animated coloured character icons or uploaded images, and model
  selection with supported reasoning levels. Clicking an agent's name opens
  its settings in the right panel. The composer keeps model selection and
  dictation visible, with uploads and a connected-plugin submenu under +.
  Per-agent notifications show in-app completion and attention notices while
  the workspace is open; approval prompts remain independently enforced.
  The dictation mic sits immediately left of Send. Send stays visible and is
  disabled until the draft or attachments contain content. While the agent is
  working, Stop remains available. Voice-to-voice conversations are not offered.
  Dictation still requires a connected OpenAI API account and explicit recording
  review before upload; it fills the draft without sending it. See the
  [speech guide](docs/architecture/voice-conversations.md).
- Log in and Sign up account entry for signed-out users, followed by required
  AI provider setup and first-agent name, icon and colour selection. Returning
  users with a usable provider open chat directly.
  Provider setup uses native credential storage and existing connection checks.
- One provider-driver registry with stable instance ids for ChatGPT/Codex,
  Claude, Google Antigravity, Grok, Cursor, OpenCode, and advanced direct API
  connections. Codex and Antigravity have provider-owned agent adapters;
  Cursor and Grok run through ACP; Claude uses its bidirectional Agent SDK
  protocol; and OpenCode runs behind a Mivlet-owned authenticated loopback
  server. All six provider-owned routes mediate consequential actions through
  Mivlet's one-time approval boundary. Direct OpenAI, Anthropic, xAI, DeepSeek,
  Alibaba/Qwen, Moonshot/Kimi, Z.ai/GLM, Groq, Together, Fireworks, Cerebras,
  Mistral, OpenRouter, NVIDIA, SiliconFlow, Cohere and custom API turns use the bundled OpenCode V2 embedded host, with native
  credential custody and Mivlet tool approvals. DeepSeek runs its documented
  non-thinking mode; its thinking-mode `reasoning_content` round-trip is not
  bridged, so reasoning levels are not advertised and screenshot delivery stays
  disabled. Direct Gemini uses the native Gemini wire adapter with API-key custody. User-image turns retain the audited visual
  wire route; other provider-specific wire adapters remain separate. Every route remains unavailable until its
  executable and account or credential are validated; catalogue presence is
  never presented as a live connection.
- Encrypted SQLite persistence for conversations, attached files, memory,
  connections, approvals, audit history, and a minimal internal execution
  attempt used for safe interruption and retry.
- Protected secret requests on supported Mivlet tool bridges: the human supplies
  or declines a webhook signing secret in native Windows entry. Agents receive
  an expiring, scoped, one-use reference; the value stays in account-keyed native
  credential custody. A native webhook verifier consumes it, with local signature
  checks, status and approved revocation. This does not deploy webhook ingress or
  dispatch events. See [protected requests](docs/architecture/local-teammate-computer.md#protected-secret-requests).
- Conversation controls use assistant-ui over Mivlet's canonical history. Earlier
  messages can be edited into durable branches, answers regenerated, and saved
  alternatives reopened without replaying completed actions. OpenUI renders a
  bounded Mivlet catalogue in ordinary provider responses; selections and forms
  stage reviewable replies. The context inspector distinguishes proposed context
  from the native capture and retrieval receipt used by a completed request.
- Outputs support immutable working revisions, comparison, restoration, pinning
  and native export. Text, Markdown, JSON and CSV are editable; supported DOCX
  paragraphs and XLSX cells retain their Office package structure and formulas.
  Unsupported complex Office content remains explicitly read-only. Selected
  passages offer source-bound questions, refinement and deliberate memory saving.
- Published images appear directly in chat and open the existing file viewer;
  documents, spreadsheets and other published files use clickable file cards.
  Text, Markdown, JSON and bounded Office content render in the viewer, with sheet
  and slide selection. PDFs have page navigation and zoom. Open preserves full
  Office layout/editing; Save uses a native file dialog and keeps existing files
  intact. Shared tools create passive DOCX, formula-bearing XLSX, editable
  16:9 PPTX and PDF reports with tables and vector bar charts. Uploaded images and text can be previewed
  during the current session (bounded to 32 MB of preview memory). Upload pixels
  are not embedded in saved conversation text. Work retains verified private image
  copies and hash-bound references for continuation and explicit recipient sharing;
  unavailable or changed originals ask for reattachment.
  Saved workspace text files remain previewable through their scoped file path.
- Provider and plugin-style Connections, including connector and MCP
  boundaries. App connections use browser sign-in through native OAuth or official remote services.
  The official MCP SDK owns negotiation and discovery in the bundled
  native host over the existing transport. Credentials stay in native or service-secret custody rather than
  React state or conversation transcripts.
  Compatible MCP Apps open beside their saved tool results and can expand into
  the right panel. The isolated host renegotiates on reopen, keeps app requests
  behind Mivlet authority, and retains readable ordinary results on failure.
  See [MCP Apps](docs/architecture/mcp-apps.md) for supported capabilities and
  [verification](docs/development/verification.md) for evidence and limitations.
- An authenticated local MCP server lets external assistants inspect explicitly
  shared Work and request tasks from selected agents. Native desktop consent,
  read-only defaults, expiry, revocation and scoped access history preserve
  Mivlet authority. Manual remote MCP access requires an operator-provided HTTPS
  proxy. See [external assistants](docs/architecture/mcp-server.md).
- An opt-in phone/web view shares those granted agents and Work, with task
  requests, bounded results and Stop for tasks the browser started. Native OAuth
  custody and HttpOnly cookies keep bearer credentials out of browser JavaScript.
  Managed phone access uses a separate Free Cloudflare relay with fixed client
  assets and closed native operations; it requires no user-operated tunnel.
  Cloudflare carries the selected shared requests/results over TLS without
  retaining their text in relay storage. Opt-in push contains no task content.
  Deployment configuration, browser permission and an awake, signed-in desktop
  are required. Account credential refresh or relink ends the link and requires
  reconnecting; this is not hosted task execution or proof of real-phone delivery.
- Agent instructions travel as model context rather than appearing in user
  messages. Skills belong to their agent profile. ChatGPT turns use ephemeral
  Codex sessions while Mivlet keeps the durable conversation locally.
- Each named agent can have multiple private conversations. A leading @mention
  assigns work to an existing workspace agent, including from an ordinary Chat.
  The composer picker saves stable agent IDs, supports several recipients and
  leaves quoted or inline references as references. Replies use the recipient's
  configured provider, model and permissions. Workspace discovery, delegation and
  task messages let any configured agent coordinate a bounded effort; a project
  is optional. Activity shows assignments, questions, blockers and Stop controls.
  Projects own a shared
  Chat, Team, Work, files, artifacts and decisions with an optional coordinator,
  explicit @mention routing, bounded assignments, attributed results and
  inspectable decisions. Without a coordinator the sender picks a current
  participant; Mivlet never fans out automatically. Legacy standalone groups
  convert into projects without losing history or authorship, and explicit shares
  record recipient, owner and snapshot/live-reference semantics. Delegation uses
  the Codex, Claude SDK and native API routes that bridge Mivlet tools; provider-owned routes
  without that bridge cannot coordinate agents and show that prerequisite.
- The native title bar keeps conversation Back/Forward and compact File, View,
  and Help menus on the left, separate from the window controls. History only
  changes the focused conversation; it does not start or stop agent work.
- A persistent right-hand strip opens Activity, Files, Memory, Side Chat and
  Schedules. The panel starts closed; selecting a section opens it and the header
  X closes it while the strip stays available. Agent
  and project settings replace only its content. Activity
  keeps current work, shared references and recent published files bounded;
  completed work remains in searchable, paged history. Collections follow the
  current chat without changing model context or permissions. Files lists chat attachments, published work outputs and shared
  project files as compact metadata rows with search, useful collection filters
  and bounded pages. File contents open only in the inspector. Agent workspace
  files and repository/native execution setup are available in a closed disclosure.
  Add places files in the current conversation draft for review before sending.
  Memory supports explicit chat-scoped additions, corrections, deletion, and
  existing suggestion review, with inherited context labelled separately.
  A document, web preview, side conversation or computer opens in the same panel;
  Back restores the collection and its search. Closing the panel preserves its
  collection searches; the desktop agent sidebar stays expanded. Created files, search previews and side conversations
  open alongside the main chat. Text, Markdown, JSON, images, PDFs and bounded
  Office content preview locally; published files also retain native Save/Open.
  Explicit web-link
  clicks open script-free HTTPS frames; sites that block embedding or require
  interaction can be opened in the browser. Frames receive no native capabilities,
  while the application renderer retains its IPC-only network policy.
- Conversation split panes arrange durable conversations and
  supported artifacts. Closing a pane leaves work running and discoverable in
  Activity. Projects contain focused chats, shared files and occurrence-tracked
  local agent automations and research-only schedules. Work runs while the app is open and Windows is awake;
  interrupted work requires review before continuation. Steering and explicit
  continuation are recorded at safe boundaries without replaying external
  effects, request files keep durable references with accurate reattachment
  prerequisites after restart, and saved results can be promoted into Memory
  with provenance. See the
  [coordination decision](docs/adr/2026-09-12-teammates-conversations-projects.md)
  and [Work execution](docs/architecture/work-execution.md).
- Conversation turns preserve the order of updates and tool activity, with
  expandable public reasoning summaries, Markdown answers and reading-aware
  scrolling. Agents can create bounded passive DOCX files and XLSX workbooks
  with safe aggregate formulas in their private workspace. Generation,
  structural validation and immutable publication are separate steps;
  published Office documents and passive PDFs open as verified copies in their
  associated app.
- Workspace-wide app access and approval preferences shared by all agents,
  with exact approval checks for consequential tools and connector actions.
- Provider model visibility controls in Settings. Hidden models stay out of
  conversation pickers; hiding the selected model requires a new selection.
- File attachments and memory provide conversation context; long conversations
  keep recent turns plus incremental durable summaries and scoped retrieval of
  older relevant history rather than replaying the lifetime transcript. Knowledge
  is no longer a separate product feature. Existing imported records remain stored.
- Native Windows application control through bundled Cua Driver 0.25.0, governed
  by the global approvals setting. Computer Use is enabled and disabled from its
  ordinary Plugin card and detail view; enabling it does not grant permission.
  Full Access needs
  no separate app grant; the agent finds and selects the window itself.
  A compact native activity window and Ctrl+Alt+Esc stop control. This shares
  your Windows session. Supported app controls use background delivery by default;
  screenshots, keys and pixel actions require an explicitly approved foreground
  selection. Minimized windows are unavailable. This is not a separate desktop.
  Structured observations, bounded input and scoped workspace files
  use Mivlet's native approval boundary. Screenshot delivery supports the
  vision-capable Codex app-server route and the audited OpenAI, Anthropic and xAI
  direct API models. See the [provider matrix](docs/architecture/local-teammate-computer.md#tool-and-provider-paths)
  for supported routes and [verification evidence](docs/development/local-computer-verification.md#visual-provider-expansion)
  for live limitations. No local shell tool is exposed.
- Agents can open a Mivlet-owned Chrome or Edge window under global approvals,
  using a private profile outside agent files. Launch requires explicit foreground
  delivery and a protected system installation with a verified publisher.
  The agent then lists and selects the window through normal computer tools.
  Stop leaves this browser open for human takeover; account changes and app
  closure close it. Fresh DOM references support tab activation, observation,
  clicks and empty public text fields. Private fields require human handover.
  Managed downloads close the owned browser before sealing passive files into
  workspace custody; uploads attach an exact verified published passive artifact
  to a fresh empty file field. Both are bounded to 8 MiB and require exact approval.
- Runtime-detected operating-system dictation. It fails closed when speech
  recognition is unavailable and does not retain raw audio.

### Optional and deployment-gated

- The hosted runner contains bounded Cloudflare computer and browser endpoints
  with short-lived generation-fenced capabilities. Local tests and packaging
  checks do not prove that Containers, Browser Rendering, Durable Objects,
  Convex, Clerk, or production secrets have been deployed.
- The [cloud task service](docs/architecture/hosted-text-tasks.md) accepts an
  explicitly reviewed Work item and separately connected cloud API key. Text tasks
  make one model call; public-page research uses a bounded model/read loop within
  exact reviewed HTTPS domains. Both can finish while the desktop is closed and
  retain their result for reconciliation. The deployed Worker and development
  Convex capability endpoint passed live authorization checks; a real provider
  completion and signed-in native admission still need acceptance.
- Cloud file work requires exact selected input files, writable paths and optional
  check commands, followed by a separate approval to import returned changes.
  Its isolated offline runtime requires Workers Paid and successful runtime
  isolation checks. That runtime has not been activated or live-validated.
- A separate OpenCode Workerd and Cloudflare Agents fixture verifies a scheduled
  task, exact approval, cancellation and durable receipt across restart. It accepts
  fixed synthetic data only and provides no additional production task authority.
  See the [SDK architecture](docs/architecture/hosted-opencode-prototype.md).
- Account sign-in gates first-run setup. Convex sync and remote workspace code
  remain optional foundation for future shared or multi-device work and are not
  current production collaboration claims.
- Account sign-in needs configured Clerk OIDC. Confidential connector OAuth
  needs the separate broker and provider
  configuration. Direct provider APIs and Codex browser sign-in still require
  valid credentials, entitlement, installed components, and network access.
  Antigravity's managed installer is currently Windows x64 only. Claude,
  Cursor, Grok, and OpenCode require their official command-line runtime to be
  installed separately before Mivlet can connect it.

### Not complete

- Automatic continuation of ordinary conversations after the desktop app
  closes.
- Secure sign-in or secret handoff inside a hosted agent computer.
- Live hosted computer/browser operation, real-provider cloud task acceptance,
  production tenancy, metering, monitoring, disaster recovery, or multi-device sync.
- Signed public installers, updater channels, supported macOS/Linux releases,
  and physical-phone/push-delivery acceptance.

The [local computer](docs/architecture/local-teammate-computer.md) and
[hosted computer](docs/architecture/hosted-teammate-computer.md) documents define
their separate trust boundaries.

## Repository layout

```text
apps/desktop        React UI, Convex functions, and the Tauri Rust boundary
apps/accounts       Mivlet-themed browser authentication and OAuth consent
apps/hosted-runner  deployment-gated Cloudflare computer/browser worker
apps/broker         narrow confidential connector OAuth broker
packages/protocol   shared product and authority contracts
packages/connectors provider, connector, tool, voice, and MCP adapters
packages/agent-host native-only embedded OpenCode execution and fixture tests
packages/knowledge  local ingestion and retrieval engine
docs                maintained architecture, security, and operations notes
```

## Requirements

- Node.js 22 or newer
- pnpm 10 (the repository pins `pnpm@10.34.7`)
- Stable Rust and the Windows Tauri prerequisites
- Windows WebView2
- Official Codex app-server components for optional ChatGPT browser sign-in

Native computer use supports Windows x64. The normal development/build commands
download and verify the pinned driver, then bundle it with Mivlet and its license
notices. Installed users need no Docker, Python, Node, uv or separate Cua app for
this capability. Windows WebView2 and a validated model provider are still
required; provider-specific runtime prerequisites above remain separate.

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the browser-only Vite preview, whose synthetic state is
labelled. Use the native app for provider credentials, encrypted persistence,
and native Windows application control:

```bash
pnpm tauri:dev
```

Configuration templates live beside the component that owns them:

- `apps/desktop/.env.example`
- `apps/broker/.env.example`
- `apps/broker/.dev.vars.example`
- `apps/hosted-runner/.dev.vars.example`

Keep real credentials out of Git. Missing optional configuration must leave the
related capability unavailable rather than substituting a fixture.

## Verification

The aggregate local/release gate is `pnpm check` (quality, `verify:build`, tests,
perf, release manifest, `tauri:check`, and `audit:all`). Linux PR loops use
`pnpm test:pr` (excludes the Windows agent-host executable). Host tests are
`pnpm test:host` on Windows. Focused gates:

```bash
pnpm typecheck
pnpm test:pr
pnpm quality
pnpm verify:build
pnpm perf:check
pnpm perf:test
pnpm perf:runtime
pnpm release:test
pnpm tauri:check
```

Daily Linux PR loops can use `pnpm check:pr` (or `pnpm test:pr` for the package
tests). The Windows embedded-host suite is `pnpm test:host`. `pnpm lint` is
security-subset ESLint (`lint:security`) plus the explicit-any ratchet, not
typed or React lint.

For Rust changes, also run:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Hosted-runner changes require its focused tests, build, and
`pnpm --filter @mivlet/hosted-runner worker:deploy:dry-run`.
A dry-run validates packaging and bindings only; it does not validate a live
Cloudflare environment. Local hosted-runner Worker dev is
`pnpm --filter @mivlet/hosted-runner worker:dev` on port 8789.

## Working principles

- Keep the default UI sparse, conversational, accessible, and agent-first.
- Preserve provider choice behind Mivlet-owned contracts and adapters.
- Keep credentials behind native or deployment-secret boundaries.
- Bind consequential actions to exact approvals and fail closed when authority
  or configuration is missing.
- Treat fixtures, tests, dry-runs, and local builds as local evidence, never as
  deployment, integration, or product-parity evidence.

Contributor guidance is in [AGENTS.md](AGENTS.md). Product direction is in
[docs/product/vision.md](docs/product/vision.md).

## Compatibility

Package names are `@mivlet/*`. Operator environment keys are `MIVLET_*`; missing
values fall back once to the former `FABLE_*` aliases for one deploy cycle (a
present empty `MIVLET_*` value does not fall through). Native application
identifier (`com.fable.workspace`), database filenames, credential namespaces,
local storage keys, and computer paths stay on their existing on-disk names so
installs keep their data. See the [Windows release guide](docs/operations/windows-private-release.md)
for installer upgrade behavior and verification limits.
