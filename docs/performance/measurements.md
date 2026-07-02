# Performance Measurements

This page defines the repeatable local baseline for Fable performance work. It is a measurement harness, not an optimization claim.

## Bundle and Build Timing

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

## Startup Proxy

True Tauri cold-start timing is not stable in this repo-only harness because it depends on installed WebView2 state, Windows process warmup, signing/build profile, and whether the desktop app is launched by `tauri dev`, an unpacked executable, or an installer.

The reproducible proxy for now is:

- `pnpm build` timing from `pnpm perf:baseline`;
- `pnpm --filter @fable/desktop build` when isolating only the Vite/TypeScript desktop path;
- optional manual launch observation after `pnpm tauri:build` when a local packaged binary exists.

Do not present these proxy timings as real user cold-start numbers.

## Memory Observation

On Windows, start the app or the path you want to observe, then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/perf/observe-memory.ps1 -DurationSeconds 60 -Output docs/performance/memory-observation.md
```

The helper samples process working set and private memory for `fable-desktop`, `msedgewebview2`, `node`, and `cargo` by default. It is useful for spotting large local regressions across repeated runs on the same machine. It is not a precise allocator benchmark and should not be compared across machines.

## Fixture Latency Guardrails

These checks use local fixtures only. They do not require OAuth, provider accounts, API keys, hosted Fable accounts, or live network access.

```bash
pnpm --filter @fable/protocol build
pnpm --filter @fable/connectors exec vitest run src/performance-baseline.test.ts
pnpm --filter @fable/knowledge exec vitest run src/performance-baseline.test.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml perf_
```

The checks cover:

- provider and connector fixture search/import/action shaping;
- native provider request-loop shaping with fixture streams;
- knowledge retrieval over synthetic local sources;
- connector cache search and scheduler queue list paths in the encrypted SQLite store.

The timing limits are deliberately loose so they catch severe local regressions without pretending to be lab-grade benchmarks.

## Known Limits

- No live connector OAuth flow is measured.
- No provider API key, subscription token, or hosted account is needed or captured.
- The scripts do not store secrets and do not inspect OS secure storage.
- Browser preview fixtures remain fixtures; they are not live connector evidence.
- Generated reports should only be committed when they are useful for branch synthesis and are small, text-only Markdown files.
