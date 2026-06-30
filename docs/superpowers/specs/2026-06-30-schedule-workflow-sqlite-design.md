# Batch 9 — Schedules & Workflows Encrypted SQLite Migration

Migrates schedules (the durable automation engine: scheduled jobs + the
scheduler queue) and workflows (definitions + the run journal) from raw JSON
files into the existing encrypted SQLite vault. Scope: `apps/desktop/src-tauri`.

## Goals

- Encrypted-at-rest persistence for schedules and workflows, reusing the
  repository's AES-256-GCM `Vault` and `repos::{open_json, seal_json}` seam.
- Workspace isolation from day one so the data-model branch can tighten the
  scope without a data migration.
- A safe, transactional, idempotent legacy-JSON → SQLite migration with explicit
  rollback and recovery guarantees.
- No plaintext secrets or sensitive workflow payloads at rest.

## Schema (v3 → v4)

Bumps `CURRENT_SCHEMA_VERSION` to `4`. New tables, all workspace-scoped, all
following the established `payload` BLOB + `payload_nonce` BLOB + plaintext
query-column convention:

- `scheduled_job(id PK, workspace_id, status, workflow_definition_id,
  trigger_kind, missed_run_policy, schema_version, next_run_at, last_run_at,
  last_run_id, created_at, updated_at, payload, payload_nonce)`.
- `scheduler_queue_entry(id PK, workspace_id, job_id, state, lease_holder,
  lease_expires_at, lease_token, deduplication_key, available_at, last_error,
  scheduled_at, updated_at, payload, payload_nonce,
  UNIQUE(workspace_id, deduplication_key))`.
- `workflow_definition(workspace_id, id, version, schema_version, created_at,
  updated_at, payload, payload_nonce, PK(workspace_id, id, version))`.
- `workflow_run(id PK, workspace_id, definition_id, definition_version, status,
  trigger, scheduled_job_id, started_at, updated_at, finished_at, payload,
  payload_nonce)`.

The delta lives in `SCHEMA_V3_TO_V4` (idempotent `CREATE TABLE IF NOT EXISTS`)
and is also folded into `SCHEMA_V1` so fresh databases reach v4 in one batch.
Registered in `migrations::apply` as the `3 => …` arm.

### Encryption approach

Each row seals a JSON payload with `Store::seal_payload` (AES-256-GCM), bound to
a row-identity AAD of the form `table:{workspace_id}:{id}` (definitions also
include the version). Fresh 12-byte random nonce per seal; AAD re-checked on
open, so a swapped ciphertext row fails closed. Sensitive free text (job name +
description, the full trigger object, workflow step prompts, run inputs, the
idempotency key) lives only inside the encrypted blob; plaintext columns are
non-secret enums, ids, timestamps, counts, and the dedup/lease fields the tick
needs to filter without decrypting. The frozen execution route carries only
provider/model ids + permission mode — never keys or tokens.

## Repositories

`repos::scheduled_job`, `repos::scheduler_queue`, `repos::workflow` expose
`upsert_from_value` / `list` / `delete` over `&Connection` + `&Store`, mirroring
the existing repo conventions (`memory_record`, `connector_cache`, etc.).
`repos::scheduled_job::normalize_workspace` is the shared workspace normalizer
(empty → `default`), reused by the queue and workflow repos.

## Legacy JSON migration

Three new sources join the existing `migrate_all` loop in
`store/migrations/legacy.rs`, each migrated idempotently in its own transaction
through the established `migration_log(source, checksum, status, diagnostics)`
bookkeeping:

- `scheduler-store.json` → `scheduled_job` + `scheduler_queue_entry`.
- `workflow-definitions.json` → `workflow_definition`.
- `workflow-runs.json` → `workflow_run`.

### Migration phases (per source)

1. **Detect** — the source file must exist and be readable.
2. **Checksum** — SHA-256 of the file bytes is the idempotency key.
3. **Idempotency probe** — skip if `migration_log` already has `(source,
   checksum, status='done')`.
4. **Validate + parse** — a structurally invalid source (not an object/array,
   unsupported `schemaVersion`) records `status='partial'` and is retried next
   launch; it never touches SQLite.
5. **Migrate transactionally** — every record upserts inside one
   `store.transaction`; a record-level validation failure is recorded as a
   skipped diagnostic and does not abort the source.
6. **Record outcome** — `done` when nothing was skipped, else `partial`.

### Record handling

- **Malformed record** → skipped with a diagnostic reason; the source continues.
- **Partial source** (some records skipped) → `status='partial'`; re-running
  with unchanged bytes is a no-op (checksum matches the `done`-equivalent run
  only when nothing was skipped, so a partial source is retried until clean or
  the bytes change).
- **Duplicated occurrence** (same `deduplicationKey`) → the queue repo rejects
  the duplicate at the storage layer (`UNIQUE` constraint); counted as a skip.
- **Unsupported legacy fields** → preserved verbatim inside the encrypted
  payload (the repo stores the whole record); unknown top-level keys are also
  recorded in `diagnostics.preserved_fields`.

### Recovery and rollback guarantees

- A failed migration leaves the prior state intact: each source migrates in its
  own transaction that rolls back on error, so a structural failure never writes
  partial SQLite state.
- Partial SQLite state never supersedes valid legacy data: legacy JSON files are
  **never deleted** by the migration or the live paths — they remain on disk as
  a downgrade/rollback target. `delete_local_data` (the explicit, confirmed
  destructive reset) is the only path that removes them.
- Recovery avoids duplicates: re-running a clean source is a checksum no-op; a
  partial source only re-attempts records whose validation can still succeed,
  and the queue's `UNIQUE(workspace_id, deduplication_key)` constraint makes a
  duplicate occurrence impossible even across retries.
- Backups and temporary files have explicit lifecycle rules: `backup_local_data`
  uses `VACUUM INTO` to a non-existing destination (never overwrites); the
  legacy atomic writes use `tmp` + `rename` and are now write-only mirrors.

## Live persistence

- **Scheduler** (`scheduler.rs`): `initialize_store` loads from SQLite (the
  production authority) and falls back to the legacy JSON file in the unit-test
  path (no global store). `persist` flushes the whole managed store back to
  SQLite transactionally (`delete_all` + re-insert, bounded by the existing
  caps), falling back to the JSON file in tests. `list_scheduler_jobs` /
  `list_scheduler_queue` read SQLite first. The in-process tick + lease map are
  unchanged.
- **Workflows** (`workflows.rs`): the save/list commands prefer SQLite and fall
  back to the JSON file in the unit-test path. The legacy JSON files are
  write-only mirrors once migration has run.

### No-duplicate-execution guarantee

Persisted across restart by three layers, unchanged by the migration:

1. The queue's `UNIQUE(workspace_id, deduplication_key)` storage constraint +
   the in-queue check in `enqueue_job_run` (a duplicate enqueue is a no-op).
2. The fencing `lease_token` checked by `report_job_attempt` / `renew_job_lease`
   so a stale report from a superseded run cannot mutate a freshly re-leased
   occurrence.
3. The `WorkflowRun.idempotencyKey` + `workflowMutationKey` in the TS workflow
   layer so a re-executed step does not double-apply an external mutation.

Because completed/cancelled/dead entries remain as rows in
`scheduler_queue_entry` (they are not deleted on load), the cross-restart
deduplication that the legacy in-memory `occurrence_ledger` provided is now
enforced structurally by the durable queue table + its unique constraint.

## Workspace / project integration (Batch 9 data model)

The scheduler/workflow repos are workspace-scoped today but the command surface
passes the single-profile default workspace (`""`, normalized to `default`)
because the workspace/project contracts from the Batch 9 data-model branch are
not yet merged. Expected integration points when that branch lands:

- Add a `workspace_id: String` parameter to the scheduler + workflow Tauri
  commands (`save_scheduled_job`, `list_workflow_definitions`, …) threaded from
  the shell's active workspace.
- Pass it through to `load_store_from_sqlite`, `write_store_to_sqlite`, and the
  workflow SQLite helpers (all currently hardcode `""`).
- The repo functions already take `workspace_id` and enforce isolation in every
  `WHERE` clause, so no data migration is required — only the command plumbing.
- Project scoping (a job belonging to a project) is a future column on
  `scheduled_job`; none of the current fields assume it.

## Files

- `store/schema.rs` — v4 constant + `SCHEMA_V3_TO_V4` + folded tables.
- `store/migrations/mod.rs` — `3 => …` step.
- `store/migrations/legacy.rs` — three new migrators + sources.
- `store/repos/{scheduled_job,scheduler_queue,workflow}.rs` — new repos.
- `store/repos/mod.rs` — module registration.
- `store.rs` — `delete_local_data` covers the new tables + legacy files;
  `seed_legacy_documents` excludes the new sources (typed rows are authoritative).
- `scheduler.rs`, `workflows.rs` — SQLite-backed load/save with JSON fallback.
- `models.rs` — `MAX_WORKFLOW_DEFINITION_HISTORY`.

## Risks

- The full-store flush on every scheduler mutation is O(jobs + queue) per write
  (bounded at 100 + 500). Acceptable for the single-process desktop shell; a
  future optimization is per-entry upsert/delete on the queue.
- The legacy in-memory `occurrence_ledger` is not migrated (the durable queue
  table provides stronger cross-restart dedup). If a downgrade reverts to the
  JSON file path, the ledger restarts empty — but the JSON file is preserved, so
  the pre-migration ledger is still on disk for that downgrade.
- Workspace plumbing is stubbed to `default`; until the data-model branch lands,
  all schedules/workflows share one workspace.
