# ADR: Canonical Product Ontology

Date: 2026-07-10

Status: Accepted

## Context

Fable has working foundations for projects, project-bound threads, agent runs,
goals, plans, connectors, backend providers, approvals, knowledge, memory,
schedules, workflows, departments, pipelines, local workspaces, and an optional
cloud/team path. Those foundations were built at different times and do not yet
express one coherent product model. In particular, current contracts and storage
contain several assumptions that are not the approved final state: projects are
required by some thread paths, schedules and workflows appear as top-level
concepts, external accounts and runtimes use several unrelated record families,
and earlier cloud documents distinguish solo and shared workspace modes.

The [Product Blueprint](../product/vision.md) is authoritative for the final
state. The [Master Build Plan](../product/master-build-plan.md) sequences the
work needed to reach it. This ADR makes the blueprint's ontology durable and
precise enough to guide later protocol, schema, product-copy, and migration work.
It does not assign records to SQLite or Convex and does not define identity
provider, membership-role, invitation, or authorization mechanics; those belong
to the separate record-authority and identity/tenancy decisions in Wave 0A.

## Decision

Fable will use the ontology in this ADR as its canonical product language and
relationship model.

The model has one hard tenancy and isolation root: the **workspace**. Projects,
departments, and other contexts refine work inside a workspace but never create
another tenancy boundary. A workspace uses the same model whether it currently
has one member or many. There is no separate Personal Home, Team Workspace, or
Fable Organization product type.

Ordinary conversation does not require a project, mission, department,
pipeline, or routine. A thread may stand alone in a workspace. The Fable
orchestrator sizes each request dynamically: it may answer directly, create a
mission, generate and revise a plan, and assemble run-scoped workers. Departments
are optional operating contexts, not fixed agent teams. Pipelines constrain a
guided outcome without freezing the worker graph. Routines represent deferred,
recurring, monitored, or event-driven work; schedules are time-based triggers of
routines, not a separate top-level product.

All external accounts, services, model runtimes, and MCP servers available to a
workspace are represented as **Connections**. A **connector** describes a
supported integration; it is not the authorized account itself. Missions,
pipelines, routines, and workers ask for Fable-owned semantic capabilities.
Connections implement those capabilities, capability grants constrain their use,
provider routes identify eligible model or agent execution paths, and approvals
govern exact proposed actions.

Fable owns portable contracts for users, workspaces, membership, Connections,
capabilities and grants, goals, missions, plans, workers, runs and run events,
artifacts, routines and triggers, approvals, and execution placement. Vendors,
storage engines, provider protocols, and hosted workflow products may implement
those contracts but do not define the product ontology.

## Canonical definitions

Terms in this section are normative. A later contract may add lifecycle state,
metadata, or implementation detail, but it must preserve these meanings.

| Concept | Canonical definition | Explicit non-meaning |
|---|---|---|
| **Internal user** | Fable's stable record for a person, mapped to but not defined by an external identity-provider subject. | Not a provider account, connector identity, workspace, or permission grant. |
| **Workspace** | The hard-isolated personal or collaborative environment that owns Fable work and policy. The same workspace model supports one or many members. | Not a Clerk Organization, deployment mode, project, or parent organization. |
| **Member** | The relationship by which an internal user participates in a workspace under Fable-owned role, status, and policy. | Not a second user identity and not an external service account. |
| **Thread** | A durable conversation in a workspace. It may stand alone, be created in a project, or be assigned to or removed from a project later. | Not a project and not itself an execution record. |
| **Project** | An optional workspace-owned container for a related body of work, including any associated threads, goals, knowledge, Connections, missions, routines, artifacts, and activity. | Not required for conversation and not a tenancy boundary. |
| **Fable orchestrator** | Fable's logical workspace-level chief-of-staff role: it interprets requests, resolves permitted context and capabilities, chooses execution depth and routes, supervises work, requests input or approval, and returns coherent results. | Not a member, department, fixed worker, provider model, or user-maintained agent graph. |
| **Goal** | A durable desired outcome in a workspace. It may stand alone, organize related work, or originate missions and routines. | Not a plan, task queue entry, or proof that work was executed. |
| **Mission** | One bounded, outcome-oriented unit of work chosen or created by Fable, ranging from a small delegation to a multi-department job. | Not every chat turn, a fixed workflow graph, or a permanent agent team. |
| **Plan** | The generated, inspectable, revisable execution proposal for one mission, including intended work, constraints, dependencies, gates, and expected outputs at the appropriate level of detail. | Not the mission's desired outcome and not an immutable script. |
| **Worker** | A run-scoped agent execution with a bounded role, provider route, capabilities and tools, context, budget, stop conditions, and output or handoff contract. | Not a persistent employee, member, department, or globally fixed custom agent. |
| **Run** | One inspectable execution of a direct request, mission, routine, or pipeline, with recorded scope, policy, routes, placement, progress, approvals, outputs, and terminal outcome. | Not the reusable definition that initiated it and not merely a provider API call. |
| **Run event** | An ordered, durable fact about a run, such as creation, planning, routing, worker progress, tool proposal or result, handoff, approval wait or resolution, artifact production, retry, cancellation, failure, or completion. | Not execution authority and not mutable current-state storage disguised as history. |
| **Department** | An optional workspace-owned operating context that contributes a charter, boundaries, knowledge, Connections, capabilities, authority limits, quality standards, routines, pipelines, and history. | Not mandatory navigation, an org chart, a tenant, a saved prompt, or a fixed agent team. |
| **Pipeline** | A reusable guided outcome journey that defines stages, required inputs, decisions, approvals, outputs, acceptance criteria, recovery, and escalation while allowing Fable to plan workers dynamically. | Not a fixed worker graph or a vendor workflow primitive. |
| **Routine** | A reusable definition of work that begins later, repeats, monitors, follows up, or reacts to an event. | Not a separate automation product and not a single execution. |
| **Trigger** | The time or event condition that starts a routine. A schedule is a one-time or recurring time trigger; a Connection event, webhook, threshold, follow-up, or monitoring condition may be another trigger type. | Not the routine, the resulting run, or authority to perform side effects. |
| **Artifact** | A durable, inspectable output such as a document, report, decision, code change, design, image, video, dataset, or configuration, with provenance and lineage. | Not transient working context, a raw run event, or hidden execution history. |
| **Connector** | A Fable-supported integration definition for a product or protocol, including its authentication, discovery, capability, health, and policy expectations. | Not an authorized account, token, runtime session, or capability grant. |
| **Connection** | One authorized external account, service, model or agent runtime, or MCP server made available within a workspace. It is the shared product concept for external access and execution paths. | Not the connector definition, a credential value, a member identity, or blanket authority. |
| **Provider route** | One permitted model or agent execution path exposed through a Connection, such as an API-backed model route, provider-owned app server, ACP runtime, router, or local model service. | Not a semantic business capability and not an execution node. |
| **Capability** | A Fable-owned, provider-neutral semantic action or outcome that work may request, such as reading documents, drafting email, updating CRM, or inspecting a deployment. | Not a provider feature flag, OAuth scope, tool name, or brand-specific operation. |
| **Capability grant** | The workspace-owned statement of where, for whom, through which eligible Connections, and under what limits and approval requirements a capability may be used. | Not a credential, an approval of a particular action, or proof that a provider can perform the capability. |
| **Knowledge** | Reference material Fable may retrieve and cite, with source, provenance, trust, freshness, visibility, and scope. | Not retained personal memory, temporary working context, or authority. |
| **Memory** | Information deliberately retained for future work, with provenance, visibility, scope, lifecycle, and user control. | Not all conversation history, automatically promoted knowledge, or transient working context. |
| **Approval** | A human or policy decision over one exact proposed action, its target, data use, consequence, route, scope, and freshness window. | Not a general capability grant, credential, standing Connection authorization, or substitute for runtime revalidation. |
| **Execution node** | A permitted local or hosted environment in which all or part of a run executes, with explicit placement and data, credential, provider, and destination boundaries. | Not a provider route, Connection, model, member device identity, or automatic authority expansion. |

## Relationships and cardinality

Cardinalities describe product semantics, not a required physical table layout.
`0..*` associations may be represented by references, link records, or derived
provenance as later contract work determines.

| Relationship | Cardinality and rule |
|---|---|
| Internal user to workspace | Many-to-many through **Member**. A member belongs to exactly one internal user and exactly one workspace. A live workspace has at least one active member; detailed roles and lifecycle are decided by the identity/tenancy ADR. |
| Workspace to thread | One workspace owns `0..*` threads. Every thread belongs to exactly one workspace. |
| Workspace to project | One workspace owns `0..*` projects. Every project belongs to exactly one workspace. |
| Project to thread | A project contains `0..*` threads. A thread belongs to `0..1` project, so standalone workspace threads are first-class. Project assignment may change only within the same workspace. |
| Workspace to orchestrator | Each workspace has one logical Fable orchestrator role. Its implementations and executions may be many; the role is not a persisted member or worker requirement. |
| Goal to context and work | Every goal belongs to exactly one workspace and may reference `0..1` project plus other permitted contexts. A goal may exist with no mission or routine and may originate `0..*` missions and `0..*` routines. |
| Mission to context | Every mission belongs to exactly one workspace. It may reference a source thread or goal, `0..1` project, `0..*` departments, and `0..1` pipeline execution context without making any of them mandatory. |
| Mission to plan | A mission has `0..*` plan revisions and at most one current plan. Every plan belongs to exactly one mission. Revisions preserve inspectability; revising a plan does not change the mission's identity. |
| Run to initiating work | Every run belongs to exactly one workspace and records exactly one initiating cause. It may additionally reference the direct request, mission, routine occurrence, pipeline, thread, goal, and project needed for provenance. A direct request may produce a run without a mission. |
| Run to worker | A run owns `0..*` workers. A simple direct run may use no separately materialized worker; a worker belongs to exactly one run and may reference the plan step or bounded task it fulfils. |
| Run to run event | A run owns an ordered sequence of `1..*` run events once created. Every lifecycle transition and externally relevant side-effect boundary is represented by a new event; prior events are not rewritten to change history. |
| Department to work | Every department belongs to exactly one workspace. Projects, goals, missions, pipelines, routines, knowledge, Connections, grants, and artifacts may reference `0..*` departments. Department association adds context and constraints, not ownership or authority by itself. |
| Pipeline to department and execution | Every pipeline belongs to exactly one workspace and may reference `0..*` departments. A pipeline has one or more ordered or gated stages. Starting it creates or contributes to a run and may generate `0..*` missions dynamically; stages do not prescribe permanent workers. |
| Routine to trigger | Every routine belongs to exactly one workspace and has `1..*` triggers while active. Every trigger belongs to exactly one routine. A trigger firing creates a routine occurrence that may initiate a run; it does not mutate the routine definition. |
| Routine to context | A routine may reference a project, department, pipeline, goal, thread, or Connection event source, singly or in combination, subject to one workspace boundary. With no narrower context it is workspace-level. |
| Artifact to provenance | Every artifact belongs to exactly one workspace. It may have `0..1` producing run (for example, an imported artifact has none), `0..*` versions, and contextual links to threads, projects, goals, missions, departments, pipelines, routines, and source artifacts. |
| Connector to Connection | A connector definition may support `0..*` Connections. A Connection references `0..1` connector definition because provider-owned runtimes or protocol-generic services may not require a brand connector. |
| Workspace to Connection | A workspace owns `0..*` Connections. Every Connection is available within exactly one workspace, even when the underlying external account is also authorized separately elsewhere. Sharing or personal availability is explicit policy on the Connection; it never crosses workspaces implicitly. |
| Connection to provider route | A Connection exposes `0..*` provider routes. Every provider route belongs to exactly one Connection. Non-model service Connections may expose no provider route. |
| Capability to Connection | A capability may be implemented by `0..*` Connections, and a Connection may implement `0..*` capabilities. Availability and health are resolved at use time; catalogue support alone is insufficient. |
| Capability grant | Every grant belongs to exactly one workspace and names exactly one capability. It may constrain eligible Connections, members or roles, contexts, consequences, budgets, destinations, placement, and approval policy. Multiple grants may exist; their combination may only narrow effective authority unless an explicit authorized policy change broadens it. |
| Knowledge and memory | Every knowledge or memory record belongs to exactly one workspace, has explicit visibility, and may have narrower member, project, thread, department, goal, or other context associations. Knowledge may be proposed for memory, but only a deliberate retention action creates memory. |
| Approval to run and action | Every approval belongs to exactly one workspace and one exact proposed action. It normally references one run and may exist without a run for an exact configuration action. A decision applies only to the proposal it identifies; changed inputs, target, route, placement, or material consequence require revalidation or a new approval. |
| Run to execution node | Each active execution segment is bound to exactly one permitted execution node. A run records every node it used if work is transferred or distributed. Placement changes are explicit events and cannot silently move data, credentials, provider use, or billing across a boundary. |

## Scope rules

### Hard ownership and isolation

1. Internal users are global Fable principals and members are workspace
   relationships. User-owned work records belong to exactly one workspace.
2. Connector and capability catalogue definitions may be global because they
   carry no workspace data or authority. Connections, provider routes, grants,
   and actual use are always workspace-bound.
3. Nothing crosses a workspace boundary through inheritance, retrieval,
   orchestration, sync, fallback, or provider routing. Transfer or export is an
   explicit user action that preserves provenance and does not carry hidden
   history, credentials, grants, or approvals.
4. The workspace model does not vary with member count, storage placement, or
   collaboration state. Those are properties of the same concept, not distinct
   workspace types.

### Optional contexts

1. Projects are optional. A workspace with only standalone threads is complete
   and valid.
2. Departments are optional contexts. Their absence does not remove the Fable
   orchestrator or block direct, project, mission, pipeline, or routine work.
3. Project and department references narrow or enrich context; they do not
   create a new ownership root and do not themselves grant access.
4. A record may carry several contextual associations inside its workspace when
   work is cross-project or cross-department. Fable passes only the context and
   artifacts needed for the receiving work; it does not silently merge all
   histories or authority.

### Context resolution

1. Explicit user references to a thread, project, department, Connection,
   source, artifact, goal, or other context override suggestions.
2. A project thread inherits permitted project context. A standalone thread uses
   permitted workspace context selected by Fable.
3. A department reference contributes its charter, boundaries, standards,
   permitted context, and applicable capability policy.
4. Authorization and visibility filtering occur before retrieval, ranking, or
   model context assembly. Relevance cannot make inaccessible context visible.
5. Private member context never becomes workspace-shared context automatically.
6. Context, capability availability, authority, and approval are separate
   checks. Possessing context never grants a capability; having a Connection
   never grants broad authority; a capability grant never pre-approves an exact
   consequential action.

## Invariants

1. **One workspace model.** A workspace is the only hard work-tenancy boundary
   and supports one or many members without changing type. There is no Fable
   Organization layer in this ontology.
2. **Projects remain optional.** Threads, direct runs, goals, knowledge, memory,
   Connections, routines, and artifacts can exist at workspace scope without a
   project where their own semantics allow it.
3. **Standalone threads are durable first-class records.** A thread never needs
   a synthetic project merely to satisfy storage or routing.
4. **Orchestration is dynamic.** Users ask for outcomes; Fable chooses direct,
   mission, and multi-worker depth. A mission's workers and plan may change
   without redefining its goal, project, department, or pipeline.
5. **Departments are optional contexts.** They supply purpose, standards,
   knowledge, constraints, and capability policy, not fixed worker graphs or
   mandatory navigation.
6. **Pipelines constrain outcomes, not agent topology.** They define stages,
   gates, inputs, outputs, approvals, and quality bars while missions and workers
   remain dynamically planned.
7. **Schedules are routine triggers.** Scheduled work receives no broader
   authority than immediate work. Provider routes resolve at run time within
   saved policy unless deliberately pinned by an explicit user policy.
8. **Connection is the external-instance abstraction.** Native accounts,
   services, provider runtimes, routers, local model services, and MCP servers do
   not create competing product-level account concepts.
9. **Capabilities are semantic and portable.** Work requests provider-neutral
   capabilities. Connector operations, provider features, tools, and OAuth
   scopes are implementation mappings and evidence, not the capability identity.
10. **Authority is least and explicit.** A Connection does not imply a grant, a
    grant does not imply an approval, and an approval does not survive a material
    change to the exact proposed action.
11. **Knowledge, memory, working context, and artifacts stay distinct.** Import
    or retrieval does not create memory; working context is run-specific;
    artifacts are durable outputs with lineage.
12. **Run history is append-only in meaning.** Current state may be projected
    from events, but retries, corrections, approvals, failures, cancellations,
    placement changes, and partial outcomes remain inspectable.
13. **Execution placement is explicit.** A provider route answers how model or
    agent work is reached; an execution node answers where Fable runs it. Neither
    silently changes the other or expands data and credential boundaries.
14. **Contracts are Fable-owned and portable.** TypeScript, Rust, SQLite,
    Convex, hosted drivers, provider adapters, and product copy implement the
    same concepts. No vendor identifier or storage primitive becomes a required
    user-facing ontology term.

## Final-state decision versus current foundation

This ADR defines the approved final state. It does not claim that the current
checkout implements it.

The current foundation remains valuable: it has workspace IDs and local
isolation, projects, project-bound threads, persisted agent and workflow runs,
goals and plans, artifacts, connector manifests and accounts, backend provider
records, semantic-looking connector operations, approvals, knowledge, memory,
schedules, workflow definitions, departments, pipelines, encrypted SQLite, and a
config-gated Convex collaboration skeleton. These records provide migration
inputs and implementation evidence.

They are not automatically canonical contracts. In particular:

- the current SQLite thread schema requires a project, while final-state threads
  require a workspace and make project membership optional;
- current goal and plan snapshots are workspace utilities, while the final-state
  plan is a revisioned proposal for a mission and goals may originate missions
  and routines;
- `PersistedAgentRun` and `WorkflowRun` represent useful run foundations but do
  not yet supply the unified run, worker, run-event, placement, and provenance
  model;
- schedules, scheduled jobs, automation rules, workflow definitions, and
  workflow runs are migration sources for routines, triggers, pipelines, and
  runs, not additional top-level final-state concepts;
- connector accounts, backend connections/providers, local runtimes, and future
  MCP records must converge on Connection, provider route, capability, and
  capability-grant contracts;
- current department and pipeline shapes are narrow workflow lanes and do not
  yet express optional context, quality, authority, dynamic missions, or
  cross-department work;
- current cloud and identity foundations contain Clerk Organization and
  solo-versus-shared assumptions that conflict with the one-workspace direction.
  The identity/tenancy and record-authority ADRs must resolve those mechanics;
  this ADR does not select the replacement fields or storage authority.

## Consequences

### Positive

- Product copy, UI, protocol, storage, sync, orchestration, and integrations gain
  one vocabulary.
- The minimum product remains account, workspace, provider Connection, and
  conversation; optional configuration cannot become a hidden prerequisite.
- The same mission semantics can survive provider, connector, MCP, model,
  execution-node, and hosted-runtime substitution.
- Dynamic missions and departments can grow without exposing or persisting a
  user-maintained agent graph as the product model.
- Exact approvals, semantic capability grants, and explicit placement make
  trust boundaries composable and inspectable.
- Fable can migrate vendors or storage engines without rewriting user-facing
  concepts.

### Costs and constraints

- Existing schema, protocol, copy, and navigation cannot be renamed
  mechanically; migrations must preserve history, IDs, provenance, and recovery.
- Several current record families must converge, which requires compatibility
  readers or adapters during transition.
- Polymorphic context and provenance relationships require disciplined
  authorization and cannot rely on an unvalidated generic foreign key.
- A unified run/event model adds durable lifecycle and replay requirements.
- Capability resolution needs a maintained semantic registry plus truthful
  mappings from each Connection and provider route.
- Optional projects and departments require every feature to handle workspace
  scope deliberately rather than assuming a narrower parent exists.

## Rejected alternatives

### Require a project for all work

Rejected because it makes basic conversation administrative, contradicts
standalone workspace threads, and turns an optional organizing layer into a
storage prerequisite.

### Separate personal, solo, team, and organization workspace types

Rejected because member count and collaboration state do not change the product
concept. Parallel workspace types would duplicate scope, navigation,
authorization, migration, and copy semantics. The external identity provider's
organization model must not define Fable tenancy.

### Make departments fixed teams or agent graphs

Rejected because it exposes orchestration machinery as configuration, prevents
mission-specific routing, and makes departments mandatory actors rather than
optional contexts and quality systems.

### Treat workflows and schedules as top-level product destinations

Rejected because users repeat outcomes, not queue primitives. Pipelines describe
guided outcomes, routines describe reusable deferred or reactive work, and
schedules are one trigger type. Existing workflow and scheduler machinery may
implement those concepts without defining them.

### Keep connector accounts, model backends, MCP servers, and local runtimes unrelated

Rejected because missions would need brand- and transport-specific logic,
authorization would fragment, and provider substitution would change the meaning
of work. Connection is their shared authorized-instance abstraction.

### Define capabilities as provider operations or OAuth scopes

Rejected because provider operations and scopes are unstable implementation
details. Semantic capabilities let pipelines and missions express intent while
Connections supply truthful implementations and grants supply authority.

### Materialize every request as a mission with a visible plan

Rejected because it creates process theatre for simple work. Direct runs are
canonical; Fable escalates to a mission when complexity warrants it and records
that decision.

### Conflate grants and approvals

Rejected because standing scope policy and consent to one exact consequential
action have different freshness, revocation, audit, and replay properties.

### Adopt a hosted vendor's workflow or tenancy objects as Fable contracts

Rejected because it would leak infrastructure into product semantics and make
portability, local execution, and vendor exit materially harder.

## Compatibility and migration implications

1. Migrations must be additive and reversible until canonical readers and
   writers are proven. Existing records remain readable throughout the change.
2. Legacy records without an explicit workspace continue to receive a validated
   compatibility workspace during migration; this is data repair, not a special
   workspace type.
3. Threads gain direct workspace ownership and optional project association.
   Existing project-bound threads retain their project; no synthetic project is
   created for new standalone threads.
4. Existing goals remain goals. Existing free-standing plans require an explicit
   compatibility mapping before they can become mission plans; migration must not
   invent a mission outcome silently.
5. Agent runs and workflow runs map into the unified run model with source-kind
   and provenance retained. Existing transcripts, step records, tool calls,
   approvals, retry ancestry, and scheduler attempts become run events or linked
   evidence. An honest legacy-import event may establish the canonical event
   sequence, but migration does not pretend that missing historical events
   occurred.
6. Existing connector manifests become connector definitions. Connector-account,
   backend-connection, provider-runtime, local-runtime, and future MCP instance
   records migrate to typed Connections. Credential custody remains behind its
   existing trust boundary and credential values never enter portable records.
7. Provider/model selection migrates to provider routes associated with the
   relevant Connection. Existing pins are preserved as explicit policy; defaults
   do not become permanent pins accidentally.
8. Connector capability strings, backend capability flags, tool names, and OAuth
   scopes become implementation mappings to semantic capabilities. Until a
   mapping is validated, availability is unknown or degraded rather than
   inferred.
9. Existing approval records remain audit evidence. Broad permission presets or
   saved rules do not become proof of approval for an exact historical or future
   action.
10. Schedules and scheduled jobs migrate to routines plus time triggers;
    workflow definitions are classified as pipeline/routine implementation or
    retained compatibility data. Occurrence IDs, deduplication, retry history,
    and outcomes must survive.
11. Artifacts gain explicit workspace scope, lineage, version, and producing-run
    semantics without moving hidden run context or authority with them.
12. Cloud schema, membership, sync, and local/hosted authority changes are gated
    on the separate identity/tenancy and record-authority decisions. This ADR
    supplies names and invariants, not a storage allocation.
13. Canonical contracts require TypeScript/Rust parity and versioned migration
    tests before legacy fields or record families are removed.

## Open implementation questions

These questions do not reopen the ontology; they must be answered by later
contract, identity/tenancy, authority, or execution ADRs.

1. Which system is authoritative for each canonical record and which projections
   are local caches, outboxes, or hosted coordination state?
2. What are the exact internal-user, member, invitation, role, policy, and
   identity-provider mapping contracts?
3. Which contextual associations require dedicated link records, and should any
   concept have a single primary presentation context in addition to multiple
   semantic contexts?
4. What are the mission and plan lifecycle states, revision rules, acceptance
   criteria, and direct-run-to-mission escalation contract?
5. What event envelope, ordering, idempotency, redaction, checkpoint, retention,
   and replay rules define the unified run and run-event protocol?
6. How are worker identity, parent/child relationships, handoffs, joins, budgets,
   evaluation, and partial outcomes represented without creating permanent agent
   graphs?
7. What Connection subtype and lifecycle contract unifies native connectors,
   provider-owned runtimes, routers, local services, MCP, and future protocols
   while keeping credentials separate?
8. What is the semantic capability namespace, how are implementation mappings
   evidenced, and how do overlapping grants combine and revoke?
9. What artifact versioning, lineage, review, acceptance, and cross-context
   handoff contract preserves provenance without transferring hidden authority?
10. What routine occurrence, trigger, time-zone, missed-run, event-validation,
    deduplication, and recovery semantics are portable across local and hosted
    execution?
11. How are execution nodes identified, attested, authorized, selected, revoked,
    and recorded when a run is transferred or distributed?
12. What ID, timestamp, versioning, deletion, export, and compatibility rules are
    shared across TypeScript, Rust, SQLite, Convex, and future drivers?
