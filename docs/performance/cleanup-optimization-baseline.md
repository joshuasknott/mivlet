# Cleanup and optimisation baseline

Recorded on 29 July 2026 before cleanup work, from commit
`db55d28f4b1b6cbb75c8a07818af5d0a978e79d5`.

This is repository evidence, not a deployment or release claim. Browser preview
remains a synthetic development adapter. Native Tauri remains authoritative.

## Protected work

The primary checkout contained uncommitted OAuth callback and explicit
multi-workspace scope work: six tracked files with 684 insertions and 154
deletions, plus two local-environment helper files. Before acting:

- the complete binary-safe tracked diff was saved outside the repository;
- both untracked helpers were copied outside the repository and checksummed;
- an isolated `codex/fable-cleanup-optimization` worktree was created;
- the preserved diff was applied there and verified byte-for-byte as the same
  patch;
- the primary checkout was left untouched.

The preserved worktree patch has SHA-256
`17229B9C607E5138073CC8DF6B8D6A42478357C2287E1C80F31A6FC8F121790E`.

## Current gates

An untouched `pnpm check` passed on Windows with Node 24.16.0 and pnpm 10.15.0.
This included TypeScript checks, unit and fixture tests, production builds,
bundle and runtime performance gates, release-manifest tests, and `cargo
check`. It took 927.9 seconds on a cold worktree, including first-time native
compilation; that wall-clock result is not a performance comparison.

The existing check and CI definitions repeat package builds across typecheck,
build, and final package-specific steps. Lint is currently an alias for
TypeScript checking in the desktop package. There are no enforced source-cycle,
dead-code, pnpm production-audit, or Cargo advisory-policy gates.

## Desktop bundle

Measured from the untouched production build:

| Metric | Baseline |
| --- | ---: |
| Initial desktop entry | 718,322 B |
| All JavaScript | 1,356,381 B |
| All CSS | 195,411 B |
| JavaScript and CSS | 1,551,792 B |
| Initial entry gzip | 196,958 B |

The existing budget file allows 760,205 B for the initial entry, 209,396 B for
CSS, and 1,596,877 B total. The approved programme instead requires an initial
entry below 600 KiB, total JavaScript/CSS no greater than 1,552,743 B, and CSS
below 195,411 B, with unchanged or tighter checked budgets.

## Dependency advisories

`pnpm audit --prod` reported five high, four moderate, and three low
advisories, all on the marketing Astro toolchain. The high findings are the
Astro reflected-XSS and host-header SSRF advisories plus affected PostCSS,
Sharp, and SVGO versions. Astro currently resolves to 5.18.2.

`cargo audit` reported two RustSec advisories against two resolved `quick-xml`
versions:

- `quick-xml` 0.39.4 is reached through `plist` 1.9.0 and Tauri;
- `quick-xml` 0.37.5 is reached only through
  `tauri-winrt-notification` 0.7.2, `notify-rust`, and the Tauri notification
  plugin.

Source inspection of `tauri-winrt-notification` 0.7.2 found only
`quick_xml::escape::escape` calls. It does not import or call `Reader`,
`NsReader`, attribute iteration, `try_get_attribute`, or namespace resolution;
Windows' `XmlDocument` parses the generated notification XML. Any temporary
exception must encode this exact dependency path and source proof, expire, and
fail closed if either changes.

## Source structure

Madge found two source dependency-cycle families:

- `apps/waitlist/src/magic-tokens.ts` and `waitlist.ts`;
- protocol `remote-control.ts`, `scheduling-workflows.ts`, and the root
  `index.ts`.

Knip reported four possible unused files and three dependency findings.
Two files are known entry/fixture false positives: the Rust-launched MCP stdio
fixture and the protocol compatibility-regression entry. The remaining files
and dependencies require reference confirmation before removal.

The largest relevant implementation files are:

| File | Lines |
| --- | ---: |
| `mission_workers.rs` | 11,661 |
| `mission_coordination.rs` | 6,722 |
| `mcp_process.rs` | 5,712 |
| `runtime.ts` | 5,613 |
| `App.test.tsx` | 4,314 |
| `useShellRuntime.ts` | 4,047 |
| `ChatWorkspace.tsx` | 2,550 |
| `SettingsPage.tsx` | 2,198 |

These measurements identify refactoring seams; they do not justify changing
authority, persistence, replay, approval, or fail-closed behaviour.

## Evidence boundary

- Repository-tested: the complete existing local gate passed from the isolated
  preserved state.
- Fixture-tested: connector, knowledge, storage, scheduling, migration, export,
  and other deterministic suites passed as part of that gate.
- Native-smoke-tested: the product status records the 27 July 2026 native
  development validation; a fresh post-change responsive native smoke remains
  required.
- Live-integrated: the prior native validation covered configured
  Clerk/Convex/Codex paths. It is not evidence for unconfigured third-party
  connectors or another account.
- Release-gated: packaging, signing, notarisation, clean-machine install,
  multi-account validation, and publication remain open and unauthorized.
