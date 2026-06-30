# Fable Vision

Fable is an open-source, local-first AI workspace for real work. The product ambition is to make the coding-agent model useful across the whole computer: files, projects, cloud tools, memory, schedules, and long-running work, without turning the user into a passenger.

The north star is a workspace where a person can describe an outcome, give bounded permission, watch the agent gather context and take action, and keep durable ownership of the result. Fable should feel like talking to your computer, not renting a hidden SaaS workflow.

## What Fable Should Become

Fable should be the user's local command center for delegated work:

- A universal composer for chat, files, tools, slash commands, voice (planned/future capability), models, and permission level.
- A backend-neutral agent runtime that can use subscriptions, API keys, and eventually local models without locking the workspace to one provider.
- A connector system where GitHub, Vercel, Google Drive, Notion, Gmail, Slack, Calendar, local files, and future community adapters are explicit bridges with scopes, health, provenance, and removal paths.
- A memory and knowledge layer where sources are inspectable, pinned context is deliberate, and durable memory is approved instead of silently inferred forever.
- An approval system where every write, publish, spend, delete, shell command, external post, or private-data share is understandable before it happens.
- A schedule and automation surface for recurring agent work, with the same approval and audit rules as manual work.

## Product Shape

Fable starts as a calm desktop workspace, not a dashboard. The first screen should invite the user to ask for work, then reveal power through context: add a file, connect a tool, choose a model, lower or raise permissions, pin a source, approve an action, or schedule a follow-up.

The product should be understandable to non-developers while still strong enough for code, operations, research, writing, and personal workflow tasks. Technical power belongs behind plain controls and inspectable records.

## Open-Source Position

Fable should be open in the parts that matter:

- Protocol types, adapter contracts, runtime boundaries, and approval semantics should be visible and reusable.
- Provider integrations should be replaceable modules, not product lock-in.
- Local data formats should be documented enough that users can export, inspect, migrate, or repair their workspace.
- Security-sensitive paths should be boring, narrow, and reviewable.

## Local-First Position

Local-first means the desktop runtime is the authority for private work. Secrets do not belong in React state. Local files, memory, approvals, snapshots, and connector caches should be stored on-device first, encrypted where appropriate, and synced only when the user chooses a shared or hosted feature.

Hosted services can help with auth brokering, collaboration, downloads, or optional sync, but they should not be required for the core local workspace to remain useful.

## Non-Goals

Fable should not become:

- A hidden automation engine that acts without visible approval.
- A hosted-only assistant where user work is trapped behind a cloud account.
- A connector marketplace that treats missing credentials as connected.
- A memory system that mixes facts, guesses, and stale imports without provenance.
- A model wrapper whose only differentiator is a prettier chat box.

## Evidence Checked

This vision is grounded in the current thesis, roadmap, architecture, connector, security, runtime, and desktop shell files:

- `docs/product/thesis.md`
- `docs/product/roadmap.md`
- `docs/product/architecture.md`
- `docs/product/connectors.md`
- `docs/security/threat-model.md`
- `packages/protocol/src/index.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src-tauri/src/lib.rs`
