# Performance Measurements

This page defines Fable's repeatable repository-local performance gates. They
detect regressions in deterministic fixtures and built assets; they are not
packaged-app, live-provider, or cross-machine performance claims.

## Enforced gate

Run:

```bash
pnpm build
pnpm perf:check
pnpm perf:test
pnpm perf:runtime
```

The root `pnpm check` command and Windows CI run all four steps. `perf:check`
reads `apps/desktop/dist`, removes Vite hash suffixes, and compares exact logical
assets with `scripts/perf/budget.json`. `perf:test` proves missing builds,
malformed configuration, Windows path normalization, exact boundaries, missing
budgeted routes, and one-byte regressions fail deterministically.

`perf:runtime` runs bounded local fixtures for:

- connector search and response shaping;
- knowledge retrieval and retention;
- native encrypted-store/cache operations;
- native scheduler queue operations.

The fixture timing limits are intentionally loose enough for shared CI runners.
Their record counts and result bounds are the durable contract; elapsed time is
a severe-regression tripwire rather than a benchmark claim.

## Recorded desktop build

The 24 July 2026 repository build is the current baseline:

| Metric | Observed | Enforced ceiling |
| --- | ---: | ---: |
| JS and CSS | 1,462,564 B raw / 388,413 B gzip | 1,528,100 B / 413,000 B |
| CSS | 189,977 B | 206,400 B |
| Initial entry JavaScript | 680,884 B | 730,100 B |
| Settings route | 89,513 B | 101,824 B |
| Knowledge route | 44,635 B | 52,864 B |
| Schedules route | 41,168 B | 49,408 B |

The prior 3 July baseline remains in the budget file for history. It was not
silently treated as a current ceiling after substantial repository-local
Mission, Routine, MCP, recovery, and diagnostics implementation. The new
ceilings use 8–64 KiB of explicit headroom, so later growth still fails loudly.

React, React DOM, their scheduler bridges, and React Query share one stable
vendor chunk. This avoids a circular vendor dependency. Route and panel lazy
loading keeps Settings, Knowledge, Schedules, Connections, and approvals out of
the initial entry. Phosphor icons use direct CSR modules where practical.

The initial entry remains larger than Vite's advisory 600 KiB warning. It is
budgeted truthfully rather than hidden by raising the warning threshold.

## Startup and memory

Static initial-entry payload is the enforced repository proxy for startup.
Actual Windows cold start depends on the executable profile, WebView2, disk,
installer state, and process warmth. It must be measured during packaged-app
testing and is not claimed here.

For repeatable observation on one Windows machine:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/observe-memory.ps1 -DurationSeconds 60 -Output docs/performance/memory-observation.md
```

The helper samples Fable, WebView2, Node, and Cargo working/private memory. RSS
and startup readings are not hard-gated across machines because that would
produce false precision.

## Storage, retrieval, streaming, and long-run bounds

The repository enforces bounded payloads and histories at their owning
boundaries in addition to the fixture timings:

- native encrypted storage and queue tests cover deterministic local-scale
  reads, writes, duplicate handling, and restart-safe persistence;
- knowledge and connector fixtures bound source counts, result counts, and
  response shaping before ranking or rendering;
- provider and MCP decoders bound frames, outputs, deadlines, cancellation,
  and malformed or late input;
- Mission and Routine tests bound iterations, worker counts, event histories,
  leases, retries, occurrences, and retained route evidence.

No fixture uses credentials, OAuth, hosted accounts, or live network access.
Long-duration packaged soak, real-provider streaming, and real working-set
budgets remain explicit private-test gates.

To inspect an already built tree without rebuilding:

```bash
pnpm perf:baseline -- --skip-build
```

The generated report is local evidence only. Browser preview data remains
synthetic and cannot substitute for native or packaged-app evidence.
