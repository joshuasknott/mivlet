# Batch 9 — Export / Import Foundation Design

**Date:** 2026-06-30
**Branch:** `codex/batch9-export-import`
**Status:** Foundation (conservative, local-first)

## Goal

A conservative, local-first export/import foundation for user-owned data in the
encrypted SQLite store. Users can export a portable, **credential-free** archive
of their workspace data and re-import it later (or on another install) without
ever risking secret leakage, silent overwrites, or unexpected activation.

This is a **foundation**: it covers format, scope, parse/validate/apply, and
transactional rollback. It deliberately does **not** add UI, automatic cloud
sync, or live activation of imported connectors/schedules.

## Scope and non-goals

**In scope**
- A versioned, documented manifest format independent of raw DB internals.
- Export of the typed domain tables (the durable user-owned record set).
- Deterministic output (sorted keys/rows) where practical.
- Explicit, enumerated omission of secrets, caches, transient state, keys,
  machine-specific paths, and logs.
- A parse → validate → plan → apply transactional import pipeline with
  deterministic conflict handling and full rollback on failure.
- Local-first guarantees: no network, no telemetry, no connector activation, and
  imported connectors/schedules remain disabled until reconfigured.
- Focused tests for round trips, malformed input, version mismatch, conflict
  handling, secret omission, workspace isolation, and failed-import rollback.

**Out of scope (deferred)**
- Frontend UI wiring (the Tauri commands are the seam; UI is a later batch).
- Migration of the legacy `scheduler.rs` / `workflows.rs` JSON-file stores into
  the portable format (see Integration Points).
- Selective/partial exports beyond "the whole workspace".
- Encryption of the export artifact itself (the artifact is plaintext JSON by
  design; users own it and may store it wherever they like — secrets are
  structurally absent, not encrypted-away).

## Architecture

A single new Rust module `apps/desktop/src-tauri/src/portable.rs` owns the
format and pipeline. It sits **above** the existing `store` + `repos` layer — it
reads via `Store::with_conn` / `Store::transaction` and the repo helpers, and
writes through the same repo `upsert*` functions the legacy migrator already
uses. It never touches the vault, keyring, or network directly.

```
                ┌──────────────────────────────────────┐
   Tauri cmd ──▶│ portable::export_workspace(&Store)   │──▶ Manifest (JSON)
                │ portable::import_workspace(&Store,…) │──▶ ImportReport
                └───────────────┬──────────────────────┘
                                │ reads/writes through
                                ▼
                 store + repos (encrypted SQLite, unchanged)
```

Three Tauri commands expose it: `export_workspace_archive_to_file`,
`import_workspace_archive_from_file`, `portable_format_version`. Export and
import content stays inside the native file boundary rather than crossing the
renderer IPC contract as a manifest string.

## 1. Export format

A top-level **manifest** object:

```jsonc
{
  "format": "fable.portable-workspace",
  "formatVersion": 1,
  "schemaVersion": 3,            // DB schema the export was taken from
  "exportedAt": "2026-06-30T12:00:00Z",  // informational, not used for replay
  "producedBy": "fable-desktop/0.1.0",
  "credentialsIncluded": false,  // invariant, always false
  "sections": {
    "profile":            { ... } | null,
    "preferences":        [ { key, updatedAt, value } ],
    "projects":           [ { id, titleFingerprint, createdAt, updatedAt, payload } ],
    "threads":            [ { id, projectId, createdAt, updatedAt, payload } ],
    "messages":           [ { id, threadId, role, seq, createdAt, payload } ],
    "runs":               [ { id, threadId, providerId, model, status, turn,
                              recoverable, retryCount, createdAt, updatedAt, payload } ],
    "toolCalls":          [ { id, runId, tool, status, createdAt, payload } ],
    "approvals":          [ { id, runId, service, action, mode, riskLevel,
                              decision, requestFingerprint, decidedAt, payload } ],
    "auditEvents":        [ { id, kind, actor, createdAt, category, service, action,
                              status, riskLevel, mode, correlationId, errorCode,
                              summary, payload } ],
    "artifacts":          [ { id, runId, kind, contentFingerprint, sizeBytes,
                              createdAt, payload } ],
    "connectorAccounts":  [ { connectorId, accountId, status, expiresAt,
                              connectedAt, updatedAt, payload } ],
    "backendConnections": [ { providerId, connectedAt, updatedAt } ],
    "knowledgeSources":   [ { id, connectorId, kind, trust, pinned,
                              contentFingerprint, sizeBytes, importedAt, origin,
                              payload } ],
    "memoryRecords":      [ { id, kind, pinned, approved, createdAt, payload } ],
    "schedules":          [ { id, weekday, time, enabled, createdAt, payload } ],
    "modelConfigs":       [ { providerId, modelId, selected, payload } ],
    "drafts":             [ { id, updatedAt, payload } ],
    "runStates":          [ { id, updatedAt, payload } ]
  },
  "omitted": {
    // WHY each category is absent, so imports can request reconfiguration.
    "secrets":       ["oauth-tokens","api-keys","vault-master-key"],
    "credentialRefs":["connector_account.credential_ref"],
    "caches":        ["connector_cache","connector_cache_settings"],
    "transient":     ["run_state (imported only when explicitly enabled)"],
    "bookkeeping":   ["schema_meta","migration_log"]
  }
}
```

### Design rules

- **Versioned**: `formatVersion` (manifest shape) is independent of
  `schemaVersion` (DB shape). Import checks `formatVersion` first; future
  versions register a migration hook.
- **DB-internal-free**: the manifest never exposes BLOBs, nonces, AAD, or row
  layout. Each record is the *decrypted domain value* + its non-secret columns.
- **Deterministic**: every array is sorted by its natural key (id / key /
  `(providerId, modelId)` / `(seq)` etc.); `serde_json` serializes with sorted
  keys via `BTreeMap`-backed maps where needed. `exportedAt` is the only
  non-deterministic field and is explicitly informational.
- **Extensible**: `sections` is a map; new sections add without breaking older
  readers (unknown sections are ignored on import with a warning).
- **Secret-free by construction**: secrets never enter the DB (keyring-only), so
  they cannot enter the export. Additionally `connector_account.credential_ref`
  (an opaque per-installation keyring key) is **dropped** and recorded in
  `omitted.credentialRefs` so import knows connectors need reconfiguration.

## 2. Export scope

The desktop shell is single-profile; "workspace" is the whole user dataset. The
export reads **only** the explicitly enumerated domain tables. It does **not**
read `connector_cache*`, `schema_meta`, or `migration_log`.

**Referential integrity** is validated before the artifact is emitted:
- every `thread.projectId` resolves to an exported project;
- every `message.threadId` / `run.threadId` resolves to an exported thread;
- every `toolCall.runId` / `artifact.runId` / `approval.runId` resolves to an
  exported run (nullable run-refs are allowed);
- duplicate ids within a section are rejected.

If integrity fails, export returns an error and produces **no artifact**.

Cross-workspace leakage is structurally impossible: there is one workspace, and
the connector cache (the only multi-workspace table) is excluded entirely.

## 3. Import pipeline

```
parse ──▶ validate(formatVersion, schemaVersion, integrity) ──▶ plan ──▶ apply(tx)
                                    │ on any error → return ImportReport, no writes
```

1. **Parse**: deserialize into typed structures; reject malformed JSON / wrong
   types / missing required fields with a structured error.
2. **Validate**:
   - `format` must be `"fable.portable-workspace"`;
   - `formatVersion` must be `<= CURRENT`; a newer version is rejected
     (`unsupported-format-version`) — the migration hook seam is a
     `migrate_manifest(v_in, v_out)` function that is currently a no-op stub;
   - `credentialsIncluded` must be `false` (a `true` value is rejected — we will
     not import anything claiming to carry credentials);
   - referential integrity of the *incoming* records is checked.
3. **Plan conflicts**: for each record, if its id already exists in the target
   store, the conflict policy applies (see below). The plan is computed **before
   any write** so the report is accurate and atomic.
4. **Apply**: all writes run inside a single `Store::transaction`. Any error
   rolls back the whole import (SQLite transaction semantics + the store's
   existing rollback tests guarantee this). On success the transaction commits.
5. **Report**: returns an `ImportReport` with counts (inserted, skipped,
   remapped), warnings (unknown sections, omitted categories needing
   reconfiguration), and errors.

### Conflict policy

The default and only policy in this foundation is **skip-existing** (never
overwrite). A conflicting id is recorded in the report as `skipped` with its
section + id, and the existing row is left untouched. This satisfies "never
overwrite existing user data silently" — skips are explicit and reported, not
silent. (A future `rename`/`overwrite` mode can be added behind an options
argument without changing the format.)

### Rollback policy

The entire import is one SQLite transaction. A failure at any point (validation
after parse, a write error, an integrity violation) leaves the pre-import state
byte-for-byte intact. This is verified by a dedicated test that injects a
conflict mid-import and asserts no rows were added.

## 4. Local-first behavior

- **No network/telemetry**: `portable.rs` imports only `store`, `repos`,
  `serde_json`, `chrono`. It makes zero network calls and emits zero events.
- **No connector activation**: imported `connector_account` rows are written
  with `status = "disconnected"` and **no `credential_ref`** (the field is
  omitted from the manifest). They cannot become active without a fresh OAuth
  handshake. `backend_connection` rows are imported as-is (they record only
  provider ids, never keys) but confer no execution authority on their own.
- **No schedule activation**: imported `schedule` rows are written with
  `enabled = false`. The user must explicitly re-enable them.
- **Secrets stay disabled**: because `credential_ref` is absent, any imported
  connector is structurally unable to authenticate until reconfigured.

## 5. Interfaces and tests

- The format is plain JSON over typed Rust structs — no DB internals leak.
- Tauri commands: `export_workspace_archive_to_file`, `import_workspace_archive_from_file`,
  `portable_format_version`.
- Focused Rust unit tests (`#[cfg(test)] mod tests` in `portable.rs`):
  1. round trip (export → import into a fresh store → re-export → equal manifests)
  2. malformed input rejected
  3. version mismatch rejected (newer `formatVersion`)
  4. `credentialsIncluded: true` rejected
  5. conflict handling (existing id is skipped, not overwritten)
  6. secret omission (`credential_ref` absent; keyring untouched)
  7. workspace isolation (no connector-cache rows leak)
  8. failed-import rollback (mid-import failure leaves store unchanged)
  9. referential integrity violation rejected on both export and import
  10. unknown section produces a warning, not an error

## Integration points (coordination, not editing)

- **data-model branch** (`codex/batch9-data-model`): if it adds tables or
  renames columns, the export sections map must be extended in lockstep. The
  `sections` map + `formatVersion` bump is the contract. The data-model branch
  should not change `formatVersion` semantics.
- **schedule-SQLite branch**: when `scheduler.rs`/`workflows.rs` move from JSON
  files into SQLite tables, add `schedules`/`workflowDefinitions`/
  `workflowRuns` sections. Until then, the durable `schedule` table (already in
  SQLite) is exported; the JSON-file scheduler/workflow stores are intentionally
  out of scope and documented in `omitted`.
- **UI batch**: the three Tauri commands are the seam; UI calls them and
  presents the `ImportReport`.

## Remaining risks

- **Run transcripts may contain pasted secrets** in user-typed message/draft
  text. These are user-owned content, exported as-is (the user explicitly owns
  the artifact). Mitigation: the manifest header documents this; a future
  "secret-scan" pass could redact, but that is out of scope for the foundation.
- **`run_state` is borderline transient** but is user-recoverable state; it is
  exported by default but listed in `omitted.transient` documentation. A future
  option could exclude it.
- **Determinism vs `exportedAt`**: the timestamp breaks byte-identical
  re-exports. It is explicitly informational and the only such field.
