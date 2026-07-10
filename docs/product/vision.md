# Fable Product Blueprint

**Status:** Authoritative product vision

**Last updated:** 10 July 2026

**Purpose:** Describe the coherent final state Fable is being built toward. This document defines the product, ontology, experience, trust model, and durable architectural direction. It is not a task tracker.

The ordered implementation tracker is [Master Build Plan](master-build-plan.md). The factual state of the current checkout is [Status](status.md).

## 1. Product definition

Fable is a minimalist, agent-native operating layer for human-agent work.

A person describes an outcome in ordinary language. Fable understands the relevant workspace context, decides how much work is required, chooses from the user's available providers and connections, coordinates the work, pauses where human judgement is required, and returns durable results.

Fable must be useful immediately with only:

1. A Fable account.
2. One connected AI provider.
3. The built-in Fable orchestrator.

Projects, knowledge, memory, connections, MCP servers, departments, routines, browser use, voice, custom agents, and advanced orchestration controls are optional additions. Each must improve Fable without becoming a prerequisite for ordinary work.

Fable is currently polished private software for Josh and invited users. Public release, open-source distribution, enterprise administration, marketplace work, and broad platform distribution are future decisions and must not distort the private-product build.

## 2. Product promise

Fable should feel like speaking to a capable chief of staff who can use the user's computer, providers, services, and accumulated context without hiding what it is doing or demanding that the user become a systems administrator.

The normal loop is:

1. The user asks for an outcome.
2. Fable resolves the relevant scope, context, capabilities, and authority.
3. Fable responds directly or generates an appropriately sized mission.
4. Fable uses the best permitted providers and connections available.
5. Fable requests human input or approval at exact decision and side-effect boundaries.
6. Fable returns a coherent answer and durable artifacts with sources, history, and recovery.

The product becomes more capable as optional layers are configured, but never more administratively demanding in normal use.

## 3. Product invariants

### Simple at every depth

- The primary experience is conversation, not configuration.
- Every major feature offers useful defaults, plain-language customization, and optional expert controls.
- No feature starts with an empty builder when a sensible preset, suggestion, or conversational setup can be offered.
- Technical concepts are translated into the outcome they enable.
- Advanced controls stay contextual and secondary.

### Optional layers

- Fable works without projects, departments, native business connections, knowledge libraries, routines, custom agents, browser use, or voice.
- A user can stop at any level of configuration.
- Missing optional configuration degrades a capability and explains what would unlock it; it does not block unrelated work.
- A pipeline may require a genuine input or connection only when the outcome cannot be delivered without it.

### Dynamic orchestration

- The user describes the outcome; Fable determines the execution depth.
- Users do not choose between chat, task, workflow, agent team, or department run before asking for work.
- Workers and execution plans are normally assembled for the mission at hand.
- Departments supply context, capabilities, constraints, and quality standards rather than fixed agent graphs.
- Pipelines constrain stages, inputs, approvals, outputs, and quality bars without unnecessarily freezing the reasoning loop.
- Provider, model, tool, and worker choices can change without redefining the user's project or department.

### Hard workspace boundaries

- A workspace is one hard-isolated personal or collaborative environment.
- A workspace may have one member or many members; these are not separate workspace types.
- There is no Fable Organization layer.
- Clerk Organizations do not define Fable tenancy.
- Fable owns internal users, workspaces, memberships, and authorization.
- Nothing crosses a workspace boundary unless a user explicitly transfers or exports it.

### User control and product truth

- Consequential actions are attributable, inspectable, and approval-gated where appropriate.
- Fable identity, provider credentials, connector credentials, MCP authorization, and approval authority are separate trust boundaries.
- External content and tool output are untrusted input.
- A provider or connection is called supported only after its real path has been validated.
- Fixtures, preview paths, synthetic users, simulated panels, and model opinions are labelled honestly.

### Portability

- Fable owns its user, workspace, connection, capability, mission, run, artifact, routine, and approval contracts.
- Hosted vendors may implement parts of the system but do not define Fable's product ontology.
- Native connectors are the default integration experience.
- MCP is an early first-class architectural path and an advanced secondary user experience.
- OpenAPI, webhooks, imports, databases, and approved browser assistance provide controlled breadth and escape hatches.
- Provider routing covers API providers, sanctioned account-backed runtimes, local models, routers, and future execution protocols.

## 4. Universal configuration contract

Every configurable surface supports the same three layers.

### Layer 1 - Ready to use

- A strong default is selected.
- Fable asks only for information required to proceed.
- Recommended connections, knowledge, and permissions appear contextually.
- The user can begin from an ordinary request rather than a setup screen.

### Layer 2 - Plain-language customization

- The user explains what they want in ordinary language.
- Fable proposes the configuration and shows a concise summary before consequential changes.
- Forms use non-technical terms, examples, and safe defaults.
- Existing departments, routines, agents, and pipelines can be duplicated and adapted.

### Layer 3 - Expert control

- Advanced users can inspect and override providers, models, budgets, tools, context, policies, capability grants, evaluation criteria, and execution placement.
- Expert settings compile into the same Fable-owned contracts used by the default experience.
- Expert controls do not create a second product model or leak into ordinary work.

This contract applies to providers, connections, projects, knowledge, departments, routines, pipelines, voice agents, browser use, and custom agents.

## 5. Product ontology

| Concept | Meaning |
|---|---|
| Fable account | A person's Fable identity and session. |
| Internal user | Fable's stable user record, mapped to an external identity-provider subject. |
| Workspace | A hard-isolated personal or collaborative environment. |
| Member | An internal user participating in a workspace under a Fable-owned role and policy. |
| Thread | A durable conversation that may stand alone or belong to a project. |
| Project | An optional container for related threads, goals, knowledge, connections, missions, routines, and artifacts. |
| Fable orchestrator | The workspace-level chief of staff that interprets requests, resolves context, plans work, routes execution, and returns coherent results. |
| Goal | A desired outcome that can exist independently or generate missions and routines. |
| Mission | One unit of outcome-oriented work, from a small delegated task to a multi-department job. |
| Plan | The generated, inspectable, and revisable execution proposal for a mission. |
| Worker | A run-scoped agent execution with a bounded role, provider route, tools, context, budget, and output contract. |
| Run | One inspectable execution of a direct request, mission, routine, or pipeline. |
| Department | An optional configurable operating context with a charter, knowledge, capabilities, standards, routines, pipelines, and history. |
| Pipeline | A guided outcome journey with stages, required inputs, approvals, outputs, and acceptance criteria. |
| Routine | Work that begins later, repeats, monitors, or reacts to an event. |
| Trigger | The time or event condition that starts a routine. A schedule is one trigger type. |
| Artifact | A durable output such as a document, report, decision, code change, design, image, video, dataset, or configuration. |
| Connector | A supported integration definition such as Gmail, GitHub, Stripe, or Figma. |
| Connection | One authorized external account, runtime, service, or MCP server available in a workspace. |
| Provider route | One permitted model or agent execution path, such as an API key, Codex app-server, ACP runtime, router, or local model service. |
| Capability | A provider-neutral action such as reading documents, drafting email, updating CRM, or inspecting a deployment. |
| Capability grant | The scope, authority, approval requirement, and constraints under which a capability may be used. |
| Knowledge | Reference material Fable may retrieve. |
| Memory | Deliberately retained information for future work. |
| Approval | A human or policy decision over an exact proposed action. |
| Execution node | The permitted local or hosted environment in which a run executes. |

## 6. Scope and containment

```text
Fable account
└── Workspace
    ├── Members and workspace policy
    ├── Standalone threads
    ├── Optional projects
    │   ├── Threads and goals
    │   ├── Knowledge and memory
    │   ├── Connections and capability grants
    │   ├── Missions and runs
    │   ├── Artifacts
    │   └── Routines
    ├── Workspace connections
    │   ├── Provider routes
    │   ├── Native connectors
    │   └── MCP connections
    ├── Workspace knowledge, memory, and policy
    ├── Optional departments
    │   ├── Charter and boundaries
    │   ├── Knowledge, connections, and capabilities
    │   ├── Quality standards
    │   ├── Pipelines and routines
    │   └── Missions, runs, and artifacts
    └── Activity, approvals, and artifacts
```

Fable resolves scope automatically:

1. Explicit user references override suggestions, including a named project, department, connection, source, or artifact.
2. A project thread inherits its project context within the member's permissions.
3. A department reference adds its charter, capabilities, standards, and allowed context.
4. A standalone thread uses visible workspace context selected by Fable.
5. Cross-project and cross-department work passes explicit context and artifacts rather than silently sharing all history or authority.
6. Authorization filtering happens before retrieval and relevance ranking.

## 7. Identity and workspaces

- Clerk supplies managed sign-in, session, onboarding, recovery, and identity-provider lifecycle.
- Fable stores a stable internal user ID mapped to the Clerk subject.
- Fable/Convex owns workspace records, membership, roles, invitations, and authorization.
- Clerk Organizations are not used as Fable workspaces.
- A new account receives an initial workspace automatically.
- A user can create multiple isolated workspaces.
- A workspace can invite more members without changing its underlying type.
- New-member onboarding shows what the workspace already supplies and which personal connections the member may add.
- User-owned and workspace-shared connections are represented explicitly.
- The identity-provider boundary remains replaceable without rewriting Fable workspace data.

## 8. Primary product experience

### Onboarding

The shortest successful path is account creation or sign-in, automatic workspace creation, one provider connection, and a useful first conversation. Projects, departments, connectors, knowledge, routines, and expert orchestration are not setup requirements.

### Workspace shell

The primary surface remains calm and conversational. It presents the current workspace, threads, optional projects, a universal composer, active work, approvals, and recent artifacts. Complex configuration appears only when relevant.

### Threads and projects

- Threads can exist directly in a workspace.
- A thread can be created inside a project or assigned later.
- Projects organize a body of work but do not gate basic conversation.
- Project instructions, goals, knowledge, connections, missions, routines, and artifacts remain optional and inspectable.

### Context, knowledge, and memory

- Knowledge is reference material; memory is deliberately retained information; working context is what the current request or run is using.
- Fable shows important sources and can explain why context was selected.
- Private member context never becomes shared workspace context automatically.
- Imported or external content remains untrusted until policy and provenance allow its use.
- Memory is visible, editable, scoped, exportable, disableable, and forgettable.

### Artifacts

Meaningful work becomes a durable artifact rather than disappearing into a transcript. Artifacts can be versioned, sourced, reviewed, approved, searched, exported, and handed off. Moving an artifact does not transfer the producing context's hidden history or permissions.

## 9. Orchestration and model routing

There are no user-facing execution modes. The user may optionally express:

- Scope: thread, project, department, connection, source, or artifact.
- Preference: quick, deep, cost-conscious, private/local, or a preferred provider.
- Timing: now, later, recurring, or event-driven.
- Control: draft only, ask before actions, or a saved authority rule.

Fable decides internally across scope, depth, and trigger:

| Axis | Internal choices |
|---|---|
| Scope | Thread, project, department, multiple departments, or workspace |
| Depth | Direct response, delegated mission, or dynamic multi-worker mission |
| Trigger | Immediate, scheduled, recurring, threshold, follow-up, or external event |

- Small, low-risk requests begin directly without process theatre.
- Medium requests show a compact execution receipt when useful.
- Large, expensive, long-running, or consequential missions show an inspectable plan before execution.
- Fable can escalate a direct request into a mission when complexity is discovered and explains the change.
- Plans remain revisable during execution.
- Workers communicate through bounded task contracts, artifacts, evidence, and structured handoffs.
- Reviewers or judges are introduced only when disagreement, risk, or quality requirements justify them.
- Human approval remains at exact side-effect boundaries.

Routing considers capability, quality, cost, speed, privacy, context size, tool support, provider health, user preference, and task risk. Automatic fallback never silently crosses a privacy, billing, execution-placement, or provider boundary.

Fable-native commands such as `/goal`, `/plan`, `/schedule`, `/remember`, and `/stop` are interpreted before provider execution. Natural language provides the same capabilities; commands are shortcuts rather than a separate product language.

## 10. Connections, MCP, and capabilities

Fable uses this integration precedence:

1. Official native API, SDK, webhook, or provider-owned runtime.
2. First-party or Fable-reviewed MCP.
3. OpenAPI, signed webhook, database, import/export, or another approved adapter.
4. Isolated assisted browser use where permitted.
5. Unsupported.

Missions and pipelines request semantic capabilities rather than brands. A workspace maps those capabilities to available connections. Each capability reports whether it is available, approval-gated, degraded, human-assisted, or blocked.

Read, draft, write, publish, destructive, financial, and identity-sensitive grants are distinct. A broad connection never implies broad authority.

MCP supports local STDIO and remote Streamable HTTP servers, explicit authorization including OAuth/PKCE where appropriate, tool and resource discovery, trust classification, and per-scope enablement. MCP actions remain subject to Fable approvals, budgets, audit, data-routing visibility, and prompt-injection defenses. Token passthrough never bypasses the Connection boundary.

## 11. Departments, pipelines, and routines

### Departments

Departments are optional configurable operating contexts, not mandatory navigation, rigid org charts, saved prompts, or fixed teams.

The initial library is:

- Product.
- Marketing.
- Sales.
- Customer.
- Finance.
- Legal.

There is no General department; the Fable orchestrator sits above departments. Operations may be added later only if real usage cannot be represented through cross-department missions, routines, and custom departments.

Each department can contain a purpose, boundaries, recommended knowledge and connections, capabilities and authority limits, quality standards, suggested prompts, pipelines and routines, active work, approvals, artifacts, history, and optional advanced execution policy.

Users can enable a ready-made department, describe changes conversationally, edit simple sections, or open expert controls. They can create, duplicate, rename, disable, or remove departments without destabilizing the workspace.

### Pipelines

A pipeline is a polished, guided journey for a repeated outcome. It defines required information, major stages, decision gates, outputs, approvals, quality bars, recovery, and escalation while allowing Fable to plan workers dynamically.

The Voice Agent Builder is the benchmark pipeline: minimalist setup, strong defaults, conversational customization, realistic simulation, connection-backed tools, test calls, human handoff, deployment, monitoring, versioning, rollback, consent, and cost controls.

### Routines

A routine is work that begins later, repeats, monitors, or reacts to an event. A schedule is a trigger, not a top-level product destination.

Routines can belong to a workspace, project, department, pipeline, goal, connection event, or thread. Users create them conversationally, through `/schedule`, or from a contextual action. Upcoming work, controls, notifications, and history appear where the routine belongs and in a compact workspace-level activity view.

Automatic execution receives no broader authority because it is scheduled. Provider and model choices resolve at run time within saved policy unless deliberately pinned.

## 12. Product surfaces and execution fabric

### Desktop

The Tauri desktop application is the primary local execution surface. Local files, credentials, local models, provider-owned runtimes, private interactive work, browser takeover, and computer use prefer the desktop node.

### Mobile companion

The mobile surface is a focused companion/PWA, not a remote desktop mirror. It supports sign-in, device pairing, conversations, voice input, run status, approvals, artifacts, routine controls, and notifications.

### Execution nodes

- Local desktop node.
- Optional Fable-managed node for webhooks, persistent routines, browser sessions, and deployed agents.
- Optional customer-hosted node only if a real private-network or residency requirement appears.

Every run records where it executed and which data, credentials, providers, and destinations were involved. Local data and execution remain on the selected local node unless the user explicitly selects hosted execution or a feature genuinely requires it.

### Browser and computer use

Official connectors and APIs are preferred. Browser work uses isolated sessions, domain and action boundaries, prompt-injection defenses, visible execution, exact approval, and user takeover. Windows computer use is accessibility-first with visual fallback, application allowlists, protected secret fields, and an emergency stop. Fable never bypasses CAPTCHA, extracts hidden credentials, or automates prohibited activity.

### Voice

Personal voice begins with excellent editable dictation, then adds affordable interruptible conversation with transcript, visual artifacts, and normal mission delegation. Fable routes between realtime speech-to-speech and chained speech recognition/orchestration/speech generation based on quality, latency, cost, and task needs without coupling the product to one premium provider.

Deployed voice agents use the same knowledge, connections, missions, approvals, artifacts, policies, and execution nodes as the rest of Fable. They require disclosure, consent, recording controls, identity verification, human transfer, monitoring, rollback, and a kill switch.

## 13. Durable architecture direction

### Core stack

- Tauri 2 and Rust own the desktop trust, filesystem, credential, local database, process, and OS boundary.
- React and TypeScript own product surfaces.
- Encrypted SQLite owns authoritative local state and offline execution where the authority matrix assigns records locally.
- Convex owns shared workspace state, realtime collaboration, hosted coordination, and the first hosted-run foundation where the authority matrix assigns records to shared state.
- Clerk owns identity and sessions only.
- Fable owns internal users, workspaces, memberships, authorization, and all portable product contracts.

### Web and routing

- TanStack Query remains the remote asynchronous state layer.
- TanStack Router replaces manual page-state routing.
- TanStack Start powers the mobile companion and future web surface, sharing domain and UI packages with desktop.
- TanStack DB is not added while SQLite and Convex already define the data model.

### Cloudflare and hosted infrastructure

- Workers handle OAuth brokering, connector webhooks, signed callbacks, lightweight APIs, and notifications.
- Durable Objects handle bounded realtime coordination such as device presence, secure relay, live run events, and approvals.
- R2 stores large artifacts, screenshots, recordings, and generated media.
- Browser Rendering supports managed browser execution when required.
- Queues, TURN, Secrets Store, AI Gateway, and workflow infrastructure are added only when a demonstrated requirement justifies them.
- D1 is not introduced as a competing product database.

### Vercel

- Vercel remains an important deployment Connection and optional hosting target.
- Vercel AI Gateway, Workflows, and Blob do not become core dependencies while Fable owns routing and uses Convex/Cloudflare for hosted state and infrastructure.

### Portable hosted execution

Fable defines a provider-owned-neutral hosted-run driver. The local driver lands first. The first hosted path uses the simplest dependable Convex-backed approach. Cloudflare Workflows or another durable runtime can be evaluated when managed long-running missions require it. Vendor workflow primitives never leak into the user-facing mission contract.

### Codebase structure

- Provider, Connection, capability, mission, artifact, workspace, routine, and approval contracts live in focused packages.
- TypeScript and Rust protocol contracts are generated or validated to prevent drift.
- Migrations are explicit and reversible.
- Oversized shell and runtime files are split into bounded domain modules.
- Fable maintains one implementation path per concept rather than accumulating parallel legacy and replacement systems.

## 14. Trust, safety, and recovery

- Secrets remain behind native or managed credential boundaries and never enter ordinary React state, logs, snapshots, or exported artifacts.
- Exact, fresh approvals are revalidated immediately before consequential side effects.
- External content is treated as untrusted and cannot grant itself authority.
- Runs, actions, approvals, provider routes, execution placement, and artifacts are inspectable and attributable.
- Workspace authorization is enforced at storage, retrieval, execution, and synchronization boundaries.
- Backup, restore, migration recovery, crash recovery, export, deletion, credential revocation, and emergency controls are first-class private-product requirements.
- Failure modes are honest and actionable; Fable never silently substitutes fixtures or crosses policy boundaries to appear successful.

## 15. Connector direction

Connector breadth follows real outcomes rather than logo count.

### Wave A - Daily operating core

- Google Drive, Docs, Sheets, Slides, Gmail, Calendar, and Contacts.
- Microsoft Outlook, Calendar, Contacts, OneDrive, SharePoint, and Teams.
- Slack, Notion, Dropbox, Box, Calendly, Zoom, and DocuSign.
- GitHub, Linear, Atlassian Jira and Confluence, Figma once authorized, Vercel, Cloudflare, Railway, PlanetScale, Supabase, Neon, Convex, Sentry, and PostHog.

### Wave B - Revenue, customer, and communication

- HubSpot, Salesforce, Attio, Zoho CRM, and Pipedrive.
- Intercom, Zendesk, Front, Gorgias, Help Scout, and Freshdesk.
- Discord through webhooks and approved bot/app installation.
- Telegram through workspace-owned bots and webhooks.
- WhatsApp Business Platform only; never personal WhatsApp session automation.
- Fireflies, Granola, and supported meeting/transcript systems.

### Wave C - Marketing, commerce, finance, and legal

- GA4, Search Console, Google Ads, Meta business/advertising surfaces, Instagram Business, approved LinkedIn products, X API, YouTube, Mailchimp, Klaviyo, Customer.io, Webflow, WordPress, Shopify, and Resend.
- Stripe, QuickBooks, Xero, Sage, NetSuite, Ramp, Brex, and Plaid or approved open-banking providers where suitable.
- DocuSign, Adobe Sign, Ironclad, Juro, Contractbook, Clio, and licensed legal sources where access exists.

Every native connector must pass feasibility review for official access, authentication, scopes, webhooks, rate limits, plan requirements, terms, execution placement, approvals, and live validation.

### Long tail

- MCP, OpenAPI, databases, webhooks, RSS, email ingestion, import/export, n8n, Pipedream, Zapier, and Make.
- GitLab is not a planned native connector; it may be supported through MCP or a custom integration if later required.
- Browser assistance never masquerades as native support.

## 16. Final-state success journeys

Fable is approaching the intended final state when all of these journeys work without hidden prerequisites:

1. **Minimum setup:** a user signs in, receives a workspace, connects one provider, asks for useful work, closes Fable, and continues later.
2. **Durable body of work:** a user keeps standalone and project threads, sources, memory, goals, runs, decisions, and versioned artifacts coherent across sessions.
3. **Portable capability:** the same requested outcome can use a native connection, approved MCP server, or explained alternative without changing the mission semantics.
4. **Dynamic mission:** one natural-language request becomes the right-sized inspectable plan, uses several permitted providers when useful, pauses for exact approvals, and produces coherent artifacts.
5. **Repeatable work:** any successful result can become a contextual routine without creating a separate automation product.
6. **Configured department:** a user enables and adapts a department in minutes, invokes it naturally, and receives work that follows its context and quality standards without maintaining an agent graph.
7. **Guided pipeline:** a user completes a high-value multi-stage outcome through a minimalist journey with dynamic workers and clear gates.
8. **Remote supervision:** a user safely directs and approves eligible work from mobile while local boundaries remain intact.
9. **Voice:** a user dictates, converses, delegates, reviews artifacts, and approves actions through the same Fable system.
10. **Sustained private use:** Fable is recoverable, accessible, observable, and trustworthy for Josh and invited users.

## 17. Deferred decisions

- Public release timing.
- Open-source licensing and contribution model.
- Marketplace and third-party commercial distribution.
- Enterprise organization hierarchy, SSO, SCIM, centralized administration, and compliance packaging.
- macOS and Linux distribution and app-store delivery.
- A parent Organization above workspaces.

These decisions must not block or reshape the private-product programme. Contracts should remain capable of supporting them later without implementing them now.

## 18. Document authority

- [Product Blueprint](vision.md): what Fable is becoming and the product invariants that must be protected.
- [Master Build Plan](master-build-plan.md): ordered phases, parallel waves, task checklist, dependencies, integration gates, and completion state.
- [Status](status.md): factual implementation state of the current checkout.
- ADRs: durable decisions and their consequences.
- Architecture documents: current or proposed technical designs subordinate to accepted ADRs and the blueprint.
- Historical roadmaps, batch plans, baselines, thesis notes, and handoff maps: useful evidence, not competing product authority.

If implementation evidence changes feasibility, update the architecture and tracker. If a change would alter product direction, scope, or user experience, flag it before changing this blueprint.
