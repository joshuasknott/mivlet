# Fable Master Build Plan

**Status:** Authoritative execution tracker

**Last updated:** 10 July 2026

The [Product Blueprint](vision.md) describes the Fable we are building. This document is the ordered checklist for building it. [Status](status.md) records what is factually implemented now.

## Programme

| Phase | Outcome | State |
|---|---|---|
| 0. Product spine | One ontology, authority model, and shared contract foundation | Complete |
| 1. Essential Fable | Account + provider + durable conversation | In progress |
| 2. Work context | Workspaces, projects, context, memory, and artifacts | Not started |
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

- [ ] Support standalone workspace threads without requiring a project.
- [ ] Persist user, assistant, tool, approval, interruption, and error records correctly.
- [ ] Complete streaming, stop, retry, failure recovery, and continuation.
- [ ] Recover drafts, threads, runs, and pending states after restart.
- [ ] Keep the composer calm and free of optional setup requirements.

### Wave 1C - Provider and first artifact

- [ ] Complete provider add, health, reconnect, revoke, and remove behavior.
- [ ] Complete live model discovery and exact eligible route selection.
- [ ] Explain auth, entitlement, offline, timeout, rate-limit, and provider failures clearly.
- [ ] Turn a useful response into a durable sourced artifact.
- [ ] Test the complete minimum-configuration journey through the real Tauri path.

**Phase 1 complete when:** one account, workspace, and provider can sustain a useful conversation and artifact across restart without any optional layer configured.

## Phase 2 - Workspace, project, context, and artifacts

**Outcome:** Fable sustains a multi-session body of work without losing context, outputs, boundaries, or decisions.

### Wave 2A - Optional projects

- [ ] Complete project create, rename, archive, restore, and delete behavior.
- [ ] Create threads inside projects or assign and remove them later.
- [ ] Add optional project instructions, goals, knowledge, connections, missions, routines, artifacts, and activity.
- [ ] Keep standalone workspace threads first-class.
- [ ] Prove workspace and project scope isolation.

### Wave 2B - Knowledge, memory, and context

- [ ] Complete source ingestion, provenance, trust, freshness, and lifecycle.
- [ ] Filter retrieval by member, workspace, project, department, and Connection before ranking.
- [ ] Complete citations and explain why important context was selected.
- [ ] Complete visible, editable, scoped, exportable, disableable, and forgettable memory.
- [ ] Prevent private member context from entering shared context automatically.

### Wave 2C - Artifact system

- [ ] Add artifact types, versions, lineage, scope, and producing-run links.
- [ ] Preserve sources, citations, inputs, and decisions.
- [ ] Add review, requested changes, acceptance, and approval state.
- [ ] Add artifact search and export.
- [ ] Support explicit cross-context handoff without transferring hidden history or authority.

### Wave 2D - First multi-member slice

- [ ] Complete invitation, acceptance, role, and removal lifecycle.
- [ ] Deliver one useful shared record with realtime updates and offline outbox.
- [ ] Handle idempotency, revisions, conflicts, and tombstones.
- [ ] Attribute shared actions to the internal user and device/session.
- [ ] Prove private and shared boundaries end to end.

**Phase 2 complete when:** standalone and project work, context, memory, versioned artifacts, and the first shared slice remain coherent and isolated across sessions.

## Phase 3 - Universal Connection and MCP fabric

**Outcome:** One semantic capability can use a native Connection, approved MCP server, or clearly explained alternative without changing the mission.

### Wave 3A - Connection and capability control plane

- [ ] Migrate connector-account records and product language to Connection.
- [ ] Implement Connection authorization, health, refresh, degradation, revocation, removal, and recovery.
- [ ] Implement the semantic capability registry and resolver.
- [ ] Implement scoped, consequence-aware capability grants.
- [ ] Prove provider, connector, MCP, credential, and approval boundaries remain separate.

### Wave 3B - OAuth and native reliability

- [ ] Complete durable encrypted one-time OAuth handoff storage.
- [ ] Complete broker deployment configuration and callback policy.
- [ ] Complete multi-account, refresh, revocation, disconnect, and recovery behavior.
- [ ] Complete exact connector approvals and audit.
- [ ] Add connector contract tests for pagination, cancellation, rate limits, scopes, and errors.

### Wave 3C - MCP runtime

- [ ] Implement local STDIO MCP.
- [ ] Implement remote Streamable HTTP MCP.
- [ ] Add explicit authorization including OAuth/PKCE where appropriate.
- [ ] Add trust classification, discovery, and per-tool/resource enablement.
- [ ] Apply Fable capability grants, approvals, budgets, audit, and prompt-injection defenses.

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
