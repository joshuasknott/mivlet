# Fable product mastermap

## Grok Bot audit, competitor study, and decisions for a human–agent workspace

**Date:** 18 August 2026  
**Fable checkout:** `ea6137fd6b20a10dfecb8fbfefc16f1d64c05c5d` on `main`  
**Grok Bot observed:** Windows desktop app 0.18.0, signed in, onboarding not previously started  
**Purpose:** inform product decisions; this is not an implementation specification or release-readiness claim

The complete visual record is in the [screenshot ledger](screenshot-ledger.md).

## Executive conclusion

Fable should borrow Grok Bot’s restraint, not copy its product ceiling.

Grok Bot’s visible model is unusually true and legible:

1. You have a workspace.
2. The workspace contains durable teammates.
3. You speak to one or more teammates in conversations.
4. A teammate can use a computer, repeat a routine, and connect to outside services.
5. Work-specific detail appears only while it is useful.

Fable’s present architecture is already more ambitious: knowledge and memory, provider routing, local execution, projects, approvals, missions, artifacts, departments, pipelines, and portable execution. The problem is not lack of capability. The problem is that too many correct internal distinctions are candidates for the everyday interface.

The recommended product rule is:

> **Conversation first. Capability at the point of need. Infrastructure only when the user asks to inspect or control it.**

The visible Fable ontology should therefore be deliberately smaller than its internal ontology:

- **Workspace** — the human’s private or shared place.
- **Teammate** — a durable identity with a purpose, personality, permissions, and accumulated context.
- **Conversation** — where humans and one or more teammates think and work together.
- **Work** — the inspectable execution behind a request, surfaced only when status, intervention, history, or evidence matters.
- **Routine** — work that starts again on a schedule or event.
- **Knowledge** — “what Fable knows,” including deliberate reference material and clearly separated learned context.
- **Connections** — outside apps and systems Fable is allowed to use.
- **Deliverable** — a durable result worth keeping, sharing, revising, or exporting.
- **History** — versions, decisions, actions, and recovery appropriate to the object being inspected.

Projects can remain an optional organizer. Approvals should appear contextually. Departments should be an advanced operating context. Mission, worker, pipeline, capability grant, provider route, artifact version, and execution node should remain precise internal concepts unless an expert opens details.

Fable’s differentiating promise is not “Grok Bot plus more pages.” It is:

> **A friendly team of intelligences that can understand the person, use the systems they choose, route work to the right intelligence, act with clear authority, preserve everything important, and scale from one helpful task to operating a business—without making the person become an agent engineer.**

## Evidence and boundaries

### What was directly observed

- The entire first-run Grok Bot onboarding.
- First-teammate creation and the normal chat shell.
- Plugin marketplace, installed/private views, filters, and Gmail detail.
- Account menu, usage, billing, general settings, execution policy, natural-language review rules, security-key control, updates, and feedback.
- Teammate profile, mascot, generated/uploaded avatar paths, computer, routines, schedule/event triggers, and demonstration recording.
- Global search, later teammate creation, multi-teammate group drafts, threads, reactions, replies, attachments/teaching menu, and sidebar organization.
- Accessibility labels and control structure for each reachable state.

### What was intentionally not executed

- No connector, OAuth grant, plugin install, file upload, microphone capture, external message, provider write, purchase, cancellation, upgrade, update, reset, sign-out, or deletion.
- A `Researcher` teammate was created during onboarding. Inspecting the post-onboarding creator immediately created `New Bot`. Inspecting sections immediately created an empty `New section`. They remain because Grok Bot describes teammate deletion as permanent and irreversible.
- The walkthrough is a product/interaction audit, not a security penetration test, screen-reader certification, or production reliability test.

### How Fable claims are labelled

This document preserves the repository’s evidence boundary:

- **Implemented:** present in current source.
- **Fixture-tested:** deterministic preview or synthetic data proves the UI/contract, not a provider.
- **Configured:** integration shape exists, but credentials or external setup are still required.
- **Development-live:** a real path has been exercised in a bounded development environment.
- **Production-integrated:** deployed, account-scoped, operationally observed, and supported.
- **Release-gated:** additional external, packaging, recovery, security, or operational evidence is still required.

Green tests do not turn provider, OAuth, account, external-effect, or release paths into production evidence.

## 1. What Grok Bot gets right

### 1.1 Onboarding is a story, then one commitment

The first three screens explain a simple narrative:

- meet the product;
- understand that the teammate has a computer;
- understand that each teammate has a job.

Only then does the product ask for anything. The optional service catalogue is recognizable and skippable. Teammate creation asks for a character and a purpose. It does not ask for a system prompt, model, reasoning level, tool graph, budget, or permission preset.

This is the correct abstraction. The user commits to a **relationship and outcome**, not an implementation.

### 1.2 The interface is sparse because the ontology is sparse

The main shell contains:

- one sidebar of conversations/teammates;
- one conversation;
- one composer;
- contextual teammate settings and computer controls;
- account and plugin access at the bottom.

The product does not try to make every feature discoverable on every screen. Search silently spans messages, teammates, groups, files, links, routines, and commands. The right-hand detail pane exists only when opened. The computer becomes a full surface only when invoked. Routine history appears only inside a routine.

This is more than minimal styling. It is **progressive ontology**: an object becomes visible when the user has a reason to understand it.

### 1.3 A teammate is durable; a run is not the identity

The teammate has a name, avatar, title, description, notifications, computer, and routines. Work happens through that teammate but is not confused with the teammate. Fable should preserve this separation:

- the teammate is who the user trusts and returns to;
- the conversation is shared context;
- a run/worker is a temporary execution;
- a deliverable is the result that survives.

### 1.4 Multi-agent collaboration uses a human metaphor

Adding two Bots is identical to creating a group chat. That is a better everyday model than a graph, workforce canvas, DAG, department chart, or pipeline builder.

Graphs are valuable when a user needs deterministic handoffs. They are not the default mental model for colleagues thinking together.

### 1.5 Repetition is promoted from normal work

Grok Bot supports two unusually strong routes:

- save a recurring instruction as a routine;
- teach a task by demonstrating it on the teammate’s computer.

The broader Grok product uses the same idea: [Automations](https://x.ai/news/grok-automations) are described once, run on a schedule or trigger, and each run becomes a resumable conversation. Fable should treat “make this repeat” as a promotion of successful work, not force users to enter a separate automation builder first.

### 1.6 Permissions are described as choices, not infrastructure

Local-computer access is “always allow / ask every time / never allow.” Auto-review rules use a natural-language condition plus “allow automatically / ask first,” and conservative rules win conflicts.

This is a useful presentation layer over Fable’s stronger execution-boundary controls. The plain rule should compile into precise capability, account, object, destination, time, and risk constraints; the user should not have to author those dimensions manually.

### 1.7 Mascots create warmth without pretending to be human

The Grok Bot characters are a family of abstract shapes with two eyes. Shape and colour differentiate them, but they remain clearly software. The system scales from a default mascot to generated and uploaded identity.

The important lesson is not “use blobs.” It is:

- establish a recognizable family;
- keep the base anatomy consistent;
- use a small number of states;
- let role identity layer onto the family;
- avoid implying a human identity or copying provider brands.

## 2. Where Grok Bot is weaker—and where Fable should be better

### 2.1 Later teammate creation is too eager

Selecting “Create new Bot” immediately persisted `New Bot` and generated a greeting. This makes the product feel responsive, but it also creates account clutter before the user has expressed an intention.

**Fable recommendation:** begin a reversible draft. Persist only when the user names it, assigns a job, sends a first message, or explicitly keeps it. Autosave can protect the draft without treating it as a finished teammate.

### 2.2 Sidebar sections are immediate and under-explained

“Move to new section” immediately created `New section`. Sections are useful, but the interaction has no naming gate and creates an empty persistent object.

**Fable recommendation:** offer “New group…” with a name field and a preview of what will move. Empty groups should disappear when abandoned.

### 2.3 “Plugins” combines several different trust concepts

The marketplace mixes connectors and skills, while private skills are created by the Bot. Some catalogue copy refers to Cursor, revealing platform inheritance rather than a product-specific mental model.

**Fable recommendation:** preserve separate concepts internally and explain them plainly:

- **Connections:** accounts and systems the teammate can access.
- **Skills:** reusable ways of doing something.
- **Knowledge:** information the teammate may use.
- **Providers:** the intelligence/runtime used to think and execute.

They may share a catalogue, but install, permission, data, billing, and ownership boundaries must remain distinct.

### 2.4 Model and routing truth are invisible

The observed shell did not surface the model, route, fallback, cost, or provider behind a response. That supports simplicity, but it conflicts with Fable’s promise to let people bring subscriptions/providers and understand what is doing the work.

**Fable recommendation:** keep `Auto` as the default and reveal a small, live attribution:

> `Auto · Claude Sonnet · balanced`

The label opens “why this route,” cost/usage, privacy location, fallbacks, and per-worker attribution. It should be visible enough to be honest but not large enough to become the product.

### 2.5 The computer is powerful but opaque

The teammate computer is easy to open and teach, but the empty screen does not explain persistence, files, network reach, login ownership, sharing, or whether the environment is local or cloud.

**Fable recommendation:** use one friendly `Computer` control, then clearly label execution location:

- `This device`
- `Private Fable computer`
- `Connected runtime`

The active-work detail should show which one is in use, what data crossed into it, and how to stop or reset it.

### 2.6 Connector detail is too shallow before authorization

Gmail’s detail gives useful verbs, but fine-grained access is not visible before `Add`. Fable’s trust posture should be stronger.

**Fable recommendation:** show a plain pre-authorization capability contract:

> Read mail and search threads. Draft replies. Ask every time before sending. No deletion.

Advanced details can expose scopes, shared versus personal account ownership, data residency, and revocation.

### 2.7 Feedback shares diagnostic context by default

The feedback form defaults “Include current conversation ID” to on.

**Fable recommendation:** diagnostics should be opt-in or clearly previewed: what identifier, transcript excerpt, logs, provider metadata, and account data will be shared.

## 3. Current Fable: strong foundations, overloaded surface candidates

### 3.1 Current shell

The current React/Tauri shell is already agent-centred:

- left: workspace, agent search/list, Knowledge, Connectors, profile;
- centre: selected agent, conversation, composer;
- right: Live Work with run state, transcript, approvals, and activity;
- additional routes: Knowledge, Connectors, Schedules, Departments, Settings, Projects.

Relevant implementation evidence:

- `apps/desktop/src/shell/ChatWorkspace.tsx:2246`
- `apps/desktop/src/components/agents/AgentSidebar.tsx:59`
- `apps/desktop/src/shell/ShellRoutes.tsx:1`
- `apps/desktop/src/components/agents/AgentWorkspaceHeader.tsx:12`
- `apps/desktop/src/components/agents/LiveWorkRail.tsx:8`

The architecture can support the proposed simplification; this is primarily a product hierarchy problem, not a rewrite mandate.

### 3.2 What is genuinely strong

- A short account/provider onboarding direction.
- Provider-neutral models and provider-qualified model identities.
- Explicit approvals at consequential execution boundaries.
- Encrypted local persistence and clear private workspace ownership.
- Strong Knowledge provenance, scope, lifecycle, and trust contracts.
- Typed Connections with capability grants rather than raw token exposure.
- A Live Work rail capable of showing active execution and intervention.
- Projects, routines, missions, artifacts, and recovery contracts that can become optional depth.
- Honest fixture-versus-live documentation and fail-closed provider behavior.

These should be preserved while the interface is simplified.

### 3.3 Where the current product risks exposing its implementation

The current blueprint precisely defines user, workspace, member, project, thread, message, mission, plan, worker, pipeline, routine, capability, connection, knowledge, memory, artifact, run, approval, and action history (`docs/product/vision.md:120`). That is appropriate for architecture. It is too much for the default interface.

Specific pressure points:

- Projects and threads have several routes and representations.
- Knowledge exposes Sources, Memories, and Artifacts as peer tabs.
- Connector cards expose several technical lifecycle and permission states.
- The composer gives exact-model selection high visual importance.
- Schedules are a primary page even though “make this repeat” can emerge from conversation.
- Live Work is useful during activity but can become permanent dashboard furniture when nothing is happening.
- Approval vocabulary varies across presets, prepared actions, cited plans, mission review, and provider writes.

Relevant implementation evidence:

- `apps/desktop/src/components/pages/KnowledgePage.tsx:178`
- `apps/desktop/src/components/pages/KnowledgePage.tsx:538`
- `apps/desktop/src/components/PluginPanel.tsx:281`
- `apps/desktop/src/components/Composer.tsx:520`
- `packages/protocol/src/index.ts:1198`

### 3.4 Repository truth as of this audit

| Evidence class | Current position |
|---|---|
| Implemented | Tauri/Rust authority boundary, React shell, encrypted SQLite, agent workspace, Knowledge/Memory/Artifacts, Projects, typed Connections, provider catalogue, approvals, missions, local routines |
| Fixture-tested | Browser preview identity/workspace, connector catalogue and statuses, browser Knowledge, synthetic provider paths |
| Configured | Production Clerk shape, provider credentials, Google OAuth, broker, MCP/ACP and hosted collaboration seams |
| Development-live | One Clerk/Convex development identity, local Codex app-server path, encrypted restart, harmless scheduled run |
| Not production-integrated | Broad third-party connectors, multiple members/workspaces, consequential writes across providers, broad missions, production routing, background sync |
| Release-gated | Production identity/recovery, deployment/signing/packaging, broker callbacks, consent review, multi-session evidence, external provider publication and operations |

Authority sources are `docs/product/status.md`, `docs/product/release.md`, `docs/product/connectors.md`, and `docs/product/vision.md`. None of this research changes those gates.

## 4. Proposed product ontology

### 4.1 Three layers

| Layer | User sees | Purpose |
|---|---|---|
| Everyday | Workspace, Teammates, Conversations, composer | Think, ask, delegate, collaborate |
| Contextual | Work, approval, routine, connection, knowledge, deliverable, computer | Appears when the current action needs it |
| Advanced | Projects, departments, provider/model policy, budgets, scopes, routing, versions, execution nodes | Deliberate inspection and control |

Internal-only by default: mission graph, worker, pipeline node, capability grant, provider route receipt, trust classification, citation identity, sync cursor, approval proposal hash, and runtime driver.

### 4.2 Canonical relationships

| Object | Owns | Does not mean |
|---|---|---|
| Workspace | Members, teammates, conversations, shared Knowledge, Connections, policy | A mandatory project hierarchy |
| Teammate | Identity, purpose, behaviour, permissions, routine set, optional Knowledge | A single model invocation |
| Conversation | Participants, messages, attachments, referenced work | A project or execution graph |
| Work | Plan/run state, workers, evidence, approvals, route and location | The teammate’s identity |
| Routine | Instruction, trigger, policy, destinations, run history | A separate kind of agent |
| Knowledge | Reference material and deliberate learned context | Finished outputs or connector credentials |
| Connection | Account, authentication, capability grants, health | Knowledge itself |
| Deliverable | Stable result, revisions, approvals, share/export state | Every intermediate model response |
| Project | Optional body-of-work organizer | A prerequisite for conversation |
| Department | Optional operating context, standards, authority and shared resources | A rigid fixed agent graph |

### 4.3 Navigation options

#### Option A — Grok-faithful

One combined list of teammates and conversations; bottom entries for Connections and account. Knowledge and Work are reached through search or contextual details.

**Benefits:** calmest; strongest everyday model.  
**Costs:** Fable’s distinguishing Knowledge and durable work can be under-discovered.

#### Option B — Fable core, recommended

One combined list of teammates/conversations, plus three quiet destinations at the bottom:

- `Knowledge`
- `Connections`
- `Work` (only with active/recent items; otherwise accessible from search)

Projects become optional sidebar groups. Routines live with their teammate and in search. Settings remains under the account.

**Benefits:** preserves Grok-level simplicity while making Fable’s differentiators findable.  
**Costs:** requires disciplined badge/empty-state behavior so the bottom does not become a second navigation stack.

#### Option C — Work hub

Separate primary areas for Chat, Work, Knowledge, and Connections.

**Benefits:** strong operational visibility for teams running a business.  
**Costs:** quickly becomes a dashboard product; asks casual users to understand the system before asking for help.

**Recommendation:** Option B, with `Work` contextual and collapsible rather than a permanent three-column rail.

## 5. Knowledge: simplify the surface, preserve the rigour

Fable’s Knowledge architecture is stronger than Grok Bot’s observed product, but the current surface is an administration console. Sources, Memories, and Artifacts reflect implementation/provenance distinctions rather than the user’s question: “What does Fable know, and can I trust it?”

### Option A — Rename the current tabs

- Sources → `Reference material`
- Memories → `Learned about me`
- Artifacts → `Finished work`

**Benefits:** fastest and lowest-risk.  
**Costs:** still makes three storage types the primary experience; finished work is not knowledge.

### Option B — Remove Artifacts, keep two areas

- `What Fable knows`
- `What Fable has learned`

Move Artifacts to `Work`/`Deliverables`.

**Benefits:** corrects the largest ontology problem; stays easy to implement.  
**Costs:** source-management detail can still dominate both lists.

### Option C — One everyday Knowledge surface, recommended

Navigation label: `Knowledge`  
Screen title: `What Fable knows`

Default surface:

- one search field;
- one calm list of useful items;
- `Add knowledge` with file, note, website, or Connection as plain choices;
- a small `Learned` filter/section;
- a per-item sentence explaining relevance or scope;
- stale/needs-attention shown only when action is required.

Advanced `Manage` view:

- provenance and exact source;
- workspace/project/conversation scope;
- sync/refresh state;
- trust classification;
- indexing lifecycle;
- connector identity;
- retention, disable, remove, export.

Per-teammate detail should say `What Researcher knows` and allow simple include/remove choices. The runtime continues to enforce exact scope, provenance, trust, and retrieval rules; the everyday user does not need to see database vocabulary.

### Knowledge rules to freeze

1. Knowledge is information that may be consulted.
2. Learned context is deliberate, inspectable, editable, and removable—not invisible personality drift.
3. Connections can supply Knowledge but are not Knowledge.
4. Deliverables are work products, not Knowledge by default.
5. Conversation context is temporary unless deliberately kept.
6. Every answer can expose “What did you use?” on demand.
7. Fable never silently promotes provider data or a model inference into durable Knowledge.

## 6. Connections: capability grants in human language

The current connector architecture correctly treats a Connection as authenticated authority with capabilities. The interface should compile that precision into a sentence a non-technical user can evaluate.

### Recommended default card

> **Gmail**  
> Read mail and search threads. Draft replies. Ask before sending.  
> `Ready`

Visible states:

- `Not connected`
- `Ready`
- `Needs attention`

Details on demand:

- whose account;
- shared or personal;
- what it can read;
- what it can prepare;
- what it can change;
- which actions always ask;
- which projects/teammates may use it;
- last successful use and health;
- disconnect/revoke.

### Integration architecture options

| Option | Shape | Benefit | Risk |
|---|---|---|---|
| Native-only | Fable builds every integration | Best UX and policy control | Cannot cover the long tail fast enough |
| MCP-first | Most integrations are external MCP servers | Broad and fast | Uneven quality, auth, safety and observability |
| Native core + MCP escape hatch | Typed first-party integrations for high-value systems; MCP for the long tail | Best balance | Requires a clear quality/trust label |

**Recommendation:** native core + MCP escape hatch. This matches current Grok direction: xAI documents built-in OAuth connectors, a catalogue, and custom MCP as three distinct layers ([Grok connectors](https://docs.x.ai/grok/connectors)).

Additional fallbacks may include provider-owned runtimes, OpenAPI/API actions, webhooks, import/export, browser assistance, and human handoff. They should never pretend to have the same assurance as a typed native connector.

### Connection rules to freeze

- Ask for outcomes and plain permissions; compile to exact scopes and constraints.
- Start read-only where useful.
- Drafting is distinct from sending/publishing.
- Shared teammate-owned accounts are visibly different from personal accounts.
- No secret appears in model context, ordinary settings, logs, exports, or fixtures.
- A connector being configured is not proof that its live provider path works.
- Provider writes remain exact, fresh, attributable, and fail closed.

## 7. Providers, subscriptions, and Auto routing

The user-facing mistake to avoid is treating every “account” as interchangeable.

### 7.1 Provider account taxonomy

| Account/runtime | What it supplies | Example |
|---|---|---|
| Fable-managed intelligence | Fable bills and routes approved model access | Fable credits / managed gateway |
| API provider account | Programmatic model access billed separately | OpenAI API, Anthropic Console |
| Consumer subscription | Product entitlement, not automatically API entitlement | ChatGPT, Claude, Grok plan |
| Sanctioned account-backed runtime | A provider-supported app/CLI session Fable can coordinate | Codex/ACP-style runtime where terms permit |
| Router | One endpoint/policy over several providers | OpenRouter or enterprise router |
| Local model/runtime | On-device or user-managed inference | Ollama-compatible/local engine |

OpenAI explicitly states that API service is billed and managed separately from ChatGPT ([OpenAI account guidance](https://help.openai.com/en/articles/8156019-is-api-usage-included-in-chatgpt-subscriptions-even-if-i-have-a-paid-chatgpt-account)). Anthropic states the same separation for Claude paid plans and Console/API access ([Anthropic account guidance](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)).

Fable should never imply that entering a ChatGPT or Claude consumer login creates generic API access. It may support a subscription only through a sanctioned, inspectable account-backed runtime with clear limits and terms.

### 7.2 Auto options

#### Option A — Provider router

Delegate routing to a provider/router service.

**Benefits:** fastest access to evolving model pools.  
**Costs:** weaker policy transparency; potential privacy/billing boundary surprises.

#### Option B — Deterministic Fable policy router, recommended

Fable evaluates capability, task complexity, quality, latency, cost, privacy, context size, tool support, provider health, user preference, and risk. It chooses only from routes the user has authorized.

**Benefits:** Fable owns trust and explanation; supports managed, BYOK, subscription-backed, router, and local paths.  
**Costs:** ongoing evaluation and routing-quality work.

#### Option C — User pins every model

**Benefits:** maximum direct control.  
**Costs:** turns every user into a model operator; poor resilience and accessibility.

**Recommendation:** Option B, with exact pinning available in Advanced.

Cursor’s current router illustrates both useful ideas and trade-offs: Auto offers Cost, Balance, and Intelligence modes; administrators can constrain the pool; underlying model display may be shown or hidden ([Cursor Router](https://cursor.com/docs/cursor-router)). Fable should borrow the simple modes but default to honest model attribution because cross-provider privacy, billing, and subscription boundaries are central to its promise.

### 7.3 User experience

Default composer:

> `Auto · Balanced`

While working:

> `Using GPT-5.6 Terra for planning`  
> `Using Claude Sonnet for the contract review`  
> `Local model handling private extraction`

Details:

- requested route and actual route;
- why it was chosen;
- fallback history;
- provider/account used;
- execution location;
- privacy boundary;
- input/output usage and estimated cost;
- model/version identity;
- per-worker route for multi-agent work.

Hard rules:

- no silent crossing of privacy, billing, account, execution-location, or provider constraints;
- no silent downgrade that changes the task contract;
- fallback must remain inside declared policy;
- exact model remains an expert override, not the primary everyday decision.

## 8. Fable History and Git/Origin interoperability

Non-technical users need recovery and collaboration even when they never learn Git. Technical users and coding agents need real Git interoperability. Those are related requirements, not the same interface.

### Option A — Native Fable History plus Git-compatible project repositories, recommended

Fable owns a friendly history for deliverables, project configuration, teammate definitions, Knowledge changes, routines, and published states. Code projects may use real Git repositories under the hood or alongside that history.

User-facing actions:

- `Save version`
- `Compare`
- `Restore`
- `Try as draft`
- `Publish`
- `Export`
- `Connect GitHub/Origin`

Technical detail can reveal commit, branch, remote, diff, and conflict state.

**Benefits:** works for everyone; preserves true Git for code; keeps audit/history distinct from source control.  
**Costs:** requires canonical ownership rules and adapters between Fable objects and repos.

### Option B — Fable snapshots with on-demand Git export

Fable stores versions; export creates a repository/bundle only when requested.

**Benefits:** smaller MVP and simple source of truth.  
**Costs:** weak continuous collaboration with GitHub/Origin; round-trip imports require careful mapping.

### Option C — Explicit bidirectional mirror

The user chooses Fable, GitHub, or Cursor Origin as the source of truth; Fable continuously mirrors with visible divergence and conflict handling.

**Benefits:** strong external collaboration.  
**Costs:** complex conflicts, permissions, webhooks, large files, hooks, secrets, deleted history, and provider-specific semantics.

### Option D — CRDT/content-addressed universal document layer

**Benefits:** rich multiplayer and offline convergence.  
**Costs:** large architectural commitment; does not replace Git for code or audit history.

**Recommendation:** start with A. B is a valid first delivery slice. Add C only with an explicit source-of-truth choice. D belongs to a later rich-collaboration programme.

Cursor Origin is a useful interoperability target, not a dependency: it is an early-beta Git forge that supports standard clone/push/pull, GitHub mirroring, code browsing, pull requests, and agent/automation integration ([Cursor Origin](https://cursor.com/docs/origin)). Fable should interoperate through ordinary Git semantics and documented APIs rather than copy Origin-specific concepts into its core ontology.

### History planes must remain separate

- **Fable History:** user-facing versions and recovery.
- **Git history:** code/content repository lineage.
- **Action history:** who/what acted, under which authority, with which result.
- **Knowledge lineage:** where information came from and how it changed.
- **Provider route trace:** which intelligence/runtime performed work.

Trying to collapse these into one “activity log” will produce both poor UX and weak evidence.

## 9. Teammates, groups, departments, and work

### Recommended model

- A teammate is durable and can participate in many conversations.
- A conversation can include a human, one teammate, or several teammates.
- Fable may create run-scoped specialists behind the scenes; they need not become permanent teammates.
- A user can promote a useful specialist into a teammate.
- A department is shared context, policy, quality bars, Knowledge, Connections, authority, and routines—not a mandatory fixed chart.
- A plan appears only when work is complex enough to benefit from review.
- Active work exposes progress, evidence, provider attribution, costs, approvals, blockers, and stop/redirect controls.

### Team-shape options

| Option | Everyday experience | Best for | Risk |
|---|---|---|---|
| Fixed org chart | Departments contain named permanent agents | Stable repeated operations | Rigid and configuration-heavy |
| Dynamic hidden workers | One teammate delegates invisibly | Casual work | Can hide cost, responsibility and route truth |
| Durable teammates + inspectable dynamic workers | User relates to teammates; Fable creates bounded workers when needed | Fable’s full range | Requires a clear work-detail model |

**Recommendation:** durable teammates + inspectable dynamic workers.

Relevance AI’s explicit Agents/Tools/Workforces/Knowledge model is useful for advanced builders, and its workforce can use AI-selected or fixed handoffs ([Relevance AI](https://relevanceai.com/docs/build/introduction), [Workforces](https://relevanceai.com/docs/get-started/core-concepts/workforces)). Fable should borrow the internal separation and human-in-the-loop controls, but keep the visual graph out of the everyday product.

Grok Build demonstrates the expert version: plan approval, diffs, subagents in worktrees, saved workflows, phases, budgets, and per-agent progress ([Grok Build](https://x.ai/news/grok-build-cli), [Workflows](https://x.ai/news/workflows)). Those mechanics belong in Fable’s advanced work inspector and engineering experiences—not the first screen of a general-purpose teammate.

## 10. Routines and automation

### Creation paths

1. `Make this repeat` after successful work.
2. `Teach this task` by demonstration.
3. Natural language: “Every weekday at 8, do this.”
4. Start from a small template.
5. Advanced editor for deterministic triggers, inputs, approvals, destinations, and failure policy.

### Trigger families

- schedule;
- inbound message/email;
- Connection event;
- file/data change;
- project/work state;
- webhook/API;
- manual run;
- another approved routine/work completion.

### Routine contract

- name and plain instruction;
- owner and participants;
- trigger(s);
- Connections and Knowledge it may use;
- authority/approval policy;
- model/routing policy;
- execution location;
- notification/destination;
- failure/retry/escalation;
- pause/active state;
- test run;
- full resumable run history.

Every routine run should be a normal conversation/work record the user can open, question, continue, or turn into a revised routine.

## 11. Approval and trust model

### Plain risk ladder

| Level | User meaning | Default treatment |
|---|---|---|
| Observe | Read/search permitted information | May run within granted scope |
| Prepare | Draft, plan, stage, or preview | May run; nothing external changes |
| Act | Send, publish, update, purchase, deploy | Ask according to exact policy and risk |
| High impact | Destructive, financial, legal, identity, security, broad audience | Fresh exact approval immediately before effect |

The user can write a simple rule:

> When the finance teammate prepares invoices under £500 for approved customers, allow the draft but ask before sending.

Fable compiles this into exact identities, accounts, capabilities, destinations, amounts, object versions, expiry, and conflict rules. The advanced view shows the compiled policy.

### Approval invariants

- Bind approval to the exact proposed action and immutable preview.
- Consume one-time approvals once.
- Revalidate authority immediately before egress.
- Show account, destination, content, attachments, amount, audience, and irreversible consequences.
- Never let a prompt, memory, provider response, or connector claim grant authority.
- Narrow standing rules by capability, account, project, teammate, risk, value, destination, and time.
- Ask-first wins policy conflicts.
- Keep model review separate from human acceptance.

Grok Bot’s natural-language rules are the right user-facing direction. Fable’s current fail-closed prepared-action architecture is the stronger execution foundation.

## 12. Computer and execution model

Fable should offer a single friendly concept—`Computer`—with explicit placement beneath it.

| Location | Promise | Key boundary |
|---|---|---|
| This device | Uses local files/apps with local credentials and direct supervision | Device availability and local permission |
| Private Fable computer | Persistent hosted workspace isolated for the user/team | Data movement, hosted credentials, cost and reset/recovery |
| Connected runtime | Uses a sanctioned provider/CLI/agent runtime | Provider entitlement, terms and runtime-specific authority |
| Browser handoff | User takes over or approves interactive steps | Session identity and sensitive input |

The active-work view should state location, network reach, active accounts, files transferred, persistence, and stop/reset consequences. A computer is an execution node, not a universal permission bypass.

## 13. Mascot and teammate identity

The Fable mascot should be original, provider-neutral, unmistakably non-human, and useful at 16 px as well as in onboarding animation.

### Direction A — Threadfold companion, recommended

An abstract companion combining a folded page/bookmark, a single continuous thread, and a warm lantern-like centre.

**Why it fits:** “Fable” without literal storybook clichés; thread suggests continuity and collaboration; fold suggests memory/version; light suggests intelligence and guidance.  
**Risk:** can drift into generic productivity-logo territory unless the silhouette has character.

### Direction B — Lantern/firefly

A small luminous guide with a soft body and expressive movement.

**Why it fits:** warmth, navigation, many companions, clear working/attention states.  
**Risk:** common AI visual territory and may become childish.

### Direction C — Chorus/constellation

A central companion composed of several orbiting marks that join or separate as teammates collaborate.

**Why it fits:** communicates many intelligences acting as one team.  
**Risk:** weak at tiny sizes and may feel technical/cosmic rather than human.

### Identity system

- One parent Fable mark/mascot.
- Teammates inherit a consistent face/anatomy or motion grammar.
- Role is expressed with a secondary glyph, accessory, label, and optional colour—not colour alone.
- Custom generation/upload is advanced, as in Grok Bot.
- Provider identity remains a separate small attribution; never dress a Fable teammate as a provider logo.
- States: idle, listening, thinking, working, waiting for approval, complete, blocked, offline.
- Reduced-motion alternatives and non-colour state cues are mandatory.

The next mascot step should be a deliberate visual exploration with three original families, silhouette tests at app-icon/sidebar sizes, state sheets, monochrome tests, and a selection gate before production assets.

## 14. Competitor landscape: what to borrow and what to reject

| Product | Useful lesson | Do not import as the default |
|---|---|---|
| Grok Bot | Durable teammates, own computer, group chat, conversation-first creation, routines, demonstration, sparse shell | Opaque model routing; immediate persistent drafts; plugin/connector conflation |
| Grok Automations | Describe once; schedules/triggers; each run is a resumable conversation | Automation as a separate destination before the user has done the work |
| Grok Build | Plan/review/approve, diffs, worktrees, parallel specialists, saved workflows, detailed progress | Engineering vocabulary for general users |
| OpenAI Workspace Agents | Prompt-to-plan builder, preview before publish, drafts versus published versions, RBAC, app action constraints, user-owned versus agent-owned accounts | Builder/studio complexity in the everyday chat shell |
| OpenAI Frontier | Shared context, onboarding, feedback, permissions and boundaries as coworker infrastructure | Enterprise administration as the product identity |
| Cursor | Auto routing modes, route constraints, worktrees/checkpoints, Git-native interoperability, Origin | Repo metaphors for email, finance, life administration, or ordinary documents |
| Claude Projects/skills | Bounded project context, reusable instructions/skills, familiar conversation | Invisible memory or context whose scope is unclear |
| Manus | Projects and saved skills as reusable successful processes | Over-reliance on generic project buckets |
| Lindy | Human-in-the-loop steps, workflow history, repeatable operating flows | Graph-first setup and agent-builder taxonomy for first-time users |
| Relevance AI | Clear internal separation of agents, tools, workforces and Knowledge; configurable approvals | Permanent workforce canvas as the main interaction |
| Devin | Inspectable engineering execution and durable task history | Coding-task ontology as a general business ontology |

Primary references used:

- [Grok connectors](https://x.ai/news/grok-connectors)
- [Grok Automations](https://x.ai/news/grok-automations)
- [Grok Build](https://x.ai/news/grok-build-cli)
- [Grok Build Workflows](https://x.ai/news/workflows)
- [Grok Build Mode](https://x.ai/news/grok-build-mode)
- [OpenAI Workspace Agents](https://help.openai.com/en/articles/20001143)
- [OpenAI Frontier](https://openai.com/index/introducing-openai-frontier/)
- [Cursor Router](https://cursor.com/docs/cursor-router)
- [Cursor Origin](https://cursor.com/docs/origin)
- [Manus Projects](https://manus.im/docs/features/projects)
- [Manus Skills](https://manus.im/docs/features/skills)
- [Lindy introduction](https://docs.lindy.ai/fundamentals/lindy-101/introduction)
- [Relevance AI builder](https://relevanceai.com/docs/build/introduction)

## 15. Decision mastermap

These decisions should be made in order because later choices depend on earlier ontology.

| # | Decision | Option A | Option B | Option C | Recommendation |
|---:|---|---|---|---|---|
| 1 | Primary relationship | Generic assistant | Durable teammate | Task/agent builder | Durable teammate |
| 2 | Main shell | Chat list only | Chat + contextual Work/Knowledge/Connections | Four-area dashboard | Contextual Fable core |
| 3 | Later teammate creation | Immediate persistent Bot | Reversible conversational draft | Full builder form | Reversible conversational draft |
| 4 | Multi-agent work | Fixed department graph | Group conversation + dynamic workers | Hidden delegation only | Group conversation + inspectable workers |
| 5 | Knowledge | Three storage tabs | Knows + learned | One everyday list + advanced management | One everyday list |
| 6 | Deliverables | Knowledge artifacts | Conversation attachments | Separate durable work products | Separate deliverables |
| 7 | Connections | Native only | MCP first | Native core + MCP escape hatch | Native core + MCP |
| 8 | Repetition | Schedules page | Promote work to routine | Workflow canvas | Promote work; advanced editor later |
| 9 | Model choice | Exact model default | Provider router | Fable Auto with exact override | Fable deterministic Auto |
| 10 | Subscription support | API keys only | Treat consumer plans as APIs | Explicit provider/API/subscription/runtime taxonomy | Explicit taxonomy |
| 11 | Version control | Git everywhere | Fable snapshots only | Fable History + Git interop | Fable History + Git |
| 12 | Execution | Local only | Cloud computer only | Location-aware execution nodes | Location-aware nodes |
| 13 | Approvals | Per-tool toggles | Natural-language rules only | Plain rules compiled to exact policy | Compiled exact policy |
| 14 | Mascot | Independent arbitrary avatars | One fixed mascot | Fable family + role layers + custom depth | Fable family |

### Recommended dependency order

1. Freeze the visible ontology and canonical object ownership.
2. Choose the shell/navigation direction.
3. Decide Knowledge and Deliverable separation.
4. Decide Connection capability language and trust labels.
5. Define teammate, dynamic worker, group, project, and department relationships.
6. Define Fable History and Git source-of-truth rules.
7. Define provider-account taxonomy and deterministic Auto policy.
8. Define execution-location and approval contracts.
9. Validate onboarding, routine promotion, and active-work disclosure.
10. Select the mascot family.
11. Write the repository operating contract (`AGENTS.md`).
12. Only then begin implementation in bounded slices.

## 16. AGENTS.md: what “immaculate” should mean

No `AGENTS.md` exists in this checkout or its repository ancestors as of this audit.

Creating it before the ontology decisions would freeze unresolved product language. Once those decisions are approved, the file should be short, authoritative, and testable—not a second giant product blueprint.

Recommended sections:

1. **Authority order** — exact source documents and precedence.
2. **Product promise and visible ontology** — canonical user-facing nouns and prohibited leakage.
3. **Progressive disclosure** — everyday, contextual, advanced, internal.
4. **Evidence labels** — implemented, fixture-tested, configured, development-live, production-integrated, release-gated.
5. **Knowledge/learned context/deliverable boundaries.**
6. **Provider/Connection/subscription/runtime boundaries.**
7. **Approvals and external effects** — exact, fresh, attributable, fail closed.
8. **Security and secrets** — credential ownership, vaulting, logs, exports, fixtures.
9. **UI standards** — calm hierarchy, plain language, accessibility, empty/loading/error states, screenshot comparison.
10. **Testing and evidence** — fixtures cannot prove providers; live tests are bounded and labelled.
11. **Worktree safety** — preserve dirty work, avoid destructive resets, isolate broad changes.
12. **Documentation and release gates** — update authority docs without inflating claims.

Every rule should either prevent a known failure mode or point to an authority document. Avoid duplicating low-level style guides that linters and formatters can enforce.

## 17. Design and validation programme before implementation

### Gate 1 — Ontology selection

Approve or revise the recommended visible nouns and relationships. No screen work should compensate for an unresolved object model.

### Gate 2 — Three shell directions

Use identical realistic content in three visual prototypes:

- **A: Grok-faithful** — one teammate/chat list; all Fable depth is contextual.
- **B: Fable core** — same calm list plus quiet Knowledge, Connections, and contextual Work.
- **C: Operator mode** — active work and approvals receive more persistent space for business-running users.

Compare the same tasks:

1. Ask for a one-off result.
2. Add Gmail read access and draft a reply.
3. Turn successful work into a routine.
4. Ask two teammates to collaborate.
5. Inspect what Knowledge and models were used.
6. Approve a consequential action.
7. Find, compare, restore, and export a deliverable version.

### Gate 3 — Knowledge comprehension

Test with an older, non-technical user and at least one expert user. Success criteria:

- can add something Fable should know;
- can tell the difference between reference material and something Fable learned;
- can remove or correct it;
- can understand whether it applies everywhere or only here;
- can answer “why did Fable use this?”;
- never needs the words source, chunk, embedding, artifact, scope, sync cursor, or provenance to complete the task.

### Gate 4 — Connection and approval comprehension

Before authorization, users should correctly predict:

- what Fable can read;
- what it can draft;
- what it can change;
- which identity/account acts;
- when it will ask;
- how to revoke it.

### Gate 5 — Auto trust

Test whether users understand:

- Auto is a policy, not one model;
- which model/provider actually ran;
- what it cost;
- where data went;
- whether a fallback occurred;
- how to pin a provider without becoming a model administrator.

### Gate 6 — Architecture spikes

In isolated branches/worktrees only:

- Fable History object/version contract;
- Git export/import and Cursor Origin/GitHub round trip;
- deterministic routing receipt and constraint enforcement;
- native Connection capability compiler;
- dynamic worker trace beneath a durable teammate;
- no product-wide build before each spike proves its contract.

### Gate 7 — Mascot selection

Generate three original families, evaluate silhouette, small-size readability, animation states, accessibility, role differentiation, and trademark similarity, then stop for selection before production assets.

## 18. Recommended north-star journeys

### A. One helpful task

The user opens Fable, describes what they need, and receives a useful answer. No project, department, routine, or model choice is required.

### B. Personal delegation

The user says, “Help me keep on top of important email.” Fable explains what Gmail access would allow, connects read access, drafts without sending, learns the user’s stated preferences, and offers “make this a routine” after value is proven.

### C. Co-thinking

The user and one teammate explore an ambiguous decision. Fable cites the Knowledge used, introduces a specialist only when useful, preserves decisions and versions of the recommendation, and lets the user continue naturally.

### D. Team of agents

The user starts a group conversation with Product, Engineering, and Marketing teammates. Fable creates bounded workers as needed, shows a plan only because the task is complex, attributes each route, gathers evidence, asks for decisions, and returns coherent deliverables rather than a pile of agent transcripts.

### E. Running a business

Departments contribute standards, authority, Connections, and Knowledge. Routines react to schedules and business events. Fable’s chief-of-staff teammate coordinates work, surfaces only exceptions and decisions, preserves action and version history, and never performs high-impact actions outside the user’s policy.

### F. Portable creation

A non-technical user builds an app or document in Fable History, restores an earlier version, then exports it. A technical collaborator can connect the same project to GitHub or Cursor Origin with an explicit source of truth and no loss of Fable’s friendly version interface.

## Final recommendation

Choose **Fable core** as the direction:

- Grok Bot’s teammate/conversation simplicity;
- one extremely simple `What Fable knows` experience;
- Connections described as plain capability grants;
- work, approvals, routes, costs, and computers surfaced contextually;
- Fable History for everyone, true Git interoperability for code and technical collaboration;
- durable teammates with inspectable dynamic workers;
- routines promoted from successful work and demonstrations;
- deterministic Auto routing with honest live attribution;
- an original Fable mascot family;
- advanced control available at every layer but never required for ordinary value.

Do not redesign individual pages yet. First freeze the ontology and choose among the three shell directions. That decision determines the Knowledge surface, active-work behavior, version system, teammate identity, and the future `AGENTS.md` contract.
