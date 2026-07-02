# Performance Measurements

This page defines the repeatable local baseline for Fable performance work. It is a measurement harness, not an optimization claim.

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
- raw and gzip sizes.

Use `pnpm perf:baseline -- --skip-build` to inspect an already-built `apps/desktop/dist` folder without rebuilding.

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
