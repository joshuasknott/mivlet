# Fable Master Build Plan

**Status:** Authoritative execution tracker

**Last updated:** 11 July 2026

The [Product Blueprint](vision.md) describes the Fable we are building. This document is the ordered checklist for building it. [Status](status.md) records what is factually implemented now.

## Programme

| Phase | Outcome | State |
|---|---|---|
| 0. Product spine | One ontology, authority model, and shared contract foundation | Complete |
| 1. Essential Fable | Account + provider + durable conversation | In progress |
| 2. Work context | Workspaces, projects, context, memory, and artifacts | In progress |
| 3. Connection fabric | Native connections and MCP satisfy portable capabilities | Not started |
| 4. Dynamic missions | Fable sizes, plans, routes, and supervises work | Not started |
| 5. Embedded routines | Successful work can run later or from events | Not started |
| 6. Departments | Optional configurable operating contexts | Not started |
| 7. Pipelines | Guided benchmark outcomes and useful connector breadth | Not started |
| 8. Extended execution | Browser, computer use, mobile, and remote nodes | Not started |
| 9. Voice | Dictation, conversation, and deployed voice agents | Not started |
| 10. Private-product quality | Dependable sustained use for Josh and invited users | Not started |

## Phase 0 - Lock the product spine

**Outcome:** New work no longer invents its own workspace, Connection, execution, artifact, or routine semantics.

### Wave 0A - Product truth and decisions

- [x] Separate the final-state Product Blueprint from this execution tracker.
- [x] Record the [core product ontology](../adr/2026-07-10-product-ontology.md) as an ADR.
- [x] Record [identity and tenancy decisions](../adr/2026-07-10-identity-workspace-tenancy.md): Clerk identity only; Fable-owned users, workspaces, membership, and authorization.
- [x] Decide [local SQLite versus Convex authority](../architecture/record-authority-matrix.md) for every core record.
- [x] Inventory [schema, protocol, architecture, product-copy, and module-size conflicts](product-spine-inventory.md) against the blueprint.

### Wave 0B - Canonical contracts

- [x] Define [internal user, workspace, membership, and authorization contracts](../../packages/protocol/src/spine/identity.ts).
- [x] Define [Connection, provider-route, capability, and capability-grant contracts](../../packages/protocol/src/spine/connections.ts).
- [x] Define [mission, plan, worker, run, and run-event contracts](../../packages/protocol/src/spine/missions.ts).
- [x] Define [artifact, handoff, routine, and trigger contracts](../../packages/protocol/src/spine/artifacts-routines.ts).
- [x] Add [TypeScript/Rust parity checks](../../packages/protocol/spine-parity-manifest.json) and the [legacy migration strategy](../architecture/product-spine-migration-strategy.md).

### Wave 0C - Tenancy and authority

- [x] Implement stable internal users mapped to Clerk identities.
- [x] Implement Fable-owned workspace membership and remove Clerk Organization coupling.
- [x] Enforce workspace isolation across local repositories and Convex policy.
- [x] Align the Convex schema, outbox, cursors, devices, conflicts, and tombstones with the authority matrix.
- [x] Migrate legacy data and terminology without data loss.

### Wave 0D - Structural cleanup

- [x] Split the highest-risk React application/shell module.
- [x] Split the highest-risk TypeScript runtime/hook module.
- [x] Split the highest-risk Rust runtime module.
- [x] Focus protocol/domain package boundaries and add regression coverage around moved behavior.

**Phase 0 complete when:** one product model governs TypeScript, Rust, SQLite, Convex, and product copy; migrations and isolation tests pass; the minimum existing product still runs.

## Phase 1 - Account, provider, and durable conversation

**Outcome:** A user signs in, receives a workspace, connects one provider, completes useful work, closes Fable, and continues later.

### Wave 1A - Account and workspace

- [ ] Complete Clerk production configuration and live claim/session validation.
- [x] Complete sign-in, onboarding, sign-out, expiry, recovery, and device revocation.
- [x] Create the initial workspace automatically and idempotently.
- [x] Support multiple isolated workspaces and switching.
- [x] Keep minimum onboarding to account plus provider.

### Wave 1B - Durable chat

- [x] Support standalone workspace threads without requiring a project.
- [x] Persist user, assistant, tool, approval, interruption, and error records correctly.
- [x] Complete streaming, stop, retry, failure recovery, and continuation.
- [x] Recover drafts, threads, runs, and pending states after restart.
- [x] Keep the composer calm and free of optional setup requirements.

### Wave 1C - Provider and first artifact

- [x] Complete provider add, health, reconnect, revoke, and remove behavior.
- [x] Complete live model discovery and exact eligible route selection.
- [x] Explain auth, entitlement, offline, timeout, rate-limit, and provider failures clearly.
- [x] Turn a useful response into a durable sourced artifact.
- [ ] Validate the complete minimum-configuration journey through actual Tauri IPC/UI and restart.

**Phase 1 complete when:** one account, workspace, and provider can sustain a useful conversation and artifact across restart without any optional layer configured.

## Phase 2 - Workspace, project, context, and artifacts

**Outcome:** Fable sustains a multi-session body of work without losing context, outputs, boundaries, or decisions.

### Wave 2A - Optional projects

- [x] Complete project create, rename, archive, restore, and delete behavior.
- [x] Create threads inside projects or assign and remove them later.
- [ ] Add optional project instructions, goals, knowledge, connections, missions, routines, artifacts, and activity.
- [x] Keep standalone workspace threads first-class.
- [x] Prove workspace and project scope isolation.

### Wave 2B - Knowledge, memory, and context

- [ ] Complete source ingestion, provenance, trust, freshness, and lifecycle.
  - Repo-local evidence: supported local text files now have authenticated workspace/project import, provenance, trust, search, disable/re-enable, tombstone delete, and explicit one-shot content refresh. Connection-backed source ingestion and lifecycle remain open with Wave 3.
- [ ] Filter retrieval by member, workspace, project, department, and Connection before ranking.
  - Repo-local evidence: member, workspace, and project authority now filter Knowledge and Memory before ranking, including pins, explicit source requests, and promoted memory. Department and Connection authority remain open with their later waves.
- [x] Complete citations and explain why important context was selected.
  - Evidence: every new provider run persists an immutable pre-egress receipt with exact scope, ranked citation snapshots, and closed reason codes. Each response can reopen its own `Context used` evidence after restart, and artifact citations are derived natively from that producing run rather than mutable renderer state.
- [x] Complete visible, editable, scoped, exportable, disableable, and forgettable memory.
- [ ] Prevent private member context from entering shared context automatically.
  - Repo-local evidence: SQLite schema v15 qualifies Knowledge, Memory, chunks, pins, and tombstones by a proven member or local-user owner; new private runs carry that exact audience through retrieval, immutable receipts, and visible disclosure. Legacy unowned context is quarantined rather than guessed. Native shared context currently fails closed; the first real shared run and its resolver remain open in Wave 2D.

### Wave 2C - Artifact system

- [x] Add artifact types, versions, lineage, scope, and producing-run links.
  - Evidence: SQLite schema v16 stores exact-owner artifact identities and immutable ordered versions separately. New edits use optimistic revision/current-version checks, retain earlier bytes and hashes, add an exact `supersedes` lineage link, survive restart, and remain bound to the producing run, thread, and terminal assistant response.
- [ ] Preserve sources, citations, inputs, and decisions.
  - Repo-local evidence: response artifacts derive v1 citations from the immutable producing-run receipt, and later versions inherit that evidence without accepting renderer replacements. Portable import rejects unsigned citation, input, decision, review, and publication claims until Fable has a trusted evidence-transfer mechanism.
- [x] Add review, requested changes, acceptance, and approval state.
  - Evidence: schema v17 stores immutable exact-version private review records. A private owner can start review, request bounded specific changes, create a new draft version, review again, and mark that exact version accepted with atomic stale-write protection, restart recovery, portable history, honest self-review copy, and keyboard focus coverage. Multi-member assignment remains part of Wave 2D rather than being simulated here.
- [x] Add artifact search and export.
  - Evidence: Knowledge → Artifacts now lists and searches exact-owner current artifacts by title, content, source, and decision; opens plain type/status/scope/origin/source/review details; selects immutable historical versions; and exports an exact version as whitelisted Markdown or JSON. Native search validates thread/project scope, pages bounded current-only rows, reports an honest narrow-search error at its scan ceiling, and exact export verifies hashes/media while stripping paths, signed URLs, hidden history, reviews, grants, and authority.
- [x] Support explicit cross-context handoff without transferring hidden history or authority.
  - Evidence: schema v18 stores an encrypted, exact-owner association between one immutable artifact version and another active member-private project owned by the same member. The two-step Knowledge action names the exact version and states that conversation history and permissions stay behind. Native proposal and acceptance derive workspace, actor, source project, target eligibility, time, and authority; resume safely after restart; reject stale, duplicate accepted, shared, archived, deleted, foreign-member, and cross-workspace targets; and leave the source artifact, reviews, evidence, and authority unchanged. Accepted target search projects only the handed-off version, including when the source later advances, while corruption and renderer-forged authority fail closed.

### Wave 2D - First multi-member slice

- [ ] Complete invitation, acceptance, role, and removal lifecycle.
  - Repo-local evidence: Convex now implements authenticated direct-inbox invitations for existing internal users and config-gated verified-email invitations, exact-recipient acceptance, pending-invite listing/revocation/expiry, role changes, suspension/restoration, terminal removal, last-owner protection, device revocation, idempotency, and hashed session audit attribution. Verified-email targeting uses a versioned Convex-side HMAC keyring, stores only a keyed recipient digest plus masked hint, checks retained key versions during rotation, and never performs account lookup or stores the raw address. Authenticated bootstrap caches only bounded display claims, masks verified email before storage, clears withdrawn hints, and never uses profile data for identity or authorization. A bounded roster query joins only active internal accounts with active or paused memberships, omits terminal removal history, and projects the exact role, invitation, and lifecycle controls permitted for the actor and each target. Native replaces hosted member IDs and invitation authority with process-local action references tied to the exact account generation, active workspace, current member, target revision, and projected controls; it rechecks those facts before and after fixed hosted mutations and returns only secret-free outcomes. Workspace Settings resets immediately with account and workspace context, supports guarded invitation acceptance and explicit verified-email invitation creation without claiming an email was sent, shows a calm `People with access` list, uses explicit role saving and projected pause/restore controls, and requires focused confirmation for permanent removal. Registered-handler, native, runtime, and component tests exercise authorization-before-write, key rotation, hash-only storage, exact replay, device revocation, stale revisions, response loss, account/workspace switching, Strict Mode completion, and same-tick duplicate actions. A deployed two-account invitation/acceptance journey remains open.
- [ ] Deliver one useful shared record with realtime updates and offline outbox.
  - Repo-local evidence: the shared-project contract, Convex authority, encrypted native cache/outbox, fixed-path authenticated flush, and revision-delta pull are connected. Accepted creates, updates, and deletes settle atomically into the local shared mirror. A deployed live multi-session journey and realtime desktop subscription remain open.
- [ ] Handle idempotency, revisions, conflicts, and tombstones.
  - Repo-local evidence: the hosted mutation path recomputes canonical fingerprints, accepts only exact idempotent replay, appends immutable per-revision change snapshots, and returns closed conflict/rejection results. Native settlement enforces contiguous cursors, encrypted intent integrity, durable tombstone anti-resurrection, atomic conflict/shadow state, restart safety, and legacy-history backfill gating. Live deployed recovery remains open.
- [ ] Attribute shared actions to the internal user and device/session.
  - Repo-local evidence: hosted membership and shared-project writes derive the internal user and active member from Clerk identity, require the linked active device where applicable, persist member/device attribution, and record only a hashed session reference. React receives neither bearer credentials nor arbitrary hosted-call authority. External live-session validation remains open.
- [ ] Prove private and shared boundaries end to end.
  - Repo-local evidence: registered Convex handlers reject inactive, viewer-write, cross-workspace, stale, and privilege-inverting operations before durable side effects; native commands recheck the current account, workspace selection, membership, and device link before and after hosted calls. Member-private context still fails closed for shared resolution. A real two-member IPC/UI/restart journey remains open.

**Phase 2 complete when:** standalone and project work, context, memory, versioned artifacts, and the first shared slice remain coherent and isolated across sessions.

## Phase 3 - Universal Connection and MCP fabric

**Outcome:** One semantic capability can use a native Connection, approved MCP server, or clearly explained alternative without changing the mission.

### Wave 3A - Connection and capability control plane

- [ ] Migrate connector-account records and product language to Connection.
  - Repo-local evidence: the native multi-account compatibility boundary now projects each connected external account as a stable opaque Fable Connection ID bound to the exact workspace and connector definition. Selection accepts only that Connection ID, never the provider account id; connector manifests, authorization results, and account options also substitute that opaque ID before crossing into the renderer. The control is labelled `Active connection` and receives truthful lifecycle, authorization, health, credential-custody, and credential-state vocabulary. Connected manifests reload those projections after desktop hydration, while workspace-switch cleanup rejects stale completions, so multi-Connection selection survives restart without widening scope. SQLite schema v19 adds the constrained canonical Connection record boundary and an idempotent migration ledger: legacy connector-account rows retain their compatibility read path and only an opaque proposed identity is quarantined because those rows cannot prove the authenticated creator required for adoption. A repository writer creates or revision-updates encrypted canonical native-connector records only after revalidating the current account, active workspace, and member in the same transaction; project scope, stale revisions, cross-workspace secure-store reuse, unknown states, and stale account scopes fail closed, while safe reads omit provider account ids and secure-store references. The real native account-list path reconciles its exact legacy snapshot into those records under one account-generation guard and one SQLite transaction; repeat hydration is revision-idempotent and a concurrent account change rejects the whole reconciliation. That path reads lifecycle, authorization, health, credential-custody, and credential state back from the exact canonical IDs and fails closed on a missing mapping. Schema v20 adds revisioned canonical active-Connection selection without guessing during migration. Authenticated reconciliation may seed it once from a proven compatible record, then canonical selection wins on restart; OAuth, explicit switching, disconnect promotion/clear, account options, refresh, manifests, and token resolution all coordinate through that exact selection, with compatibility-file rollback when a canonical update rejects. Native credential resolution now reads the secure-store binding from the selected canonical record and repairs or ignores a stale compatibility reference; safe projections still never expose that binding. Refresh-required records may use only the retained refresh path, not normal provider operations. Portable canonical sections and the wider connector catalogue remain open.
- [ ] Implement Connection authorization, health, refresh, degradation, revocation, removal, and recovery.
  - Repo-local evidence: OAuth completion treats secure-store persistence as reversible until both compatibility metadata and the canonical Connection transaction are durable. It captures the exact previous credential value, fails closed if that value cannot be read, restores it when later persistence fails, removes a newly created credential on the same failure, restores the prior compatibility account set when the canonical transaction rejects, and returns only secret-free recovery errors. Provider authorization is bound to the stable Fable account and active workspace that started it; asynchronous exchange prepares without writing, then a synchronous native commit rechecks and holds the exact identity generation across all three persistence participants. Account/workspace mismatch consumes the single-use pending state without provider egress, and a generation change before commit writes no connector credential. Canonical native Connections also have a transaction-current, revision-checked lifecycle transition primitive with idempotent no-change behavior and stale-revision rejection. Disconnect holds that identity guard while it removes the exact credential, updates compatibility selection, and transitions the exact canonical record to disconnected/revoked/offline; metadata or canonical failure restores the credential and prior account set, and best-effort provider revocation runs only after the local commit succeeds. Token refresh snapshots the exact account, credential, canonical lifecycle, and canonical revision before provider egress, rejects concurrent local or canonical change, and commits rotated credentials, compatibility metadata, and canonical authorization state together under the same account generation. This prevents a late refresh from reviving a concurrently disconnected or revoked Connection. A definitive provider rejection transitions both compatibility and canonical state to refresh-required/expired/unhealthy without deleting the retained refresh credential; canonical failure restores the connected compatibility state, while transient provider errors remain non-destructive. Explicit live health probes persist healthy/degraded/unhealthy results to the exact canonical Connection only after rechecking the initiating account generation and active compatibility selection; the probe never changes authorization or credential state. Background health policy and complete remove/recovery journeys remain open.
- [ ] Implement the semantic capability registry and resolver.
  - Repo-local evidence: the provider-neutral execution path is wired through the real model-tool boundary. The advertised `connection-read` tool declares `source.repository.list`, `source.file.search`, `knowledge.content.search`, `communication.email.search`, `communication.channel.list`, `calendar.list`, `calendar.event.search`, `software.deployment.list`, and `work.issue.list` without naming providers; the native registry maps them to the existing GitHub repository-list, Google Drive search, Notion explicitly-shared content search, Gmail search, Slack accessible-channel list, Google Calendar accessible-calendar list and primary-calendar event search, Vercel deployment-list, and Linear issue-list adapters with exact `repo`, Google Drive `drive.file`, Notion `read_content`, Gmail `gmail.readonly`, Slack `channels:read` plus `groups:read`, Google Calendar calendar-list and event-read-only scopes, `deployment:read`, and `read`. Gmail returns metadata-only normalized messages and preserves its existing bounded partial-failure behavior; it does not grant compose/send authority. Calendar listing rejects query-shaped input, while event search requires a non-empty query, so neither semantic capability can silently switch to the other provider operation. Slack global message search remains intentionally absent because the current broker has a bot token, while that operation requires a separately governed user-token model. Notion search remains limited to pages and databases explicitly shared with the integration, and semantic pagination is clamped to the provider limit. The registry dispatches capability-shaped, Google search-shaped, and collaboration search-shaped native adapters without collapsing their provider result contracts. Resolution requires the selected canonical Connection, current account/workspace authority, matching provider boundary, authorized lifecycle, available credential, and usable health evidence, then executes the live adapter through the unchanged read-only approval/audit boundary. The adapter token is bound to the exact opaque Connection resolved before refresh or provider egress, so a same-account selection change conflicts instead of silently reading through another provider account. Schema v21 persists only secret-free `adapter-validated` observations during authenticated OAuth commit and canonical reconciliation. Evidence is keyed by semantic capability and exact Connection revision, is returned as supporting resolution evidence, and becomes unreadable after any lifecycle/health revision change; it never replaces current scope, health, grant, approval, or provider checks. The v20-to-v21 migration creates an empty table and guesses no capability authority. Unknown capabilities, provider mismatch, absent Connections, missing scopes, unhealthy/offline state, changed identity or selection, malformed search inputs, and unavailable encrypted state fail closed with the canonical resolution vocabulary. Results identify the opaque Connection without exposing provider account ids or credentials. Alternative implementations/provider routes and mission/routine consumption remain open.
- [ ] Implement scoped, consequence-aware capability grants.
- [ ] Prove provider, connector, MCP, credential, and approval boundaries remain separate.

### Wave 3B - OAuth and native reliability

- [x] Complete durable encrypted one-time OAuth handoff storage.
  - Evidence: the broker has production-shaped Cloudflare Durable Object SQLite stores for pending OAuth state, one-time handoffs, and rate limits. Pending verifier and handoff payloads are encrypted before storage with AES-256-GCM using an HKDF-derived key and record-bound additional authenticated data; atomic delete-before-return consumption prevents replay, while expiries and alarms remove abandoned records. Staging and production bindings plus the `v1-broker-ephemeral` Durable Object migration are declared, and durable mode fails closed on missing bindings, a non-32-byte encryption secret, or a non-HTTPS public URL. The broker's 99-test suite covers concurrency, replay, expiry, encryption, and absence of plaintext, and its production build passes. Deployment, secret provisioning, live migration, provider callback registration, and external OAuth validation remain honestly open in the next item.
- [ ] Complete broker deployment configuration and callback policy.
- [ ] Complete multi-account, refresh, revocation, disconnect, and recovery behavior.
- [x] Complete exact connector approvals and audit.
  - Evidence: every registered external write is consequential and requires a fresh per-action decision; standing/session grants are rejected. Native preparation fingerprints the complete connector action, rechecks connector, account, action, risk, workspace permission profile, exact prepared record, and one-time execution permit immediately before provider egress, then records completed/failed outcomes with normalized error codes. The portable TypeScript connector runtime now snapshots JSON input before approval and binds connector, account, capability, full canonical input, cursor, target, preview, risk, run, and idempotency key into a secret-free SHA-256 fingerprint; the trusted adapter receives only that snapshot, so caller mutation during approval cannot substitute provider input. Forged decisions, field mismatch, downgrade, stale/replayed permits, non-JSON input, and unapproved writes fail closed, with focused Rust and TypeScript regression coverage.
- [x] Add connector contract tests for pagination, cancellation, rate limits, scopes, and errors.
  - Evidence: the production adapter suites cover GitHub, Vercel, Linear, Google Drive, Gmail, Google Calendar, Notion, and Slack pagination/cursor shapes, bounded rate-limit normalization, explicit granted-scope behavior, malformed/provider/auth/network errors, and secret-safe failures. Cooperative cancellation is asserted at provider egress for every adapter family and now individually for Linear, Slack, Gmail, and Calendar rather than inferred from a sibling implementation. Opt-in live cases remain deliberately skipped without credentials and are not counted as production validation.

### Wave 3C - MCP runtime

- [ ] Implement local STDIO MCP.
  - Repo-local progress: the portable MCP 2025-11-25 client core implements bounded newline-delimited JSON-RPC framing, mandatory initialization and capability negotiation, paginated tool/resource discovery, request timeouts with cancellation, clean shutdown, malformed-result rejection, and exact tool-call authorization over a deeply frozen JSON snapshot. Discovery remains untrusted and never grants execution authority; denied calls never reach the transport, and neither caller nor authorizer mutation can substitute approved input. Schema v22 adds authenticated member-private, machine-local MCP launch configuration: executable paths and exact arguments are encrypted with owner-bound AAD, safe list projections omit them, writes are optimistic-revision checked, and the forward migration creates no launch authority or guessed rows. A fresh one-time native approval is bound to the exact secret-free configuration fingerprint before save. Rust then resolves only the opaque saved reference, rechecks account/workspace ownership on spawn/write/close, requires an absolute link-free executable, passes a small safe environment allowlist, bounds and validates stdout frames, suppresses stderr at the renderer boundary, and supervises shutdown under a random session id. The native generic frame writer is control-plane-only: it permits lifecycle and discovery methods but rejects `tools/call`, resource reads, prompt reads, sampling, and server-request responses, so a compromised renderer cannot bypass execution policy. The dedicated tool path rechecks current enablement and the exact live Connection revision, fingerprints the immutable proposal without storing arguments in approval metadata, consumes a persisted fresh one-time decision into a 60-second single-use session permit, constructs `tools/call` only in Rust, and correlates the result to a content-free completion/failure audit. Secret-shaped keys, non-object, oversized, or excessively nested arguments fail closed. The desktop adapter reports unexpected process exit immediately, cleans the native session, and exposes the prepare/authorize/execute sequence without reopening generic frame writes. A real repository fixture completes initialize, tool discovery, exact tool call, and shutdown through the hardened child-process builder; that fixture drives the child builder directly and does not claim product execution authority. An advanced Providers setting prepares the exact approval, saves a local server, lists only safe metadata, and checks tool/resource discovery while enabling nothing; browser preview states that local programs require desktop. Saving is atomic with adoption into the canonical Connection store under a stable opaque ID: the record is member-private, user-owned, user-managed, credential-free, and disabled by default, while existing native-connector payloads retain decode compatibility. Discovery is persisted only through the exact live owner-bound session and Connection revision; stale writes and oversized/malformed inventories fail closed. Explicit tool/resource selections must be a subset of that discovery and are revision-fenced, while checking still enables nothing. The remaining local-STDIO evidence gate is the actual Tauri IPC/UI journey, which requires the externally configured Fable account; standing capability grants, budgets, and mission consumption are deliberately tracked by later Wave 3C/3D items.
- [ ] Implement remote Streamable HTTP MCP.
  - Repo-local progress: an authenticated member can prepare and explicitly approve a credential-free HTTPS MCP endpoint from the advanced desktop settings, save it under the same encrypted machine-local configuration boundary, and adopt it as a disabled-by-default canonical `streamable-http` Connection. Rust alone opens the endpoint and retains the server-issued MCP session id. Every POST uses the negotiated protocol header after initialization, advertises JSON and SSE, pins the current public DNS answer into the HTTP client, rejects local/private/reserved destinations and unsafe ports, follows no redirects, and bounds UTF-8 JSON/SSE responses before returning validated JSON-RPC frames. Discovery and explicit enablement reuse the exact live Connection revision; generic remote frames remain control-plane-only, so `tools/call`, resource reads, prompts, sampling, and server-request responses cannot cross this route. Session DELETE is attempted on close and a 404 session expiry fails closed. The repository covers endpoint policy, JSON/SSE parsing, native-only routing, settings, and local/remote transport separation, but it has not claimed a live third-party server journey. Standalone GET/SSE listening, resumability/redelivery, OAuth/PKCE, remote tool execution, and live interoperability evidence remain open. The transport follows the [MCP 2025-11-25 Streamable HTTP contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- [ ] Add explicit authorization including OAuth/PKCE where appropriate.
- [ ] Add trust classification, discovery, and per-tool/resource enablement.
  - Repo-local progress: local STDIO Connections are classified `user-managed`. Their bounded encrypted discovery inventory is supporting metadata only, recorded against the exact live native session and canonical Connection revision. Every tool and resource starts disabled; Settings exposes an explicit subset selection, and native persistence rejects stale revisions or names/URIs absent from current discovery. Rediscovery automatically removes enablement that the server no longer advertises. Remote trust classes, discovery lifecycle/notifications, and cross-transport policy remain open.
- [ ] Apply Fable capability grants, approvals, budgets, audit, and prompt-injection defenses.
  - Repo-local progress: local STDIO tool execution now has an exact native approval and audit boundary. Only a currently discovered and explicitly enabled tool on the live Connection revision can be proposed; approval metadata contains a proposal fingerprint rather than raw arguments; only a fresh `once` decision can mint a short-lived one-use session permit; Rust alone constructs the call; response audits record status, tool, Connection, actor, and normalized error without result content. Credential-shaped arguments, oversized/deep JSON, renderer tool-call frames, sampling, and server-request responses fail closed. Standing semantic capability grants, budgets, mission integration, richer untrusted-content/prompt-injection policy, and remote-MCP parity remain open.

### Wave 3D - Live capability substitution

- [ ] Choose one high-value daily outcome from Josh's real use.
- [ ] Validate its native Connection path with a real account.
- [ ] Validate an approved MCP or alternative path for the same capability.
- [ ] Add contextual missing-connection and degraded-mode UX.
- [ ] Record live evidence and add a truthful canary where practical.

**Phase 3 complete when:** one real capability works through two permitted implementations with the same mission semantics and all trust boundaries intact.

## Phase 4 - Dynamic missions and smart routing

**Outcome:** Fable automatically chooses direct, delegated, or multi-worker execution and returns an inspectable result without exposing an agent graph by default.

### Wave 4A - Mission engine

- [ ] Implement mission sizing and generated plan lifecycle.
- [ ] Implement bounded worker tasks, context, tools, budgets, outputs, and handoffs.
- [ ] Implement durable run events, checkpoints, cancellation, and restart recovery.
- [ ] Implement the portable local execution driver.
- [ ] Implement acceptance criteria, evaluation, and partial outcomes.

### Wave 4B - Routing and experience

- [ ] Route by capability, quality, cost, speed, privacy, context, tools, health, preference, and risk.
- [ ] Enforce provider pins/exclusions and safe fallback boundaries.
- [ ] Show compact receipts for medium work and inspectable plans for consequential work.
- [ ] Make `/goal`, `/plan`, `/schedule`, `/remember`, and `/stop` Fable-native with natural-language parity.
- [ ] Add visible routing explanations and time/token/cost/iteration budgets.

### Wave 4C - Multi-worker coordination

- [ ] Add parallel workers, joins, and deterministic aggregation.
- [ ] Add dynamic reviewers/judges only when justified.
- [ ] Add bounded iteration and explicit stop conditions.
- [ ] Add durable human-input and approval waits.
- [ ] Add retry, resume, escalation, and replay-safe artifact handoffs.

**Phase 4 complete when:** a multi-provider mission plans, executes, pauses, recovers, and produces coherent artifacts within visible constraints while simple requests remain simple.

## Phase 5 - Embedded routines

**Outcome:** Any successful work can run later or from an event without becoming a separate automation product.

### Wave 5A - Routine experience

- [ ] Migrate schedules and workflows to routines and triggers without data loss.
- [ ] Attach routines to workspaces, projects, departments, goals, threads, pipelines, and Connection events.
- [ ] Create and edit routines conversationally, through `/schedule`, and from “run this again”.
- [ ] Resolve providers and models at run time within saved policy.
- [ ] Move schedules out of mandatory primary navigation and into contextual activity.

### Wave 5B - Triggers and reliability

- [ ] Complete one-time and recurring time triggers.
- [ ] Add signed webhook and connector-event triggers.
- [ ] Add threshold, monitoring, and follow-up triggers.
- [ ] Complete pause, resume, retry, notifications, and run history.
- [ ] Handle time zones, missed occurrences, deduplication, leases, and untrusted event payloads.

### Wave 5C - Always-on execution

- [ ] Define the portable hosted-run driver.
- [ ] Deliver the smallest dependable Convex-backed hosted path.
- [ ] Enforce execution-placement, data, credential, and provider boundaries.
- [ ] Handle offline desktop authority honestly.
- [ ] Add hosted recovery, cancellation, audit, and observability.

**Phase 5 complete when:** time, event, and follow-up routines execute reliably with no broader authority, including one always-on path that survives client disconnect.

## Phase 6 - Configurable departments

**Outcome:** A user enables and adapts a department in minutes and invokes it naturally without maintaining an agent graph.

### Wave 6A - Department foundation

- [ ] Implement the department charter, context, capability, authority, quality, routine, pipeline, history, and policy contract.
- [ ] Resolve natural-language and `@Department` scope safely.
- [ ] Add ready-made activation and immediate use.
- [ ] Add simple Purpose, Access, Ways of working, When to ask, and Quality sections.
- [ ] Add conversational create/edit plus duplicate, rename, disable, and remove.

### Wave 6B - Initial library

- [ ] Build the Product default.
- [ ] Build the Marketing default.
- [ ] Build the Sales default.
- [ ] Build the Customer default.
- [ ] Review all defaults for useful degraded behavior without recommended connections.

### Wave 6C - Collaboration and expert controls

- [ ] Add dynamic cross-department missions.
- [ ] Add explicit artifact-based handoffs and review.
- [ ] Add optional worker, provider, capability, budget, evaluation, and placement controls.
- [ ] Add calm department activity, approvals, artifacts, routines, and history.

### Wave 6D - Finance and Legal

- [ ] Define Finance evidence, approval, irreversible-action, and professional-review boundaries.
- [ ] Define Legal jurisdiction, source, confidentiality, review, and non-advice boundaries.
- [ ] Build Finance and Legal defaults only after those boundaries pass review.

**Phase 6 complete when:** the initial departments work from defaults and conversational customization, and cross-department work passes only explicit context and authority.

## Phase 7 - Benchmark pipelines and connector breadth

**Outcome:** Fable completes genuine guided outcomes across alternative software stacks while remaining simple to configure.

### Wave 7A - Pipeline foundation

- [ ] Define pipeline inputs, stages, decisions, outputs, approvals, quality bars, recovery, and escalation.
- [ ] Run pipelines on dynamic missions rather than fixed worker graphs.
- [ ] Add ready-to-use, conversational, and expert configuration layers.
- [ ] Choose and deliver one high-value representative pipeline for Josh.
- [ ] Measure accepted outcomes, corrections, time/cost, and failure reasons.

### Wave 7B - Department pipelines

- [ ] Build representative Product, Marketing, Sales, and Customer pipelines.
- [ ] Add Finance and Legal pipelines only if their departments shipped.
- [ ] Review consistency, accessibility, degraded modes, and quality bars across pipelines.

### Wave 7C - Voice Agent Builder benchmark

- [ ] Build minimalist definition and conversational customization.
- [ ] Add knowledge and Connection-backed tools.
- [ ] Add realistic simulation, evaluation, test calls, and human handoff.
- [ ] Add deployment, monitoring, versioning, and rollback contracts.
- [ ] Add consent, disclosure, recording, retention, identity, cost, and kill-switch controls.

### Wave 7D - Capability-driven connectors

- [ ] Rank missing capabilities from real pipeline needs.
- [ ] Review official access, auth, scopes, events, limits, terms, placement, approvals, and live-test paths.
- [ ] Implement selected connectors in non-overlapping provider-family tasks.
- [ ] Add contract tests, live canaries, capability substitution, and truthful degraded modes.
- [ ] Add later connectors only when a real outcome requires them.

**Phase 7 complete when:** representative pipelines and the Voice Agent Builder meet their quality bars, with connector claims backed by live evidence or clearly marked gates.

## Phase 8 - Browser, computer use, mobile, and remote execution

**Outcome:** Fable can use permitted websites and desktop apps and be supervised from mobile without weakening trust boundaries.

### Wave 8A - Safety contracts

- [ ] Define execution-node identity and remote run/approval protocols.
- [ ] Define data, credential, provider, and destination routing policy.
- [ ] Define isolation, takeover, revocation, emergency stop, audit, and retention.
- [ ] Complete the prompt-injection and remote-execution threat model.

### Wave 8B - Browser and Windows control

- [ ] Add isolated browser sessions with domain/action boundaries and trace.
- [ ] Add structural/visual inspection, bounded actions, exact approval, and takeover.
- [ ] Add prompt-injection, secret, download, and exfiltration defenses.
- [ ] Add accessibility-first Windows control with allowlists and visual fallback.
- [ ] Add interruption recovery without duplicate side effects.

### Wave 8C - Mobile companion

- [ ] Move desktop routing to TanStack Router.
- [ ] Build the TanStack Start mobile-first companion.
- [ ] Add Clerk sign-in, QR pairing, device trust, expiry, and revocation.
- [ ] Add secure presence/relay, conversations, run status, approvals, artifacts, routines, and notifications.
- [ ] Add explicit host selection and honest offline behavior.

### Wave 8D - Managed execution assets

- [ ] Add the R2 artifact/media boundary with signed access, retention, and deletion.
- [ ] Add a managed browser execution driver only where explicitly selected.
- [ ] Add remote-node health, cost controls, revocation, and emergency shutdown.

**Phase 8 complete when:** browser/computer actions remain visible and bounded, mobile safely supervises eligible work, and local data or credentials never move implicitly.

## Phase 9 - Voice-native Fable

**Outcome:** Voice is a natural interface to the same missions, approvals, context, and artifacts as the rest of Fable.

### Wave 9A - Dictation

- [ ] Add provider-neutral audio capture and permissions.
- [ ] Add streaming transcription into an editable composer draft.
- [ ] Handle correction, punctuation, accents, noise, long dictation, and provider failure.
- [ ] Add audio retention/deletion, accessibility, keyboard, and push-to-talk controls.

### Wave 9B - Conversational voice

- [ ] Define voice sessions across transcript, interruption, tools, artifacts, approvals, and mission handoff.
- [ ] Route between realtime speech-to-speech and chained voice paths.
- [ ] Complete barge-in, cancellation, latency, and replay-safe recovery.
- [ ] Keep transcript, sources, active work, artifacts, and approvals visible.
- [ ] Benchmark quality, latency, cost, accents, noise, and long sessions.

### Wave 9C - Deployed voice agents

- [ ] Add the telephony/SIP provider boundary.
- [ ] Complete simulation, evaluation, and test-call journeys.
- [ ] Complete human transfer and escalation.
- [ ] Complete deployment, monitoring, versioning, rollback, and kill switch.
- [ ] Complete disclosure, consent, recording, retention, identity, and cost controls.

**Phase 9 complete when:** dictation and conversation are dependable, substantive work delegates through normal missions, and deployed voice agents pass all consent and operational controls.

## Phase 10 - Private-product quality

**Outcome:** Fable is dependable, recoverable, observable, accessible, and pleasant for sustained private use.

### Wave 10A - Durability and recovery

- [ ] Complete backup and restore for data, artifacts, configuration, and required keys.
- [ ] Complete migration rollback/recovery and crash recovery.
- [ ] Complete account/workspace/data/artifact export and deletion.
- [ ] Complete identity, provider, Connection, MCP, device, and node revocation.

### Wave 10B - Security and operations

- [ ] Review identity, workspace authorization, Connections, OAuth, MCP, and capabilities.
- [ ] Review missions, approvals, routines, hosted execution, browser, computer use, mobile, and voice.
- [ ] Add provider, Connection, node, run, queue, storage, and sync diagnostics.
- [ ] Add cost visibility, budgets, cancellation, kill switches, and incident audit.

### Wave 10C - Product quality

- [ ] Complete keyboard, screen-reader, contrast, focus, motion, caption, and voice accessibility.
- [ ] Complete responsive behavior, onboarding, and contextual help.
- [ ] Remove fixtures, misleading states, duplicate paths, stale copy, and dead ends.
- [ ] Meet startup, memory, storage, retrieval, streaming, and long-run performance budgets.
- [ ] Add end-to-end regression coverage for the Product Blueprint success journeys.

### Wave 10D - Windows private distribution

- [ ] Complete the dependable Windows build and signing decision.
- [ ] Complete installer, update, rollback, and release-note paths.
- [ ] Document configuration, secret provisioning, support, and incident recovery.
- [ ] Run a private release-candidate soak against Josh's real workflows.

**Phase 10 complete when:** all agreed blueprint journeys pass on combined `main`, recovery and revocation are proven, serious security findings are resolved, and a dependable Windows build is ready for Josh and invited users.

## Deferred

These stay outside the active tracker until Josh explicitly changes direction:

- Public release.
- Open-source licensing and contribution model.
- Marketplace and third-party commercial distribution.
- Enterprise organization hierarchy, SSO, SCIM, central administration, and compliance packaging.
- macOS/Linux distribution and app-store delivery.
- A parent Organization above workspaces.
