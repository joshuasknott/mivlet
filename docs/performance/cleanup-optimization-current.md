# Cleanup and optimisation current report

Recorded on 29 July 2026 from the isolated
`codex/fable-cleanup-optimization` review state.

This is repository performance evidence. It is not packaged cold-start,
production telemetry, deployment evidence, or release authorization.

## Result

| Metric | Baseline | Current | Improvement | Checked ceiling |
| --- | ---: | ---: | ---: | ---: |
| Initial desktop entry | 718,322 B | 609,277 B | 109,045 B (15.2%) | 614,399 B |
| JavaScript and CSS | 1,551,792 B | 1,411,960 B | 139,832 B (9.0%) | 1,552,743 B |
| CSS | 195,411 B | 195,056 B | 355 B (0.2%) | 195,410 B |

The initial entry is below 600 KiB (`614,400 B`) without raising any budget.
The aggregate and CSS ceilings are also tighter than the pre-programme checked
budgets.

## What changed

- Cited-brief and parallel-approach contract code moved behind the existing
  mission entry points and loads with the mission path that needs it.
- Onboarding and Run History route styles are emitted as their own route
  assets; confirmed unused automation styles were removed.
- Runtime adapters are selected once. The development preview adapter is
  isolated and lazy-loaded, while native startup remains authoritative.
- Package builds, type checks, and CI no longer rebuild the same package output
  through separate top-level phases.

No required startup operation was moved into a timer, idle callback, or
post-render delay merely to improve the entry number.

## Validation

- The production build and budget checker read emitted files, not source
  estimates.
- The budget test guards aggregate JavaScript/CSS, CSS, gzip, initial entry, and
  named lazy route ceilings.
- Desktop typechecking and all 899 desktop tests passed after the split.
- Focused mission, runtime, Settings, Knowledge, Project, schedule, and
  workspace-switch regressions are part of that suite.
- The final `pnpm check`, Rust formatting, strict all-target/all-feature
  Clippy, and the full native suite pass. The native suite reports 813 passed,
  zero failed, and one deliberately opt-in live-provider test ignored.

## Evidence boundary

- **Repository-tested:** emitted production assets and deterministic budgets.
- **Fixture-tested:** UI behavior and domain performance fixtures.
- **Native-smoke-tested:** the exact post-cleanup state launched through
  `pnpm tauri:dev` with a fresh portable smoke database. One native `Fable`
  window remained present, its process remained responsive, and the embedded
  development server returned HTTP 200 across delayed samples. Direct UI input
  was not performed because Windows app-control approval was unavailable for
  the newly compiled executable.
- **Live-integrated:** not measured by this report.
- **Release-gated:** packaged cold start, comparable RSS, long private soak, and
  clean-machine installer performance remain open.

The pre-change measurements and protected-work record remain at
[Cleanup and optimisation baseline](cleanup-optimization-baseline.md).
