# Product Spine Conflict Inventory

**Audit baseline:** 48fa1ef (main, 10 July 2026)

**Purpose:** Factual inventory for Wave 0A. This records evidence against the
[Product Blueprint](vision.md), not a replacement ontology, identity/tenancy
ADR, or authority matrix. It proposes sequencing and ownership seams only.

**Scope:** Product docs, ADRs, architecture and security docs, README and
user-visible copy, TypeScript protocol/domain packages, Convex schema/policies,
Rust models/repositories/migrations, the central desktop runtime, and tests.

## Classification

- **Confirmed conflict:** current code or copy expresses a model that differs
  from the Blueprint.
- **Stale documentation:** current code has moved on, but a document still
  describes the old state or vocabulary.
- **Implementation gap:** the Blueprint requires a concept or behavior that is
  not yet represented end to end.
- **Needs a decision:** the repository contains competing valid directions; the
  inventory does not choose between them.

Severity is a delivery risk, not a product priority: **Critical** can make
boundaries or data migration unsafe, **High** can block the minimum product or
cross-layer parity, **Medium** creates future duplication or misleading UX,
and **Low** is bounded cleanup.

## Executive findings

1. **Critical — tenancy is not one model.** The Blueprint says Clerk supplies
   identity only and Fable owns internal users, workspaces, memberships, and
   authorization (vision.md:188-199). Convex tables and policy code still
   require clerkOrgId; the identity protocol exposes an organization and
   needs-organization state; local runtime calls default to the compatibility
   workspace. This is a confirmed contract conflict and a Wave 0B/0C decision
   boundary, not evidence that the existing policy tests are useless.
2. **High — the minimum path is opposite in the desktop UI.** The Blueprint's
   shortest path is account, initial workspace, one provider, then useful work
   (vision.md:188-205). Onboarding instead says “local profile”, “No account is
   created”, and offers “Skip onboarding (preview)” while App derives the
   workspace name from the local profile. This is a confirmed product-copy and
   implementation conflict.
3. **High — Connection has not replaced connector-account semantics.** The
   Blueprint makes Connection, provider route, capability, and capability grant
   Fable-owned contracts (vision.md:124-149). The current protocol, SDK, SQLite
   table, repository, and runtime commands still center ConnectorAccount*,
   accountId, and one connector row per workspace. The replacement needs
   canonical contracts before connector work continues.
4. **High — standalone threads are not a storage invariant.** The Blueprint
   allows a thread directly in a workspace or optionally in a project
   (vision.md:211-216), but SQLite makes thread.project_id NOT NULL and
   cascades threads from project. This is an implementation gap with a data
   migration consequence.
5. **High — automation has overlapping generations.** The protocol retains
   AutomationRule and snapshot ScheduleEntry, while also defining ScheduledJob,
   WorkflowDefinition, WorkflowRun, department pipelines, and a frozen
   scheduled execution route. The Blueprint wants Routine plus Trigger, with
   schedules as one trigger and activity in context (vision.md:276-309). Wave
   0B must choose the canonical contract and Wave 5A must migrate the legacy
   forms.
6. **High — mission ontology is mostly absent.** There are no canonical
   Mission, Worker, RunEvent, ProviderRoute, or CapabilityGrant interfaces in
   packages/protocol/src/index.ts; existing workflows and departments are
   static execution structures. That is an implementation gap, not a reason to
   redesign workflows in this inventory.
7. **Medium — repository reality and product documentation disagree.** The
   SQLite source is at CURRENT_SCHEMA_VERSION = 7, while README, status,
   release, architecture, marketing, and connector docs still cite schema v5
   (the connector cache separately uses v2). This is stale documentation and
   makes migration evidence harder to trust.
8. **Medium — public/open-source copy is already shipped in user-visible
   surfaces.** The Blueprint defers public release and open-source distribution
   (vision.md:442-451), but desktop metadata and the marketing site say
   “open-source” and “developed in public.” This is a confirmed copy conflict.

## 1. Schema and protocol conflicts

| ID | Severity / kind / target | Classification and evidence | Consequence / safe next action |
|---|---|---|---|
| S-01 | Critical · contract/schema · 0B→0C | **Confirmed conflict; needs decision.** apps/desktop/convex/schema.ts:11-32 stores clerkOrgId on workspaces and memberships. apps/desktop/convex/cloudPolicy.ts:103-124 rejects a mismatched Clerk organization, and apps/desktop/convex/workspace.ts:7-16 requires one at create/join. packages/protocol/src/index.ts:571-610 still calls cloud identity optional and models IdentityOrganization; IdentityAuthState includes needs-organization. | A Clerk organization can still become an accidental tenancy root. The identity/tenancy ADR must define the Fable-owned identity and membership mapping; contract work can then remove or demote org fields without silently breaking authorization. |
| S-02 | High · schema/structure · 0B→0C | **Implementation gap.** apps/desktop/src-tauri/src/store/schema.rs:312-420 has a workspace root but no internal user or membership tables. store/repos/workspace.rs:20-30 creates default / “My Workspace”; apps/desktop/src/runtime.ts:4 and apps/desktop/src/hooks/useShellRuntime.ts:1723-1730 use that default scope. | Local storage has workspace isolation but not the Blueprint's account/member authorization contract. Preserve the local DataScope seam; add the canonical owner/member mapping in 0B/0C rather than treating default as a user identity. |
| S-03 | High · contract/schema · 0B→3A | **Confirmed conflict.** packages/protocol/src/index.ts:337-366,562-566 defines ConnectorAccountSummary, ConnectorAccountOption, and ConnectorAuthResult.account. packages/connectors/src/sdk.ts:63-166 uses ConnectorAccountSession and accountId; apps/desktop/src-tauri/src/store/schema.rs:454-480 and store/repos/connector_account.rs:1-15 persist connector_account. | “Account” ambiguously means Fable identity, external provider account, connector session, and workspace ownership. Introduce a Fable-owned Connection contract plus provider-route/capability-grant references; keep external account identity as provenance, with a deliberate legacy migration. |
| S-04 | Medium · schema/contract · 0B→3A | **Implementation gap.** Capability concepts are split across connector permissions (packages/protocol/src/index.ts:271-279), connector capabilities (:1126-1149), action kinds (:425-482), backend capabilities (:1037-1065), and permission profiles. No canonical CapabilityGrant or provider-neutral ProviderRoute exists. | Resolver and authorization work will otherwise invent parallel connector/backend policy paths. Define the Fable-owned contract first; preserve existing approval and credential boundaries as adapters. |
| S-05 | High · schema · 0B→1B/2A | **Confirmed conflict; implementation gap.** The Blueprint permits standalone threads. SQLite thread requires project_id (apps/desktop/src-tauri/src/store/schema.rs:359-369) and message reaches a thread only through that project (:371-383). ThreadSummary has no workspace/project ownership fields (packages/protocol/src/index.ts:1197-1208), while fixtures are assembled in apps/desktop/src/data/workspace.ts:5-34. | A standalone thread cannot be represented consistently in the durable store. Define thread ownership as workspace plus optional project, then migrate existing project-bound rows without deleting history. |
| S-06 | High · schema/contract · 0B→0D | **Confirmed conflict.** packages/protocol/src/index.ts:1517-1550 retains generic AutomationRule and legacy ScheduleEntry; :1838-2042 separately defines ScheduledJob and versioned WorkflowDefinition. The latter says ScheduleEntry remains for the legacy snapshot (:1838-1839). | Multiple names and lifecycles make future Routine migration ambiguous. Inventory the legacy readers/writers, select one canonical wire form in 0B, and retain explicit versioned adapters only during migration. |
| S-07 | High · contract/structure · 0B→5A | **Confirmed conflict.** ScheduledExecutionRoute says schedules pin backend/model/permission at creation (packages/protocol/src/index.ts:1806-1823), while the Blueprint says provider/model resolve at run time within saved policy unless deliberately pinned (vision.md:305-309). | Preserve deliberate pins as an allowed policy outcome, but do not let the legacy schedule shape imply that pinning is mandatory. This requires a contract decision and migration test cases. |
| S-08 | High · schema · 0B→4A | **Implementation gap.** Protocol search finds Artifact (packages/protocol/src/index.ts:1460-1471) and WorkflowRun, but no canonical Mission, Worker, RunEvent, or Handoff contract. Rust persists workflow step data as untyped serde_json::Value and explicitly says the rich step shape is owned by TypeScript (apps/desktop/src-tauri/src/models.rs:1144-1164). | A generated mission cannot yet be portable across TypeScript, Rust, SQLite, and Convex. Define the mission/run-event contract before adding dynamic execution; do not infer one from the current workflow graph. |
| S-09 | High · schema · 0B→0C | **Implementation gap.** SQLite has artifact but no workspace_id or project_id (apps/desktop/src-tauri/src/store/schema.rs:432-445); run also lacks workspace_id and only has optional thread_id (:385-410). Artifact.workspaceId is optional in protocol (packages/protocol/src/index.ts:1460-1471). | Artifact/run authorization can be indirect or absent for threadless work. The authority matrix must assign these records explicitly and add composite ownership before shared execution. |
| S-10 | Medium · schema · 0B→0D | **Confirmed TypeScript/Rust drift.** TypeScript workflow validation allows 32 steps (packages/connectors/src/workflows/definition.ts:4-16); Rust caps workflow steps at 24 (apps/desktop/src-tauri/src/models.rs:270-276, enforced in workflows.rs:59-68). Rust stores trigger and workflow step details as generic JSON (models.rs:1040-1117,1144-1191). | A definition can pass TS validation and fail Rust persistence. Add generated or bidirectional parity checks for limits, enums, and serde shapes; make one side authoritative per contract. |
| S-11 | Medium · schema · 0B→0D | **Partial parity foundation, incomplete coverage.** Backend auth vocabularies have explicit TS parity assertions (packages/protocol/src/index.ts:954-1034, apps/desktop/src/lib/backend-state.test.ts:206-226) and Rust mirrors. Scheduler states also have TS/Rust constants (packages/protocol/src/index.ts:1894-1908, apps/desktop/src-tauri/src/models.rs:253-268). Workflow, connector, identity, and ownership contracts do not have equivalent generated parity. | Preserve the existing fail-closed checks, expand parity around the canonical contracts only after 0B settles them. |
| S-12 | High · schema/structure · 0B→0C | **Implementation gap.** Convex CloudRecordType is only project (apps/desktop/convex/cloudPolicy.ts:3-8); its schema has shared_projects, tombstones, idempotency, and audit but no shared threads/messages/runs/artifacts/mission records (apps/desktop/convex/schema.ts:46-94). viewer.ts:24-52 returns projects and tombstones only. | Convex is a policy-tested project slice, not authority for the Blueprint's shared product model. Keep the policy tests; do not claim shared-workspace completeness until record authority is assigned. |
| S-13 | Critical · schema · 0B→0C | **Needs a decision.** Local schema has durable workspace-scoped schedules/workflows and local cloud outbox/conflict tables (apps/desktop/src-tauri/src/store/schema.rs:225-309), while Convex is described as shared authority in docs/adr/2026-07-05-cloud-team-backend.md:65-77. The Blueprint assigns SQLite or Convex per record through an authority matrix (vision.md:340-379), which is not present in this checkout. | Do not migrate records or add sync paths until each core record has one authority, mirror status, offline semantics, and conflict policy. |
| S-14 | Medium · schema · 0B→5A | **Confirmed legacy overlap.** SQLite contains both simple schedule and durable scheduled_job tables (apps/desktop/src-tauri/src/store/schema.rs:626-760); store/repos/schedule.rs:1-13 calls the simple table the stable “Goal 8” surface, while store/repos/scheduled_job.rs:1-10 calls the newer table the automation-engine record. | Legacy schedule and new job APIs can diverge. Map all callers, then migrate to the routine/trigger contract with one read/write authority. |

## 2. Architecture and document conflicts

| ID | Severity / kind / target | Classification and evidence | Consequence / safe next action |
|---|---|---|---|
| A-01 | Critical · decision/architecture · 0B→0C | **Confirmed conflict; needs decision.** docs/adr/2026-07-05-cloud-team-backend.md:10-25,114-142 and docs/architecture/cloud-team-sync-mvp.md:33-48 make Clerk organization identity part of shared workspace setup. The Blueprint explicitly says Fable workspaces are not Clerk Organizations (vision.md:68-75,188-199). | Mark the old ADR/MVP contract as superseded or amend it only after the identity/tenancy ADR. No implementation should silently reinterpret clerkOrgId. |
| A-02 | High · architecture/copy · 0B→1A | **Confirmed conflict.** docs/product/architecture.md:3-12,169-175 and docs/adr/2026-07-05-cloud-team-backend.md:18-25 describe local-first solo startup with optional cloud identity; Blueprint onboarding requires a Fable account and one provider. Status correctly labels the current implementation config-gated (docs/product/status.md:25-29,89-99). | Keep local encrypted storage as a foundation, but stop treating optional account/local-only startup as the target product. Separate current-state notes from target architecture in future edits. |
| A-03 | High · architecture/copy · 0B→5A | **Confirmed conflict.** docs/product/architecture.md:113-128 says schedules do not require Convex or a hosted account and gives the Schedules page a standalone runtime model. apps/desktop/src/components/pages/SchedulesPage.tsx:8-16 presents a standalone Schedules page; apps/desktop/src/lib/constants.ts:45 keeps Schedules in primary utility navigation. Blueprint says a schedule is a trigger and activity belongs where the routine belongs (vision.md:305-307). | Preserve the local scheduler engine and tests, but migrate the product surface to contextual routines/activity. Do not delete the local path before hosted authority is decided. |
| A-04 | Medium · architecture/document · 0B→0D | **Stale documentation.** docs/product/architecture.md:45,127, docs/product/release.md:60, docs/product/status.md:25,28,69, docs/marketing/marketing-site-and-waitlist-spec.md:58, and apps/marketing/src/pages/product.astro:9-14 say schema v5. Source is v7 at apps/desktop/src-tauri/src/store/schema.rs:12, with migrations through v7 at apps/desktop/src-tauri/src/store/migrations/mod.rs:28-54. | Update the factual references after the inventory; do not use the old number to choose migration behavior. |
| A-05 | Medium · architecture/copy · 0B→0D | **Confirmed conflict.** The Blueprint describes departments as optional operating contexts, not rigid teams or fixed agent graphs (vision.md:276-295). apps/desktop/src/components/pages/DepartmentsPage.tsx:8-14 calls them “Purpose-built teams of agents,” while packages/connectors/src/departments/builtins.ts:20-57 exposes only research and ship; the Blueprint's initial library is Product, Marketing, Sales, Customer, Finance, and Legal (vision.md:280-291). | Treat the package as a small foundation/fixture, not the product library. Copy and domain defaults need to move together in the departments wave. |
| A-06 | Medium · architecture/document · 0B→0D | **Stale/competing current-state claims.** docs/product/agent-handoff.md:61-72 says departments and pipelines are not present on main and schedules still reference the old JSON migration; current source has packages/connectors/src/departments, a live Departments route, and SQLite scheduler repositories. | Keep the handoff as historical evidence only, or mark each claim with its audited commit. Avoid using it as implementation authority. |
| A-07 | Medium · decision/architecture · deferred | **Needs a decision, already leaking into copy.** The Blueprint defers public release, open-source licensing, enterprise hierarchy, and a parent Organization (vision.md:442-451). Marketing and waitlist surfaces assume those decisions are settled; see C-03 below. | Do not implement public-release architecture in Wave 0. Align claims to the deferred private-product posture until an explicit decision changes it. |
| A-08 | Medium · architecture · 0B→0D | **Implementation gap.** Blueprint requests focused packages and TS/Rust validation (vision.md:375-381). Current ownership crosses packages/protocol, packages/connectors, desktop hooks, Rust models.rs, SQLite schema, Convex, and JSON compatibility layers; workflow steps are TS-owned JSON in Rust (models.rs:1144-1148). | Use the contract and extraction seams below. Avoid a broad rewrite or a second parallel domain model. |

## 3. Product-copy conflicts

| ID | Severity / kind / target | Classification and evidence | Consequence / safe next action |
|---|---|---|---|
| C-01 | High · copy · 1A | **Confirmed conflict.** README says the product is designed around “optional depth” and calls Clerk/Convex a foundation (README.md:3-8), while its feature matrix labels Local Workspace & Chat and Schedules & Automations live and presents Fable Account & Shared Workspaces as foundation only (README.md:31-45). The Blueprint's target minimum path requires account plus provider, not local-only core. | Keep truthful current-state labels, but make the target/current distinction explicit and remove copy that implies local-only is the approved minimum product. |
| C-02 | High · copy · 1A/5A | **Confirmed conflict.** README promotes Schedules & Automations as live and a local scheduler engine (README.md:12-19,33-35); UI labels are Schedules throughout (apps/desktop/src/components/pages/SchedulesPage.tsx:32, apps/desktop/src/components/SchedulePanel.tsx:177). Blueprint names routines and makes schedules a trigger. | Preserve the tested scheduler capability; rename or contextualize user-facing copy only after the canonical routine contract exists. |
| C-03 | High · copy · deferred/10C | **Confirmed conflict.** apps/desktop/index.html:9-21 calls Fable open-source. apps/marketing/src/pages/open-source.astro:6-12 says “fully open-source and developed in public”; apps/marketing/src/layouts/Layout.astro:39,58 repeats it; apps/marketing/src/pages/product.astro:6-14 says open-source and core use requires no hosted account. Blueprint says private software and defers public/open-source decisions (vision.md:25,442-451). | Treat public marketing as stale product copy, not evidence of an approved release strategy. |
| C-04 | Medium · copy · 1A | **Confirmed conflict.** Onboarding explicitly says “No account is created” and “Set up your local Fable workspace” (apps/desktop/src/components/pages/OnboardingPage.tsx:74-112) and tests preserve that behavior (apps/desktop/src/App.test.tsx:1845-1856). Settings presents Fable account as optional/config-gated (apps/desktop/src/components/pages/SettingsPage.tsx:154-177). | The UI teaches the wrong entry contract. Update only as part of the account/workspace vertical slice so copy and enforcement land together. |
| C-05 | Medium · copy · 6A | **Confirmed conflict.** Departments copy says “teams of agents” (apps/desktop/src/components/pages/DepartmentsPage.tsx:8) although the Blueprint says departments are not fixed teams (vision.md:280-295). | Use outcome/context language once the department contract is finalized; do not imply an agent graph. |
| C-06 | Low · copy · 0D/10C | **Stale copy.** docs/product/release.md:59-65, docs/product/connectors.md:1-12, and docs/product/architecture.md:45 describe current implementation accurately in places but retain older schema v5, AutomationRule, and standalone schedules vocabulary. | Update factual references in one documentation cleanup pass after contract decisions; do not mix cleanup with ontology decisions. |

## 4. Oversized and high-risk modules

The ranking uses line count plus boundary density: how many product contracts,
storage paths, effects, and tests a module owns. Line count is not a quality
judgement and is not a request to split everything at once.

| Rank | Module (line count) | Evidence of ownership/dependency density | Proposed extraction seam (not implemented) |
|---|---|---|---|
| 1 | apps/desktop/src/hooks/useShellRuntime.ts (3,766) | Owns the ShellRuntime surface (:395-704), identity/backend state (:722-820), fixture/live connector state, knowledge/memory, local persistence, command dispatch, and schedule creation/update/run/retry (:2820-3593). It is imported by App and most pages. | Split behind a stable ShellRuntime facade: identity/account, workspace/session state, connector/connection state, knowledge/memory, approvals/history, and scheduler/routine controller. Move pure transforms first; leave Tauri invocation at one boundary. |
| 2 | apps/desktop/src-tauri/src/portable.rs (2,784) | Owns archive format, export/import, workspace traversal, credential-free filtering, migrations, and many tests. It crosses every durable entity and is sensitive to authority changes. | First isolate archive manifest/section codecs from repository traversal and policy validation. Defer extraction until 0B/0C authority and ownership fields are stable. |
| 3 | apps/desktop/src-tauri/src/scheduler.rs (2,218) | Combines scheduler store normalization, leasing, tick transitions, retry/backoff, route/permission gates, Tauri commands, and a large test matrix (:1-330, :1197-1309, tests :1310-2218). | Separate pure occurrence/retry/transition logic, repository I/O, and Tauri event/command wiring. The seam must accept the future Routine/Trigger contract rather than hard-code Schedule. |
| 4 | apps/desktop/src-tauri/src/clerk_identity.rs (1,792) | Owns PKCE, keyring session state, JWT/JWKS validation, optional organization requirements, userinfo enrichment, and status commands (:344-474, :628-823, :1194-1572). | Split protocol-neutral claim/session validation from Clerk transport/keyring and from UI status mapping. Do not remove organization checks until the identity/tenancy ADR defines their replacement. |
| 5 | apps/desktop/src-tauri/src/connectors.rs (1,687) | Centralizes connector status/auth/health/search/import/action boundaries and account metadata; apps/desktop/src-tauri/src/connector_api.rs adds provider action routing. | Extract connection lifecycle, capability/action authorization, and provider adapter dispatch. Keep credential custody and approval permit revalidation in Rust. |
| 6 | apps/desktop/src/App.tsx (1,022) and apps/desktop/src/components/WorkspaceSidebar.tsx (828) | App owns page routing, onboarding gate, profile-derived workspace name, agent wiring, sidebar callbacks, composer dispatch, and schedule notifications (App.tsx:113-132,371-379,548-676,729-838). Sidebar owns workspace switcher, projects, chats, settings, and mobile variants. | Extract route/page composition and onboarding/account gate from App; keep sidebar presentational with a workspace-navigation model. Collision risk is high because account, workspace, and routine waves will touch these seams. |
| 7 | apps/desktop/src-tauri/src/store/schema.rs (878) + store/migrations/mod.rs (963) | Two large files are the SQLite contract, migration registry, compatibility workspace, schedule/workflow tables, connector cache, cloud outbox, conflicts, and tombstones. | Extract per-domain DDL/migration modules only after authority ownership is recorded. Preserve forward-only migrations, idempotence tests, and legacy payload AAD behavior. |
| 8 | packages/protocol/src/index.ts (2,644) + apps/desktop/src-tauri/src/models.rs (1,192) | Protocol mixes approvals, memory, connectors, identity, cloud sync, snapshots, schedules, workflows, departments, voice, browser, and mobile. Rust mirrors constants but stores several rich records as strings/JSON. | Focus protocol/domain packages by canonical contract, then generate or validate Rust mirrors. Avoid moving fields while 0B decisions are open. |

### Structural collision risks

- Account/workspace work will touch App.tsx, useShellRuntime.ts, runtime default
  scope, clerk_identity.rs, Convex policy, and onboarding tests.
- Connection migration will touch protocol account types, connector SDK/Rust
  repositories, knowledge provenance, portable export/import, and connector
  tests. It must not be parallelized with identity ownership changes without a
  shared contract branch or explicit handoff.
- Routine migration will touch snapshot compatibility, schedule/workflow
  repositories, scheduler engine, Schedules UI, command parsing, and tests.
  Keep extraction of scheduler pure logic separate from user-visible rename.
- portable.rs, schema.rs, migration code, and cloud-sync repositories are unsafe
  collision surfaces for independent feature work: they encode data-loss and
  rollback behavior.

## 5. Foundations to preserve and tests that characterize them

| Foundation | Evidence to preserve | Characterizing tests |
|---|---|---|
| Encrypted local vault and scoped repositories | apps/desktop/src-tauri/src/store/schema.rs:312-420,454-620; store/repos/scope.rs:1-124; tombstones and composite keys in schema.rs:520-620 | apps/desktop/src-tauri/src/store/repos/scope.rs:217-446, apps/desktop/src-tauri/src/store_tests.rs, migration tests in store/migrations/mod.rs:507-929 |
| Exact approval and audit boundaries | Protocol approval types packages/protocol/src/index.ts:1-70; Rust permit/audit wiring in apps/desktop/src-tauri/src/permission_policy.rs, tools.rs, and lib.rs | packages/connectors/src/native-api/approvals.test.ts, apps/desktop/src-tauri/src/permission_policy.rs:166-176, apps/desktop/src-tauri/src/tests.rs approval/permit cases |
| Provider-neutral agent runtime and secret custody | packages/connectors/src/agent-runtime/contract.ts, native-api/agent-loop.ts; Rust credential/runtime boundary in apps/desktop/src-tauri/src/backends.rs and native_api.rs | packages/connectors/src/agent-runtime/conformance.test.ts, factory.test.ts, native-api/agent-loop.test.ts, apps/desktop/src/lib/backend-state.test.ts:206-226 |
| Connector fail-closed lifecycle and approvals | packages/connectors/src/sdk.ts:63-166; provider adapters; Rust connector_auth.rs, connector_api.rs, and connectors.rs | packages/connectors/src/providers/google-connectors.test.ts, developer-connectors.test.ts, collaboration-api.test.ts, apps/desktop/src/App.test.tsx:1531-1708 |
| Knowledge provenance, bounded ingestion, and retrieval | packages/knowledge/src/ingestion, context, and retrieval; local source protocol at packages/protocol/src/index.ts:1213-1490 | packages/knowledge/src/ingestion/*.test.ts, retrieval/retrieve.test.ts, context/assemble.test.ts, packages/connectors/src/knowledge-search.test.ts |
| Scheduler reliability | apps/desktop/src-tauri/src/scheduler.rs:1197-1309; SQLite scheduler repositories; provider-neutral scheduled runner | Rust scheduler tests apps/desktop/src-tauri/src/scheduler.rs:1310-2218, packages/connectors/src/scheduler/*.test.ts, apps/desktop/src/components/SchedulePanel.test.tsx, SchedulesIntegration.test.tsx |
| Convex policy foundations | Workspace membership, role, device, idempotency, revision, and tombstone checks in apps/desktop/convex/cloudPolicy.ts and mutations.ts | apps/desktop/convex/cloudPolicy.test.ts:55-159 covers cross-workspace reads/writes, roles, revoked devices, idempotency, revisions, and tombstones |
| Honest preview/fixture labeling | apps/desktop/src/data/workspace.ts:1-18; fixture adapters and preview branches in useShellRuntime.ts | apps/desktop/src/App.test.tsx:377,1531-1708,1845-1877; connector registry and fixture tests |

These are foundations, not proof that the target product is complete. In
particular, policy tests prove rejection behavior for the current Convex model;
they do not prove Fable-owned tenancy or a complete shared-workspace journey.

## 6. Prioritized Wave 0B–0D action list

| Priority | Wave | Action and suggested ownership | Collision / exit evidence |
|---|---|---|---|
| P0 | 0B | Record the core ontology: internal user, workspace, member, thread, project, Connection, provider route, capability/grant, mission/run/artifact, routine/trigger. Suggested owner: packages/protocol plus a focused domain package. | Must settle names before touching connector_account, schedule/workflow, Convex record types, or UI copy. Exit: one contract map with legacy aliases identified. |
| P0 | 0B | Record identity/tenancy and authority decisions. Suggested owner: ADRs plus apps/desktop/convex and store/repos. | Do not parallelize with Convex schema rewrite or Clerk organization removal. Exit: Fable user/workspace/membership mapping, per-record SQLite/Convex authority, offline/conflict rules. |
| P1 | 0B | Define Connection, provider route, capability, and grant contracts; map external account identity as non-authoritative provenance. Suggested owner: packages/protocol, packages/connectors, Rust connector boundary. | Collides with connector OAuth/account work and portable archive. Exit: account-to-connection mapping and migration fixtures. |
| P1 | 0B | Define mission, plan, worker, run, run-event, artifact, and handoff contracts. Suggested owner: focused packages/protocol/domain package, with Rust/Convex adapters. | Do not promote current workflow steps into the mission ontology. Exit: TS/Rust/SQLite serialization and bounded parity tests. |
| P1 | 0B | Define routine/trigger contract and legacy migration map for AutomationRule, ScheduleEntry, schedule, ScheduledJob, workflow definitions, and workflow runs. Suggested owner: scheduler/domain package plus migration owner. | Collides with Schedules UI and scheduler extraction. Exit: every old record has a canonical target and rollback behavior. |
| P2 | 0C | Implement internal user mapping and one workspace model; remove Clerk Organization as Fable tenancy while retaining Clerk identity validation. Suggested owner: identity/tenancy owner across clerk_identity.rs, Convex policy, workspace repositories. | Must preserve keyring separation, negative isolation tests, and account recovery boundaries. Exit: account → initial workspace is idempotent; one/many members share the same workspace type. |
| P2 | 0C | Make workspace ownership explicit for threadless runs, artifacts, approvals, and other core records; add missing composite predicates and migration tests. Suggested owner: Rust repositories/schema, then Convex mirrors. | High data-loss risk in schema.rs, migrations/mod.rs, and portable.rs. Exit: cross-workspace negative tests and export/import round trips. |
| P2 | 0C | Expand Convex only to records assigned shared authority by the matrix; align outbox, cursor, shadow, conflict, tombstone, device, and membership fields. Suggested owner: apps/desktop/convex + Rust cloud-sync repositories. | Do not claim collaboration from project-only tests. Exit: shared record list and conflict tests match authority matrix. |
| P3 | 0D | Extract the React shell/runtime seams in the ranking above. Suggested owner: desktop UI/runtime owner. | Keep the existing ShellRuntime facade during moves; run App, hook, schedule, connector, knowledge, and persistence tests after each seam. |
| P3 | 0D | Extract Rust scheduler pure logic/repository/Tauri wiring and split protocol/domain package boundaries. Suggested owner: Rust runtime owner plus protocol owner. | Keep lease fencing, deduplication, retry, blocked-auth, and approval tests. Do not rename the user surface in the same mechanical extraction. |
| P3 | 0D | Add TS/Rust parity checks for canonical enums, limits, serde shapes, and migration versions; resolve v5/v7 documentation claims. Suggested owner: protocol + Rust test owners, followed by docs cleanup. | Exit: generated or checked parity is part of CI, and all factual docs cite the same audited version. |

## Recommended safe parallel boundaries

1. **Safe now:** read-only evidence cleanup and test inventory; no shared schema
   edits. A documentation-only branch may update stale v5/current-state claims
   after the contract decisions are recorded.
2. **Safe with a frozen contract snapshot:** pure TypeScript domain validation,
   Convex policy test expansion, connector adapter tests, knowledge tests, and
   scheduler transition tests. These must not rename public concepts.
3. **Keep serial:** identity/tenancy + authority matrix; connector-account to
   Connection migration; thread/project ownership migration; SQLite schema and
   portable import/export changes; routine migration across snapshot and
   scheduler tables.
4. **Wave 0D extraction boundary:** split pure functions and adapters behind
   existing facades first. Avoid concurrent edits to useShellRuntime.ts,
   scheduler.rs, schema.rs, migrations/mod.rs, or portable.rs unless one owner
   coordinates the branch and regression suite.

## Audit limits

This inventory does not claim live provider sessions, deployed broker/Convex
behavior, or external account coverage. It also does not decide the ontology,
identity/tenancy, or authority matrix; those remain Wave 0A ADR decisions. The
absence of a search hit is treated as an implementation-gap signal only where
the named repository surfaces were inspected, not as proof that no related
experimental code exists elsewhere.
