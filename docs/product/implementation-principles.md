# Implementation Principles

These are the implementation rules for Fable while it is becoming a real open-source, local-first workspace.

## 1. Local First Is The Default

Private user work starts on the device. Local files, drafts, approvals, memory, snapshots, schedules, connector cache, and provider state should be usable without a hosted Fable account unless a feature truly requires hosted coordination.

## 2. Secrets Stay Behind Native Boundaries

Credentials must not enter React state, logs, screenshots, runtime snapshots, exported memory, connector fixtures, or local JSON state. JavaScript can see auth state and capability metadata; Rust or another native boundary owns secret lookup and egress.

## 3. Fail Closed, Then Explain

Missing credentials, missing provider setup, unsupported actions, unknown tools, invalid approvals, and unavailable runtimes must fail closed. The user-facing state should say what is missing without pretending the connection exists.

## 4. Approvals Are Product Infrastructure

Every consequential action goes through the approval system: writes, shell commands, publishing, sending, deleting, spending, external posts, and private-data sharing. The main UI uses Read Only, Ask Me, Work Freely, and Custom rather than internal policy vocabulary. High-risk tool calls and connector writes require a fresh decision for the exact action. Native execution checks still bind the service, action, mode, risk, data preview, freshness, and one-time permit immediately before the side effect.

## 5. Fixtures Must Look Like Fixtures

Fixture data is allowed for preview, tests, and design validation. It must be labeled and kept out of live credential, account, connector, or provider claims.

## 6. Open Adapters Over Closed Integrations

Backends, connectors, model providers, and tools should be adapter-shaped. Keep protocol types stable, keep provider-specific logic isolated, and make future community adapters possible without rewriting the shell.

## 7. Memory Needs Provenance

Memory should separate facts, preferences, inferences, and imported content. Durable memory requires user control, source provenance, freshness, pinning, disable/export/forget paths, and approval when promoted from untrusted knowledge.

## 8. Product Code Should Match Product Copy

Do not describe a feature as live until the files prove it. If a path is fixture-backed, local-only, preview-only, planned, or fail-closed, say that clearly in UI, docs, tests, and release notes.

## 9. Keep The Core Small

Prefer plain files, typed protocol objects, narrow Rust commands, and focused React components. Add abstractions only when they reduce real duplication or create a stable adapter boundary.

## 10. Verify Before Publishing

Before claims, releases, or public docs, check the current files and run the relevant gates. At minimum, keep typecheck, tests, build, Tauri check, Rust tests, clippy, and formatting aligned with the package manager and platform.

## Evidence Checked

- `docs/product/thesis.md`
- `docs/product/architecture.md`
- `docs/product/connectors.md`
- `docs/security/threat-model.md`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src-tauri/src/connectors.rs`
- `apps/desktop/src-tauri/src/backends.rs`
- `apps/desktop/src-tauri/src/tools.rs`
- `packages/protocol/src/index.ts`
- `packages/connectors/src/native-api/tool-executor.ts`
