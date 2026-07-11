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

- Account and workspace (**Wave 1A implementation complete; live validation open**): accepted ADRs and `@fable/protocol` contracts govern identity and tenancy. Clerk supplies authentication facts only; Convex owns stable internal users, identity links, workspaces, memberships, invitations, devices, and hosted authorization. Encrypted SQLite schema v18 stores the per-account workspace directory, active selection, device mirror, workspace-scoped sync state, durable conversations, local project lifecycle, typed local goals, owner-qualified private context, immutable artifact versions, exact-version private reviews, and exact-version private-project handoffs. Native workspace commands fail closed without a current authenticated internal user; portable archives are bound to the active authorized workspace and private owner. The native adapter bootstraps an initial workspace idempotently, reconciles and creates workspaces, switches isolated runtime scope, and revokes account devices without exposing bearer tokens or arbitrary hosted calls to React.
- Durable chat (**Wave 1B implemented**): standalone or project-linked threads, typed encrypted messages and immutable revisions, workspace-scoped drafts and runs, streaming checkpoints, stop, retry, interruption/error recovery, and restart hydration are wired through the canonical Conversations contract. Empty or late hydration is fenced so it cannot bleed or erase another thread's optimistic exchange; workspace changes clear the selected conversation.
- Provider and artifact foundation (**Wave 1C creation plus Wave 2C immutable revisions, private review, search/export, and private-project handoff implemented; full minimum-journey UI/IPC restart validation open**): agent providers support verified add, health checks, credential replacement/reconnect, revoked-auth recovery, and confirmed local removal with explicit provider-side revocation guidance. Provider metadata and keyring credentials are account-owned and unavailable after sign-out or account switching; legacy ownerless provider metadata is quarantined. Model selection uses exact provider-qualified routes and fails closed for unavailable or ambiguous choices. A terminal assistant response can become an encrypted, sourced artifact whose creator/member attribution and citations are derived from authenticated durable records. Schema v18 binds artifacts, versions, reviews, and handoffs to the exact hosted member or local user with owner-bound encryption, quarantines pre-v16 unowned rows, and stores each edit as an immutable version. Append, review, and handoff actions use atomic expected-revision checks; earlier content, hashes, evidence, resolved reviews, and source authority remain unchanged. Private owners can review and revise an exact version, search and export it, and explicitly add that exact version to another active private project they own. The two-step desktop action states that conversation history and permissions stay behind; source-project, shared, archived, deleted, foreign-member, and cross-workspace targets fail closed. Pending proposals resume after restart, accepted duplicates are rejected, and target-project search remains pinned to the handed-off historical version when the source advances. Multi-member reviewers and shared handoffs are not implied before Wave 2D. The desktop shows compact status, history, editing, review and handoff controls, plain stale-conflict handling, and persistent keyboard focus. Native artifact actions ignore renderer-supplied authority, actor, time, status, and evidence. Run ownership, message linkage, member isolation, version/review/handoff history, archive tamper rejection, corruption rejection, and reopen behavior are covered by native tests. The existing minimum-journey test composes native repositories directly; an actual Tauri IPC/UI plus restart validation remains open.
- Optional projects (**Wave 2A lifecycle, placement, guidance, conversations, Goals, local Knowledge, and Memory implemented; broader context open**): canonical Project contracts define local/private and shared authority, active/archive/delete lifecycle, optimistic revisions, and bounded encrypted title, description, and instructions. SQLite schema v15 preserves legacy projects, adds member-private ownership plus tombstones, and stores typed local goals with optional project association. Native commands derive the workspace, internal user, and member from the authenticated active context; the renderer cannot select them. The desktop shell now creates, renames, archives, restores, and confirms deletion; opens a calm detail page with editable guidance, project conversations, and exact-project Knowledge and Memory; creates chats inside projects; moves chats into or out of a project; and keeps standalone workspace chats first-class. Users can import and search supported local text files, explicitly update a source by choosing the current same-named file, disable/re-enable it, and confirm tombstone deletion without affecting another project. Update does not retain a file path or handle: native code revalidates the selected file and atomically replaces the authorized source only when its expected fingerprint is current. Disabled sources stay visibly manageable but cannot be searched or remembered; deleted sources cannot be routinely reimported into the same identity. Users can deliberately remember a canonical live project source, then edit, pin, disable/re-enable, forget, and export the resulting memory with provenance. Promotion ignores forged renderer metadata, records approval in the same encrypted project scope, and rejects missing, disabled, deleted, foreign, or archived inputs. Project runs load exact owner-qualified project memory before launch and combine it transiently with owner-qualified workspace memory; standalone and foreign-project runs cannot receive it. Encrypted project Knowledge and Memory documents use collision-safe owner- and project-qualified keys beneath their authorized workspace store and have independent round-trip coverage across projects, members, and restart. Pre-v15 context without provable ownership is retained in quarantine rather than assigned to the active member. Archived projects are openable read-only for Knowledge, Memory, and export while every mutation remains unavailable in the UI and rejected natively. `/goal` writes through the authenticated typed Goal runtime and retains the snapshot only as a compatibility mirror. Project deletion detaches threads, goals, knowledge, memory, schedules, workflow definitions/runs, and pinned context instead of erasing workspace-owned records. Cross-workspace/member access, stale revisions, migration, detachment, tombstone anti-resurrection, scoped promotion/audit, rollback, run-context selection, and visible lifecycle behavior have focused coverage. Existing legacy snapshot goals remain workspace-level compatibility data; Fable does not guess project scope. Connections, missions, routines, artifacts, and activity surfaces remain open.
- Structural boundaries (**Wave 0D implemented**): the desktop `App` is now a small query-provider/composition entry over typed shell modules; agent/approval/voice wiring, lazy routes, model selection, and workspace presentation have explicit seams. `useShellRuntime` retains its stable facade while public types, default/preview policy, and backend normalization live in focused modules with regression tests. The Rust scheduler keeps its public command facade while state, events, pure transitions, persistence, orchestration, and tests are separated. The legacy protocol root is a compatibility barrel over account/cloud, approvals, agent-runtime, scheduling/workflow, and remote-control domains; executable checks preserve root/direct-domain exports and Spine parity.
- Desktop shell: Clerk account and provider onboarding, verified account display, workspace creation/switching, sidebar navigation, universal composer, theme toggle, model picker, permission picker, add menu, connector page, interactive Knowledge page, schedules page, profile page, and settings page.
- Composer: supports text entry, slash command insertion, local file import, opt-in browser dictation where the runtime exposes speech recognition, model selection, permission selection, and native-agent submit path when a connected native backend exists.
- Protocol package: defines approvals, memory, connectors, backend providers, runtime snapshots, native agent events, native tool specs, and tool-call request shapes.
- Local file import: supports `txt`, `md`, `markdown`, `json`, `csv`, `yaml`, and `yml`; rejects empty files, unsupported extensions, changed file sizes, and files over 2 MB; imported files are untrusted local knowledge with a 6,000-character preview.
- Knowledge and retrieval: local files and recursive folders can be imported (with path-escape guards), structurally chunked (for Markdown, JSON, CSV, YAML), fingerprinted, scoped, searched, disabled, and deleted. Workspace and project local sources support an explicit one-shot update that asks the user to choose the current same-named file, retains no path or file handle, and atomically replaces content only after authorization and fingerprint compare-and-swap validation. Updated content and freshness survive native restart; an unchanged file is a no-write outcome. Project local sources have the same disable/re-enable and tombstone-delete lifecycle. Retrieval uses reciprocal-rank fusion (RRF, k=60) for hybrid lexical/semantic ranking. SQLite schema v15 qualifies Knowledge, Memory, chunks, pins, tombstones, private document keys, and encryption binding by a proven hosted member or legacy local user. Member, workspace, and project authority filter before ranking, and no pin or explicit id can bypass that boundary. Legacy unowned records and documents are retained in quarantine and are unavailable until a future explicit recovery design; Fable does not silently adopt them. Department and Connection filtering, plus Connection-backed source ingestion and lifecycle, remain open.
- Run context receipts (**Wave 2B citations implemented; native shared resolver open**): each new provider run receives one stable id before context assembly and persists a bounded encrypted receipt before provider egress. Version 2 receipts snapshot the exact private audience, scope, assembly time, ranked source excerpts, source authority, and closed reason codes such as project context, pinned memory, approved memory, and retrieved source without storing hidden reasoning. New sourced runs require v2; receipt-less historical runs and empty v1 compatibility receipts remain readable. Native persistence verifies the active private owner and every citation authority exactly, while shared audiences fail closed until Fable has a native shared-context resolver. Disabled, forgotten, out-of-scope, wrong-owner, or unauthorized inputs do not enter the receipt. Receipt identity and content become immutable after first persistence, survive restart, redact secret-shaped evidence text, and remain bound to the producing response. The calm per-response `Context used` disclosure is collapsed by default and opens the historical source title, provenance, freshness, reason, excerpt, and plain-language audience (`Only you` or `Workspace`). Two responses cannot borrow each other's citations, and later source updates do not rewrite historical evidence.
- Approvals: the shell exposes Read Only, Ask Me (default), Work Freely, and Custom. Rust persists exact one-time execution permits, audit entries, high-risk confirmation, and denied-action handling.
- Memory: Rust commands support listing, saving, exporting, disabling, editing through shell state, and approval-gated promotion from a knowledge source into durable memory.
- Local recovery: runtime snapshot, approval audit, approval rules, imported knowledge, memory state, connected backend ids, artifacts, immutable artifact versions, private review history, and exact-version project handoffs are persisted through encrypted SQLite in Tauri. Browser preview remains non-authoritative fixture state and does not count as restart evidence. Schedules, workflows, and knowledge structures are persisted inside the encrypted SQLite database under schema v18.
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
- Cloud/team backend (**Wave 2D repo-local invitation lifecycle, member roster, and member controls implemented; live multi-member journey open**): Convex is the canonical hosted control plane for Fable-owned users, identity links, workspaces, memberships, direct-inbox invitations, roles, devices, and shared-project authorization. Authenticated handlers implement invitation acceptance/revocation/expiry, role and status transitions, terminal removal, last-owner protection, device revocation, and exact replay. Owners and admins can create an invitation for a verified email through a config-gated path that uses a versioned Convex-side HMAC keyring, retains rotation-compatible hashes, stores no raw address, performs no account lookup, and exposes only a masked hint. Bootstrap caches only bounded display claims from the validated session, masks verified email before storage, clears withdrawn hints, and keeps every profile field display-only. The roster joins only active internal accounts with active or paused memberships; removed and inactive accounts do not disclose stale profiles or appear to retain access. It projects exact per-target and invitation controls while hosted execution independently rejects self-management, no-op role churn, admin-to-owner changes, stale revisions, and unsafe owner transitions. Native replaces hosted member IDs and invitation authority with process-local action references bound to the account generation, active workspace/current member, target revision, and projected allowlist; fixed calls recheck context before and after every await and return no hosted authority, receipts, raw email, or hashes to React. Workspace Settings resets by account and workspace, creates verified-email invitations without claiming an email was sent, shows an honest desktop-only inbox and `People with access` list, uses explicit role saves and projected pause/restore controls, and requires focused confirmation before permanent removal and linked-device revocation. Hash-only storage, key rotation, response loss, exact replay, changed-intent collision, device revocation, account/workspace switching, restart, unavailable services, Strict Mode probes, same-tick clicks, and stale completions have focused coverage. Shared-project mutations and the encrypted native cache/outbox retain their revision, conflict, tombstone, and authorization boundaries. Deployment, realtime desktop consumption, and live two-account/network validation remain open.
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
- Google connectors: Drive, Gmail, and Calendar expose authenticated reads and approval-gated writes, active-token granted-scope checks, refresh-token preservation without historical scope merging, explicit active-Connection selection, bounded responses, cancellation, and normalized provider errors. The multi-account compatibility boundary derives an opaque workspace-and-connector-bound Fable Connection ID for each account, rejects raw provider account IDs as selection authority, and projects canonical lifecycle, authorization, health, credential-custody, and credential-state vocabulary. Durable storage still uses the legacy connector-account shape and broader Connection migration remains open. External use still requires Google Cloud configuration and applicable verification.
- Connector sync foundation: manual sync records an encrypted, workspace-scoped lifecycle around existing on-demand reads, with background/retry trigger vocabulary, stale-token refresh through the native credential boundary, explicit failure classes, and cache export/deletion rules. The always-on background worker and provider-specific full-content indexers remain future work.
- Schedules page: users can create, pause/resume, and delete local schedule records. Records persist in the encrypted SQLite database; the Tauri runtime leases due occurrences, queues workflow runs, and executes scheduled prompts through the provider-neutral `AgentBackend` path when a runnable backend is connected.
- Connector cache lifecycle: synced connector data is cached in the encrypted local vault (`connector_cache`, schema v2). The cache is searchable, workspace-isolated, and secret-free; the write path redacts token-shaped values and fails closed when a secret marker survives. Per-workspace and per-connector cache settings gate writes/reads, and disable/delete/clear/resync/export commands preserve workspace isolation and never include provider tokens.
- CI file: `.github/workflows/ci.yml` exists and uses pnpm for typecheck, tests, build, Tauri check, Rust tests, clippy, and fmt on Windows.
- Tests exist across desktop, connectors, native API, local files, knowledge search, backend registry, and Rust runtime modules.
 
## Runtime Availability Matrix
 
| Area | Category | Details / Location |
| --- | --- | --- |
| Local files, approvals, memory controls, knowledge search, runtime snapshots | **Finished** | Live local runtime paths in Tauri. Pinned context, sources, and memory records are persisted in dedicated SQLite tables (schema v18) with owner-qualified composite key isolation. |
| Run context receipts and citations | **Finished** | New runs persist immutable pre-egress scope, citation, and selection-reason snapshots; the desktop hydrates per-response evidence after restart, and native artifact creation uses only the producing run's receipt. |
| Private artifacts | **Finished for create, edit, history, lineage, source retention, private review/changes/acceptance, search, exact-version export, same-owner private-project handoff, ownership, restart, and portable integrity** | Exact-owner artifacts have immutable versions, reviews, and encrypted exact-version handoffs; atomic stale-write protection; producing-response links; inherited canonical evidence; calm inline editing/review/handoff controls; Knowledge search/detail/history; whitelisted Markdown/JSON export; and fail-closed archive and handoff validation. Handoffs add only the selected version to another active private project owned by the same member and never transfer transcript history or authority. Multi-member review and shared handoff remain open. |
| Member-private context boundary | **Implemented; real shared journey open** | Owner-qualified Knowledge and Memory filter before ranking and carry exact private authority into v2 receipts and visible audience disclosure. Legacy unowned context is quarantined; native shared resolution remains fail-closed pending Wave 2D. |
| Local optional projects | **Finished for lifecycle, guidance, conversations, Goals, local Knowledge, and Memory** | Encrypted member-private projects support lifecycle and thread placement, a calm detail page, typed local goals, exact-project local-file import/list/search/update/disable/delete, deliberate source-to-memory promotion, full memory controls/export, and exact run-context consumption through authenticated Tauri commands. Connections and later project context remain open. |
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
| Native voice providers, Convex collaboration | **Mixed** | Dictation still depends on the host Web Speech API. Convex now has hosted membership lifecycle, config-gated hash-only verified-email invitation creation and acceptance, a capability-projected member roster, member role/status/removal controls, and shared-project revision history plus an authenticated native encrypted cache/outbox adapter. Workspace Settings can create, list, and accept invitations and manage eligible members without exposing hosted member authority or fabricating preview data; realtime desktop consumption, deployment, and live multi-member validation remain open. |

## Partially Implemented Or Preview-Only

- Browser preview uses an explicit synthetic identity/workspace fixture. The Tauri path requires a Fable account and then one provider; it no longer offers a local profile, password, or skip route.
- The API-key path can hand native backend secrets to the Rust credential boundary, but subscription provider paths are represented as backend catalog states and install/setup flows, not proven live provider integrations.
- Browser preview can mark API-key backends as locally connected for testability. Connector reads remain explicitly fixture-backed and do not become live connections.
- Connector search/import in browser preview uses explicitly labeled synthetic fixture behavior.
- Private artifact archives export only the exact active owner's records. Strictly validated self-review history can round-trip with an exact native source response; unsigned citation, input, decision, external-review, and publication claims remain non-importable until Fable has a trusted evidence-transfer mechanism.
- Artifact text search decrypts only exact-owner current versions in deterministic pages. It stops after 2,000 candidates and asks the user to narrow an overly broad query instead of silently omitting older matches; an empty query lists the newest requested results directly.
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
- No production Clerk/Convex configuration or externally validated live Fable account session exists in this checkout. The first multi-member membership and shared-project sync slice is implemented and tested repo-locally, but its deployed two-account, realtime UI, and restart journey is not validated.
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
