# Fable Status

Last audited: 2026-07-11.

This is the factual state of the repo, not the product pitch. Claims below were checked against current files in this checkout.

> **Document boundary:** [Product Blueprint](vision.md) defines the approved final state. [Master Build Plan](master-build-plan.md) is the ordered execution tracker. This file reports current implementation facts only.

> **Approved workspace direction:** Fable requires a Clerk-backed account, but Clerk supplies identity/session only. Fable owns internal users, workspaces, memberships, and authorization. One workspace model supports one or many members; there is no separate Personal Home, Team Workspace type, Fable Organization layer, or Clerk Organization tenancy. The implementation remains configuration-gated until live Clerk and Convex validation is performed.

## Repo Shape

- The repo is a private pnpm monorepo named `fable`, with apps `@fable/desktop`, `@fable/broker`, `@fable/marketing`, and `@fable/waitlist`, plus packages `@fable/connectors`, `@fable/knowledge`, and `@fable/protocol`.
- The desktop app is Tauri 2 plus React, TypeScript, and Vite.
- The Rust runtime is under `apps/desktop/src-tauri`.
- Product docs already exist for thesis, roadmap, architecture, connectors, native-runtime, release notes, and threat model.
- Brand assets exist under `apps/desktop/public/brand`.

## Implemented

- Account and workspace (**Wave 1A implementation complete; live validation open**): accepted ADRs and `@fable/protocol` contracts govern identity and tenancy. Clerk supplies authentication facts only; Convex owns stable internal users, identity links, workspaces, memberships, invitations, devices, and hosted authorization. Encrypted SQLite schema v14 stores the per-account workspace directory, active selection, device mirror, workspace-scoped sync state, durable conversations, local project lifecycle, and typed local goals. Native workspace commands fail closed without a current authenticated internal user; portable archives are bound to the active authorized workspace. The native adapter bootstraps an initial workspace idempotently, reconciles and creates workspaces, switches isolated runtime scope, and revokes account devices without exposing bearer tokens or arbitrary hosted calls to React.
- Durable chat (**Wave 1B implemented**): standalone or project-linked threads, typed encrypted messages and immutable revisions, workspace-scoped drafts and runs, streaming checkpoints, stop, retry, interruption/error recovery, and restart hydration are wired through the canonical Conversations contract. Empty or late hydration is fenced so it cannot bleed or erase another thread's optimistic exchange; workspace changes clear the selected conversation.
- Provider and first artifact (**Wave 1C implementation complete; full UI/IPC validation open**): agent providers support verified add, health checks, credential replacement/reconnect, revoked-auth recovery, and confirmed local removal with explicit provider-side revocation guidance. Provider metadata and keyring credentials are account-owned and unavailable after sign-out or account switching; legacy ownerless provider metadata is quarantined. Model selection uses exact provider-qualified routes and fails closed for unavailable or ambiguous choices. Auth, entitlement, offline, timeout, rate-limit, and provider failures retain distinct plain-language states. A terminal assistant response can become an encrypted, versioned, sourced artifact whose creator/member attribution and citations are derived from authenticated durable records. Run ownership, terminal state, message linkage, content hash, thread association, and reopen behavior are covered by native tests. The existing minimum-journey test composes native repositories directly; an actual Tauri IPC/UI plus restart validation remains open.
- Optional projects (**Wave 2A lifecycle, placement, guidance, conversations, and local Goal foundation implemented; broader context open**): canonical Project contracts define local/private and shared authority, active/archive/delete lifecycle, optimistic revisions, and bounded encrypted title, description, and instructions. SQLite schema v14 preserves legacy projects, adds member-private ownership plus tombstones, and stores typed local goals with optional project association. Native commands derive the workspace, internal user, and member from the authenticated active context; the renderer cannot select them. The desktop shell now creates, renames, archives, restores, and confirms deletion; opens a calm detail page with editable guidance and project conversations; creates chats inside projects; moves chats into or out of a project; and keeps standalone workspace chats first-class. `/goal` now writes through the authenticated typed Goal runtime and retains the snapshot only as a compatibility mirror. Project deletion detaches threads, goals, knowledge, memory, schedules, workflow definitions/runs, and pinned context instead of erasing workspace-owned records. Cross-workspace/member access, stale revisions, migration, detachment, and tombstone anti-resurrection have focused coverage. Existing legacy snapshot goals remain workspace-level compatibility data; Fable does not guess project scope. Project knowledge, Connections, missions, routines, artifacts, and activity surfaces remain open.
- Structural boundaries (**Wave 0D implemented**): the desktop `App` is now a small query-provider/composition entry over typed shell modules; agent/approval/voice wiring, lazy routes, model selection, and workspace presentation have explicit seams. `useShellRuntime` retains its stable facade while public types, default/preview policy, and backend normalization live in focused modules with regression tests. The Rust scheduler keeps its public command facade while state, events, pure transitions, persistence, orchestration, and tests are separated. The legacy protocol root is a compatibility barrel over account/cloud, approvals, agent-runtime, scheduling/workflow, and remote-control domains; executable checks preserve root/direct-domain exports and Spine parity.
- Desktop shell: Clerk account and provider onboarding, verified account display, workspace creation/switching, sidebar navigation, universal composer, theme toggle, model picker, permission picker, add menu, connector page, interactive Knowledge page, schedules page, profile page, and settings page.
- Composer: supports text entry, slash command insertion, local file import, opt-in browser dictation where the runtime exposes speech recognition, model selection, permission selection, and native-agent submit path when a connected native backend exists.
- Protocol package: defines approvals, memory, connectors, backend providers, runtime snapshots, native agent events, native tool specs, and tool-call request shapes.
- Local file import: supports `txt`, `md`, `markdown`, `json`, `csv`, `yaml`, and `yml`; rejects empty files, unsupported extensions, changed file sizes, and files over 2 MB; imported files are untrusted local knowledge with a 6,000-character preview.
- Knowledge and retrieval: local files and recursive folders can be imported (with path-escape guards), structurally chunked (for Markdown, JSON, CSV, YAML), fingerprinted, scoped, searched, refreshed, disabled, and deleted. Retrieval uses reciprocal-rank fusion (RRF, k=60) for hybrid lexical/semantic ranking. Sources and memory records are subject to workspace-scoped composite key isolation (SQLite schema v5) with deletion/forget tombstones.
- Approvals: the shell exposes Read Only, Ask Me (default), Work Freely, and Custom. Rust persists exact one-time execution permits, audit entries, high-risk confirmation, and denied-action handling.
- Memory: Rust commands support listing, saving, exporting, disabling, editing through shell state, and approval-gated promotion from a knowledge source into durable memory.
- Local recovery: runtime snapshot, approval audit, approval rules, imported knowledge, memory state, and connected backend ids are persisted through encrypted SQLite in Tauri; browser preview still uses localStorage. Schedules, workflows, and knowledge structures are persisted inside the encrypted SQLite database under schema v5.
- Backend catalog: Codex, Cursor, GitHub Copilot, Grok Build, OpenCode, Kimi Code, Mistral Vibe, Ollama, OpenAI, Anthropic, Gemini, xAI, OpenRouter, and a broad native API-key catalogue are modeled as agent-runtime backends. Codex uses app-server; provider-owned coding runtimes use ACP when their installed CLI is available and authenticated; Ollama uses an externally managed literal-loopback service. No provider-owned session token enters Fable.
- Backend credentials: Rust uses an internal-user-scoped keyring boundary for backend secrets, with an in-memory fallback for headless/test paths. Connection metadata is scoped to the same account, and workspace archives exclude provider authority. JavaScript receives auth state, capabilities, and models, not raw secrets.
- Native API agent loop: TypeScript owns provider request shaping and a bounded
  multi-round agent loop; Rust owns API key lookup, bounded HTTP/SSE egress,
  normalized retry/error events, idle timeout, response-size enforcement, and
  cancellation for OpenAI-compatible, Anthropic, and Gemini-style providers.
- Native model discovery: provider lists are paginated and bounded with
  distinct success/empty/unsupported/offline/failed outcomes. Non-generation
  and unknown-capability models cannot be selected.
- Local model runtime: Ollama discovery and streaming generation are wired
  through Rust commands that only accept `http` literal-loopback base URLs
  (default `http://127.0.0.1:11434`). Fable does not bundle Ollama, start it,
  pull models, or broaden webview/network egress. Prompt and response payloads
  are not logged; action history records provider/model/request status only.
- Clerk identity: the native public-client PKCE path enforces mandatory account gating, recovery, sign-out, configuration drift, expiry, revocation, issuer, audience, authorized-party, and signing-key validation. Credentials and pending PKCE state use a dedicated identity keyring service; React receives only secret-free verified account data and opaque references. Clerk organization claims neither grant nor block Fable access. Production credentials and a real live session have not been validated in this checkout.
- Cloud/team backend: Convex is the canonical hosted control plane for Fable-owned users, identity links, workspaces, memberships, invitations, roles, devices, and shared-project authorization. The native boundary exposes only explicit account/workspace operations. Hosted policy and the SQLite v11 mirror fail closed on ambiguous identity, inactive authority, cross-workspace access, privilege inversion, stale/conflicting revisions, replay conflicts, removed memberships, and tombstone resurrection. Deployment and live network validation remain open.
- Agent recovery: run checkpoints persist active-thread user, assistant, and
  tool exchanges. Interrupted runs surface in chat and retry as new child runs
  from the durable user prompt without replaying tool effects.
- Tool execution: the registered tools are `read-file`, `write-file`,
  `run-shell`, and `web-fetch`; calls are bounded and route through approval
  before Rust re-validates an exact, fresh, single-use execution permit.
- First-wave connector catalog: GitHub, Vercel, Google Drive, Notion, Gmail,
  Slack, Google Calendar, and Linear are modeled with scopes, auth mode,
  health/status metadata, search/import/action protocol shapes, and fixture
  adapters.
- Connector writes: native preparation creates exact approval requests for supported provider actions. Development fixtures are explicit test/preview adapters and are never a production fallback.
- Tauri connector runtime: external connector commands expose status/auth/health/search/import/action boundaries. Google public-client connectors use loopback PKCE and OS secure storage; confidential-client connectors (GitHub, Vercel, Notion, Slack, Linear) are broker-gated and fail closed with `configuration-required` until the auth broker and provider configuration exist. GitHub live integration is read-only for identity, repositories, issues, and pull requests; live GitHub writes are not advertised or mapped.
- Notion, Slack, and Linear connector adapters implement authenticated provider reads, normalized pagination/errors, and approval-gated writes. Their configured, unconfigured, expired, revoked, and provider-error states remain visible instead of collapsing to connected. External use is still gated on broker deployment, provider-console setup, and live OAuth validation.
- Google connectors: Drive, Gmail, and Calendar expose authenticated reads and approval-gated writes, active-token granted-scope checks, refresh-token preservation without historical scope merging, explicit active-account selection, bounded responses, cancellation, and normalized provider errors. External use still requires Google Cloud configuration and applicable verification.
- Connector sync foundation: manual sync records an encrypted, workspace-scoped lifecycle around existing on-demand reads, with background/retry trigger vocabulary, stale-token refresh through the native credential boundary, explicit failure classes, and cache export/deletion rules. The always-on background worker and provider-specific full-content indexers remain future work.
- Schedules page: users can create, pause/resume, and delete local schedule records. Records persist in the encrypted SQLite database; the Tauri runtime leases due occurrences, queues workflow runs, and executes scheduled prompts through the provider-neutral `AgentBackend` path when a runnable backend is connected.
- Connector cache lifecycle: synced connector data is cached in the encrypted local vault (`connector_cache`, schema v2). The cache is searchable, workspace-isolated, and secret-free; the write path redacts token-shaped values and fails closed when a secret marker survives. Per-workspace and per-connector cache settings gate writes/reads, and disable/delete/clear/resync/export commands preserve workspace isolation and never include provider tokens.
- CI file: `.github/workflows/ci.yml` exists and uses pnpm for typecheck, tests, build, Tauri check, Rust tests, clippy, and fmt on Windows.
- Tests exist across desktop, connectors, native API, local files, knowledge search, backend registry, and Rust runtime modules.
 
## Runtime Availability Matrix
 
| Area | Category | Details / Location |
| --- | --- | --- |
| Local files, approvals, memory controls, knowledge search, runtime snapshots | **Finished** | Live local runtime paths in Tauri. Pinned context, sources, and memory records are persisted in dedicated SQLite tables (schema v5) with composite primary key isolation. |
| Local optional projects | **Finished for lifecycle, guidance, conversations, and Goal storage** | Encrypted member-private projects support create, rename, archive, restore, deletion, optional thread association, a calm guidance/conversation page, and typed local goals through authenticated Tauri commands. Broader project context remains Wave 2A work. |
| Encrypted SQLite Core | **Finished** | Active in production Tauri path (keyring-backed AES-256-GCM vault). |
| Native API-key Backends (BYOK) | **Finished** | Live OpenAI, Anthropic, Gemini, xAI, OpenRouter model execution when keys are supplied to local keyring. (See [Native Agent Runtime](native-runtime.md) for the capability matrix). |
| Schedules Core | **Finished** | Local scheduler tick, leasing, queueing, and headless prompt execution are fully functional (depends on connected runnable backend). |
| Connector Cache (schema v2) | **Finished** | Searchable, workspace-isolated, secret-free synced connector data in encrypted SQLite with disable/delete/clear/resync/export lifecycle and per-workspace/per-connector settings. |
| Google Connectors (Drive, Gmail, Calendar) | **Functional but gated** | Live public-client PKCE egress is functional, but requires user-supplied Google Cloud Console OAuth Client configuration. |
| ACP Providers | **Functional but gated** | Cursor, GitHub Copilot, Grok Build, OpenCode, Kimi Code, and Mistral Vibe run only when their local CLI is installed and authenticated. |
| Codex app-server | **Functional but gated** | Live chat-server loop when local Codex CLI is installed/authenticated. |
| Local Ollama Runtime | **Functional but gated** | Live loopback streaming is available only when the user installs Ollama, starts its local service on a literal loopback IP, and pulls a generation model. Real-runtime smoke testing is opt-in. |
| Confidential Connectors (GitHub, Vercel, Notion, Slack, Linear) | **Functional but gated** | Rust/TS brokered auth, lifecycle states, and provider adapters exist. Notion, Slack, and Linear expose authenticated reads and approval-gated writes; GitHub's implemented live surface is read-only. Durable atomic handoff storage, production deployment, provider secrets, callback registration, and live OAuth validation are still missing. |
| Fable Cloud Identity (Clerk) | **Implemented; live-validation gated** | Native PKCE, mandatory sign-in, recovery, expiry/revocation, strict claim/config validation, workspace bootstrap/switching, and account device revocation are implemented. Production configuration and a live session are not validated. |
| Browser Preview Mode | **Preview/fixture-only; transport deferred** | Purely synthetic fixture responses. Browser permission policy architecture, session derivation, and audit redaction are implemented; headless browser transport and live execution are deferred. |
| Mobile Remote Control | **Local status surface; transport deferred** | Protocol metadata, trust checks, and native status commands exist. Settings reports that live LAN transport and pairing are unavailable; no socket, mobile app, hosted account, or remote execution authority exists. |
| Schedules & Workflows SQLite migration | **Finished** | In Batch 9, schedules, queue entries, workflow definitions, and workflow runs were fully migrated from legacy JSON files into encrypted SQLite tables. |
| GitHub Copilot Execution | **Functional but gated** | Uses the installed provider-owned ACP runtime and requires its own authenticated CLI session. |
| Non-Windows Packaging & CI Keychain | **Missing** | Release builds only support Windows (unsigned). macOS/Linux packaging and CI keychain test runners are missing. |
| Native voice providers, Convex collaboration | **Mixed** | Dictation still depends on the host Web Speech API. Convex now has an explicit native account/workspace adapter and visible workspace journey; multi-member collaboration and live deployment validation remain later work. |

## Partially Implemented Or Preview-Only

- Browser preview uses an explicit synthetic identity/workspace fixture. The Tauri path requires a Fable account and then one provider; it no longer offers a local profile, password, or skip route.
- The API-key path can hand native backend secrets to the Rust credential boundary, but subscription provider paths are represented as backend catalog states and install/setup flows, not proven live provider integrations.
- Browser preview can mark API-key backends as locally connected for testability. Connector reads remain explicitly fixture-backed and do not become live connections.
- Connector search/import in browser preview uses explicitly labeled synthetic fixture behavior.
- The Knowledge page provides Sources and Memory modes with search, provenance,
  status, scope, account, freshness, local file/folder import, connector entry,
  refresh, pin, disable/delete, explicit memory promotion, edit, export,
  disable, and forget controls.
- Schedules execute locally through the runtime scheduler when due and when a connected runnable backend is available. Blocked-auth and unavailable-backend states remain explicit instead of silently falling back. The schedules are backed by encrypted SQLite tables.
- Voice dictation is opt-in and available only when the host browser/webview exposes a Web Speech API. Unsupported runtimes preserve normal text entry; there is no native offline speech provider.
- The native Convex account/workspace adapter is configuration-gated. Existing hosted devices can be listed and revoked; automatic registration of the current device is deferred until Fable has a genuine public-key/proof-of-possession contract.

## Not Implemented Yet

- No deployed production auth broker or externally validated OAuth session. The
  broker defaults to memory storage, but durable atomic storage classes and
  Worker bindings exist behind `FABLE_BROKER_STORAGE_BACKEND=durable`; durable
  mode still requires deployment, bindings, and `FABLE_BROKER_STORE_ENCRYPTION_KEY`.
- No provider-console apps, deployed callback URLs, OAuth consent verification, or non-production live OAuth validation evidence in the repo.
- No externally validated live connector sessions in this checkout. Google public-client connectors still require provider configuration and test accounts; confidential-client connectors still require the auth broker (implemented in `apps/broker` targeting Cloudflare Workers, but not yet deployed in production).
- Browser-only preview state still uses localStorage; the Tauri production path uses encrypted SQLite for main documents, schedules, workflows, and knowledge structures. Backend and connector credentials remain separately handled by OS secure storage.
- No bundled local model runtime, model download flow, model license UI, or live Ollama smoke evidence in the default suite. Ollama remains a user-installed trusted loopback integration.
- No production Clerk/Convex configuration or externally validated live Fable account session exists in this checkout. Multi-member invitations and collaboration remain a later vertical slice.
- No signed release, updater channel, macOS packaging, or Linux packaging. Release docs identify the Windows preview build path and unsigned distribution gaps.
- No product website, legal pages, downloads page, or public release pipeline in the audited files.

## Highest-Risk Gaps

- External connectors look close in the UI but remain gated by provider setup and credentials. GitHub now has a brokered live read path in code, but product messaging must keep production deployment and read-only limits clear.
- Local model execution now exists through Ollama but depends on a user-managed local service and model installation; Fable must keep avoiding bundled downloads or broader egress until those are intentionally designed.
- Mandatory Clerk identity remains separate from connector OAuth and provider credentials. Production cloud use is blocked on real Clerk/Convex configuration and live end-to-end validation, not on additional client-side account gating.
- Backup restoration requires the database and matching OS-secure master key; external recovery UI polish remains future work.
- Scheduled work still depends on a connected runnable backend and user approval gates for consequential actions; live account coverage was not externally validated in this checkout.

## Evidence Checked

- `docs/product/vision.md`
- `docs/product/master-build-plan.md`
- `docs/product/product-spine-inventory.md`
- `docs/adr/2026-07-10-product-ontology.md`
- `docs/adr/2026-07-10-identity-workspace-tenancy.md`
- `docs/architecture/record-authority-matrix.md`
- `docs/architecture/product-spine-migration-strategy.md`
- `README.md`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/product/thesis.md`
- `docs/product/roadmap.md`
- `docs/product/architecture.md`
- `docs/product/connectors.md`
- `docs/product/release.md`
- `docs/security/threat-model.md`
- `apps/desktop/package.json`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src/hooks/useShellRuntime.ts`
- `apps/desktop/src/hooks/useNativeAgent.ts`
- `apps/desktop/src/components/Composer.tsx`
- `apps/desktop/src/components/pages/OnboardingPage.tsx`
- `apps/desktop/src/components/pages/ProfilePage.tsx`
- `apps/desktop/src/components/pages/SettingsPage.tsx`
- `apps/desktop/src/components/pages/KnowledgePage.tsx`
- `apps/desktop/src/components/pages/SchedulesPage.tsx`
- `apps/desktop/src/data/workspace.ts`
- `apps/desktop/src/lib/persistence.ts`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/src-tauri/src/models.rs`
- `apps/desktop/src-tauri/src/paths.rs`
- `apps/desktop/src-tauri/src/snapshot.rs`
- `apps/desktop/src-tauri/src/memory.rs`
- `apps/desktop/src-tauri/src/connectors.rs`
- `apps/desktop/src-tauri/src/connector_auth.rs`
- `apps/desktop/src-tauri/src/connector_api.rs`
- `apps/desktop/src-tauri/src/collaboration_connectors.rs`
- `apps/desktop/src-tauri/src/google.rs`
- `apps/desktop/src-tauri/src/oauth_loopback.rs`
- `apps/desktop/src-tauri/src/backends.rs`
- `apps/desktop/src-tauri/src/native_api.rs`
- `apps/desktop/src-tauri/src/local_model.rs`
- `apps/desktop/src-tauri/src/clerk_identity.rs`
- `apps/desktop/src-tauri/src/tools.rs`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/spine/primitives.ts`
- `packages/protocol/src/spine/identity.ts`
- `packages/protocol/src/spine/connections.ts`
- `packages/protocol/src/spine/missions.ts`
- `packages/protocol/src/spine/artifacts-routines.ts`
- `packages/protocol/scripts/check-spine-parity.mjs`
- `apps/desktop/src-tauri/src/product_spine_parity.rs`
- `packages/connectors/src/index.ts`
- `packages/connectors/src/local-files.ts`
- `packages/connectors/src/knowledge-search.ts`
- `packages/connectors/src/providers/registry.ts`
- `packages/connectors/src/backends/registry.ts`
- `packages/connectors/src/native-api/agent-loop.ts`
- `packages/connectors/src/native-api/ollama.ts`
- `packages/connectors/src/native-api/tools.ts`
- `packages/connectors/src/native-api/tool-executor.ts`
- `docs/connectors/auth-broker.md`
- `docs/architecture/local-model-runtime.md`
- `docs/adr/2026-07-04-clerk-tauri-identity.md`
- `docs/adr/2026-07-05-cloud-team-backend.md`
- `docs/security/cloud-team-sync-threat-note.md`
- `docs/architecture/cloud-team-sync-mvp.md`
- `docs/architecture/browser-automation.md`
