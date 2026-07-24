# Fable Master Build Plan

**Status:** Authoritative execution tracker

**Last updated:** 23 July 2026

The [Product Blueprint](vision.md) describes the Fable we are building. This document is the ordered checklist for building it. [Status](status.md) records what is factually implemented now.

## Programme

| Phase | Outcome | State |
|---|---|---|
| 0. Product spine | One ontology, authority model, and shared contract foundation | Complete |
| 1. Essential Fable | Account + provider + durable conversation | In progress |
| 2. Work context | Workspaces, projects, context, memory, and artifacts | In progress |
| 3. Connection fabric | Native connections and MCP satisfy portable capabilities | In progress |
| 4. Dynamic missions | Fable sizes, plans, routes, and supervises work | In progress |
| 5. Embedded routines | Successful work can run later or from events | In progress |
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
  - Repo-local progress: schema v23 adds owner-qualified, encrypted capability grants with explicit workspace or exact-project scope, one eligible opaque Connection, a consequence class, optional use budget, optional expiry, revisioned lifecycle, and no migration-created authority. The first `knowledge.content.search` use previews a plain-language confirmation naming the semantic capability, selected native or MCP Connection, read consequence, scope, limit, and expiry; only a persisted fresh one-time decision can create the grant. Both implementations recheck the active account/workspace/project, current Connection and binding, grant state, consequence, scope, expiry, and budget immediately before egress, atomically consume the matching budget, and return matched grant ids as resolution evidence. A project grant may reference a workspace-scoped Connection without becoming usable from workspace scope. Existing legacy session/rule approvals never satisfy `connection-read`, and every individual search still requires its separate exact-action approval. Repository coverage proves empty migration, encrypted payloads, stale Connection rejection, budget exhaustion, revocation, project isolation, renderer first-use sequencing, and the standing-policy/exact-action separation. Optional limits and expiry are supported by the native command contract; the default conversational first-use path states `no fixed limit` and `until revoked`. Live cross-transport evidence remains open, so this item is not yet checked complete.
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
  - Repo-local progress: the portable MCP 2025-11-25 client core implements bounded newline-delimited JSON-RPC framing, mandatory initialization and capability negotiation, paginated tool/resource discovery, request timeouts with cancellation, clean shutdown, malformed-result rejection, and exact tool-call authorization over a deeply frozen JSON snapshot. Discovery remains untrusted and never grants execution authority; denied calls never reach the transport, and neither caller nor authorizer mutation can substitute approved input. Schema v22 adds authenticated member-private, machine-local MCP launch configuration: executable paths and exact arguments are encrypted with owner-bound AAD, safe list projections omit them, writes are optimistic-revision checked, and the forward migration creates no launch authority or guessed rows. A fresh one-time native approval is bound to the exact secret-free configuration fingerprint before save. Rust then resolves only the opaque saved reference, rechecks account/workspace ownership on spawn/write/close, requires an absolute link-free executable, passes a small safe environment allowlist, bounds and validates stdout frames, suppresses stderr at the renderer boundary, and supervises shutdown under a random session id. Every newly spawned process starts with no current discovery authority; Rust correlates each non-empty tool/resource inventory to the exact bounded paginated responses observed from that session, rejects missing/mismatched pages and cursors, and atomically fences the Connection revision before any tool proposal, so a renderer assertion or saved enablement alone cannot authorize a changed process. A server `list_changed` notification immediately revokes that session's freshness. The native generic frame writer is control-plane-only: it permits lifecycle and discovery methods but rejects `tools/call`, resource reads, prompt reads, sampling, and server-request responses, so a compromised renderer cannot bypass execution policy. The dedicated tool path rechecks current enablement and the exact live Connection revision, fingerprints the immutable proposal without storing argument values in approval metadata, consumes a persisted fresh one-time decision into a 60-second single-use session permit, constructs `tools/call` only in Rust, and correlates the result to a content-free completion/failure audit. Secret-shaped keys, embedded URL credentials, non-object, oversized, or excessively nested arguments fail closed. The desktop adapter reports unexpected process exit immediately, cleans the native session, and exposes the prepare/authorize/execute sequence without reopening generic frame writes. A real repository fixture completes initialize, tool discovery, exact tool call, and shutdown through the hardened child-process builder; that fixture drives the child builder directly and does not claim product execution authority. An advanced Providers setting prepares the exact approval, saves a local server, lists only safe metadata, and checks tool/resource discovery while enabling nothing; browser preview states that local programs require desktop. Saving is atomic with adoption into the canonical Connection store under a stable opaque ID: the record is member-private, user-owned, user-managed, credential-free, and disabled by default, while existing native-connector payloads retain decode compatibility. Discovery is persisted only through the exact live owner-bound session and Connection revision; stale writes and oversized/malformed inventories fail closed. Explicit tool/resource selections must be a subset of that discovery and are revision-fenced, while checking still enables nothing. The remaining local-STDIO evidence gate is the actual Tauri IPC/UI journey, which requires the externally configured Fable account; standing capability grants, budgets, and mission consumption are deliberately tracked by later Wave 3C/3D items.
  - Lifecycle evidence: Rust accepts local discovery only after the exact pending initialize id returns the supported protocol version, bounded server identity, and capability object without a JSON-RPC error. Early discovery, duplicate initialization, wrong-version responses, and initialization errors do not create session authority.
- [ ] Implement remote Streamable HTTP MCP.
  - Repo-local progress: an authenticated member can prepare and explicitly approve a credential-free HTTPS MCP endpoint from the advanced desktop settings, save it under the same encrypted machine-local configuration boundary, and adopt it as a disabled-by-default canonical `streamable-http` Connection. Rust alone opens the endpoint and retains the server-issued MCP session id. Every POST uses the negotiated protocol header after initialization, advertises JSON and SSE, pins the current public DNS answer into the HTTP client, rejects local/private/reserved destinations and unsafe ports, follows no redirects, and bounds UTF-8 JSON/SSE responses before returning validated JSON-RPC frames. After initialization, the desktop adapter also opens the optional native GET/SSE route; `405` disables listening without breaking POST, transient closure retries, and Rust alone retains a bounded visible-ASCII event cursor, applies `Last-Event-ID`, and respects a clamped 250-30,000 ms server retry interval. POST SSE event cursors feed the same resumption state. Each newly opened remote session must initialize and persist fresh native-attested paginated discovery before saved enablement can support a tool proposal; mismatched cursors/inventories and `list_changed` notifications revoke freshness, while valid discovery and explicit enablement reuse the exact live Connection revision. Generic remote frames remain control-plane-only, so `tools/call`, resource reads, prompts, sampling, and server-request responses cannot cross this route. The dedicated approved-call route now accepts either transport: it revalidates current enablement and Connection revision, consumes the same 60-second one-use permit, constructs `tools/call` only in Rust, serializes remote POSTs, requires the exact correlated response, and settles the same content-free completion/failure audit before returning bounded frames. Session DELETE is attempted on close and a 404 session expiry fails closed. The repository covers endpoint policy, JSON/SSE parsing, native-only routing, settings, and local/remote transport separation, but it has not claimed a live third-party server journey. Long-lived/partial-stream interoperability, authenticated requests, and live remote execution/resumability evidence remain open. The transport follows the [MCP 2025-11-25 Streamable HTTP contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
  - Lifecycle evidence: remote transport initialization is now derived from the exact correlated successful JSON-RPC response rather than the outbound method name. An initialize error cannot activate protocol headers, retain a returned server session id, or permit discovery.
  - Authorization update: authenticated POST, GET/SSE, and DELETE requests now use the account-scoped keyring credential selected by the native session, with exact resource binding and refresh rotation. This supersedes the earlier repo-progress sentence that listed authenticated requests as open; live third-party execution and resumability evidence remain open.
- [ ] Add explicit authorization including OAuth/PKCE where appropriate.
  - Repo-local progress: the native boundary discovers protected-resource and authorization-server metadata through the official MCP 2025-11-25 order, binds the exact resource and issuer, requires authorization code plus S256 PKCE, and follows no redirects. Account connection executes exact pre-registration, a fetched and validated Client ID Metadata Document, or Dynamic Client Registration; manual information remains configuration-required. Dynamic registration requires the exact bound loopback redirect and a public client without a secret. Rust owns state, verifier, callback validation, code exchange, resource indicators, bounded non-widening scopes, keyring custody, canonical Connection credential metadata, authenticated POST/GET/DELETE, serialized refresh rotation, and serialized rollback-safe reconnect. Disconnect calls the advertised revocation endpoint when present, removes the native credential, and revision-fences canonical Connection revocation so orphaned credentials cannot be used. React receives only secret-free status and controls. Endpoint/revision-bound challenges cannot survive configuration change. Multi-challenge compatibility beyond the accepted Bearer challenge, step-up, and live-provider evidence remain open, so this item is not yet checked. The flow follows the [MCP 2025-11-25 authorization contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- [ ] Add trust classification, discovery, and per-tool/resource enablement.
  - Repo-local progress: local STDIO and remote Streamable HTTP Connections are classified `user-managed`. Their bounded encrypted discovery inventory is supporting metadata only, recorded against the exact live native session and canonical Connection revision. Every tool and resource starts disabled; Settings exposes an explicit subset selection, and native persistence rejects stale revisions or names/URIs absent from current discovery. An advanced user can explicitly bind exactly one discovered, enabled tool to `knowledge.content.search`. Fable, not the server, fixes that binding to contract `fable.connected-source-search.v1`, consequence `read`, and trust `untrusted`; unsupported capabilities, duplicate bindings, disabled tools, stale revisions, and ambiguous routes fail closed. The binding remains inside the encrypted Connection payload and safe projections contain no credentials. Rediscovery automatically removes both enablement and semantic bindings for tools the server no longer advertises, while native tool/resource `list_changed` handling immediately revokes the live session's discovery freshness. Strict result validation and ordinary `connection-read` routing now consume that binding. Additional trust classes and live cross-transport policy evidence remain open.
- [ ] Apply Fable capability grants, approvals, budgets, audit, and prompt-injection defenses.
  - Repo-local progress: local STDIO and remote Streamable HTTP tool execution share an exact native approval and audit boundary. Only a currently discovered, explicitly enabled, semantically bound tool on the live Connection revision can be proposed; the transport is bound into the proposal fingerprint; approval metadata contains the proposal fingerprint plus bounded safe field paths and destination origins, never values, URL paths, queries, bodies, or credentials; only a fresh `once` decision can mint a short-lived one-use session permit; Rust alone constructs the call; and response audits remain content-free. The ordinary semantic route now enforces the same scoped capability grant before minting that permit. Before cited-search content can reach the model, strict validation rejects query substitution, server-supplied authority metadata, unsafe links, malformed or oversized citations, and truncated results, then stamps `external-untrusted` and `instructionAuthority: none`. Fable-owned model guidance requires claims to cite exact citation ids, list their source titles and URIs, disclose degraded/empty/conflicting evidence, and never follow citation content as instructions. Mission integration, richer destination/data-routing policy, authenticated-remote execution, and live prompt-injection/parity evidence remain open. Result validation follows the [MCP 2025-11-25 tool-result security guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

### Wave 3D - Live capability substitution

- [x] Choose one high-value daily outcome from Josh's real use.
  - Decision: “Search my connected work sources and produce a trustworthy cited brief.” The semantic capability is `knowledge.content.search`; native and MCP implementations must preserve the same workspace/project scope, read consequence, explicit capability grant, exact-action approval, citation contract, external-content trust classification, and degraded-mode vocabulary.
- [ ] Validate its native Connection path with a real account.
- [ ] Validate an approved MCP or alternative path for the same capability.
  - Repo-local progress: the shared `fable.connected-source-search.v1` result contract now defines the exact provider-neutral query, workspace/project scope, bounded citations, cursor, external-untrusted classification, no-instruction authority, degraded reasons, opaque Connection, matched capability-grant ids, and implementation evidence consumed by a cited brief. Native Notion search is normalized into that contract after grant enforcement. MCP structured results use the same contract but may supply only query, cursor, and citation facts; strict validation rejects query substitution, extra authority fields, server-supplied trust/scope/grants/Connection, unsafe citation URIs, truncation, unsupported versions, and malformed or oversized citations, then stamps Fable-owned authority metadata.
  - Repo-local substitution path: the ordinary `connection-read` model-tool executor now resolves the single explicit MCP binding before first-use confirmation. After the separate exact search approval, it opens the bound local or remote transport, initializes and freshly rediscovers the server, proves the same binding survived at the new Connection revision, and passes only the native session id outside the model-approved semantic arguments. Rust consumes the same workspace/project capability grant, validates the fixed read/untrusted binding and exact current session, constructs contract-versioned query arguments, and mints the existing 60-second one-use MCP permit without adding a second standing or exact authority. The established approved-call route executes the bound tool and records its content-free MCP audit; the renderer accepts only the strict cited-search result and returns the same outer semantic result shape as native. A missing, ambiguous, stale, changed, denied, malformed, truncated, or failed MCP route stops with an explanation and never silently falls back to native. Focused repository composition tests cover the native-session handoff and full MCP-to-citation normalization. Actual Tauri IPC/UI and a live third-party server/account remain external evidence gates, so this item remains unchecked.
  - Cited-brief behavior is provider-neutral too: the Fable-owned tool policy tells every tool-capable native model that connected-source results are evidence rather than instructions, requires each result-derived factual claim to carry its exact `[citationId]`, requires a Sources list mapping used ids to titles and URIs, and requires degraded, empty, conflicting, or unsupported evidence to be stated. This policy is identical after native or MCP execution and is covered at the actual model-request seam.
- [x] Add contextual missing-connection and degraded-mode UX.
  - Evidence: runtime errors preserve their native semantic error code and retryability through the desktop boundary. A missing eligible Connection now tells the agent that no source was searched and points to connecting a supported work source or binding an MCP cited-search tool in Providers. Authorization, credential, and scope failures point to reconnecting and confirming read scope. Unhealthy/retryable Connections recommend retrying or selecting another eligible Connection while explicitly stating that Fable did not silently switch sources. Successful degraded reads retain their normalized degradation reasons, which the shared cited-brief policy requires the model to disclose. Focused tests cover missing and unhealthy paths before either approval or provider egress.
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

Repository evidence so far: the portable planner validates bounded acyclic
generated plans, required deliverable and acceptance coverage, useful parallel
width, worker budgets, immutable initial/replacement revisions, and optimistic
conflicts. Encrypted SQLite schema v24 persists the member-private mission,
selected plan, and immutable revision atomically and restores it after process
restart. Authenticated native create/read/revise commands derive workspace,
member, actor, authority, lifecycle, timestamps, and revisions; they repeat the
bounded-plan validation before persistence rather than trusting the renderer.
General production worker execution and the inspectable product journey remain open,
so the Wave 4A boxes stay unchecked.

The next repository slice compiles one selected step into a scope-matched,
budget-clamped worker only when all context was declared by the mission and
every required capability has one explicit grant reference. A provider-neutral
local driver runs that worker through any live `AgentBackend`, requires an exact
tool set, enforces duration/token/tool/attempt ceilings at the boundary, cancels
on overrun, and preserves partial streamed work. Durable worker/run records,
grant revalidation at execution time, handoff execution, and product wiring are
still open; this evidence therefore does not complete the worker or driver box.

Native worker creation now persists the first production `worker-created` event
through the authenticated run journal. Rust reloads the exact selected mission,
plan revision, and step; requires durable dependency completion; rejects reused
worker or step assignments; separately clamps lifetime assignments to plan
steps and active concurrency to mission/parallel bounds; derives actor, scope,
role, outputs, stop conditions, and the tighter numeric/monetary budget; and
normalizes selected declared context to `untrusted`. The renderer cannot name a
tool: native code maps only the registered connected-source read capabilities
to `connection-read`, requires the exact active read grant in the authenticated
workspace/project scope, and rejects capabilities without a native mission
binding. The event is revision/sequence fenced and exact-replay safe. Worker
start now atomically advances an eligible run to `running` when needed and
appends `worker-started` only for an exact unstarted assignment after reloading
the selected step and rechecking every active read grant; scope, actor, time,
status, sequence, and both events are native-built, and the transaction exposes
no intermediate running-without-worker state. One deliberately narrow native
completion path now binds an already-started, objective-only native-provider worker to
the current run revision and journal head before provider egress. It permits no
tools, context, capabilities, grants, or expected outputs; Rust validates the
exact request shape, observes a clean provider `stop`, rechecks account and
workspace authority after the await, and appends an idempotent native-built
`worker-completed` event with an empty output list. A process-local lease rejects
duplicate concurrent egress for the same started worker. Definitive transport,
HTTP, response-bound, provider-payload, output-limit, and incomplete-terminal
failures append a separate native-built `worker-failed` event with static
secret-free details and conservative branch-specific retryability; cancellation
is retained as its own terminal state rather than being mislabeled as failure. Success and failure
replay through distinct exact event identities without repeating provider
egress. For the eligible one-step shape, a worker failure now continues in the
same transaction to terminal `run-failed`, projects the run and selected mission
to `failed`, and retains a failure `MissionResult` with every unevaluated
criterion explicit. Token-limit failures use the canonical `budget-exceeded`
category; provider failures remain provider failures. This does not claim semantic output evidence: tool-bearing workers,
durable output receipts and provenance, non-HTTP runtimes, live grant
consumption at tool use, handoffs, and the desktop experience remain open.

The cited native-provider worker boundary now also derives its duration ceiling and current
attempt from the authenticated selected worker before egress. One monotonic native
deadline spans request send, internal transport retries, retry backoff, and stream
consumption; renderer state cannot reset it. Cancellation retains priority. Reaching
the deadline discards any unaccepted buffered output and durably terminalizes the
attempt as a static non-retryable `budget-exceeded` failure. Every non-cancelled
provider attempt records its bounded native-observed duration and exact journal
attempt before completion or failure, even when a failed provider turn has no final
token pair. Replay requires the same attempt and, for a duration failure, the exact
authenticated ceiling. Non-HTTP runtimes and multi-worker duration aggregation remain
open, so the Wave 4A boxes stay unchecked.

The same provider-specific native boundary now has one deliberately constrained semantic
output path. A worker with exactly one required, evidence-free Markdown
run-result slot receives a native-reconstructed prompt containing its persisted
objective, output key, description, format, and uncertainty requirement. Rust strictly frames UTF-8 SSE
bytes. OpenAI-compatible providers require one choice, one finish reason, and
one post-finish usage frame; Anthropic requires an initial input count, text-only
content blocks, one terminal message delta with output usage, and `message_stop`;
Gemini requires text-only candidate parts and final usage with the candidate
finish reason. Every family rejects tool calls, duplicate or late terminal facts, invalid or
oversized text, and whitespace-only results, then hashes the exact bounded text.
Schema v27 atomically links the `worker-completed` event's domain-separated
value reference to an immutable owner-qualified encrypted receipt containing
the text, requested model reference, exact observed provider identity, provider-generated
trust class, and no citations. Replay requires both the exact event and receipt;
an authenticated native read resolves only the active member's reference after
restart. This is durable provider-generated text, not an artifact, cited brief,
accepted mission result, canonical provider-route observation, or evidence for
tool/context-bearing workers, so the Wave 4A boxes remain unchecked.

Native mission settlement now atomically appends one `usage-recorded`
event before every non-cancelled completion or failure. A completed turn requires
exactly one nonnegative final token pair at the legal provider-specific terminal
position; Rust rejects early, duplicate, stale, or post-usage content frames. A failed turn retains that
pair only when provider finality was actually observed. The event binds the
worker, requested model, immutable selected route, exact prior tool count,
native-observed provider duration, and journal attempt. Exact `gpt-5` token pairs
carry the reviewed source-attributed standard API cost; other models and failures
without final tokens invent no cost. Token- or duration-budget excess is retained
then closed as a non-retryable budget failure instead of disappearing into a
retryable started worker. Cooperative cancellation records no usage because
provider finality is not established. Older direct terminal events remain
readable as legacy exact replays, and legacy usage without durable timing is not
projected as a modern cited receipt.

Mission-owned `knowledge.content.search` can now cross the same exact-action
approval and scoped standing-grant boundary through either the native Connection
resolver or an explicitly bound MCP tool. The worker's exact assigned grant is
consumed before egress; another active grant is never substituted. Native results
and native-correlated MCP JSON-RPC responses are normalized to the same cited
search contract, stamped `external-untrusted` with no instruction authority, and
atomically appended as `tool-call-completed` with a domain-separated reference to
an owner-qualified encrypted schema-v28 receipt. MCP settlement is driven only by
the response Rust observed for the exact single-use permit; the renderer can
neither supply evidence nor skip execution. Exact event-plus-receipt replay occurs
before consuming another one-shot approval. This is the durable,
transport-neutral tool-evidence stage consumed by the completed cited-brief
journey described below; by itself it does not claim provider output or acceptance.

The same worker can now continue from that exact encrypted tool receipt without
another tool call. The portable driver canonicalizes only the Rust-attested result
into the native-reconstructed final prompt; Rust independently reloads the receipt,
worker, grant, Connection scope, and current tool-event head before native-provider egress.
The final Markdown must cite only available `[source-N]` ids, include a Sources
mapping with each used title and URI, and explicitly disclose empty or degraded
evidence. Unknown or unmapped citations fail closed. Usage records one prior tool
call, and the completion atomically stores a v2 output receipt whose trust is
`provider-generated-with-external-evidence` and whose citations retain their
`external-untrusted` classification. This closes the repository-local native/MCP
semantic substitution through durable cited output. The desktop composition below
now consumes it; live account/native/MCP validation remains open, so no live Wave
3D or full Wave 4A checkbox is claimed.

Run-journal evidence now includes a deterministic portable reducer for legal
status transitions, contiguous previous-event links, exact idempotent replay,
checkpoint replay boundaries, advancing recovery attempts, cooperative
cancellation, and terminal immutability. Encrypted SQLite schema v25 stores the
current projection plus immutable events, rejects stale/changed appends
atomically, and reopens the owner-qualified chain after restart. Native command
support now creates a root run only from the authenticated member's ready,
currently selected persisted mission plan; reads only that owner's journal;
and appends an idempotent native-built cooperative cancellation without
accepting renderer authority, actor, status, sequence, or time. The cited journey
binds that request to the real stop boundary: Rust finalizes pre-provider work only
when no native mission execution lease exists, while an in-flight provider request
is terminalized only after its transport observes cancellation. Both paths append
exact-replay-safe `run-cancelled`, project the revision-fenced mission to cancelled
with an explicit `MissionResult`, and the desktop refuses to surface cancellation
until it reloads that terminal fact. On the first authenticated hydration for an
account/workspace/member in each process, a process-start epoch now finds only
older nonterminal cited journals. Rust reconciles an older stored cancellation to
cancelled. For the exact one-step cited shape whose attested search result remains
bound to the latest checkpoint, whose persisted route is still authorized, and whose
mission has its single restart attempt available, Rust returns a closed resume
descriptor containing the reloaded encrypted evidence and deterministic restore
and terminal identities. The desktop restores exactly attempt two and runs only
the tool-free final provider-writing turn. Rust accepts settlement only from the
exact restore head and original checkpoint/tool chain, so search execution, grant
consumption, and approval cannot repeat. Invalid, legacy, pre-checkpoint, changed,
or attempt-exhausted journals retain the conservative deterministic
`mission-interrupted` terminal path. Current-process runs and active native leases
are excluded. The same descriptor path now handles one current-process same-run
retry after attempt one's exact final-provider transport failure, temporary
unavailability, or interrupted stream. Native settlement first records bounded
attempt-one usage, `attempt-finished`, and `retry-scheduled`, projects the run to
`retrying`, and emits no worker/run result, transcript, or artifact. An
authenticated preparation command revalidates that exact three-event chain,
restores the checkpoint as attempt two, and returns the run to `running`; an app
restart discovers and validates the same chain. Policy, budget, cancellation,
request-rejection, invalid-output, pre-checkpoint, and attempt-two failures never
enter this retry. Terminal receipts select attempt-two usage and cannot mistake a
duration-only attempt-one record for final token usage. Schema v26 adds
owner-qualified encrypted checkpoint state linked by composite foreign key to
the exact immutable checkpoint event. Authenticated create/restore commands
derive completed workers, plan steps, committed effects, active work, and waits
only from the durable journal; persist only the closed portable replay shape;
bind its hash to run, event, attempt, and reference; select the newest checkpoint
by event sequence; restore into exactly the next attempt without exceeding the
Run's saved `maxAttempts`; and make an exact restore replay stable even after a
newer checkpoint exists. The cited desktop
journey now creates that checkpoint immediately after the attested connected-source
tool receipt and before provider egress. The final provider request carries its
exact checkpoint event identity, and Rust accepts it only when that event is the
current head and immediately binds the same tool event, sequence, and attempt;
neither an arbitrary later checkpoint nor renderer-declared state can authorize
egress. The narrow native-provider path described above persists truthful production
`worker-completed` and `worker-failed` events plus one atomic encrypted Markdown
receipt. Accepted cited output now has the exact artifact provenance described
below. A separate authenticated general-recovery pass now excludes live native
executions and the fixed cited shape, then replays an earlier-process journal
against its selected Plan. It preserves exact validated human-input and general
effect-approval waits,
leaves paused and not-yet-started heads dormant, and returns a route-free resume
descriptor only when the newest integrity-checked portable-redacted checkpoint
is the exact run head, contains the same bounded worker/step/effect facts as
journal replay, conceals no wait, and has one saved attempt left. The descriptor
requires fresh route selection rather than reusing provider, credential,
placement, grant, or approval authority. A changed, missing, corrupt,
attempt-exhausted, or otherwise unreplayable running graph is atomically failed;
an exact interrupted cancellation is atomically cancelled. Both the encrypted
Run and selected Mission retain the same explicit terminal result. Automatic
general checkpoint restoration, worker recreation/dispatch, renderer
composition, other mission artifact shapes, and packaged restart observation
remain open, so the durable-run box remains unchecked.

The native `/stop` path now includes these general effect-approval waits. Before
stopping anything, the desktop verifies bounded native lists for cited approval,
typed human-input, and general effect-approval waits, fails closed if any list is
unavailable or truncated, and chooses the newest exact wait deterministically.
For a general approval it records the same native `cancelled` resolution used by
the run journal, then terminalizes from the returned durable head; it never
approves or consumes the proposed effect.

Pending typed-input and general effect-approval cards now also load the existing
authenticated native progress projection for their exact Run. The compact view
shows selected Plan steps, durable states, observed usage, saved budgets,
acceptance, and the next action; an unavailable or corrupt projection is stated
as unavailable and the Mission remains waiting rather than receiving inferred
progress.

The portable completion boundary now converts a bounded local-worker outcome
into a `RunResult` without equating provider completion with mission success.
It accepts only declared unique deliverables, matches evaluations to the exact
worker or run, requires identified internal reviewers for human criteria and
identified reviewer workers for worker criteria, refuses to claim unsupported
external attestation, checks required evidence, records bounded usage/cost, and
preserves useful incomplete work with explicit remaining work and a recovery
recommendation. Required deliverables, every required criterion, any configured
minimum, and required human acceptance must all be satisfied before `succeeded`.
The cited-brief native settlement now adds one narrow trusted policy evaluator:
after the completion event and encrypted v2 output receipt are saved in the same
transaction, Rust reloads the selected plan and exact worker step, evaluates only
its policy-owned criteria, and appends `evaluation-recorded`. Pass/fail and
evidence references come only from the attested receipt, retained citation ids,
and any exact required evidence; renderer assertions cannot create acceptance.
The general finalizer can now consume authenticated human and graph-worker
evaluation facts, multiple uniquely produced outputs, and mission-level
acceptance, while external evaluation remains unattested. A settled general
Mission can now produce the identified-human fact through the native review
boundary described below; no renderer-supplied identity, target, evidence,
timestamp, summary, or event id is accepted. General policy and reviewer-worker
evaluation production, ambiguous output-selection policy, and inspectable plans
for other mission shapes remain open, so the acceptance/evaluation box stays
unchecked.

For the deliberately narrow single-step cited-brief shape, policy evaluation
now always continues in that transaction to a terminal run outcome.
Rust requires exactly one plan step, one created worker, one required deliverable,
no human gate, and every mission criterion to be policy-owned and evaluated.
A pass appends `run-completed` and stores the derived successful `RunResult` on
the run projection. A fail appends `run-failed` with a validation-category policy
error and a recoverable `PartialOutcome` that preserves the exact output,
per-criterion acceptance, remaining work, and a stop recommendation; it projects
the run to `partially-completed` without blaming the provider. Exact settlement
replay requires the original evaluation and its matching accepted or partial
terminal fact. The general finalizer adds multi-step aggregation and declared
evaluator consumption, but automatic graph composition, evaluator production,
artifact materialization, and other product journeys remain open.

The authenticated lifecycle now also projects those journal facts back to the
selected mission. Creating the first run atomically advances the exact
revision-fenced mission from ready to running. The eligible terminal cited run
advances it from running to either completed or partially-completed in the same
transaction and stores a derived `MissionResult` naming only that producing run.
No renderer-selected status, result, actor, or time crosses this boundary; stale
transitions roll back. An eligible only-worker provider or budget failure instead
advances both run and mission to failed with the exact worker error retained on
the terminal run event. General multi-run failure aggregation remains open.

Policy-accepted output for that exact cited shape now becomes a canonical
member-private artifact and immutable version in the same settlement transaction.
The mission scope carries the real source conversation; Rust derives stable
artifact/version identities from the workspace, member, run, worker, completion
event, output key, and immutable content hash, and derives content, citations,
external-untrusted source provenance, creator, owner, status, and time only from
the durable journal and v2 output receipt. Schema v31 adds an exact owner-qualified
link from the mission run, completion/evaluation/result events, and output receipt
to the shared artifact read model without pretending the mission is an ordinary
chat run or inferring historical artifacts. `run-completed` and `MissionResult`
name the exact artifact/version; exact replay requires that linked accepted bundle
and never duplicates it. Premature, partial, failed, cancelled, and interrupted
outcomes create no artifact. General mission artifact types, explicit downstream
handoffs, and general multi-worker artifact aggregation remain open.

The desktop now reads those artifact identities from the accepted terminal
result, reloads the exact native bundle, and exposes the existing `View artifact`
control beside the cited response. It suppresses the ordinary `Save as artifact`
path for mission results, so neither an accepted output nor a policy-failed draft
can be duplicated or misrepresented as a completed chat-run artifact. Once in the
canonical Knowledge surface, the accepted version reuses the existing explicit
two-step exact-version project handoff; no mission-specific transfer authority is
invented. A handoff planned and journaled as part of a future mission remains open.

The cited result now survives conversation restart as the same exchange rather
than only as a mission journal and artifact. The immutable plan revision retains
the exact submitted prompt encrypted at rest. During eligible terminal settlement,
Rust derives that prompt and the accepted or explicitly not-accepted response from
the selected plan, output receipt, policy result, and artifact binding, then appends
deterministic terminal user/assistant messages to the real source thread in the same
transaction as the run, mission, and artifact facts. Only native settlement can add
the assistant's compact `mission-result` linkage; it contains result/artifact ids and
outcome, not copied receipt prose or authority. Exact terminal replay verifies both
encrypted message checkpoints and their adjacency. Desktop hydration uses that
linkage to restore the accepted `View artifact` action or suppress artifact creation
for a partial draft without reconstructing authority from mutable UI state. A bounded
authenticated native projection now also rebuilds the compact cited receipt after
restart. For each terminal assistant marker it requires the exact owner-qualified
journal, message detail, route, usage, evaluation, output receipt, durable budgets,
result event, and accepted-artifact binding, and returns only the existing secret-safe
receipt fields. Corrupt, ambiguous, or legacy evidence is unavailable rather than
inferred; the desktop reads markers in bounded batches and shows the same accepted or
not-accepted receipt used at settlement. The same narrow cited shape now also commits
deterministic failed or cancelled user/assistant checkpoints atomically with provider
failure, early or in-flight cancellation, and stale-run restart reconciliation. Those
assistant markers contain only the durable terminal result identity and outcome, offer
no receipt or artifact action, and exact terminal replays validate their encrypted
content and adjacency. General and other multi-worker mission transcript projection remains
open.

The desktop runtime exposes the authenticated plan, run, worker, and output
commands needed to compose that journey through Tauri. The shell now recognizes
the explicit natural-language benchmark request, obtains the separately confirmed
one-use capability grant, creates and starts the bounded mission, executes the
already-planned semantic search through its own exact-action approval, and sends
only the attested evidence into the final provider turn. It preserves an explicit
MCP route when one is configured, otherwise uses the native resolver, then reloads
the terminal journal and encrypted output receipt before showing the Markdown in
the conversation. An accepted output carries an accepted receipt, reloads its
linked artifact beside the response, and remains searchable through Knowledge; a policy-failed
draft remains readable but is prefixed as not accepted and its receipt exposes the
failed acceptance summary. A provider or budget failure is surfaced only after the
desktop reloads and validates the matching durable terminal run failure. Browser
preview creates no mission state. Focused orchestration
and rendered-shell tests cover this composition, but actual Tauri execution and
restart with production account/provider/native/MCP services remains a live
external evidence gate rather than a checked repository claim.

### Wave 4B - Routing and experience

- [ ] Route by capability, quality, cost, speed, privacy, context, tools, health, preference, and risk.
- [ ] Enforce provider pins/exclusions and safe fallback boundaries.
- [ ] Show compact receipts for medium work and inspectable plans for consequential work.
- [x] Make `/goal`, `/plan`, `/schedule`, `/remember`, and `/stop` Fable-native with natural-language parity.
- [ ] Add visible routing explanations and time/token/cost/iteration budgets.

Repo-local routing foundation now selects deterministically over already-authorized
Fable `ProviderRoute` candidates. It filters workspace, semantic capability,
state/health, tools, context capacity, exact privacy/billing/provider/placement
boundaries, placement kinds, risk, request and route budgets, currency, and
require/exclude preferences before scoring quality, estimated cost, and speed.
Preferred fallback must be explicit and cannot cross a boundary; decisions retain
the rejected reasons, selected score/explanation, fallback source, and stable
boundary reference. The native mission path now derives a stable private
account route only from current account-owned provider metadata and an exact
catalogue model. The desktop passes the complete immutable selection into the
native worker start; Rust independently re-derives its current route, latency,
policy-evaluation, price, token-bound, reason, and boundary evidence before
appending that exact selection immediately after `worker-started`. Tool execution,
usage, output receipts, and terminal run results remain bound to it across replay
and restart.
An authenticated native command now projects model-specific `ProviderRoute`
records from durable account-owned backend metadata and current credential
availability into the active member/workspace scope. Route and Connection ids
are opaque and stable, credential references remain secret-free, and live egress
still rechecks the credential. The cited journey requires the user-selected
provider/model route as a no-fallback pin through the portable selector, then
requires Rust to validate and retain the same selection. Missing, wrong-workspace,
unhealthy, insufficient-context, or changed routes fail closed; unobserved
quality, latency, and cost stay explicitly unobserved rather than zero.
Ordinary interactive native-provider turns and scheduled native prompts now use
the same exact no-fallback selector before execution. Interactive runs persist
the workspace-fenced selection with their durable recovery record, both paths
carry it unchanged through the provider-neutral backend, and Rust independently
rechecks the active account, membership, workspace, provider, model, route id,
reason, boundary, and absence of fallback before credential access. Native API
egress without either that binding or the separate mission-worker journal
authority fails closed; ambiguous dual authority is rejected.
Completed and recovered ordinary chat responses now expose that persisted
selection as a compact route receipt. It shows the canonical plain-language
reason and workspace scope while withholding opaque route, workspace, and
boundary identifiers; legacy runs without route evidence make no routing claim.
The same per-response receipt now retains final provider usage both live and
after restart. It shows actual input/output tokens and an observed or explicitly
unknown cost. When the immutable route carries exact source-attributed pricing,
it also shows the request's input estimate, output-token maximum, and conservative
currency ceiling; unsupported models stay honestly unknown. Usage is keyed to the
canonical run rather than the latest activity panel, so later responses cannot
rewrite an earlier receipt.
Scheduled native prompts attach the same route receipt to the durable workflow
run only after execution finishes. Rust permits that one post-execution
attribution transition, rejects running, changed, removed, fallback, non-schedule,
or secret-bearing route claims, and the run-detail surface reuses the same
secret-safe explanation.
Schema v29 adds bounded encrypted account-owned provider-route observations.
After an exact native-provider route finishes with one clean stop and final usage, Rust
records the monotonic egress latency plus token counts under an idempotent
request-derived observation id. Changed replay, unconnected providers,
cross-account reads, malformed values, and more than fifty retained samples per
route fail closed or are bounded; migration creates no inferred evidence. The
authenticated route catalogue projects only sample count, median latency,
usage-sample count, latest observation time, and a content-derived summary
reference. The portable selector may use that median latency only when the exact
summary snapshot is captured in the immutable route selection. Rust recomputes
the reference, bounds the evidence, requires the current snapshot before egress,
and validates the retained snapshot independently during replay so a later
aggregate cannot reinterpret the earlier decision. Exact `gpt-5` routes also
project a source-attributed standard-API price record reviewed on 13 July 2026.
The selector calculates a conservative USD-minor-unit ceiling from the requested
input/output token bounds and retains the exact rates, source, review time, token
bounds, and estimate in the immutable selection. Rust independently verifies the
model-specific record and arithmetic before egress and during persisted replay;
every unsupported model remains cost-unobserved.
Schema v30 adds encrypted native cited-policy outcomes without inferring historical
evidence. Each row is bound to the exact account route, evaluator implementation
revision, workspace/member, plan revision, run, worker, route event, evaluation
event, criterion count, verdict, and evaluation time. Retention is capped at the
newest fifty outcomes per route and evaluator revision. The catalogue exposes only
the matching current cited-policy cohort as an immutable content-derived summary:
raw passed/sample counts, a Laplace-smoothed routing score, latest evaluation time,
and exact policy revision. The selector ignores it unless the request names that
same revision; ordinary chat therefore remains quality-unobserved. A cited mission
may score and explain the matching snapshot, while Rust requires the current exact
snapshot at worker start and validates the persisted snapshot independently during
settlement and replay. A native policy fail counts as a policy outcome, not a
provider/model failure, and observation-storage failure cannot roll back a valid
provider settlement. This evidence says only whether outputs passed that exact
citation-structure policy; general model quality, factual correctness, user
satisfaction, broader evaluator revisions, broader exact-model pricing, and visible
receipts for other mission shapes remain open. The
cited-brief result now shows a
compact expandable receipt derived only from the reloaded durable journal and
encrypted output receipt: provider/model route explanation, token and tool usage,
cited-source count, external-evidence trust classification, native-observed provider
time and attempt ordinal, and the persisted input/output token, tool-call, time, and
attempt ceilings. The timing is scoped to that exact provider attempt rather than
total mission wall time. Legacy receipts without durable timing remain unavailable
instead of being inferred. It also names the
accepted or not-accepted policy state and its durable summary. Exact `gpt-5` usage
also carries a Fable-calculated USD observation from the reviewed official
standard API list rate; the durable pricing reference records the source, review
date, and input/output rates, while every other model remains explicitly unknown.
The Wave 4B
checkboxes stay unchecked because the experience is not yet general. The cited
accepted/partial receipt now survives restart through the exact native projection
described above; this does not claim receipt coverage for other mission shapes or
general inspectable consequential-work plans.
The exact one-step cited journey now also exposes its immutable native-selected
plan as a compact expandable view as soon as plan creation succeeds and beside
the terminal conversation after restart. The authenticated projection is limited
to the readable goal/question, one step, a plain connected-search capability
label, required Markdown output, policy acceptance descriptions, and the persisted
time/token/tool/attempt ceilings. It requires the exact active member/workspace,
selected revision, source thread, run, terminal message, and result head during
hydration; accepted, partial, failed, and cancelled outcomes share the same
projection. Internal mission/plan/revision, grant, Connection, route, owner,
credential, context, and reasoning fields never cross the boundary. Corrupt,
changed, legacy, or non-cited facts show `Plan unavailable` instead of an inferred
plan. This completes inspectability only for the narrow cited benchmark; general
consequential and multi-worker plan views remain open, so the combined Wave 4B
checkbox stays unchecked. A partial, failed, or cancelled cited result with that
authenticated plan projection now offers `Run again as a new mission` both live
and after restart. The action uses only the projected original question, stays
single-flight, and re-enters the current conversation/project scope, provider
route, capability-grant, and exact-action approval boundaries. The normal mission
composer creates fresh mission, plan, revision, run, worker, event, checkpoint,
and idempotency identities; it never reopens the terminal journal or reuses its
checkpoint, consumed grant, route selection, or approval. Accepted results and
unavailable plans offer no action. This is a narrow new-mission recovery path,
distinct from the automatic one-attempt cited provider retry above; general resume,
escalation, and multi-worker recovery remain open, so
the Wave 4A and 4C retry boxes remain unchecked. `/stop`
is now a Fable-owned command with exact natural-language parity, remains
submittable while work is running, drives the existing cooperative native-agent
cancel path, and persists the durable cancellation request plus terminal cancelled
run and mission state for the active cited journey.
The same narrow cited journey now supports a durable human-acceptance wait when
the user explicitly asks to approve before saving. Rust persists a wait-boundary
checkpoint whose encrypted state binds the exact plan revision, worker start,
route, terminal attempt usage, completed output, policy evaluation, content hash,
and proposal hash before projecting the Run as `waiting-approval` and the Mission
as `waiting`. No artifact or terminal conversation is created at that boundary.
The pending approval is recovered from authenticated native facts after restart;
approve creates the one replay-safe accepted artifact and terminal transcript,
while keep-as-draft and cancellation preserve the cited output without creating
an artifact. Stale revisions, concurrent or changed decisions, detached event
chains, cross-thread reads, non-owner decisions, proposal substitution, and
replayed alternative decisions fail closed. `/stop` prioritizes active work and,
when only dormant approvals remain, cancels one deterministic newest approval.
Terminal same-decision replay must follow the exact request, owner resolution,
and result head rather than merely finding an older matching decision. Pending
discovery queries a bounded newest set of waiting approvals, isolates unreadable
records so valid cards remain usable, and reports that Fable left unavailable or
truncated approvals untouched instead of silently hiding the condition.
The conversation renders the recovered draft with explicit `Approve and save`
and `Keep as draft` actions, busy/error states, keyboard focus, 44-pixel controls,
and no desktop or mobile overflow. Repository evidence covers the portable journal
contract, encrypted wait/reopen and tamper rejection, exact artifact ancestry,
runtime action composition, and approval-card behavior; responsive styles include
the desktop and mobile overflow protections. This is still one opt-in,
single-worker cited benchmark rather than general human-input
coordination, so the Wave 4C checkbox remains unchecked.
A provider-free human-input wait kernel is now available beneath that cited
benchmark. Its portable journal contract accepts one checkpoint-bound schema of
bounded text, number, boolean, choice, date-time, or exact artifact-version fields,
enforces the exact required field set and typed response, and rejects alternative
replay, concurrent waits, malformed references, and secret-valued fields. The
renderer can submit only an artifact id and immutable version id selected from a
bounded authorized candidate list. Native code revalidates current owner and
workspace/project visibility, recomputes the stored version's SHA-256 hash, and
requires exact inline bytes and size to match the immutable owner-qualified
record before writing only that attested three-part identity to the portable journal; neither
artifact content nor renderer-supplied hashes enter the wait event. The authenticated native
coordinator atomically stores the wait-boundary checkpoint and request in the
encrypted mission journal, moves the Run and Mission to their waiting states,
rehydrates only owner/workspace/thread-matching pending requests after restart,
isolates unreadable records, and resumes the exact wait once. Changed values,
stale heads, detached or altered checkpoints, cross-owner access, and replay with
different facts fail closed. The conversation now renders a generic accessible
form with typed controls and restart-safe busy/error handling; `/stop` selects one
deterministic newest dormant approval or input wait after prioritising active work
only when both bounded discovery results are complete, otherwise it leaves every
wait untouched. Human-input cancellation atomically settles both Run and Mission
lifecycles so a restart cannot strand the intermediate request. Repository evidence
covers portable reduction, real encrypted-store reopen and tamper paths, strict
runtime projections, form submission, and active-work cancellation priority.

A native continuation dispatcher now selects the only permitted post-response
behavior from the authenticated checkpoint and immutable Plan constraint. Its
identity is included in the request suffix but never accepted from a renderer or
portable wait payload. Unknown, duplicated, substituted, or mismatched selectors
fail closed; the generic form command cannot opt into a producer. Exact terminal
replay routes through the same dispatcher without repeating settlement.

Two fixed, provider-free producers now invoke that coordinator end to end. An
explicit structured-project-brief request atomically creates its native-owned
Mission, one-step Plan, Run, wait-boundary checkpoint, and six-field intake
schema without requiring a model or connector. Submitting the authenticated
response resumes and completes that exact Run and Mission in the same encrypted
transaction, renders deterministic Markdown, creates one draft artifact with
direct human-input-event provenance (and no worker, provider, evaluation,
citation, or acceptance claim), and appends a restart-safe terminal transcript.
Exact start and receive replay are duplicate-free across database reopen;
changed start facts, stale or altered wait schemas, invalid settlement,
cross-member access, and detached terminal facts fail closed or roll back to the
pending form. The conversation starts this narrow journey ahead of provider
routing, rehydrates its form after restart, and exposes the resulting draft
without mislabelling it as a cited mission.

An explicit artifact-revision-brief request creates the same fixed native
lifecycle with an exact artifact-version selector plus bounded objective, changes,
preservation, review, and target-date fields. Settlement uses the native-attested
immutable source hash to create deterministic content-free Markdown, one draft
artifact, exact `artifact-version` input and lineage references, and a terminal
transcript in one transaction. Replay remains valid when the source is renamed,
reviewed, or advanced to a later current version, while changed source identities,
tampered hashes, foreign members/projects, stale waits, and cancellation create no
substitute output. The desktop loads only project/workspace-authorized candidates,
keeps failed discovery safely waiting, binds delayed starts to their source thread,
and hydrates completed drafts without cited-plan or provider-receipt UI.

These are two fixed local producers, not general producer selection, arbitrary
provider/tool continuations, general reference kinds, or multi-worker
coordination.

A provider-neutral native approval kernel now covers arbitrary selected Mission
Plans without borrowing the fixed cited-artifact acceptance shape. One exact
running Run head can create one secret-safe consequential-effect proposal bound
to an immutable proposal hash, optional exact live worker, action/effect keys,
target summary, and idempotency key. Rust atomically stores an encrypted
wait-boundary checkpoint plus `approval-requested`, moves the selected Mission
to waiting, lists only exact owner/workspace/conversation records, and appends an
identified internal-user approve/deny resolution before returning the Run and
Mission to running. The checkpoint replays bounded active/completed
worker/step/effect facts from the journal, concurrent waits fail closed, exact
request/resolution replay is stable, changed scope/head/proposal fails, and the
whole chain survives database reopen. General restart recovery now validates and
preserves this approval shape alongside human input. Approval executes nothing,
does not select a provider, and grants no policy, factual, acceptance,
credential, placement, or reusable effect authority. Schema v35 adds an
empty-by-migration, owner-qualified encrypted approval-consumption ledger, and an
internal native boundary now requires the exact approved proposal, identified
approver, current Run head, and a fifteen-minute freshness window before
atomically consuming it once. It returns only a stack-local non-serializable
permit; changed, denied, stale, cross-owner, or replayed consumption fails
closed, and a crash after consumption requires fresh approval rather than risking
duplicate egress. The conversation now discovers bounded pending general
approvals after restart, shows only the secret-safe action and target in a calm
keyboard-operable card, makes the pre-execution recheck explicit, and submits
approve/deny through the strict runtime projection with busy, failure, and
unavailable-list states. Concrete effect-adapter composition and automatic graph
composition remain open, so the Wave 4C
human-input-and-approval checkbox stays unchecked.

Conservative, explicit
natural-language forms for goal, plan, schedule,
and memory now reach the same structured durable command handlers; conversational
uses of those words remain ordinary prompts.
Provider-wide hosted-model rates have also been removed from ordinary agent
usage: provider identity alone cannot prove a model price, so cost stays unknown
until an exact model-specific, source-attributed observation exists. Token usage
remains visible.

### Wave 4C - Multi-worker coordination

- [ ] Add parallel workers, joins, and deterministic aggregation.
- [ ] Add dynamic reviewers/judges only when justified.
- [ ] Add bounded iteration and explicit stop conditions.
- [ ] Add durable human-input and approval waits.
- [ ] Add retry, resume, escalation, and replay-safe artifact handoffs.

Repository evidence now includes one deliberately narrow production parallel
mission. An explicit request to generate two approaches and compare them creates
one exact three-step Plan with two independent Markdown workers and one
deterministic synthesis step. Both workers share the pinned native-provider route and run
concurrently through distinct native execution identities. The portable journal
enforces bounded multi-worker state, exact worker membership, one replay-safe
`all` join, canonical terminal sets, deadlines, cancellation, and failure
semantics. Native settlement advances sibling heads without prematurely
terminalising either worker, resolves the pre-opened join only after both outputs
are durable, and derives the fixed A-then-B comparison from the two authenticated
output receipts and hashes. The completed result creates one aggregate artifact
whose immutable inputs name the join and both exact worker outputs; failure,
cancellation, detached facts, altered receipts, and alternate replay create no
artifact. Terminal transcripts, cancellation, restart reconciliation, and exact
replay are durable, while the desktop exposes the compact plan, live stop path,
recovered result, and artifact action without overflow at desktop or mobile sizes.
Focused portable, native, runtime, provider-cancellation, renderer, and responsive
evidence covers this fixed benchmark. It does not yet establish arbitrary worker
counts, general joins, multiple providers, tool-bearing parallel steps, bounded
iteration, escalation, or live packaged-app/provider validation, so the Wave 4C
checkbox remains unchecked.

The provider-neutral coordination layer is no longer limited to that benchmark's
two hard-coded producers. A reusable compiler now binds up to thirty-two worker
records to the exact selected Plan revision, preserves arbitrary acyclic step
dependencies, requires every multi-source dependency to declare its `all`, `any`,
or quorum join explicitly, and enforces both total-worker and parallel-width
budgets. Its deterministic evaluator derives runnable, waiting, running, blocked,
and complete work only from durable worker/aggregation states; a failed join is
never silently treated as satisfied. Coordinate steps may declare an
`ordered-manifest-v1` aggregation that combines only exact worker output
references in Plan order, reports missing required outputs, and makes no policy,
human-acceptance, or factual-correctness claim. Focused coverage includes
arbitrary roots, mixed running/failed states, explicit joins, impossible joins,
authority substitution, and partial deterministic aggregation. The existing
native desktop journey still uses its fixed two-producer/reviewer composer.
Authenticated native commands now predeclare a general Plan-bound `all`, `any`,
or quorum join before any dependency worker settles, persist it in the encrypted
run journal, and resolve it only from immutable worker completion/failure facts.
The commands fence the active owner, selected revision, target step, ordered
dependency workers, deadline, journal head, and exact replay. Creating a worker
for a multi-source step requires that exact satisfied join, and a `coordinate`
step cannot be substituted with a model worker. The desktop runtime exposes the
boundary only under Tauri; browser preview creates no durable coordination state.
Product Spine contract 1.5 adds a replay-safe `aggregation-recorded` fact. For an
explicit coordinate step, Rust derives its ordered manifest from the exact saved
worker output contracts and reference-bearing terminal outputs after the required
join is satisfied. It records complete or partial truth and missing required keys,
but copies no referenced output body and grants no policy, acceptance, or artifact
authority. The portable journal independently rejects substituted workers,
outputs, order, status, and duplicate aggregation. General automatic graph
advancement is now native-owned as described below. Provider routing across
arbitrary workers, artifact materialization from the general manifest, and
product restart dispatch remain open.

An authenticated native progress projection now reads any selected general Plan
and its encrypted journal without accepting renderer state. It derives bounded
ready/running/waiting/blocked work in Plan order, applies the saved parallel
limit, totals only durable usage records, retains exact cost observations, and
projects policy/human/worker acceptance as evaluated or explicitly unevaluated.
Unknown workers, duplicate terminal facts, out-of-Plan work, malformed usage,
ambiguous evaluation, and unavailable dependencies fail closed. The current
parallel desktop journey publishes this compact calm receipt after the durable
join, worker settlement, optional reviewer, and terminal boundaries. Browser
preview returns no synthetic progress. This is inspectability, not automatic
execution authority.

A native-owned bounded advance command now removes renderer orchestration from
the deterministic part of that graph. Given only an authenticated run id, one
transaction repeatedly reloads the selected Plan and journal, resolves every
currently decidable declared join from immutable terminal worker facts, and
records every now-ready reference-only coordinate aggregation in Plan order.
Event and idempotency identities are derived from the run, event kind, and exact
join or step reference; no renderer-selected head, status, worker set, time, or
output crosses the boundary. The loop is capped at sixty-four facts and rolls
back on malformed or over-limit state. A separate authenticated native preparation
command can now derive every executable provider-only worker from the same selected
Plan using only a Run id. Worker and event identities, role, objective, output
contract, evidence requirement, stop conditions, and the minimum of saved Run,
Mission, Plan-step, and conservative default budgets are native-derived. Exact
replay is idempotent; partial or changed preparation, worker-budget overflow, and
capability-bearing steps fail the transaction before any append. Context, tools,
grants, routes, credentials, approvals, and placement remain empty rather than
being inferred. Starting/routing arbitrary ready workers, native grant composition
for tool-bearing steps, and general restart dispatch remain open.

The existing native worker-start boundary now selects cited-policy quality
evidence only when the encrypted Mission, selected one-step Plan, capability,
output contract, acceptance, and worker facts match the exact cited-brief shape.
General workers stay quality-unobserved instead of inheriting an unrelated
benchmark cohort; persisted egress revalidates the exact policy reference, if
any, that the native start transaction accepted. The same provider boundary can
now persist bounded usage and an encrypted output receipt for a provider-only
general worker without invoking cited-policy evaluation, cited artifact creation,
or cited conversation projection. It leaves general acceptance unevaluated and
the Run nonterminal for the native coordinator/finalizer; general worker failure
likewise remains one worker fact instead of incorrectly failing the whole graph.

A provider-neutral portable graph runner now drives arbitrary compiled worker
graphs through replay-safe callbacks rather than assuming either benchmark
shape. It reloads durable state after every boundary, obeys the saved parallel
width, reacts to each completed worker so an explicit `any` join need not wait
for unrelated siblings, passes exact tool-bearing worker assignments to the
runtime boundary, and delegates declared joins and reference-only aggregation
without gaining provider, credential, grant, approval, or acceptance authority.
Cancellation is persisted before active worker egress is aborted. A callback
that returns or fails without a durable terminal worker fact is rejected, as is
substituted graph state. Focused portable coverage proves bounded parallel
execution, tool assignment preservation, early `any` continuation, cancellation
ordering, and failure handling. The runner also preserves the protocol's durable
worker `waiting` state: a human-input or approval wait consumes no provider
execution slot, unrelated ready work can continue, and a later invocation resumes
from reloaded facts without replaying terminal workers.

The desktop now supplies the authenticated product adapter for that runner.
Given only a Run id, it reloads the encrypted journal and selected Plan through
native commands, reconstructs the exact Plan-bound workers, immutable join
declarations/resolutions, coordinate steps, worker state transitions, waits,
terminal facts, aggregations, and cancellation state, then compiles that state
again through the portable graph validator. Every runner transition reloads
native facts; join settlement and coordinate recording call the bounded
native-owned advance command; external cancellation is persisted through the
native Run boundary before the runner aborts egress. Current join facts now also
retain their exact target Plan step; pre-contract-1.6 rows are reconstructed
only when the ordered dependency workers identify one unambiguous target.
Changed targets, worker order, declarations, event order, and browser-only
execution fail closed. Provider execution remains an injected worker callback,
so the adapter chooses no route, credential, grant, approval, placement, tool,
or evaluator. Automatic route selection/worker start and restart dispatch still
need product composition, so the Wave 4C checkboxes remain unchecked.

A deterministic portable mission-result aggregator now consumes one exact
terminal result for every worker in the selected graph plus any independently
recomputed coordinate receipts. It requires outputs to match each worker's
declared contract, aggregation inputs to equal those durable results, and an
explicit unique mapping from exact worker/coordinate outputs to Mission
deliverables. Policy, identified human, and exact graph-reviewer evaluations are
combined conservatively; conflicting or missing evidence cannot pass, external
claims remain unattested, and a failed or partial source cannot be promoted to
Mission success merely because it returned prose. A declared reviewer worker can
contribute an identified pass/fail and evidence, but even a clean pass remains
`partially-met`; only policy or identified-human acceptance can close the
criterion. The same rule is enforced in the single-worker portable evaluator,
the native general finalizer, and the progress projection. Successful, partial,
failed, and cancelled results retain producing run ids, completed outputs,
remaining work, acceptance, recovery guidance, and human-review gates without
copying usage or content into a new authority layer. Native product composition
remains open.

An authenticated native finalizer now performs that terminal boundary again
from the encrypted selected Plan and journal without accepting a renderer
manifest. It requires every graph worker to have one terminal fact and no
runnable or waiting step, derives each deliverable from exactly one
Plan-declared producing step, recomputes coordinate receipts, verifies durable
output references, and combines policy, identified internal-user, or exact
reviewer-worker evaluations only when the immutable event actor matches the
declared evaluator. It appends a stable terminal fact, writes the exact Run
result, and projects the matching Mission result in one transaction. Successful,
recoverable partial, failed, and cancelled paths are covered, including
encrypted reopen. Plans with ambiguous deliverable producers fail closed until
a future immutable output-selection contract exists.

The identified-human evaluator path is now native and product-composed for a
fully settled general Mission. The progress projection exposes only unevaluated
human-owned criteria plus the exact Run revision and event head. A calm result
review offers `Accept` or `Needs revision`; Rust reloads the active
workspace/member and selected Plan, derives the internal-user actor, Run target,
time, stable event identity, and evidence references from immutable terminal
outputs, and appends one encrypted `evaluation-recorded` fact. Passing is
refused when declared durable evidence is absent. Exact replay returns the
original decision, a changed replay fails, and after the final human criterion
the desktop invokes the existing native finalizer so rejected work becomes an
explicit partial result rather than success. General policy/worker evaluator
production, automatic worker creation/routing, restart dispatch, and arbitrary
artifact materialization remain open.

A provider-neutral continuation policy now supplies the bounded decision layer
for iterative workers. It accepts at most sixty-four contiguous durable
iteration facts; enforces the worker's duration, token, tool, attempt,
no-progress, deadline, cancellation, human-stop, policy-stop, and explicit
iteration limits; and can recommend continue, complete, retry, escalate, or
stop without performing an effect. Completion requires a trusted policy or
identified human acceptance fact; worker and external model opinions cannot
close the work. Retry requires the exact retained retryable error and remaining
saved attempt budget. Retry and escalation are marked as requiring fresh
authorization, so this layer cannot silently reuse a provider, credential,
grant, approval, placement, or billing boundary. Native journal production and
product composition of these general iteration facts remain open.

A portable reviewer-decision boundary now rejects decorative or ambiguous
reviewers. It requires the exact selected Mission/Plan scope and one immutable
native policy reference, then justifies at most one review step from declared
worker-evaluated acceptance criteria, high/critical policy risk, or bounded
conflicting-evidence references. A missing step or assignment requests a Plan
revision instead of inventing a reviewer. The chosen worker must be the one
scope-matched reviewer assignment for that step, and its criterion keys must
equal the Mission's worker-evaluated criteria. Risk- or conflict-only review is
explicitly advisory. This boundary selects no provider and grants no policy,
human, credential, approval, or factual authority. Native dynamic reviewer
composition and execution remain open.

An explicit opt-in variant now adds one independent reviewer after the same two
producer outputs are durable. Rust alone resolves the producer join, reloads and
hash-verifies both immutable receipts, derives the bounded reviewer prompt and
pinned route, creates the third worker, and validates its exact advisory Markdown
contract. The reviewer covers four declared criteria with an inconclusive
worker-evaluation envelope; its recommendation cannot represent policy or human
acceptance. A second replay-safe `all` join binds both approaches and the review
before one deterministic aggregate artifact and terminal transcript are created.
Restart recovery resumes only the prepared reviewer, malformed review output
consumes the single attempt as a durable validation failure, and cancellation is
persisted before provider abort with recovery for the producer-to-reviewer gap.
Ordinary two-approach requests retain the v1 two-worker shape. Focused native,
runtime, renderer, cancellation-race, restart, exact-replay, tamper, and responsive
evidence covers this opt-in benchmark. General dynamic reviewer selection and
justification, arbitrary criteria, reviewer providers, iteration, and live
packaged-app/provider validation remain open, so the reviewer/judge checkbox also
stays unchecked.

**Phase 4 complete when:** a multi-provider mission plans, executes, pauses, recovers, and produces coherent artifacts within visible constraints while simple requests remain simple.

## Phase 5 - Embedded routines

**Outcome:** Any successful work can run later or from an event without becoming a separate automation product.

### Wave 5A - Routine experience

- [ ] Migrate schedules and workflows to routines and triggers without data loss.
- [ ] Attach routines to workspaces, projects, departments, goals, threads, pipelines, and Connection events.
- [ ] Create and edit routines conversationally, through `/schedule`, and from “run this again”.
- [x] Resolve providers and models at run time within saved policy.
- [ ] Move schedules out of mandatory primary navigation and into contextual activity.

The migration and local time-driver foundation now crosses the native boundary but
remains partial. The pure deterministic planner still accounts for every legacy
source without mutating storage. Schema v34 adds owner-qualified encrypted Routine,
immutable RoutineVersion, trigger, portable occurrence-history, node-local driver,
trigger cursor, migration evidence, quarantine, and scheduler-authority stores
without inferring a single row. Authenticated native capture reads exact encrypted
legacy repositories and hashes them, but proves ownership only when the stored row
itself contains the exact workspace/project/member-private creator identity.
Current legacy schedules normally lack those fields and are therefore quarantined;
Fable does not assign them to the currently signed-in member. Native application
rejects omitted, duplicated, changed, or cross-owner evidence, stores the exact
input and plan encrypted, handles canonical identity collisions by quarantine, is
idempotent by semantic evidence hash, verifies exact replay, and can remove only
unchanged batch-created records before driver execution.

New legacy-compatible schedules now cross a forward-only native ownership
boundary: Rust overwrites renderer identity and stamps the authenticated
workspace, project, member, and creator onto the scheduled job and each newly
created immutable workflow version, then carries the identical evidence into
queue occurrences and workflow runs. Existing exact ownership is preserved on
updates; missing legacy ownership is never backfilled from a later session.
Scheduler commands also resolve the asserted workspace/project through the
active native account before reading or mutating encrypted state. Production
workflow writes no longer fall back to plaintext JSON when the encrypted store
or authenticated scope is unavailable.

The five-second native scheduler now evaluates canonical one-time and legacy-lite
daily, weekly, and monthly recurrence in the trigger timezone, including DST,
bounded missed-occurrence policies, deduplication, restart cursors, epoch fencing,
leases, crash recovery, three bounded attempts, and exact run/attempt/token
settlement. A transactional authority transition keeps exactly one writer.
Reconciliation proves current migrated job checksums and retained terminal history;
future legacy queue work is retained as recovery input. The Schedules page exposes
shadow checking, explicit cutover, and rollback before any canonical driver
occurrence. `/schedule` writes canonical Routines only after that cutover. Legacy
reads remain available, and legacy mutations fail closed when legacy is not the
writer. Canonical execution resolves the current provider and model inside the
saved policy at run time; a deliberate route pin without exact native binding fails
closed instead of being guessed.

The calm local Routine surface supports create, edit, pause, resume, delete,
history, run-in-chat, and compatible migration. Its editor now preserves and
changes one-time, daily, weekly, and monthly timing instead of silently reducing
everything to daily. The existing Scheduled Task form and `/schedule` resolve
the same fenced writer, so both create canonical Routines after cutover and
legacy jobs before it; rejected writes remain visible in the open form. A
completed ordinary chat response offers `Run this again later`, which opens a
transient prefilled Routine draft and persists nothing until the user chooses a
time and saves. Browser preview labels encrypted durability unavailable instead
of using fixtures. Forward ownership capture is
implemented, while attribution of already-ambiguous legacy rows remains
deliberately impossible. Post-execution rollback now atomically bridges terminal
canonical occurrences into the exact unchanged legacy schedule history, advances
the legacy cursor to prevent duplicate firing, and fences the writer twice before
restoring it. Canonical-only or edited Routines, ambiguous/currently changed
migration mappings, in-flight work, and another private owner's state fail closed
instead of being stranded or guessed. The native driver additionally supports
bounded five-field cron recurrence with timezone/DST, named month/weekday,
range/list/step, cutoff, missed-run, deduplication, and restart semantics;
malformed or unsupported cron syntax fails closed. Event triggers,
workspace-shared writes, packaged restart observation, and live provider
validation remain open, so the broader migration and experience checkboxes stay
unchecked.

### Wave 5B - Triggers and reliability

- [ ] Complete one-time and recurring time triggers.
- [ ] Add signed webhook and connector-event triggers.
- [ ] Add threshold, monitoring, and follow-up triggers.
- [ ] Complete pause, resume, retry, notifications, and run history.
- [ ] Handle time zones, missed occurrences, deduplication, leases, and untrusted event payloads.

Repo-local evidence: canonical time triggers now cover timezone/DST calculation,
bounded missed-run policy, exact occurrence deduplication, fenced leases, crash
recovery, retry, restart cursors, immutable history, and matching one-time,
daily, weekly, and monthly form/command editing. The native contract also accepts
bounded five-field cron expressions with numeric or named fields, lists, ranges,
and steps while rejecting unsupported extensions. The calm form has no expert
cron editor. A native-only Connection-event intake now proves the exact active
owner, live Connection revision, fenced writer, bounded structural filter,
source-reference deduplication, and secret/content-free occurrence evidence.
Duplicate, stale, nonmatching, and oversized fixture events are covered. No
renderer command can forge this evidence. Native provider/MCP adapter wiring,
signed webhooks, thresholds, monitoring/follow-up inputs, and live event
validation remain open; therefore the aggregate checkboxes stay open.

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
