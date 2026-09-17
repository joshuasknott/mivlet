# Plugins and daily-driver assessment

Implementation reconciled 15 September 2026. This describes the current source.
Unit tests, browser previews, native tests, direct provider probes and packaged
workflows are separate evidence. Repeated live daily-driver acceptance remains
open. Earlier stopped-work handoffs and Docker-era claims are superseded by this
assessment and the linked architecture decisions.

## Current product and boundaries

Signed-out users authenticate. Validated accounts open their own local workspace
without mandatory provider onboarding. Agent execution still requires a verified
provider. Account-owned encrypted stores, provider credentials and workspace data
remain separate; remote sync is deployment-gated.

The entry page only signs in or retries an unavailable account workspace. The
superseded provider/app onboarding stages and their duplicate setup code are
removed; Settings and Plugins retain the functioning setup routes.

Computer Use is a built-in plugin for existing Windows applications, using bundled
Cua Driver 0.25.0. Enabling it does not grant permission. Mivlet owns exact
single-use approvals, workspace/agent/request and window identity, freshness,
generation fences, one-agent control leases and immediate Stop. Supported
accessibility actions use background delivery; screenshots, keyboard and pixel
actions require explicitly approved foreground selection. Minimized windows are
unavailable. Full Access resolves the same exact approval without extra app grants.
There is no host-shell fallback or separate local desktop.

### Browsing capabilities stay distinct

| Capability | Implemented boundary | Remaining acceptance |
| --- | --- | --- |
| Page preview | Explicit HTTPS links open script-free workspace frames without native capabilities; embedding-blocked pages can open externally | Packaged WebView behavior across representative sites |
| Page fetching | Bounded public URL reads with native URL/SSRF checks and readable text extraction | Repeated research tasks, source fidelity and recovery |
| Provider search | Selected Codex app-server routes supply provider-owned search; catalogue presence does not add search to other providers | Packaged ordinary-chat search, result selection and citations |
| Native browser control | Computer Use targets an exact browser window in the user's Windows session | Sign-in takeover, upload/download and repeated task completion |
| Hosted browsing | Separate Cloudflare runner/browser endpoints with short-lived fenced authority | Deployed bindings, secrets, tenancy and live workflows |

The retired Docker Browser plugin is not an additional plugin to restore. See
[native computer architecture](../architecture/local-teammate-computer.md),
[hosted computer architecture](../architecture/hosted-teammate-computer.md) and
[native verification evidence](../development/local-computer-verification.md).

## Connections and route selection

Computer Use, Gmail, Google Drive, Google Calendar, GitHub and Vercel appear in
Featured. Working secondary integrations remain available through categories and
search. Skills belong to agent profiles; provider login stays separate from app
authorization. App actions retain exact connection and approval checks.

| Route | Services | Custody and availability |
| --- | --- | --- |
| Native public OAuth | Gmail, Drive, Calendar | Google PKCE and token exchange stay behind the native credential boundary |
| Confidential broker OAuth | GitHub, Vercel, Notion, Linear, Slack | Separate broker owns client secrets; desktop configuration and broker deployment are required |
| Native token plugins | Outlook, Teams, Zoom and other documented token integrations | Native verification and OS credential storage; bounded reads, manual renewal, no writes or knowledge sync |
| Official remote MCP | Vercel, Notion, Linear, Canva, Figma and other official presets | Native MCP OAuth, discovery and enabled-tool checks against the exact provider endpoint |

[Connector capabilities and setup](connectors.md) maintains the full service list,
scopes and configuration references. Setup details share presentation and
pending/error handling; route-specific credentials, permissions, connection
records and tool capabilities remain separate.

Notion, Linear and Vercel show one connection flow, without a method selector.
New accounts use the official remote sign-in. Existing native accounts retain
their setup and reconnect flow. Verified remote access takes precedence when
both routes work; a broken remote setup does not hide a healthy native account
with its required permissions. If neither works, the saved remote setup shows
Reconnect. Route selection applies to new turns; an in-flight turn loses access
when its admitted route changes and cannot redirect an approved action to the
other account. Credentials are not migrated or deleted.

## Acceptance priorities

| Priority | Area | Implemented locally | Still required |
| --- | --- | --- | --- |
| P0 | Computer and browsing | Native control, scoped files, page fetch, previews and Codex search; audited screenshot delivery per provider | Repeated packaged research, browser interaction, download and output-opening tasks on advertised routes |
| P0 | Google services, GitHub and Vercel | Native reads and supported approved writes; Vercel MCP also verifies account access | Authorized live inbox/calendar/repository/deployment workflows, permission changes and reconnect/revoke cases |
| P0 | Deliverables | Bounded passive DOCX and formula-bearing XLSX creation, structural validation, immutable publication and verified external opening | Packaged layout/formula QA; richer documents and slide creation |
| P0 | Continuation and isolation | Durable history, context receipts, Stop checkpoints, explicit continuation and no automatic replay of uncertain writes | Repeated crash/restart and real side-effect reconciliation through the packaged app |
| P1 | Context and projects | Memory inspection/correction, incremental summaries and bounded retrieval; projects own Chat, Team, Work, files and attributed results | Long-running project acceptance, historical context accuracy and multi-agent interruption/recovery |
| P1 | Scheduling and delegation | Local schedules, occurrence records and scoped assignments; workspace execution survives closing views | Sleep/close/restart acceptance and notifications; ordinary conversations do not continue with the app closed |
| P1 | Media and voice | Audited image routes, native media boundaries, dictation and interruptible calls with separate OpenAI speech consent | Live media/audio, interruption and packaged device acceptance |
| P1 | Coding | Bounded repository ZIP import, file reads and explicit edits | Approved isolated execution, builds/tests, verified diffs and PR workflows; a ZIP does not supply host-shell access |
| P2 | Hosted operation and distribution | Hosted runner foundation and synthetic hosted OpenCode prototype retained | Production deployment, signing/updating, clean-machine upgrades and deliberate multi-device scope |

The [provider matrix](../architecture/local-teammate-computer.md#tool-and-provider-paths)
defines screenshot delivery; advertising vision alone is insufficient. See also
[Work execution](../architecture/work-execution.md),
[memory and context](../architecture/memory-context.md),
[speech input](../architecture/voice-conversations.md) and the
[hosted OpenCode prototype](../architecture/hosted-opencode-prototype.md).

## State ownership and history

- `apps/desktop/src/hooks/shell-runtime/useAccountWorkspace.ts` owns account
  requests and workspace transitions, suspending execution before changing scope.
- `useWorkspaceSnapshot.ts` owns hydration, failed-load recovery and serialized,
  identity-bound writes. Conversation drafts retain their separate scoped writer.
- `useWorkspaceApprovals.ts` owns the queue, audit/rules and native decision
  bridge. Old-owner responses cannot release or repopulate the next owner's queue.
- `apps/desktop/src/shell/useWorkspaceNavigation.ts` owns layout restoration and
  panel navigation; `WorkspaceConversationDialogs.tsx` handles metadata, explicit
  history sharing and legacy-group conversion.
- `apps/desktop/src/lib/workspace-execution.ts` retains execution ownership.
  Opening, closing and restoring views do not dispatch work by themselves.
- Runtime commands are imported directly from `apps/desktop/src/runtime/domains/`.
  Native OAuth enters through `begin_connector_oauth`; approval decisions through
  `resolve_approval_request`. Connector action preparation remains internal Rust.

The [coordination decision](../adr/2026-09-12-teammates-conversations-projects.md),
[account-first decision](../adr/2026-08-31-account-first-onboarding.md) and
[encrypted storage history](../architecture/encrypted-storage.md) retain useful
architecture and migration context. Historical database migrations remain necessary
for older installations; they are not active legacy product surfaces.

## Verification and measurement

Use the [verification guide](../development/verification.md) for affected tests,
types, quality, native checks, builds and unchanged performance budgets. An older
passing suite or failed bundle measurement is not today's implementation status.

Compare fixed tasks: cited research, inbox/calendar work, browser upload/download,
human sign-in takeover, spreadsheet/document creation, a repository fix, long
conversation recall and interrupted-work recovery. Record model/route, success,
human intervention, elapsed time, tool errors, artifact correctness and duplicate
side effects. Use authorized test accounts for external writes. Fixtures and direct
provider probes do not close packaged acceptance; code movement does not establish
a runtime speed improvement.
