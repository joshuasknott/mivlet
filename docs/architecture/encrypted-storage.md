# Encrypted local storage

Fable opens `fable-vault.db` in the Tauri app-data directory before registering
commands. SQLite supplies transactions, foreign keys, write-ahead logging, and
forward-only schema versions. Rust owns all database access; React never opens
SQLite directly.

## Encryption boundary

Sensitive domain values are sealed with AES-256-GCM. Every row uses a fresh
96-bit nonce and additional authenticated data derived from its table and stable
identity. Moving ciphertext to another row or table therefore fails to decrypt.

Only query-safe values remain plaintext: opaque IDs, enums, timestamps,
booleans, counts, relationship keys, and fingerprints. Provider and connector
credentials are not database payloads; they remain in the operating-system
credential store behind opaque references. The 256-bit vault key has its own
credential-store service and is never silently replaced if missing or invalid.

## Current schema

Schema v38 retains the local conversation product:

- workspace, optional project context, threads, messages, and message revisions;
- the minimal internal `run` execution attempt plus tool calls and approvals;
- audit history and preferences;
- provider and Connection metadata, connector cache/settings, and migration
  quarantine;
- knowledge sources/chunks, pinned context, memory, and deletion tombstones;
- optional account/sync cache and outbox state; and
- schema, migration, backup, and recovery metadata.

Fresh databases do not retain the retired orchestration stores. The v37 to v38
migration deletes their pre-release data and tables in one forward-only cleanup,
then verifies referential integrity. Historical migration code remains only so
an older pre-release database can reach v38 without skipping intermediate schema
repairs; it is not an active product surface.

Startup fails closed when the database is structurally corrupt, has unresolved
foreign-key violations, or carries a schema newer than the binary understands.

## Scope and deletion

Repositories require an explicit workspace scope and, where supported, an
optional project. Ownership checks prevent a record ID from being claimed or
read through another workspace. Tombstones prevent a deleted knowledge source
or forgotten memory from being silently recreated by a later import.

`delete_local_data` requires an exact confirmation and clears application rows,
connector caches, and owned compatibility files while preserving the schema and
vault key. It does not delete unrelated user-created exports.

## Backup and recovery

The native backup command uses SQLite's consistent backup path and refuses to
overwrite an existing destination. Restore validates the backup manifest,
schema compatibility, database integrity, and vault marker before replacing the
active database. A failed replacement leaves explicit recovery files rather
than silently discarding the previous store.

Do not copy only an active base database file. For manual diagnostics, either
use the supported backup command or preserve the database, WAL, and shared-memory
files as one set. A backup still depends on the matching operating-system vault
key and deliberately contains no provider or connector credentials.

Knowledge and memory have separate bounded, secret-scanned plaintext export
paths. Those exports are not full database backups.

## Repository contract

New durable data belongs behind a repository under `src/store/repos` and a
typed native command. It must declare ownership, plaintext query columns,
encrypted payload AAD, deletion behavior, export behavior, and credential
exclusions. Do not create a parallel JSON store for product state.
