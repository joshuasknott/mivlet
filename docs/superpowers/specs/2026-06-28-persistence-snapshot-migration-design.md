# Persistence → Runtime Snapshot: Safe Interim Migration

**Date:** 2026-06-28
**Scope:** `apps/desktop/src/lib/persistence.ts`, `apps/desktop/src/lib/types.ts`,
`apps/desktop/src/hooks/useShellRuntime.ts`, `packages/protocol/src/index.ts`,
`apps/desktop/src-tauri/src/models.rs`, `apps/desktop/src-tauri/src/snapshot.rs`,
`apps/desktop/src-tauri/src/tests.rs`, plus new/updated tests.

## Goal

Create the safe interim migration from browser `localStorage` / app-data JSON
toward the runtime snapshot as the source of truth for **non-secret** state,
without weakening the local-first / secret-keeps-out boundaries.

## Non-goals

- Encrypted SQLite itself. This is the *interim* migration that establishes the
  snapshot contract as the single non-secret source of truth; the future SQLite
  layer will sit behind the same `RuntimeSnapshot` boundary.
- Connector tokens / backend credentials / API keys: these already stay in the
  OS keychain or auth broker and are out of scope here.

## Current problems

1. **`localStorage` is a peer source of truth forever.** `readPersistedShellState`
   reads `STORAGE_KEY` on every mount and `persistShellState` writes it on every
   change — in both preview *and* Tauri. In desktop the snapshot should be the
   source of truth; localStorage should be preview-only with a one-time legacy
   import.
2. **Schedules are silently lost in Tauri.** `Schedule` lives only in
   `PersistedShellState` and is not part of the `RuntimeSnapshot` contract.
   `shellStateFromRuntimeSnapshot` returns `schedules: []` (via the default
   spread), but `useShellRuntime` calls `setSchedules(recovered.schedules)` on
   snapshot load → every Tauri restart wipes the user's schedules.

## Decisions (confirmed)

- **D1 — Add `schedules` to the `RuntimeSnapshot` contract** (TS protocol +
  Rust model + normalization). The snapshot becomes the single source of truth
  for schedules in desktop, mirroring every other non-secret field.
- **D2 — localStorage: write-mirror + one-time read.** In Tauri the snapshot is
  the source of truth; `localStorage` is a write-only best-effort mirror and is
  read exactly once, on first launch, to import legacy values. Preview (no
  Tauri runtime) keeps localStorage as its sole store, unchanged.

## Design

### Schedule shape

Reuse the existing shell-local `Schedule` (id, name, description, day, time,
enabled, createdAt) as a shared contract. Add a protocol type so both TS and
Rust speak the same shape:

```ts
// packages/protocol/src/index.ts
export type ScheduleWeekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface ScheduleEntry {
  id: string;
  name: string;
  description: string;
  day: ScheduleWeekday;
  time: string; // "HH:MM", 24-hour
  enabled: boolean;
  createdAt: string; // ISO timestamp
}

// RuntimeSnapshot gains:
schedules: ScheduleEntry[];
```

The existing shell `Schedule` type aliases / is structurally identical to
`ScheduleEntry`, so `useShellRuntime` needs no change beyond wiring it through.

### Rust side

- `models.rs`: add `Schedule` struct (camelCase) + `schedules: Vec<Schedule>` to
  `RuntimeSnapshot` (defaulted with `#[serde(default)]` so existing v1 files
  without it still parse).
- New caps: `MAX_RUNTIME_SNAPSHOT_SCHEDULES = 100`,
  `MAX_SCHEDULE_FIELD_CHARACTERS = 200`, controlled `SCHEDULE_WEEKDAYS` and
  `SCHEDULE_TIME` (24h `HH:MM`) validation.
- `snapshot.rs::normalize_runtime_snapshot`: normalize each schedule
  (trim/cap fields, validate weekday + time, cap list at 100, dedupe by id) the
  same way `automation_statuses` / `memory_records` are handled. Reject unknown
  weekdays/times.

### TS persistence layer (`persistence.ts`)

Introduce a `hasTauriRuntime()` check (mirror `runtime.ts`). Split read path:

- **`readPersistedShellState(defaults)`** — preview path, unchanged: reads
  `STORAGE_KEY` then legacy keys, copies forward.
- **`importLegacyShellStateOnce(defaults)`** — desktop path: reads legacy keys
  only, returns merged state, and writes a `fable.legacy-imported.v1 = "1"`
  sentinel so it never re-imports. Returns defaults after the first run.
- **`persistShellState(state)`** — write-only: still writes `STORAGE_KEY` as a
  best-effort mirror in both runtimes. It never reads. (Preview relies on it;
  Tauri ignores the read side.)

`shellStateToRuntimeSnapshot` / `shellStateFromRuntimeSnapshot`: add `schedules`
round-trip.

### Hook wiring (`useShellRuntime.ts`)

- `initialState`: in Tauri use `importLegacyShellStateOnce`; in preview use
  `readPersistedShellState` (unchanged). Both still default to a sensible empty
  state.
- Snapshot-recovery effect: `setSchedules(recovered.schedules)` now receives
  real data (D1 fixes the clobber). No other behavior change.

## Secret-boundary tests (new)

These are the proof the objective asks for. They assert no secret or
token-shaped value enters the snapshot, localStorage payload, app-data JSON, or
migration metadata.

### TS (`persistence.test.ts`, new `secret-boundary` describe)

- A shell state with a planted `composerValue: "Authorization: Bearer sk-leak"`
  round-trips through `shellStateToRuntimeSnapshot` with the literal token never
  present in other fields — and a snapshot containing token-shaped strings stays
  token-shaped only where the user typed it (never injected by us).
- `importLegacyShellStateOnce` writes the sentinel and never re-reads; the
  sentinel + copied payload contain no secret keys, only the documented fields.
- Persisted localStorage payloads never gain new secret-named keys (assert the
  serialized object has exactly the `PersistedShellState` key set).

### Rust (`tests.rs`, extend snapshot section)

- `runtime_snapshot_round_trips_schedules_without_secrets`: save a snapshot
  with schedules, read it back, assert schedules survive, and assert the
  on-disk file contains no `secret` / `token` substring (mirrors the existing
  backends test).
- A snapshot whose schedule fields contain token-shaped strings is rejected or
  capped — the normalizer never echoes unvalidated attacker-shaped data.

## Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm tauri:check`

## Worktree preservation

The in-progress changes to `App.tsx`, `App.test.tsx`, `OnboardingPage.tsx`, and
`pages.css` (the `onSubmitProfile` / onboarding refactor) are unrelated and will
not be touched. The persistence/snapshot work is confined to the files listed in
Scope.
