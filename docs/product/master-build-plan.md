# Fable Master Build Plan

**Status:** Authoritative execution tracker

**Last updated:** 10 July 2026

**Purpose:** Turn the [Product Blueprint](vision.md) into an ordered, wave-based task list that Josh can execute at high velocity with the Chief of Staff and parallel Codex worktrees.

The blueprint defines the destination. This plan defines the order of work. [Status](status.md) defines what is factually implemented now.

## 1. How to use this plan

Josh starts work by naming a phase or wave, for example: `Start Phase 0, Wave 0A`.

The operating loop is:

1. **Orient:** inspect the relevant repository, Git state, blueprint, status, ADRs, architecture, schemas, manifests, code, and tests.
2. **Reconcile:** compare the wave with current reality and adjust its task boundaries without changing product direction silently.
3. **Establish shared contracts:** the Chief of Staff handles or serializes shared schemas, migrations, protocols, and central runtime decisions before parallel edits.
4. **Launch the wave:** create only useful independent tasks with non-overlapping ownership.
5. **Monitor:** keep task hierarchy shallow and redirect work when evidence changes.
6. **Integrate sequentially:** review each completed branch, preserve user work, resolve conflicts deliberately, and merge only verified changes.
7. **Verify combined state:** run proportionate cross-package and end-to-end checks after integration.
8. **Close the gate:** update this tracker and `status.md`, clean safely integrated worktrees and branches, and report remaining risks.
9. **Wait:** do not begin the next wave until Josh requests it.

### Execution terms

- **Phase:** a product milestone with an end-to-end exit outcome.
- **Wave:** one parallel execution window inside a phase.
- **Task:** one bounded problem owned by one Codex task or by the Chief of Staff on `main`.
- **Integration gate:** the required review, merge, verification, and documentation checkpoint after a wave.
- **Foundation:** code exists but does not prove the phase's complete user journey.

Tasks within a wave marked **parallel** may run together after their dependencies are satisfied. Tasks marked **serial** own a shared contract, schema, migration, or central runtime and must be integrated before dependent parallel work begins.

## 2. Task contract for every delegated worktree

Every worktree task must state:

- Objective and user-visible outcome.
- Owned files, packages, or bounded subsystem.
- Forbidden overlap, especially shared schemas, migrations, protocols, and central runtimes.
- Dependencies and the exact integrated commit or contract it assumes.
- Definition of done and acceptance criteria.
- Required tests and verification commands.
- Requirement to commit coherent work with a clear message.
- Instruction not to merge, push, deploy, publish, or create external resources itself.

The Chief of Staff retains ownership of product interpretation, shared contracts, cross-task integration, final synthesis, tracker/status updates, and the decision to advance a gate.

## 3. Delivery rules

1. Build one thin useful vertical slice before broadening a catalogue.
2. Keep `main` clean, runnable, and verified at every completed integration gate.
3. Preserve all existing user work; never reset, discard, overwrite, or silently revert it.
4. Never let multiple tasks independently edit the same schema, migration, shared protocol, or central runtime.
5. Prefer parallel work when ownership is clean and integration cost is low.
6. Use local/`main` for shared contracts, integration, small related changes, and final verification.
7. Use worktree tasks for substantial independent edits, not administrative fragmentation.
8. Implement the ready-to-use experience before its advanced editor.
9. Prefer real end-to-end behavior over scaffolding, placeholder UI, connector logos, or speculative abstractions.
10. Test every phase against the minimum product: one Fable account, one workspace, one provider, no project, no business connection, no department, and no routine.
11. A provider or connection is not live merely because fixtures, protocol types, or a gated adapter exist.
12. Update the blueprint only for a genuine product decision; update this plan and `status.md` whenever completed work changes reality.
13. Do not push, deploy, publish, or create external services unless Josh explicitly authorizes it.

## 4. Programme map

### Status vocabulary

- **Proposed:** product idea only.
- **Feasibility confirmed:** the permitted external path and important constraints are known.
- **Contract defined:** Fable's data, authority, context, and execution behavior is decided.
- **Foundation:** code exists without a complete user journey.
- **Functional locally:** the end-to-end local path works.
- **Live validated:** tested through a real provider or service account.
- **Private ready:** dependable, recoverable, and suitable for Josh and invited users.
- **Deferred:** deliberately outside the active private-product programme.

| Phase | Outcome | Depends on | State |
|---|---|---|---|
| 0. Product spine | One coherent ontology, authority model, and shared contract foundation | Current repository | In progress: direction locked; implementation pending |
| 1. Essential Fable | Account + provider + durable conversation works brilliantly | Phase 0 | Not started |
| 2. Work context | Workspaces, optional projects, context, memory, and artifacts sustain real work | Phase 1 | Not started |
| 3. Connection fabric | Native connections and MCP satisfy portable semantic capabilities | Phases 0-2 | Not started |
| 4. Dynamic missions | Fable sizes, plans, routes, and supervises multi-worker work | Phases 0-3 | Not started |
| 5. Embedded routines | Successful work can run later or from events | Phase 4 | Not started |
| 6. Departments | Optional configurable departments provide reusable operating context | Phases 2-5 | Not started |
| 7. Pipelines and breadth | Guided benchmark outcomes work across alternative software stacks | Phases 3-6 | Not started |
| 8. Extended execution | Browser, computer use, mobile supervision, and remote nodes are safe | Phases 3-5 | Not started |
| 9. Voice-native Fable | Dictation, conversation, and deployed voice use the same system | Phases 4, 7, 8 | Not started |
| 10. Private-product quality | Fable is dependable for sustained private use | All required prior phases | Not started |

Phase numbers express dependency order, not a ban on all preparatory research. Read-only feasibility work may run early when it reduces later risk, but implementation cannot bypass the contracts and integration gates it depends on.

### Current foundations to preserve

The following are valuable foundations, not proof that a future phase is complete:

- Tauri/Rust local runtime and encrypted SQLite.
- OS-secure credential separation.
- Provider-neutral backend catalogue and execution paths.
- Codex app-server, ACP, native API, custom endpoint, and Ollama loopback foundations.
- Exact approvals, audit history, knowledge, memory, schedules, workflows, and recovery foundations.
- First-wave connector and OAuth broker foundations.
- Clerk identity and Convex collaboration foundations, while replacing Clerk Organization coupling and optional-account assumptions.
- Existing test coverage and fail-closed behavior.

Preserve these paths until a verified replacement is integrated. Remove superseded implementations only after migration, recovery, and combined regression checks pass.

## 5. Phase 0 - Lock the product spine

**Goal:** The repository has one coherent product model. New work no longer invents its own workspace, execution, connection, artifact, or routine semantics.

### Wave 0A - Product truth and decision inventory

**Can run in parallel after the Chief of Staff freezes document ownership for the wave.**

- [x] **0A.1 - Separate final-state vision from execution tracking.** Create the authoritative Product Blueprint and wave-oriented Master Build Plan.
- [ ] **0A.2 - Record the core ontology ADR.** Cover internal user, workspace, member, thread, project, Connection, provider route, capability, mission, plan, worker, run, artifact, routine, trigger, approval, and execution node.
- [ ] **0A.3 - Record identity and tenancy decisions.** Clerk supplies identity/session; Fable owns users, workspaces, membership, invitations, and authorization; no Clerk Organization tenancy and no separate solo/team workspace types.
- [ ] **0A.4 - Produce the record-authority matrix.** For each core record, state local SQLite authority, Convex authority, cache/outbox behavior, synchronization direction, encryption, deletion, and offline behavior.
- [ ] **0A.5 - Inventory current schemas and contracts against the ontology.** Identify duplicate types, legacy terms, missing workspace scope, implicit project requirements, and TypeScript/Rust drift.
- [ ] **0A.6 - Inventory product and architecture copy.** Classify each contradiction as current-state truth, obsolete direction, or a decision requiring an ADR.
- [ ] **0A.7 - Identify highest-risk oversized modules.** Measure ownership and dependency seams and propose bounded extractions with no behavior change.

#### Gate 0A

- [ ] ADRs and the authority matrix agree with the blueprint.
- [ ] The inventory names every schema/protocol migration required by Waves 0B-0D.
- [ ] Shared-file ownership for the next wave is explicit.
- [ ] `status.md` distinguishes implemented foundations from the desired spine.
- [ ] Relevant documentation checks and link checks pass.

### Wave 0B - Canonical shared contracts

**Serial contract wave. The Chief of Staff owns the canonical shape and integration order. Independent tests or generators may be delegated only after the contract is fixed.**

- [ ] **0B.1 - Define internal identity and workspace membership contracts.** Include stable IDs, roles, invitations, status, creation, switching, and isolation invariants.
- [ ] **0B.2 - Define Connection and provider-route contracts.** Represent native connectors, provider runtimes, local services, and MCP without conflating credentials or capability grants.
- [ ] **0B.3 - Define the semantic capability registry.** Include availability, grant scope, consequence class, approval policy, degradation, human assistance, and blocking reason.
- [ ] **0B.4 - Define mission, plan, worker, run, and run-event contracts.** Preserve a small direct-request path while allowing later dynamic missions.
- [ ] **0B.5 - Define artifact and handoff contracts.** Include versions, sources, producing run, review state, scope, export, and cross-context handoff.
- [ ] **0B.6 - Define routine and trigger contracts.** Treat schedules as triggers and preserve current scheduler behavior through an explicit compatibility path.
- [ ] **0B.7 - Add TypeScript/Rust parity enforcement.** Generate, validate, or contract-test the shared boundary so drift fails CI.
- [ ] **0B.8 - Define migration and compatibility strategy.** Map legacy connector-account, schedule, workflow, project-bound thread, and local profile data to canonical records without data loss.

#### Gate 0B

- [ ] Canonical contracts compile and are covered by contract tests.
- [ ] Existing production paths either use the contracts or have an explicit temporary adapter and removal task.
- [ ] Migrations are reversible or have a tested recovery path.
- [ ] No dependent feature branch carries a private competing contract.

### Wave 0C - Tenancy and authority implementation

**Parallel after Gate 0B where file ownership is clean.**

- [ ] **0C.1 - Internal user and Clerk mapping.** Implement the stable Fable user record and identity-provider mapping without exposing provider identity as the product primary key.
- [ ] **0C.2 - Fable workspace membership and authorization.** Remove Clerk Organization coupling and enforce workspace membership through Fable-owned policy.
- [ ] **0C.3 - Local workspace authority.** Apply workspace scoping and isolation to authoritative local records and repository boundaries.
- [ ] **0C.4 - Convex shared authority alignment.** Reconcile schema, policies, outbox, cursor, device, and tombstone foundations with the authority matrix.
- [ ] **0C.5 - Legacy data migration.** Migrate existing local profile/workspace records and prove idempotency, rollback/recovery, and hard isolation.
- [ ] **0C.6 - Product terminology alignment.** Replace Personal Home, Team Workspace, Organization tenancy, automation-first, and connector-account language where they conflict with the blueprint.

#### Gate 0C

- [ ] Authorization tests prove cross-workspace reads and writes fail closed.
- [ ] Existing local data migrates without silent loss.
- [ ] Clerk identity, provider credentials, connector credentials, and approval authority remain separate.
- [ ] Current-state product copy is truthful.

### Wave 0D - Structural risk reduction

**Parallel extractions with non-overlapping module ownership. Behavior must remain unchanged.**

- [ ] **0D.1 - Split the highest-risk React application/shell module.** Extract bounded navigation, workspace, composer, or domain state ownership based on the 0A inventory.
- [ ] **0D.2 - Split the highest-risk shell runtime hook/module.** Separate orchestration from domain-specific adapters without introducing a second state path.
- [ ] **0D.3 - Split the highest-risk Rust runtime module.** Extract bounded command/domain modules while preserving the native trust boundary.
- [ ] **0D.4 - Focus protocol and domain package exports.** Remove accidental central-file coupling and establish stable import boundaries.
- [ ] **0D.5 - Add regression characterization.** Cover the behavior being moved before or alongside each extraction.

#### Phase 0 exit gate

- [ ] One ontology and authority matrix govern TypeScript, Rust, SQLite, Convex, and product copy.
- [ ] Clerk Organizations are not required for Fable tenancy.
- [ ] Shared Connection, capability, mission/run, artifact, and routine contracts exist and are parity-checked.
- [ ] Highest-risk modules have bounded ownership seams for later parallel work.
- [ ] The minimum existing product still runs.
- [ ] Relevant typechecks, unit/integration tests, desktop build, Tauri check, Rust tests, clippy, and formatting pass on combined `main`.
- [ ] No required work is stranded in an unmerged worktree.
- [ ] Blueprint, this tracker, ADRs, architecture, and status agree.

## 6. Phase 1 - Fable works brilliantly with an account and provider

**Goal:** A user signs in, receives a workspace, connects one provider, completes useful work, closes Fable, returns, and continues without configuring anything else.

### Wave 1A - Account and initial workspace

**Parallel:** identity lifecycle, workspace bootstrap, and UI shell may run separately after their shared contracts are integrated.

- [ ] **1A.1 - Production Clerk configuration and claim validation.** Define supported configuration, callback policy, server-side/session validation, and fail-closed release behavior.
- [ ] **1A.2 - Complete account lifecycle.** Sign-in gating, onboarding, sign-out, expiry, recovery, and device/session revocation.
- [ ] **1A.3 - Automatic initial workspace.** Idempotently create and select a Fable workspace for a new internal user.
- [ ] **1A.4 - Multiple workspace switching.** Switch without data bleed and recover the last valid workspace.
- [ ] **1A.5 - Calm minimum onboarding.** Require only account and provider; explain optional configuration without demanding it.

#### Gate 1A

- [ ] New, returning, expired, signed-out, recovered, and revoked account journeys are tested.
- [ ] Initial workspace creation is idempotent and hard-isolated.
- [ ] Missing identity configuration fails closed in production and stays testable locally.

### Wave 1B - Durable conversation core

**Parallel:** thread persistence/runtime, streaming controls, and shell experience can be isolated behind the thread/run contracts.

- [ ] **1B.1 - Standalone workspace threads.** Create, title, list, open, archive, and recover threads without a project.
- [ ] **1B.2 - Durable message model.** Persist user, assistant, tool, error, approval, and interruption records under the correct workspace/thread/run.
- [ ] **1B.3 - Streaming lifecycle.** Deliver send, incremental output, stop, retry, failure recovery, and continuation without duplicated side effects.
- [ ] **1B.4 - Restart recovery.** Close and reopen Fable during idle, streaming, approval, interruption, and completed states.
- [ ] **1B.5 - Minimum composer polish.** Keep project, department, connector, and orchestration setup out of the critical path.

#### Gate 1B

- [ ] The complete new-chat-to-restart journey passes through the real Tauri path.
- [ ] Stop and retry semantics are explicit and do not replay prior tool effects.
- [ ] Browser preview remains labelled and cannot be mistaken for production persistence.

### Wave 1C - Provider connection and first artifacts

**Parallel:** provider health/discovery, error experience, and artifact creation can run separately after shared contracts.

- [ ] **1C.1 - Provider connection lifecycle.** Add, validate, inspect health, reconnect, revoke, and remove an allowed provider route.
- [ ] **1C.2 - Exact model discovery and selection.** Show only eligible generation models and preserve the chosen route accurately.
- [ ] **1C.3 - Understandable provider recovery.** Distinguish missing configuration, auth, entitlement, offline, timeout, rate limit, provider error, and unsupported capability.
- [ ] **1C.4 - Artifact from conversation.** Turn a useful response into a durable sourced artifact with a producing run and stable reopen path.
- [ ] **1C.5 - Minimum-configuration end-to-end test.** One account, one workspace, one provider, one conversation, one artifact, restart, and continuation.

#### Phase 1 exit gate

- [ ] The minimum journey works end to end with no optional layer configured.
- [ ] Identity and provider trust boundaries remain separate.
- [ ] Conversation, run, and artifact state survive restart and recover honestly.
- [ ] Relevant combined checks pass and docs/status are updated.

## 7. Phase 2 - Workspace, project, context, and artifact spine

**Goal:** Fable sustains a multi-session body of work without losing its context, outputs, boundaries, or decisions.

### Wave 2A - Optional projects and workspace activity

- [ ] **2A.1 - Project lifecycle.** Create, rename, archive, restore, and delete an optional project within one workspace.
- [ ] **2A.2 - Thread assignment.** Create a thread inside a project or assign/remove it later without rewriting its identity.
- [ ] **2A.3 - Project context surfaces.** Expose instructions, goals, knowledge, connections, missions, routines, artifacts, and activity as optional sections.
- [ ] **2A.4 - Workspace/project navigation.** Keep standalone threads first-class and avoid forcing a project selection.
- [ ] **2A.5 - Scope isolation tests.** Prove workspace and project filters apply before retrieval and execution.

#### Gate 2A

- [ ] Standalone and project-bound threads coexist cleanly.
- [ ] Project deletion/archive behavior is explicit for contained records.
- [ ] Navigation remains minimalist at minimum configuration.

### Wave 2B - Knowledge, memory, and context assembly

**Parallel:** ingestion/retrieval, memory controls, and context explanation may run separately against one scope contract.

- [ ] **2B.1 - Complete knowledge ingestion.** Preserve source provenance, trust, freshness, lifecycle, and connector authorization.
- [ ] **2B.2 - Complete access-filtered retrieval.** Apply member/workspace/project/department/connection boundaries before ranking.
- [ ] **2B.3 - Complete citations and context explanation.** Show which sources were used and why they were selected.
- [ ] **2B.4 - Complete scoped memory.** Visible, editable, deliberate, exportable, disableable, and forgettable with no automatic private-to-shared promotion.
- [ ] **2B.5 - Context assembly contract.** Bound prompt context consistently across direct requests and runs.

#### Gate 2B

- [ ] Retrieval tests prove no cross-scope leakage.
- [ ] Deleted, disabled, stale, disconnected, and unauthorized sources fail closed.
- [ ] Context explanations match the material actually sent.

### Wave 2C - Artifact system

**Parallel:** storage/versioning, review/export, and search/handoff can use separate ownership.

- [ ] **2C.1 - Artifact types and versions.** Persist type, content/locator, producing run, version lineage, scope, and status.
- [ ] **2C.2 - Sources and provenance.** Link artifacts to inputs, citations, decisions, and producing runs.
- [ ] **2C.3 - Review and approval.** Support review state, requested changes, acceptance, and exact approval where publication or side effects follow.
- [ ] **2C.4 - Export and search.** Find and export artifacts without losing provenance.
- [ ] **2C.5 - Explicit handoff.** Move an artifact between allowed contexts without transferring hidden history or authority.

### Wave 2D - First multi-member slice

**Starts only after solo work is stable through Gates 2A-2C.**

- [ ] **2D.1 - Workspace invitation and membership lifecycle.** Invite, accept, list, change permitted role, and remove.
- [ ] **2D.2 - One shared record vertical slice.** Deliver realtime updates, offline outbox, idempotency, revisions, conflicts, and tombstones for one useful record type.
- [ ] **2D.3 - Member/private boundary.** Prove private member context never syncs or enters shared retrieval automatically.
- [ ] **2D.4 - Device and session attribution.** Attribute writes, approvals, and conflicts to internal user and device/session.

#### Phase 2 exit gate

- [ ] The durable-body-of-work journey passes across multiple sessions.
- [ ] Workspace, project, member, and private/shared boundaries are tested end to end.
- [ ] Artifact versioning, review, export, search, and handoff work.
- [ ] The multi-member slice does not weaken solo reliability.
- [ ] Combined checks pass and docs/status are updated.

## 8. Phase 3 - Universal Connection and MCP fabric

**Goal:** The same requested capability can be satisfied by a native connection, an approved MCP server, or a clearly explained alternative without changing the mission.

### Wave 3A - Connection and capability control plane

**Serial shared-contract wave.**

- [ ] **3A.1 - Migrate connector-account records to Connection.** Preserve clear connected-account labels inside provider-specific detail.
- [ ] **3A.2 - Implement Connection lifecycle.** Create, authorize, inspect, refresh, degrade, revoke, remove, and recover.
- [ ] **3A.3 - Implement capability registry and resolver.** Resolve semantic capability requests against permitted connections and alternatives.
- [ ] **3A.4 - Implement capability grants.** Workspace, project, department, pipeline, mission, and member scope with consequence-specific authority.
- [ ] **3A.5 - Connection health and truth states.** Available, approval-gated, degraded, human-assisted, blocked, expired, revoked, offline, and provider error.
- [ ] **3A.6 - Credential-boundary tests.** Ensure tokens and provider-owned sessions cannot cross into product state or bypass authorization.

#### Gate 3A

- [ ] Native providers, native business connectors, local runtimes, and future MCP fit one base contract without erasing their differences.
- [ ] Capability resolution is deterministic, inspectable, and policy-aware.
- [ ] Missing connections degrade gracefully.

### Wave 3B - OAuth broker and native connection reliability

**Parallel by provider family after shared lifecycle is integrated.**

- [ ] **3B.1 - Durable atomic OAuth handoff storage.** Complete encryption, expiry, one-time redemption, replay protection, and recovery.
- [ ] **3B.2 - Broker deployment contract.** Bindings, environment validation, callback registration, observability, and fail-closed configuration.
- [ ] **3B.3 - Multi-account and active-account behavior.** Preserve explicit ownership and capability mapping.
- [ ] **3B.4 - Refresh, revocation, disconnect, and recovery.** Normalize provider-specific lifecycle without hiding provider truth.
- [ ] **3B.5 - Connector audit and exact approvals.** Revalidate service, account, action, payload preview, scope, and permit at execution.
- [ ] **3B.6 - Native connector contract tests.** Cover pagination, cancellation, rates, errors, scopes, and truthful degraded modes.

### Wave 3C - MCP runtime

**Parallel transports with one shared security and capability layer.**

- [ ] **3C.1 - Local STDIO MCP transport.** Allowlisted process boundary, lifecycle, discovery, cancellation, and bounded output.
- [ ] **3C.2 - Remote Streamable HTTP transport.** TLS, origin/endpoint policy, session lifecycle, cancellation, and bounded output.
- [ ] **3C.3 - MCP authorization.** OAuth/PKCE and other explicit methods without token passthrough into model context.
- [ ] **3C.4 - Trust classification and discovery.** First-party, reviewed, and unknown servers; tools/resources are discovered but not auto-enabled.
- [ ] **3C.5 - Per-scope enablement.** Workspace, project, department, pipeline, and mission tool/resource grants.
- [ ] **3C.6 - MCP approvals and injection defenses.** Treat descriptions, content, resources, and tool output as untrusted.
- [ ] **3C.7 - Map MCP tools/resources to capabilities.** Preserve exact server/tool identity for audit and approval.

#### Gate 3C

- [ ] Local and remote MCP paths pass the same capability, approval, budget, audit, and data-routing rules as native connections.
- [ ] Unknown tools cannot become enabled or execute implicitly.
- [ ] Cancellation and transport failure recover cleanly.

### Wave 3D - First live capability substitution

- [ ] **3D.1 - Select one real daily-core outcome.** Choose based on Josh's use and permitted test credentials, not logo breadth.
- [ ] **3D.2 - Validate its native Connection path live.** Record provider configuration, scopes, limitations, and evidence.
- [ ] **3D.3 - Validate an approved MCP or alternative path.** Use the same semantic capability and mission input.
- [ ] **3D.4 - Deliver contextual missing-connection UX.** Explain what is unavailable and what connecting an option would unlock.
- [ ] **3D.5 - Add live canary and truthful fallback behavior.** Never substitute fixtures in production.

#### Phase 3 exit gate

- [ ] One semantic capability works through two permitted implementations without changing mission semantics.
- [ ] OAuth and MCP trust boundaries pass security review.
- [ ] Live validation evidence is recorded honestly.
- [ ] Combined checks pass and docs/status are updated.

## 9. Phase 4 - Dynamic missions and smart model routing

**Goal:** One natural-language request becomes an appropriately sized, inspectable mission using the best permitted workers and providers without requiring the user to construct a graph.

### Wave 4A - Mission engine contract and local driver

**Serial shared-runtime wave.**

- [ ] **4A.1 - Mission creation and sizing.** Resolve direct response, delegated mission, or multi-worker mission from request, risk, and complexity.
- [ ] **4A.2 - Generated plan lifecycle.** Draft, inspect, approve when required, revise, execute, pause, resume, cancel, and complete.
- [ ] **4A.3 - Worker task and handoff contract.** Bounded inputs, context, tools, budget, output, evidence, and artifact handoff.
- [ ] **4A.4 - Run events and checkpoints.** Durable, ordered, inspectable events with restart recovery and idempotency.
- [ ] **4A.5 - Local execution driver.** Direct and worker runs use one portable driver boundary.
- [ ] **4A.6 - Evaluation and completion.** Acceptance criteria, reviewer result, human input, failure, and partial outcome.

#### Gate 4A

- [ ] A one-worker mission runs end to end and survives restart.
- [ ] Direct chat remains lightweight and compatible.
- [ ] Mission state is provider-neutral and execution-node-neutral.

### Wave 4B - Routing, commands, and user experience

**Parallel behind the mission contract.**

- [ ] **4B.1 - Provider/model route scorer.** Capability, quality, cost, speed, privacy, context, tool support, health, preference, and risk.
- [ ] **4B.2 - Constraint and fallback policy.** Pin/exclude providers; never cross privacy, billing, execution, or provider boundaries silently.
- [ ] **4B.3 - Compact receipts and plans.** No process theatre for small work; concise visibility for medium work; inspectable control for consequential work.
- [ ] **4B.4 - Native commands.** Implement `/goal`, `/plan`, `/schedule`, `/remember`, and `/stop` before provider execution with natural-language parity.
- [ ] **4B.5 - Visible routing explanation.** Explain significant route choices and fallback without exposing internal clutter by default.
- [ ] **4B.6 - Budget controls.** Time, token/cost, iteration, worker-count, and provider constraints.

### Wave 4C - Multi-worker coordination and recovery

- [ ] **4C.1 - Parallel workers and joins.** Bounded concurrency, independent ownership, deterministic aggregation, and cancellation.
- [ ] **4C.2 - Reviewers and judges.** Add dynamically from risk and quality requirements, not as a permanent graph.
- [ ] **4C.3 - Bounded iteration.** Explicit stop conditions, budget enforcement, and no unbounded self-improvement loops.
- [ ] **4C.4 - Human input and approval waits.** Pause durably without holding unsafe resources or broadening authority.
- [ ] **4C.5 - Retry, resume, and escalation.** Preserve completed side effects and avoid duplicate execution.
- [ ] **4C.6 - Cross-project/department artifact handoff foundation.** Pass only explicit context, artifacts, and grants.

#### Phase 4 exit gate

- [ ] Direct, delegated, and multi-worker requests are selected automatically and tested.
- [ ] A multi-provider mission completes with inspectable routing, approvals, artifacts, and recovery.
- [ ] Budgets and cancellation work under concurrency and restart.
- [ ] The normal UI never requires graph construction.
- [ ] Combined checks pass and docs/status are updated.

## 10. Phase 5 - Embedded routines and event-driven work

**Goal:** Any successful work can be repeated or triggered later without becoming a separate automation product.

### Wave 5A - Routine migration and contextual creation

- [ ] **5A.1 - Migrate schedules/workflows to routines and triggers.** Preserve existing data and execution history.
- [ ] **5A.2 - Contextual ownership.** Attach routines to workspaces, projects, departments, goals, threads, pipelines, and connection events.
- [ ] **5A.3 - Conversational creation/editing.** Natural language, `/schedule`, and “run this again” actions compile to the same routine contract.
- [ ] **5A.4 - Runtime route resolution.** Resolve providers/models at execution within saved policy unless deliberately pinned.
- [ ] **5A.5 - Remove Schedules as mandatory primary navigation.** Surface upcoming work where it belongs plus compact workspace activity.

#### Gate 5A

- [ ] Existing schedules migrate idempotently and remain controllable.
- [ ] A completed request can become a routine in one contextual flow.
- [ ] Automatic execution has no broader authority than manual execution.

### Wave 5B - Trigger and reliability breadth

**Parallel by trigger driver after shared routine lifecycle.**

- [ ] **5B.1 - One-time and recurring time triggers.** Time zone, daylight-saving, missed occurrence, lease, and duplicate prevention.
- [ ] **5B.2 - Webhook and connector-event triggers.** Signed ingestion, deduplication, scope resolution, and untrusted payload handling.
- [ ] **5B.3 - Threshold, monitoring, and follow-up triggers.** Bounded polling/event policy and clear stop conditions.
- [ ] **5B.4 - Pause, resume, retry, and run history.** Inspectable lifecycle and failure recovery.
- [ ] **5B.5 - Notifications.** Actionable, scoped, deduplicated, and respectful of private content.

### Wave 5C - Portable always-on execution

**Serial driver contract, then parallel implementation and hardening.**

- [ ] **5C.1 - Define hosted-run driver.** Preserve Fable mission/routine contracts across local and hosted execution.
- [ ] **5C.2 - Deliver the smallest dependable hosted path.** Use the simplest appropriate Convex-backed coordination.
- [ ] **5C.3 - Execution placement controls.** Record and enforce data, credential, provider, and destination boundaries.
- [ ] **5C.4 - Offline desktop handoff.** Queue or block work honestly when local authority or credentials are unavailable.
- [ ] **5C.5 - Hosted recovery and observability.** Durable status, retry, cancellation, and audit without vendor ontology leakage.

#### Phase 5 exit gate

- [ ] Time, event, and follow-up routines execute with correct authority and history.
- [ ] One always-on routine survives client disconnect and recovers visibly.
- [ ] Local-only work never moves to hosted execution implicitly.
- [ ] Combined checks pass and docs/status are updated.

## 11. Phase 6 - Configurable departments

**Goal:** A user enables and adapts a department in minutes, then invokes it naturally without seeing or maintaining an agent graph.

### Wave 6A - Department contract and default experience

**Serial shared contract, then parallel library/experience work.**

- [ ] **6A.1 - Department domain contract.** Charter, boundaries, context, connections, capabilities, authority, quality, routines, pipelines, history, and advanced policy.
- [ ] **6A.2 - Department scope resolution.** Natural language and `@Department` add context without bypassing member/workspace/project policy.
- [ ] **6A.3 - Ready-made department activation.** Enable a default and ask for work immediately.
- [ ] **6A.4 - Simple department surface.** Purpose, Access, Ways of working, When to ask, and Quality.
- [ ] **6A.5 - Conversational configuration.** Describe changes, review Fable's proposal, and apply safely.
- [ ] **6A.6 - Lifecycle.** Create, rename, duplicate, disable, and remove without destabilizing work or history.

### Wave 6B - Initial department library

**Parallel with one owned department per task and one shared preset schema.**

- [ ] **6B.1 - Product department.** Charter, suggestions, standards, representative prompts, routines, and pipeline candidates.
- [ ] **6B.2 - Marketing department.** Charter, suggestions, standards, representative prompts, routines, and pipeline candidates.
- [ ] **6B.3 - Sales department.** Charter, suggestions, standards, representative prompts, routines, and pipeline candidates.
- [ ] **6B.4 - Customer department.** Charter, suggestions, standards, representative prompts, routines, and pipeline candidates.
- [ ] **6B.5 - Cross-department quality review.** Remove rigid org-chart assumptions and ensure defaults remain useful without all recommended connections.

### Wave 6C - Cross-department work and advanced controls

- [ ] **6C.1 - Cross-department missions.** Fable plans collaboration dynamically and passes explicit artifacts/context.
- [ ] **6C.2 - Artifact-based handoffs.** Review, accept, request changes, and preserve source authority.
- [ ] **6C.3 - Optional advanced controls.** Worker roles, provider policy, capability grants, budgets, evaluation, and execution placement.
- [ ] **6C.4 - Department activity.** Active missions, approvals, artifacts, routines, and history without turning the page into a dashboard.

### Wave 6D - Finance and Legal

**Starts only after evidence, approval, and professional-review boundaries are proven.**

- [ ] **6D.1 - Finance risk and evidence contract.** Financial data scope, irreversible actions, audit, review, and professional boundaries.
- [ ] **6D.2 - Legal risk and evidence contract.** Jurisdiction, source licensing, privilege/confidentiality, review, and non-advice boundaries.
- [ ] **6D.3 - Finance department preset.** Useful safe defaults and representative outcomes.
- [ ] **6D.4 - Legal department preset.** Useful safe defaults and representative outcomes.

#### Phase 6 exit gate

- [ ] Product, Marketing, Sales, and Customer work from defaults and conversational customization.
- [ ] Cross-department missions pass explicit artifacts without context or authority leakage.
- [ ] Advanced controls remain optional.
- [ ] Finance and Legal ship only if their additional gates pass.
- [ ] Combined checks pass and docs/status are updated.

## 12. Phase 7 - Benchmark pipelines and connector breadth

**Goal:** Fable completes genuine multi-stage outcomes across alternative software stacks while remaining simple to configure.

### Wave 7A - Pipeline contract and first representative journey

**Serial shared contract.**

- [ ] **7A.1 - Pipeline definition.** Required inputs/connections, stages, decisions, outputs, approvals, quality bars, recovery, and escalation.
- [ ] **7A.2 - Pipeline run on dynamic missions.** Pipeline boundaries constrain outcomes without freezing worker graphs.
- [ ] **7A.3 - Guided setup contract.** Strong default, conversational customization, concise summary, optional expert control.
- [ ] **7A.4 - Choose and deliver one representative pipeline.** Select the highest-value current Josh journey and complete it end to end.
- [ ] **7A.5 - Outcome measurement.** Accepted artifact, completion, corrections, cost/time, and failure reasons.

#### Gate 7A

- [ ] One pipeline works end to end with a real quality bar and recovery path.
- [ ] Missing optional connections degrade; genuine requirements explain why they block.
- [ ] Worker composition remains dynamic.

### Wave 7B - Department pipeline wave

**Parallel with one owned pipeline per task after the shared contract is stable.**

- [ ] **7B.1 - Product representative pipeline.**
- [ ] **7B.2 - Marketing representative pipeline.**
- [ ] **7B.3 - Sales representative pipeline.**
- [ ] **7B.4 - Customer representative pipeline.**
- [ ] **7B.5 - Finance representative pipeline, if Phase 6D shipped.**
- [ ] **7B.6 - Legal representative pipeline, if Phase 6D shipped.**
- [ ] **7B.7 - Cross-pipeline consistency and accessibility review.**

### Wave 7C - Voice Agent Builder benchmark

- [ ] **7C.1 - Minimal agent definition and conversational customization.**
- [ ] **7C.2 - Knowledge and connection-backed tools.**
- [ ] **7C.3 - Realistic simulation and evaluation.**
- [ ] **7C.4 - Test calls and human handoff design.**
- [ ] **7C.5 - Deployment/version/rollback contract.**
- [ ] **7C.6 - Consent, disclosure, recording, retention, identity, cost, monitoring, and kill-switch controls.**

### Wave 7D - Capability-driven connector expansion

**Parallel by provider family only when each task unlocks an accepted pipeline outcome.**

- [ ] **7D.1 - Rank missing capabilities from benchmark pipelines.** Do not rank by connector logo count.
- [ ] **7D.2 - Feasibility review each selected connector.** Official access, auth, scopes, events, limits, plans, terms, placement, approval, and live-test path.
- [ ] **7D.3 - Implement selected daily-core connectors by non-overlapping provider family.**
- [ ] **7D.4 - Add contract tests and live canaries.**
- [ ] **7D.5 - Prove capability substitution and truthful degraded behavior.**
- [ ] **7D.6 - Add later-wave connectors only when a real pipeline requires them.**

#### Phase 7 exit gate

- [ ] Representative department pipelines and the Voice Agent Builder meet their agreed slice quality bars.
- [ ] Several real outcomes work across alternative software stacks.
- [ ] Connector claims have live evidence or are explicitly gated/foundation-only.
- [ ] Outcome metrics replace catalogue-size success measures.
- [ ] Combined checks pass and docs/status are updated.

## 13. Phase 8 - Browser, computer use, mobile companion, and remote execution

**Goal:** Fable can use permitted websites and desktop applications and can be supervised from mobile without weakening Connection, approval, or workspace boundaries.

### Wave 8A - Shared remote-execution safety contracts

**Serial security and protocol wave.**

- [ ] **8A.1 - Execution-node identity and attestation.**
- [ ] **8A.2 - Remote run/event/approval protocol.**
- [ ] **8A.3 - Data and credential routing policy.**
- [ ] **8A.4 - Session isolation, takeover, emergency stop, and revocation.**
- [ ] **8A.5 - Prompt-injection threat model and trust boundaries.**
- [ ] **8A.6 - Audit, recording, screenshot, and retention policy.**

#### Gate 8A

- [ ] Threat model and contracts are accepted before browser, computer, or mobile execution broadens.
- [ ] Local-only credentials and data cannot be routed remotely by default.

### Wave 8B - Browser and Windows computer use

**Parallel transports sharing one policy/approval layer.**

- [ ] **8B.1 - Isolated browser sessions.** Domain/action boundaries, visible state, downloads, trace, and teardown.
- [ ] **8B.2 - Browser inspection and action runtime.** Structural/visual inspection, bounded actions, exact approval, and takeover.
- [ ] **8B.3 - Browser injection defenses.** Untrusted-page handling, instruction separation, secret protection, and blocked exfiltration.
- [ ] **8B.4 - Windows accessibility-first control.** Application allowlists, semantic control, visual fallback, protected fields, and emergency stop.
- [ ] **8B.5 - Recovery and replay safety.** No duplicate consequential action after interruption.

### Wave 8C - Mobile companion and secure relay

**Parallel app/relay/notification tasks after 8A.**

- [ ] **8C.1 - TanStack Router desktop migration.** Establish shared route/domain boundaries without changing product behavior.
- [ ] **8C.2 - TanStack Start mobile-first companion shell.** Shared domain/UI packages where appropriate.
- [ ] **8C.3 - Clerk sign-in and QR pairing.** Device trust, expiry, revocation, and account/workspace binding.
- [ ] **8C.4 - Secure presence and relay.** Bounded Cloudflare Worker/Durable Object roles with end-to-end authorization.
- [ ] **8C.5 - Mobile conversations and run status.**
- [ ] **8C.6 - Mobile approvals, artifacts, routine controls, and notifications.**
- [ ] **8C.7 - Host selection and offline behavior.** No implied remote execution authority.

### Wave 8D - Managed execution assets

- [ ] **8D.1 - R2 artifact/media boundary.** Signed access, workspace scope, retention, deletion, and local cache.
- [ ] **8D.2 - Managed browser execution driver.** Only where selected and policy permits.
- [ ] **8D.3 - Remote-node observability and cost controls.**
- [ ] **8D.4 - End-to-end revocation and emergency shutdown.**

#### Phase 8 exit gate

- [ ] Browser and computer actions remain visible, bounded, approval-aware, and recoverable.
- [ ] Mobile can direct and supervise eligible work without becoming a remote desktop mirror.
- [ ] Local data and credentials remain local unless explicit policy permits otherwise.
- [ ] Security review and combined checks pass; docs/status are updated.

## 14. Phase 9 - Voice-native Fable

**Goal:** Voice is a natural interface to the same Fable system, and the deployed Voice Agent Builder meets the reference quality expected of future pipelines.

### Wave 9A - Excellent dictation

- [ ] **9A.1 - Native/provider-neutral audio capture boundary.** Permissions, device selection, cancellation, and privacy.
- [ ] **9A.2 - Streaming transcription and editable draft.** Partial/final text, correction, punctuation, and composer integration.
- [ ] **9A.3 - Quality fallback.** Provider failure, offline/unavailable behavior, accents, noise, and long dictation.
- [ ] **9A.4 - Retention and deletion controls.** Audio is not retained implicitly.
- [ ] **9A.5 - Accessibility and keyboard/push-to-talk behavior.**

### Wave 9B - Conversational voice

**Parallel routing/media and experience work behind one voice-session contract.**

- [ ] **9B.1 - Voice-session contract.** Transcript, interruption, turn state, tools, artifacts, approvals, and handoff to missions.
- [ ] **9B.2 - Provider-neutral route policy.** Realtime speech-to-speech versus chained recognition/orchestration/speech.
- [ ] **9B.3 - Interruption and latency behavior.** Barge-in, cancellation, recovery, and no duplicate side effects.
- [ ] **9B.4 - Visual companion experience.** Transcript, active work, sources, artifacts, tools, and approvals remain visible.
- [ ] **9B.5 - Quality/cost benchmark.** Providers, accents, noise, interruption, long sessions, latency, and cost.

### Wave 9C - Complete deployed voice-agent journey

- [ ] **9C.1 - Telephony/SIP provider boundary.**
- [ ] **9C.2 - Test call, simulation, and evaluation journey.**
- [ ] **9C.3 - Human transfer and escalation.**
- [ ] **9C.4 - Deployment, monitoring, versioning, rollback, and kill switch.**
- [ ] **9C.5 - Disclosure, consent, recording, retention, and identity verification.**
- [ ] **9C.6 - Cost limits and incident recovery.**

#### Phase 9 exit gate

- [ ] Dictation is excellent enough for ordinary use and fails gracefully.
- [ ] Conversational voice delegates through normal missions and approvals.
- [ ] Visual truth remains available while speaking.
- [ ] The deployed voice-agent pipeline passes consent, handoff, monitoring, rollback, and kill-switch tests.
- [ ] Combined checks pass and docs/status are updated.

## 15. Phase 10 - Private-product quality

**Goal:** Fable is trustworthy, recoverable, observable, accessible, and pleasant for sustained use by Josh and invited users.

### Wave 10A - Data durability and recovery

**Parallel by bounded subsystem after one recovery contract is agreed.**

- [ ] **10A.1 - Backup and restore.** Database, artifacts, configuration, and required key material with safe user guidance.
- [ ] **10A.2 - Migration recovery.** Interrupted, failed, rolled-back, and forward-only cases.
- [ ] **10A.3 - Crash and run recovery.** Desktop, mission, routine, browser, and hosted execution.
- [ ] **10A.4 - Export and deletion.** Account, workspace, local data, shared data, artifacts, and provider/connection records.
- [ ] **10A.5 - Credential and device revocation.** Identity, providers, connectors, MCP, desktop/mobile devices, and hosted nodes.

### Wave 10B - Security and operational controls

**Parallel threat-model reviews by boundary, integrated through one risk register.**

- [ ] **10B.1 - Identity and workspace authorization review.**
- [ ] **10B.2 - Connection, OAuth, MCP, and capability review.**
- [ ] **10B.3 - Mission, approval, routine, and hosted-execution review.**
- [ ] **10B.4 - Browser, computer use, mobile, and voice review.**
- [ ] **10B.5 - Diagnostics and health.** Provider, connector, node, run, queue, storage, and sync state.
- [ ] **10B.6 - Cost visibility and emergency controls.** Budgets, cancellation, kill switches, and incident audit.

### Wave 10C - Product quality

**Parallel UX reviews with bounded surface ownership.**

- [ ] **10C.1 - Accessibility.** Keyboard, screen reader, contrast, focus, motion, captions, and voice alternatives.
- [ ] **10C.2 - Responsive and mobile quality.**
- [ ] **10C.3 - Onboarding and contextual help.** Keep the minimum journey short and optional depth discoverable.
- [ ] **10C.4 - Remove misleading states and dead ends.** Fixtures, stale “coming soon”, duplicate paths, and unsupported claims.
- [ ] **10C.5 - Performance and resource budgets.** Startup, memory, storage, retrieval, streaming, and long-running work.
- [ ] **10C.6 - End-to-end private-user regression suite.** Cover all accepted success journeys from the blueprint.

### Wave 10D - Windows private distribution

- [ ] **10D.1 - Dependable Windows build and signing decision.**
- [ ] **10D.2 - Installer, update, rollback, and release-note path for invited users.**
- [ ] **10D.3 - Configuration and secret provisioning runbook.**
- [ ] **10D.4 - Support and incident-recovery runbook.**
- [ ] **10D.5 - Private release candidate soak with Josh's real workflows.**

#### Phase 10 exit gate

- [ ] Every agreed blueprint success journey passes on combined `main`.
- [ ] Backup/restore, migration, crash recovery, export/deletion, and revocation are proven.
- [ ] Critical and high security findings are resolved or explicitly accepted by Josh.
- [ ] Accessibility, performance, diagnostics, and emergency controls meet agreed bars.
- [ ] A dependable Windows private build is usable by Josh and invited users.
- [ ] No required implementation is stranded in a worktree.
- [ ] Blueprint, tracker, ADRs, architecture, status, and product copy agree.

## 16. Deferred programme

The following do not enter the active task list without a new Josh decision:

- Public release.
- Open-source licensing and contribution model.
- Marketplace or third-party commercial distribution.
- Enterprise organization hierarchy, SSO, SCIM, central administration, and compliance packaging.
- macOS/Linux distribution and app-store delivery.
- A parent Organization above workspaces.

## 17. Section completion record

When a wave or phase closes, add or update a short record here rather than relying on chat history.

| Section | Integrated commit | Verification | Status/docs updated | Remaining risk |
|---|---|---|---|---|
| Blueprint/tracker split | Pending commit | Documentation review pending | 10 July 2026 | Existing supporting docs still require Phase 0 reconciliation |

The authoritative checkbox state must match integrated repository reality. Work in an unmerged worktree does not count as complete.
