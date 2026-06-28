# Encrypted local storage

The desktop initializes `fable-vault.db` in the Tauri app-data directory before
registering commands. SQLite provides transactions, foreign keys, WAL recovery,
and schema versioning. Sensitive JSON payload columns are encrypted with
AES-256-GCM; each record uses a fresh 96-bit OS-random nonce and additional
authenticated data containing its table and stable row identity. IDs, enums,
timestamps, booleans, fingerprints, and relationship keys remain plaintext for
indexing.

The 256-bit master key exists only in the platform credential store under
`com.fable.workspace.vault`. A fresh install creates it once. An existing
database with a missing, malformed, or inaccessible key fails closed and is
never silently re-keyed or overwritten. Provider API keys and OAuth tokens use
their separate credential-store boundaries and never enter SQLite.

## Startup and migration

Startup applies SQLite pragmas, runs `integrity_check`, rejects schemas newer
than the binary, applies registered migrations transactionally, then imports
legacy app-data JSON. Each legacy source has a SHA-256 checksum and encrypted
migration diagnostic. Completed sources are idempotent; partial sources retry.
Malformed or unreadable files remain untouched. Legacy files are not deleted by
migration, so rollback remains possible until the user explicitly deletes local
data.

Production persistence calls route runtime snapshots, drafts, runs, approvals,
connector account metadata, backend selections, memory, knowledge sources, and
schedules through encrypted SQLite. Path-based JSON fallbacks exist only for
isolated unit tests that do not initialize Tauri. Credentials are excluded.

## Recovery, backup, export, and deletion

`encrypted_store_status` reports readiness and schema version without exposing
paths or content. `backup_local_data` uses SQLite `VACUUM INTO` to create a
consistent backup and refuses to overwrite an existing destination. A backup
must be restored together with the matching OS-secure master key.

`export_local_data` returns credential-free JSON reconstructed from decrypted
application documents. `delete_local_data` requires the exact destructive
confirmation phrase, deletes rows in referential order, and removes legacy
compatibility files. It deliberately retains the vault key and separately
managed provider credentials.

If integrity or authentication fails, preserve the database and its WAL/SHM
sidecars, restore a matched backup and key, or explicitly delete local data.
Never copy only one member of an active SQLite WAL set.

## Goal 8 contract

Later integration should use the repository modules under
`src/store/repos/` or the typed native command boundary. React must not access
SQLite directly. Knowledge sources, memory, workflows, schedules, artifacts,
and agent runs already have stable encrypted repository surfaces; Goal 8 should
reconcile overlapping schemas rather than create a second database.
