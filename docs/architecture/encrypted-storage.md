# Encrypted local storage

Mivlet opens `fable-vault.db` in the Tauri app-data directory before registering
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

Schema v42 retains the local conversation product:

- workspace, optional project context, threads, messages, and message revisions;
- the minimal internal `run` execution attempt plus tool calls and approvals;
- member-private local schedule definitions and an encrypted occurrence ledger;
- member-private conversation membership, immutable authors, project teams,
  work items, fact provenance and view layout in `collaboration_record`;
- audit history and preferences;
- provider and Connection metadata, connector cache/settings, and migration
  quarantine;
- knowledge sources/chunks, pinned context, memory, and deletion tombstones;
- optional account/sync cache and outbox state; and
- schema, migration, backup, and recovery metadata.

Fresh databases do not retain the retired orchestration stores. The v37 to v38
migration deletes their pre-release data and tables in one forward-only cleanup,
then verifies referential integrity. Historical migration code remains only so
an older pre-release database can reach the current version without skipping intermediate schema
repairs; it is not an active product surface.

Local schedules added in v40 use new `local_schedule` and
`local_schedule_occurrence` tables. They do not read or recreate the retired
Routine, workflow, Mission, or generic scheduler records. Prompt and civil-time
details stay encrypted; query columns contain only private scope, opaque route
and agent ids, states, revisions, timestamps, and one-way claim/slot
fingerprints. A stored or claimed occurrence is not evidence that execution
started or completed.

The v41 to v42 migration adds `collaboration_record` without rewriting existing
threads, message revisions, attachments, project references or authors. Native
adoption preserves each old project's original thread. New rows seal their
payload with AAD `collaboration:{workspace}:{owner}:{kind}:{id}`; only opaque
scope, kind and relationship keys remain queryable. Conversation and project
deletion cascade to their records. Full database backups and local-data deletion
include the table; plaintext knowledge exports and remote sync do not. No
credentials, approval grants or restored computer leases enter these records.

Startup fails closed when the database is structurally corrupt, has unresolved
foreign-key violations, or carries a schema newer than the binary understands.

## Scope and deletion

The embedded OpenCode host does not create a second conversation store. Each
native-managed attempt uses `database.path = ":memory:"`, disables persisted SDK
events and discards SDK log output. Its environment and temporary configuration
directory are isolated from user/project configuration; Bun's dotenv and bunfig
autoload are disabled in the compiled host. No provider credential enters the
child. Rust retains transient computer screenshots and injects them only into
authorized provider egress. The renderer receives opaque native approval IDs.

Canonical messages, tool outcomes and interruption receipts continue through
the existing encrypted repositories. Restart starts a fresh SDK attempt from
Mivlet's canonical context and authority checks; it never replays a saved SDK
session. No schema or user-data migration is required. Compiled-host fixtures
scan the temporary directory for prompt/tool-output canaries after completion.

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
