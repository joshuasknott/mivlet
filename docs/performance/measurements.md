# Performance Measurements

This page defines the repeatable local baseline for Fable performance work. It is a measurement harness, not an optimization claim.

## Bundle Regression Gate

CI runs a conservative post-build budget check after `pnpm build`. The gate reads `apps/desktop/dist`, ignores Vite hash suffixes, and compares logical chunk sizes against ceilings in `scripts/perf/budget.json`.

Run locally:

```bash
pnpm build
pnpm perf:check
pnpm perf:test
```

`pnpm perf:check` fails with a concise list of exceeded ceilings and prints the recorded baseline for comparison. Hash churn and small gzip variance are intentionally ignored; raw-byte ceilings carry most of the signal.

### Budget design rationale
- **Deterministic file-size focus:** Only bundle/asset raw byte sizes (plus gzip aggregate) are enforced as hard gates. Runtime timings and memory measurements are informational only (see "Backend and Rust Checks" and "Memory Observation" below, and loose limits in `packages/*/src/performance-baseline.test.ts`).
- **Logical chunk IDs:** `logicalChunkId` strips Vite `[hash]` suffixes (e.g. `SchedulesPage-*.js` → `SchedulesPage`). Budgets survive rebuilds without churn.
- **Raw bytes + margins:** Ceilings use raw bytes as primary signal (gzip varies with zlib impls). Recorded margins (+8–24 KiB raw per category, wider for gzip) sit above observed post-polish sizes. This catches meaningful regressions while tolerating normal variance, dependency bumps within margin, and the tracked icon import fix (barrel → CSR path).
- **Unexpected assets:** Extra chunks (e.g. `DepartmentsPage`, future pages) that are not listed in `ceilings.routeChunks` produce no violation when all explicitly budgeted items stay under ceiling. Total ceiling still provides backstop.
- **Cross-platform & error robustness:** All paths normalized to `/`. Tests (and CI on windows) cover mixed separators. `perf:test` exercises missing builds (nonexistent dist), malformed budget JSON, exact ceiling boundary (pass), +1 byte (fail).

### Recorded baseline vs observed build

| Metric | Recorded baseline | Observed build (2026-07-03) | Delta |
| --- | ---: | ---: | ---: |
| JS+CSS total | 858.7 KiB raw / 227.8 KiB gzip | 871.5 KiB raw / 230.3 KiB gzip | +12.8 KiB raw |
| CSS | 134.9 KiB raw | 141.4 KiB raw | +6.5 KiB raw |
| Schedules route chunk | 22.3 KiB raw | 25.6 KiB raw | +3.3 KiB raw |

The increase is explained by recent schedule and onboarding polish, not accidental re-bundling:

- **CSS (+6.5 KiB):** `ef8c8fe` added schedule modal/page styling in `panels.css` and reworked onboarding/page layout rules in `pages.css` (hundreds of new schedule- and page-specific selectors).
- **Schedules chunk (+3.3 KiB):** the same polish expanded `SchedulePanel.tsx` (modal-led create flow, queue-state surfacing, live recurrence summary wiring) and pulled in `schedule-client` helpers; this is intentional UX surface area, not a routing regression.
- **Remainder of total (+~2.6 KiB raw):** small shared icon/helper splits across lazy chunks; one accidental `@phosphor-icons/react` barrel import on `SchedulesPage` was corrected to the CSR path used elsewhere. `DepartmentsPage` (~0.7 KiB) is now explicitly budgeted for future growth detection.

Ceilings are set above the observed build with generous raw margins (+8–24 KiB per category) so normal CI stays stable while material regressions still fail loudly. All route chunks ending in `Page` or `ApprovalPanel` are considered; `react-vendor`/`vendor`/`index` are excluded from per-route tracking.

## Bundle and Build Timing

True Tauri cold-start timing depends on the host system, including Windows process warmup, the installed WebView2 runtime, signing or build profile, and whether the app launches through `tauri dev`, an unpacked executable, or an installer. The reproducible proxy for now is build duration plus static Vite asset payload.

Run:

```bash
pnpm perf:baseline -- --output docs/performance/latest-baseline.md
```

The script runs `pnpm build`, records the elapsed local time, then reads `apps/desktop/dist` and reports:

- largest Vite JS and CSS assets;
- total JS payload;
- total CSS payload;
- raw and gzip sizes;
- budget gate status (`scripts/perf/budget.json`).

Use `pnpm perf:baseline -- --skip-build` to inspect an already-built `apps/desktop/dist` folder without rebuilding.

`pnpm perf:test` (node --test on budget.test.mjs) validates the gate implementation itself: missing dist dirs, bad budget JSON, path separator normalization, ceiling equality vs over-by-1, and tolerance of unbudgeted extra assets.

Do not present these proxy timings as real user cold-start numbers.

### Bundle Size Strategy

- React vendor chunking keeps stable `react` and `react-dom` code in a dedicated `react-vendor` chunk.
- Route and panel lazy loading keeps heavier surfaces such as `ApprovalPanel` and `SettingsPage` out of the initial workspace path until needed.
- Phosphor icons are imported from direct CSR module paths so route-only icons do not ride along with the root package index.

## Backend and Rust Checks

Database operations are executed locally using the encrypted single-user SQLite store. The local checks measure transaction, list, and search paths over synthetic record sets.

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml perf_
```

The checks cover:

- connector cache search over synthetic local records;
- scheduler queue listing at current local scale.

The scheduler queue write path also avoids a separate duplicate `COUNT` probe and relies on SQLite uniqueness handling for duplicate deduplication keys. That keeps duplicate detection in the write statement instead of adding an extra indexed read before insert.

## Fixture Latency Guardrails

These checks use local fixtures only. They do not require OAuth, provider accounts, API keys, hosted Fable accounts, or live network access.

Run:

```bash
pnpm --filter @fable/protocol build
pnpm --filter @fable/connectors exec vitest run src/performance-baseline.test.ts
pnpm --filter @fable/knowledge exec vitest run src/performance-baseline.test.ts
```

The checks cover:

- provider and connector fixture search, import, and action shaping;
- native provider request-loop shaping with fixture streams;
- knowledge retrieval over synthetic local sources;
- memory retention over synthetic local records.

The timing limits are deliberately loose so they catch severe local regressions without pretending to be lab-grade benchmarks.

## Memory Observation

On Windows, start the app or the path you want to observe, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/observe-memory.ps1 -DurationSeconds 60 -Output docs/performance/memory-observation.md
```

The helper samples process working set and private memory for `fable-desktop`, `msedgewebview2`, `node`, and `cargo` by default. It is useful for spotting large local regressions across repeated runs on the same machine. It is not a precise allocator benchmark and should not be compared across machines.

## Known Limits

- No live connector OAuth flow is measured.
- No provider API key, subscription token, or hosted account is needed or captured.
- The scripts do not store secrets and do not inspect OS secure storage.
- Browser preview fixtures remain fixtures; they are not live connector evidence.
- Fable does not require a hosted account for the local desktop workspace.
- Connector failures, credential requirements, and disconnected states must stay fail-closed and explicit.
- Generated reports should only be committed when they are useful for branch synthesis and are small, text-only Markdown files.
