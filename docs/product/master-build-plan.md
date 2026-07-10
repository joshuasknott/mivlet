# Fable Master Build Plan

Last updated: 2026-07-10.

## Product invariants

- A hosted, Clerk-backed Fable account and one provider are mandatory for normal use.
- A Personal Home serves solo work; a Team Workspace is a multi-person environment.
- Projects are optional containers for chats, knowledge, connectors, artifacts, runs, and instructions.
- Knowledge, memory, connectors, workflows, schedules, departments, custom agents, teams, voice, browser use, and mobile access are optional layers.
- Providers, connector credentials, approvals, and Fable identity are separate trust boundaries.
- Departments package complexity; they must not expose orchestration by default.
- Every consequential action must be attributable, approved when required, and auditable.
- A feature may be called supported only after a real live-validation path exists.

## Status vocabulary

- **Proposed:** product idea only.
- **Feasibility confirmed:** official bridge and constraints are known.
- **Contract defined:** data, permission, and execution rules are decided.
- **Foundation:** code exists but no complete user journey.
- **Functional locally:** end-to-end local path works.
- **Live validated:** checked with a real provider or service account.
- **Release ready:** secure, documented, recoverable, and supportable.

## Ordered milestones

### 0. Establish and preserve the baseline

- [x] Record the current repository state and provider/runtime foundations.
- [x] Integrate the current provider overhaul with the Clerk, Convex, Ollama, OAuth, and schedule foundations.
- [ ] Keep product status, architecture, release, and marketing documentation consistent with current evidence.
- [ ] Add a durable decision log and release-gate checklist.
- [ ] Maintain a clean `main` baseline before opening parallel feature worktrees.

### 1. Mandatory hosted identity and tenancy

- [x] Clerk public-client PKCE/keyring foundation.
- [x] Convex schema, policy tests, device and local outbox foundations.
- [ ] Complete Clerk production configuration and live claim validation.
- [ ] Make sign-in mandatory in onboarding and protected application routes.
- [ ] Implement account recovery, sign-out, session expiry, device revocation, export, and deletion.
- [ ] Create Personal Home for each account.
- [ ] Map Clerk Organizations to Fable Team Workspaces.
- [ ] Implement workspace invitations, roles, switching, and backend tenant enforcement.
- [ ] Define offline-session behaviour without weakening hosted-account enforcement.

### 2. Providers and models

- [x] Provider-first catalogue, native API, ACP, Codex app-server, custom endpoint, and local-loopback foundations.
- [ ] Complete live verification for each advertised provider and connection method.
- [ ] Keep provider categories explicit: API provider, account-backed runtime, router, local runtime, or custom endpoint.
- [ ] Finish provider-specific model discovery, availability, error recovery, and usage visibility.
- [ ] Never claim subscription reuse without an official runtime or sanctioned account route.

### 3. Core product spine and basic chat

- [ ] Replace fixture-shaped chats with durable conversation repositories.
- [ ] Make New Chat, history, recovery, streaming, cancellation, retry, and artifacts fully real.
- [ ] Complete user/workspace/project/chat/message/run/artifact persistence and migrations.
- [ ] Ensure a new signed-in user can connect one provider, complete work, close Fable, and continue later.
- [ ] Keep the normal composer simple; advanced provider controls remain optional.

### 4. Projects and multi-person workspaces

- [ ] Create personal and workspace projects.
- [ ] Scope project instructions, knowledge, connectors, artifacts, goals, and schedules.
- [ ] Complete shared workspace projects, activity, member attribution, pending/accepted sync state, conflicts, and tombstones.
- [ ] Ship the first Convex-backed shared-project vertical slice before broad collaboration features.

### 5. Trust, knowledge, and memory

- [x] Local encrypted storage, keyring separation, exact approval permits, audit history, knowledge/memory foundations.
- [ ] Apply workspace and project policy boundaries consistently across every execution surface.
- [ ] Complete semantic retrieval with a real embedding path and ACL filtering.
- [ ] Distinguish private, project, workspace, and department knowledge/memory.
- [ ] Make sources, memory, citations, export, edit, disable, and deletion easy to understand.

### 6. Universal connector platform

- [x] First-wave connector contracts, OAuth foundations, local cache lifecycle, and fail-closed states.
- [ ] Define semantic capabilities such as `documents.read`, `email.draft`, `calendar.create`, `crm.read`, and `deployment.execute`.
- [ ] Complete deployment and live validation for the auth broker and each OAuth provider.
- [ ] Add connection ownership, project grants, workspace grants, health, rate limits, sync, webhooks, audit, and recovery.
- [ ] Separate live, beta, experimental, import-only, planned, and unsupported integrations in the product.

### 7. Connector expansion

- [ ] Productivity: Google, Microsoft 365, Slack, Notion, Dropbox, Box, Calendly, Zoom, DocuSign.
- [ ] Product and engineering: GitHub, GitLab, Linear, Jira, Figma, Vercel, Cloudflare, Netlify, Convex, Supabase, Neon, Sentry, PostHog.
- [ ] Sales and support: HubSpot, Salesforce, Attio, Zoho, Pipedrive, Intercom, Zendesk, Fireflies, Granola.
- [ ] Marketing and commerce: GA4, Search Console, Meta, Instagram Business, LinkedIn, X, YouTube, Mailchimp, Klaviyo, Webflow, WordPress, Shopify, Resend.
- [ ] Finance and legal: Stripe, QuickBooks, Xero, Ramp, DocuSign, and selected specialist systems after feasibility and approval review.
- [ ] Messaging and regional platforms only through official business APIs; never through consumer-session scraping.

### 8. Workflows, playbooks, and schedules

- [x] Durable local schedules, retries, runs, and workflow storage foundations.
- [ ] Fix connector-to-prompt dataflow so every workflow step receives its declared inputs.
- [ ] Add typed inputs/outputs, artifacts, versioning, human waits, retries, branching, parallel steps, sub-workflows, and run inspection.
- [ ] Present guided workflows first; keep graph editing as an advanced surface.
- [ ] Bind schedules and events to versioned workflows, not standalone opaque prompts.

### 9. Minimalist departments

- [ ] Build internal role and team contracts before exposing custom builders.
- [ ] Deliver General, Product, Marketing, Sales, and Customer Support as ready-made work areas.
- [ ] Add Finance and Legal only with appropriate evidence, controls, and professional-review boundaries.
- [ ] Make each department show one primary ask, suggested workflows, active work, outputs, and approvals.
- [ ] Label simulations as hypotheses, never as real customer or professional evidence.

### 10. Browser and computer use

- [ ] Build an isolated browser with safe sessions, visual/structural inspection, screenshots, downloads, action trace, approvals, and takeover.
- [ ] Build Windows computer use with application allowlists, accessibility-first control, visual fallback, protected secret fields, and emergency stop.
- [ ] Prefer a connector or API where it is safer than browser automation.

### 11. Mobile companion and remote execution

- [ ] Build a mobile-first web companion/PWA, not a raw remote desktop mirror.
- [ ] Add Clerk sign-in, QR pairing, a secure relay, host selection, notifications, approvals, chats, artifacts, and run review.
- [ ] Keep local files, credentials, and execution on the paired host unless a managed runner is explicitly selected.
- [ ] Add managed and customer-hosted runners for 24/7 schedules, webhooks, and future deployed agents.

### 12. Voice in Fable

- [ ] Deliver editable streaming dictation as a distinct text-entry mode.
- [ ] Deliver full-duplex Jarvis/live voice as a distinct conversation mode that delegates work to the standard run system.
- [ ] Keep visual transcript, interruption, action confirmation, privacy controls, and provider abstraction central.
- [ ] Add GPT-Live only when a supported API route exists; use current realtime adapters without coupling Fable to one provider.

### 13. Advanced agent products

- [ ] Expose custom agents with independent model/provider, knowledge, capabilities, policies, limits, and artifact contracts.
- [ ] Expose agent teams with explicit coordination and artifact handoffs.
- [ ] Build the deployable Voice Agent Builder after managed execution, workflows, knowledge, connector tools, guardrails, observability, telephony/SIP, human handoff, consent, and billing controls are ready.

### 14. Extensibility and release readiness

- [ ] Add trusted local and remote MCP support with per-tool approval and project/workspace scoping.
- [ ] Add OpenAPI and webhook-based custom connector paths.
- [ ] Complete security review, privacy/deletion/export, backup/recovery, operational observability, accessibility, and load testing.
- [ ] Add signing, updater/rollback, supported platform packaging, closed alpha evaluation, and release gates.
- [ ] Decide open-source licensing separately; do not claim it before a licence and contribution policy exist.

## Execution rule

Work one numbered milestone at a time. For each milestone: define contracts,
implement a thin end-to-end journey, test it, run an independent review, update
this document and `status.md`, then open the next milestone.
