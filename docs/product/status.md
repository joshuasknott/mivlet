# Fable status

Last audited: 2026-07-29.

This is the factual state of the repository, not the product pitch or a
release-readiness claim. The approved final state remains in
[Product Blueprint](vision.md), the ordered programme remains in
[Master Build Plan](master-build-plan.md), and release gates remain in
[Release Readiness](release.md).

The complete 27 July implementation narrative was preserved byte-for-byte at
[Archived status — 27 July 2026](../archive/status-2026-07-27.md). It remains
historical evidence; this document is the current, deliberately compact view.

## Current repository state

- Fable remains a private pnpm monorepo with a Tauri 2, React, TypeScript, Vite,
  and Rust desktop application plus broker, marketing, waitlist, connector,
  Knowledge, and protocol packages.
- Native Tauri is the production authority. Browser preview is an explicit,
  development-only adapter, selected once and lazy-loaded; it cannot silently
  replace native behavior.
- Clerk supplies identity and session only. Fable owns internal users,
  workspaces, memberships, selection, and authorization. Workspace-owned
  commands derive scope from the current native account and an explicit active
  hosted selection.
- The encrypted SQLite store is schema v37. Forward SQLite migrations, foreign
  key validation, encrypted recovery backup/rollback, and credential-free
  portable export/import remain supported.
- Pre-v37 JSON ingestion and synthetic default-workspace authority are retired.
  Legacy files are ignored on v37 restart, production scheduler/workflow
  persistence is SQLite-only, and missing account/workspace selection fails
  closed. The historical `default` row remains only as an internal schema and
  recovery namespace for existing v37 data and backup markers.
- Connector manifests and projections carry an explicitly authorized workspace
  scope. Cross-workspace, missing-scope, stale-selection, and projection
  failures are covered.
- Runtime access is split into typed domain ports with stable façades and
  native/preview adapters. Shell runtime probes, Chat mission presentation
  state, and Settings preferences are separated by responsibility.
- Connector domains expose narrow subpaths. Source dependency cycles are
  eliminated, confirmed unused production files/dependencies are removed, and
  generated/boundary validation reduces unchecked production values.
- ESLint, scoped Prettier checks, Knip, Madge cycle checks, an explicit-`any`
  ratchet, pnpm production audit, and an expiry-dated RustSec policy are
  repository gates.
- Large Mission, coordination, and MCP Rust modules are decomposed along their
  existing domain boundaries without changing command registration, module
  privacy, persistence, replay, approval, or fail-closed semantics.
- Local and CI checks use one verified build pass rather than rebuilding the
  same packages through separate typecheck/build/final steps.

## Measured desktop payload

The current production build records:

| Metric | Before | Current | Change |
| --- | ---: | ---: | ---: |
| Initial desktop entry | 718,322 B | 609,277 B | -109,045 B |
| JavaScript and CSS | 1,551,792 B | 1,411,960 B | -139,832 B |
| CSS | 195,411 B | 195,056 B | -355 B |

Checked ceilings are unchanged or tighter: initial entry 614,399 B, aggregate
JavaScript/CSS 1,552,743 B, and CSS 195,410 B. Required startup behavior was
not moved behind artificial delays. Details and route-level measurements are in
[Cleanup and optimisation current report](../performance/cleanup-optimization-current.md).

## Evidence boundary

- **Repository-tested:** `pnpm check` passes, including TypeScript/protocol
  checks, all product builds and JavaScript suites, lint, format, dead-code,
  cycle, performance, release-manifest, native compile, and dependency audit
  policies. Rust format and strict all-target/all-feature Clippy pass; the full
  native suite reports 813 passed, zero failed, and one deliberately opt-in
  live-provider test ignored.
- **Fixture-tested:** v36→v37 repair, v37 restart without JSON ingestion,
  foreign keys, encrypted backup verification, rollback, wrong-key rejection,
  portable round trips, workspace isolation, scheduler fencing, workflow
  ownership, connector scoping, and UI regressions have deterministic coverage.
- **Native-smoke-tested:** on 29 July the exact post-cleanup state launched
  through `pnpm tauri:dev` with a fresh portable smoke database. One native
  `Fable` window remained present across delayed samples, the owning process
  remained responsive, and the embedded development server returned HTTP 200.
  Direct UI input was not performed because Windows app-control approval was
  unavailable for the newly compiled executable; the separate 899-test desktop
  suite covers focused UI behavior.
- **Live-integrated:** the prior development session validated one real
  Clerk/Convex account, local Codex app-server, encrypted restart persistence,
  and one harmless no-tools schedule. It did not validate third-party
  connectors, a second account/member, or consequential effects.
- **Release-gated:** production configuration, deployment, signing, notarisation,
  clean-machine packaging, multi-account collaboration, external connector
  validation, and publication remain open and unauthorized.

## Required next evidence

Repository and native-development gates are complete, and the work is recorded
as coherent commits on the isolated clean review branch. No merge, push,
deployment, publication, or release claim is authorized by these results.
