# Implementation Principles

These rules support the [product direction](vision.md), accepted ADRs, and the
current maturity boundaries in the root `README.md`.

## 1. Local Execution And Hosted Identity Have Separate Jobs

Fable requires a hosted account for identity and session, while private execution and sensitive local data prefer the desktop. Local files, provider credentials, connector credentials, local models, private interactive work, and OS-level control stay behind native boundaries unless the user explicitly chooses an eligible hosted execution path. Convex may own shared workspace state under the documented authority matrix; it does not replace encrypted SQLite or broaden data routing implicitly.

## 2. Secrets Stay Behind Native Boundaries

Credentials must not enter React state, logs, screenshots, runtime snapshots, exported memory, connector fixtures, or local JSON state. JavaScript can see auth state and capability metadata; Rust or another native boundary owns secret lookup and egress.

## 3. Fail Closed, Then Explain

Missing credentials, missing provider setup, unsupported actions, unknown tools, invalid approvals, and unavailable runtimes must fail closed. The user-facing state should say what is missing without pretending the connection exists.

## 4. Approvals Are Product Infrastructure

Every consequential action goes through the approval system: writes, shell commands, publishing, sending, deleting, spending, external posts, and private-data sharing. The main UI uses Read Only, Ask Me, Work Freely, and Custom rather than internal policy vocabulary. High-risk tool calls and connector writes require a fresh decision for the exact action. Native execution checks still bind the service, action, mode, risk, data preview, freshness, and one-time permit immediately before the side effect.

## 5. Fixtures Must Look Like Fixtures

Fixture data is allowed for preview, tests, and design validation. It must be labeled and kept out of live credential, account, connector, or provider claims.

## 6. Portable Adapters Over Vendor Lock-In

Backends, connections, model providers, and tools should be adapter-shaped. Keep Fable-owned protocol types stable, keep provider-specific logic isolated, and preserve replacement paths without rewriting the shell.

## 7. Memory Needs Provenance

Memory should separate facts, preferences, inferences, and imported content. Durable memory requires user control, source provenance, freshness, pinning, disable/export/forget paths, and approval when promoted from untrusted knowledge.

## 8. Product Code Should Match Product Copy

Do not describe a feature as live until the files prove it. If a path is fixture-backed, local-only, preview-only, planned, or fail-closed, say that clearly in UI, docs, tests, and release notes.

## 9. Keep The Core Small

Prefer plain files, typed protocol objects, narrow Rust commands, and focused React components. Add abstractions only when they reduce real duplication or create a stable adapter boundary.

## 10. Verify Before Publishing

Before claims, releases, or public docs, check the current files and run the relevant gates. At minimum, keep typecheck, tests, build, Tauri check, Rust tests, clippy, and formatting aligned with the package manager and platform.

## Related current sources

- `README.md`
- `docs/product/vision.md`
- `docs/product/connectors.md`
- `docs/security/threat-model.md`
- `apps/desktop/src/runtime.ts`
- `apps/desktop/src-tauri/src/connectors.rs`
- `apps/desktop/src-tauri/src/backends.rs`
- `apps/desktop/src-tauri/src/tools.rs`
- `packages/protocol/src/index.ts`
- `packages/connectors/src/native-api/tool-executor.ts`
