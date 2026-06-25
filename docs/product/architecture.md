# Architecture

## Stack

- Tauri 2 for the desktop shell.
- Rust for runtime commands, permissions, jobs, local context, and connector execution.
- React, TypeScript, and Vite for the interface.
- Convex for auth, realtime shared state, and collaboration state when configured.
- Encrypted SQLite for offline/private local state.
- OS secure storage for credentials.

## Runtime Boundaries

The UI talks to the runtime through typed protocol objects in `packages/protocol`.

Core domains:

- `Directive`: workspace-aware prompt starters that write into the universal composer.
- `ApprovalRequest`: consequence-aware approval prompts with once, session, rule, modify, and deny outcomes.
- `ApprovalAuditEntry`: local audit history for user decisions and resumable follow-up.
- `MemoryRecord`: facts, inferences, provenance, freshness, permissions, and user controls.
- `ConnectorManifest`: install/auth/permission/health metadata for bridges.
- `KnowledgeSource`: imported or indexed source metadata that can be pinned into context.
- `AutomationRule`: scheduled or event-driven workflow metadata with approval requirements.
- `RuntimeSnapshot`: resumable app state after restart.

Implemented runtime commands currently cover approval audit persistence, local text-file import, imported knowledge persistence, memory control state, memory export formatting, and lexical cited retrieval over workspace sources. Browser preview keeps matching fallbacks so the UI remains testable outside Tauri.

## Offline Behavior

- Composer drafts, selected context, imported knowledge, durable memory, approval audit history, and connector health cache stay local.
- Plugin actions requiring network or missing credentials queue as resumable jobs.
- Recovered sessions show what was pending, what completed, and what needs fresh approval.

The current desktop preview implements approval audit, imported-knowledge, and memory-control persistence in the Tauri app data folder, with browser storage for composer drafts, pinned sources, automation status, and preview fallback. The next storage step is moving those local JSON stores into encrypted SQLite and OS secure storage as live connectors are added.

## Convex Boundary

Convex is optional at local preview time. If `VITE_CONVEX_URL` is present, the UI can initialize a Convex client for realtime shared state. Without it, the app uses local fixtures and typed adapter boundaries.
