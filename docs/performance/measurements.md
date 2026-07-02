# Performance measurements and known-limits documentation

This document outlines the performance characteristics, baseline check harness, and known boundaries of Fable. It defines repeatable local procedures and documents the physical limits of current checks.

---

## 1. How to run frontend bundle & startup checks

True Tauri cold-start timing depends on the host system (e.g., Windows process warming, current WebView2 runtime version, installer compilation profiles) and is not stable or reproducible in local dev environments. Instead, we use the build duration and static Vite asset payloads as reliable proxies for startup performance.

To run build and bundle checks:
```bash
# Run the baseline script (automatically triggers a clean build and gathers size statistics)
pnpm perf:baseline -- --output docs/performance/latest-baseline.md

# Inspect an existing apps/desktop/dist directory without triggering a full rebuild
pnpm perf:baseline -- --skip-build
```

### Bundle Size Strategy
- **React Vendor Chunking**: Stable core libraries (such as `react`, `react-dom`) are split into a dedicated `react-vendor` chunk inside `apps/desktop/vite.config.ts`.
- **Dynamic Lazy Loading**: Heavy panels (such as `ApprovalPanel` and `SettingsPage`) are lazily loaded using `React.lazy` and `Suspense`, preventing them from blocking initial rendering of the core workspace view.
- **Phosphor CSR Imports**: Icons are imported directly from `@phosphor-icons/react/dist/csr/*` rather than the root package index, ensuring only the used icons are bundled in the route-level code chunks.

---

## 2. How to run backend/Rust/database checks

Database operations are executed locally using an encrypted single-user SQLite store. We measure transaction latencies and list/search capabilities over synthetic record sets.

To run the local database and scheduler queue performance test suites:
```bash
# Run Rust store performance tests
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml perf_
```

### Backend Optimizations
- **Scheduler Queue**: Avoids duplicate checking using `COUNT` queries before inserting. Instead, it relies on SQLite schema constraint handling (`ON CONFLICT(workspace_id, deduplication_key) DO NOTHING`) to perform deduplication and enqueuing in a single database roundtrip, optimizing write paths.
- **Connector Cache**: Performs plaintext pre-filtering on items at scale before decrypting payload fields, which prevents bulk decryption overhead on large list/search operations.

---

## 3. Provider/connector latency measurement limits

All connector checks and provider tests in Fable are **strictly local-first** and run against deterministic synthetic fixtures.
- **No Live Access**: They do not make live external HTTP requests, and do not contact third-party APIs (such as OpenAI, GitHub, or Slack).
- **OAuth & Credentials**: No OAuth flows, credentials, API keys, or active account subscriptions are required or captured during performance checks.
- **Timing Assertion Bounds**: The vitest tests (e.g. `src/performance-baseline.test.ts`) assert that operations complete within loose guardrails (e.g., `< 1,000ms` or `< 1,500ms`) to avoid environment/CI-specific wall-clock failures while still catching orders-of-magnitude performance regressions.

To run these checks:
```bash
# Build protocols first
pnpm --filter @fable/protocol build

# Run vitest performance suites
pnpm --filter @fable/connectors exec vitest run src/performance-baseline.test.ts
pnpm --filter @fable/knowledge exec vitest run src/performance-baseline.test.ts
```

---

## 4. Memory measurement limits

Memory consumption is observed at the OS process level. Process metrics (Working Set and Private Memory) vary between host environments and do not represent precise heap allocation benchmarks.

To profile process memory on Windows during operations:
```powershell
# Sample memory utilization of the Fable processes for 60 seconds
powershell -ExecutionPolicy Bypass -File scripts/perf/observe-memory.ps1 -DurationSeconds 60 -Output docs/performance/memory-observation.md
```
- **Observed Processes**: Samples `fable-desktop`, `msedgewebview2`, `node`, and `cargo`.
- **Purpose**: Spotting regression anomalies between commits on the same local hardware. It should never be used as a hard cross-machine production guarantee.

---

## 5. Known non-goals and environment caveats

### Desktop Local-First Workspace
- Fable does not require a hosted web account, external cloud service connection, or network synchronization to run its core desktop workspace interface. It runs fully offline with encrypted local SQLite persistence.
- **Fail-Closed Behavior**: When connector actions fail, require credentials, or lose connection, they fail closed and prompt the user for validation.
- **Secrets Isolation**: Cleartext passwords, API keys, and connection secrets are strictly isolated from React state, logs, screenshots, and JSON metadata templates.

### Non-Goals
- **Lab-Grade Benchmarking**: We do not target microsecond precision or run multi-concurrent writer benchmarks. The SQLite store is single-user and optimized for local desktop access.
- **Live Integration Testing in Performance Suite**: Automated perf tests never connect to real endpoints; mock response streams and files are utilized to ensure tests are deterministic, safe, and stable.
