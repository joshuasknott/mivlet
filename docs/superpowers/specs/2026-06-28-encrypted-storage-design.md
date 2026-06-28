# Encrypted Local Storage

**Date:** 2026-06-28
**Branch:** `codex/encrypted-storage`
**Scope:** a durable, encrypted, transactional local-first store that replaces
Fable's fragmented non-secret JSON persistence, while preserving the existing
OS-secure-storage credential boundary and backward compatibility.

This is the "Encrypted SQLite" layer named by `docs/product/architecture.md`
("Encrypted SQLite for offline/private local state") and flagged as remaining
security work in `docs/security/threat-model.md` ("Move non-secret JSON metadata
to encrypted SQLite for transactional integrity and migrations"). The earlier
spec `2026-06-28-persistence-snapshot-migration-design.md` was the *interim*
localStorage→snapshot migration (Goal 1, done); this spec builds the durable
store those docs always pointed at.

## Lead-agent decisions (the load-bearing choices)

### D1 — Engine: bundled SQLite + application-layer AES-256-GCM (not SQLCipher)

**Decision.** Use `rusqlite` with the `bundled` feature (SQLite compiled from C
amalgamation, no system SQLite dependency) and perform encryption in the
application layer with AES-256-GCM, encrypting each sensitive record's payload
before it touches SQLite.

**Why not SQLCipher** (transparent page-level encryption). SQLCipher was the
first choice investigated. It is **not viable in this build environment or in
CI**:

- `rusqlite` `bundled-sqlcipher` requires a system OpenSSL via `OPENSSL_DIR`.
- `bundled-sqlcipher-vendored-openssl` bundles OpenSSL but its build runs
  OpenSSL's `./Configure` through Perl; the build environment's Perl lacks the
  locale modules OpenSSL needs (`Locale::Maketext::Simple`), so the vendored
  build fails. This would also break reproducibly in a fresh CI checkout.

Both were verified empirically before committing the architecture. Plain
`bundled` SQLite compiles and runs cleanly (the Rust `cc` crate finds MSVC even
from a Git Bash shell), and `aes-gcm` (pure Rust, no native crypto) provides
authenticated encryption with tamper detection. This stack needs **only a C
compiler** for SQLite — nothing else native — which is CI-safe.

**Residual metadata (documented honestly).** Because encryption is at the record
payload level rather than the page level, SQLite's own structural metadata is
plaintext: table names, column names, row counts, indexes, and the schema
itself. The row *content* of any sensitive table is stored as a single
authenticated ciphertext BLOB (plus small plaintext index columns used only for
querying/foreign keys). We therefore:

- keep sensitive text (drafts, transcripts, memory values, audit notes) only
  inside the encrypted payload column;
- store *only* non-sensitive, non-secret keys/ids/fingerprints as plaintext
  columns for indexing and foreign-key joins (e.g. `project_id`, `created_at`,
  `status`, content fingerprints);
- never store a secret or a free-text user value in a plaintext column.

This trade-off (visible schema + opaque content) is the standard, documented
shape of app-layer encryption and matches what the threat model already accepts:
it strengthens transactional integrity and migrability over today's plaintext
JSON without weakening the credential boundary.

### D2 — Key management: one 32-byte master key in OS secure storage

**Decision.** Generate a single 32-byte CSPRNG master key (`getrandom`,
already a dependency) and store it in the OS secure store under a dedicated
keyring service, distinct from the existing backend-key and connector-token
services. The master key never persists to the database or the filesystem.

- **Service/entry:** `keyring::Entry::new("com.fable.workspace.vault", "master-key")`.
  A new, dedicated service keeps the vault key's lifecycle separate from
  provider API keys (`com.fable.workspace`) and connector OAuth tokens
  (`com.fable.workspace.connectors`).
- **Creation:** on first launch, if no master key exists, generate one, store
  it, and proceed. This is the fresh-install path.
- **Retrieval:** on every launch, read the master key. If absent → the vault is
  unreadable; fail closed with recoverable guidance (see D7). If present →
  derive per-record encryption by using the master key directly as the AES-256
  key (GCM with a unique random 12-byte nonce per record provides semantic
  security; no KDF is needed because the stored key is full-entropy).
- **Rotation strategy:** provide a documented, manual rotation command that
  re-encrypts every sensitive payload under a new key and swaps the keyring
  entry in one transactional pass. Rotation is not automatic; it is an
  explicit, logged operation. (Implemented as `rotate_vault_key`.)
- **Missing-key behavior:** never create a *new* key silently over an existing
  vault. If the database file exists but the key is missing, treat it as a key
  loss (D7) — do not silently re-key and destroy the old data.

`keyring` v3 already ships the in-process `mock` backend used by tests, so the
key path is fully exercisable without touching the real OS keychain.

### D3 — Schema: one normalized relational schema, versioned

**Decision.** Replace the 10 ad-hoc JSON files with one SQLite database holding
normalized, foreign-key-linked tables. Model the data the objective names:

- `schema_version` (single-row metadata: current version, created/updated).
- `profile` (single-row: display name, email, preferences as encrypted JSON).
- `preferences` (key/value encrypted blob for shell preferences).
- `project`, `thread`, `message`, `run`, `tool_call`, `approval`,
  `audit_event`, `artifact` (the conversation/run/approval graph).
- `connector_account` (non-secret connector metadata: identity, scopes, status,
  expiry, opaque `credential_ref` into keyring — **never the token**).
- `backend_connection` (provider ids only, mirroring today's
  `connected-backends.json`; the secret stays in keyring).
- `knowledge_source`, `memory_record` (existing domains, now rows).
- `schedule` (existing schedule records, now rows — the stable surface for the
  scheduler branch in Goal 8).
- `model_config` (provider/model configuration without secret values).
- `draft` / `run_state` (composer drafts and resumable run state).
- `migration_log` (idempotent migration diagnostics, D5).
- `secret` table: **does not exist.** No secret is ever written to the DB.

Sensitive free-text columns are stored as `payload BLOB` (AEAD ciphertext) with
a companion `payload_nonce BLOB`. Non-sensitive columns (ids, timestamps,
enums, fingerprints, booleans, integer counts) stay plaintext for indexing and
joins. All user-supplied string inputs are length-bounded by the same `MAX_*`
constants the JSON layer already enforces.

Full column-level schema is in `SCHEMA` below.

### D4 — Repositories: typed traits, no UI/storage coupling

**Decision.** Define explicit repository traits in Rust. UI/commands never touch
SQLite directly. Each repository owns one domain and exposes typed read/write
methods. The traits are the stable interface other branches integrate against.

Repositories (in `apps/desktop/src-tauri/src/store/repos.rs`):
`ProfileRepo`, `PreferencesRepo`, `ProjectRepo`, `ThreadRepo`, `MessageRepo`,
`RunRepo`, `ToolCallRepo`, `ApprovalRepo`, `AuditEventRepo`, `ArtifactRepo`,
`ConnectorAccountRepo`, `BackendConnectionRepo`, `KnowledgeSourceRepo`,
`MemoryRepo`, `ScheduleRepo`, `ModelConfigRepo`, `DraftRepo`.

A `Store` value owns the `rusqlite::Connection` (wrapped for thread-safe shared
access) and a `Vault` (the AEAD primitive + key handle). Repositories are
constructed from a `&Store` and execute parameterized, bounded queries. All
multi-record writes run inside a `rusqlite::Transaction`.

### D5 — Migration: idempotent, transactional, no legacy deletion

**Decision.** A single idempotent migration pass reads each legacy JSON file
(or localStorage payload, surfaced via the existing `RuntimeSnapshot`) exactly
once, classifies each record, and writes it into the new schema inside a
transaction. Legacy files are **never deleted**; they are left in place so a
downgrade or rollback remains possible and so a re-run is harmless.

- **Classification** (per the objective): *secret* (never migrated — already in
  keyring), *sensitive* (encrypted), *ordinary* (plaintext column), *cache*
  (rebuilt, not migrated), *disposable* (dropped, logged). Classification is
  table-driven and recorded in `migration_log`.
- **Idempotency:** a `migration_log` row records `(source_file, checksum,
  status, migrated_at, diagnostics)`. Re-running a migration whose checksum
  matches is a no-op. Re-running after partial failure resumes only incomplete
  sources.
- **Interruption recovery:** each source file migrates in its own transaction;
  a crash mid-way leaves the DB consistent (committed sources stay, the
  in-flight source is absent and retried next launch). A `schema_version` guard
  prevents half-applied schema.
- **Malformed/older/duplicate records:** invalid records are skipped, not fatal.
  Their diagnostics are written to `migration_log` (no payload, no secret).
  Duplicates are deduped by natural key (mirroring today's normalize fns).
  Unsupported legacy fields are preserved as an encrypted `legacy_extras` JSON
  blob on the migrated row — never silently dropped.
- **Order:** schema migration first, then data migration sources in dependency
  order (parents before children) so foreign keys hold.

### D6 — Reliability: transactions, integrity, concurrency, backup

- **Transactions** for every multi-record operation; `rusqlite` `Transaction`.
- **Integrity:** `PRAGMA foreign_keys = ON;` `PRAGMA journal_mode = WAL;`
  `PRAGMA synchronous = NORMAL;` foreign-key + `CHECK` constraints; unique
  indexes on natural keys; AEAD authentication detects payload tamper.
- **Concurrency:** a single writer connection guarded by a `Mutex`, WAL allows
  concurrent readers. SQLite's own busy timeout handles contention. The store
  is `Send`-safe behind the mutex.
- **Backup/recovery:** a `backup_vault` command uses SQLite's online backup API
  to copy the DB to a timestamped `.bak` atomically; restore replaces the live
  file under a lock. Suitable for a local desktop app.
- **Corruption detection:** on open, run `PRAGMA integrity_check`. On any AEAD
  decrypt failure or integrity-check failure, fail closed with recoverable
  guidance (D7) and never return partially-decrypted data.
- **Non-blocking UI:** all DB work happens in Tauri commands (off the JS
  thread); heavy operations are chunked. The frontend remains responsive.

### D7 — Recovery and fail-closed guidance

- **Missing/invalid key:** if the DB exists but the master key is absent or
  fails to authenticate any row, the runtime surfaces a clear recovery state
  ("Fable cannot read your local data: the encryption key is missing or does
  not match. Restore from backup or reinitialize."), and offers: restore from a
  `.bak`, or reinitialize (which **archives** the unreadable DB + legacy files
  to a `.corrupt` sidecar before starting fresh — never silent deletion).
- **Corruption:** integrity-check failure → same recovery surface, with the
  corrupt file archived for manual recovery.

## SCHEMA (v1)

Column-level detail. `[enc]` = the value lives inside the encrypted `payload`
BLOB; plaintext columns are non-secret keys/enums/timestamps only. All
user-supplied text is `[enc]` unless it is an opaque id/fingerprint/enum.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- metadata
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);  -- single row: schema_version, app_id, created_at, last_migrated_at

-- profile + preferences
CREATE TABLE profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload BLOB NOT NULL,            -- [enc] { display_name, email, ... }
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE preferences (
  key TEXT PRIMARY KEY,             -- stable preference key (enum-ish)
  payload BLOB NOT NULL,            -- [enc] value
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- conversation / run graph
CREATE TABLE project (
  id TEXT PRIMARY KEY,              -- opaque id
  title_fingerprint TEXT NOT NULL,  -- sha256 of title (queryable, non-secret)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] title + project metadata
  payload_nonce BLOB NOT NULL
);

CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] thread metadata
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_thread_project ON thread(project_id);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- enum: user/assistant/tool/system
  seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] content + tool metadata
  payload_nonce BLOB NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX idx_message_thread ON message(thread_id, seq);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES thread(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,        -- enum-ish (catalog id), non-secret
  model TEXT NOT NULL,              -- catalog model id, non-secret
  status TEXT NOT NULL,             -- enum: queued/streaming/.../interrupted
  turn INTEGER NOT NULL DEFAULT 0,
  recoverable INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] transcript, usage, error, pending approvals
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_run_status ON run(status);
CREATE INDEX idx_run_thread ON run(thread_id);

CREATE TABLE tool_call (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,               -- enum-ish
  status TEXT NOT NULL,             -- enum
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] arguments + result
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_tool_call_run ON tool_call(run_id);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,               -- enum APPROVAL_MODES
  risk_level TEXT NOT NULL,         -- enum APPROVAL_RISK_LEVELS
  decision TEXT NOT NULL,           -- enum APPROVAL_DECISIONS
  request_fingerprint TEXT NOT NULL,-- sha256 of request (non-secret)
  decided_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] consequence, data_used, note, confirmation
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_approval_run ON approval(run_id);

CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- enum: approval/connector/backend/...
  actor TEXT NOT NULL,              -- enum-ish
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] event detail (note etc.)
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_audit_created ON audit_event(created_at);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,-- sha256, non-secret
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] content (if small) or reference
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_artifact_run ON artifact(run_id);

-- connectors (non-secret metadata only)
CREATE TABLE connector_account (
  connector_id TEXT PRIMARY KEY,    -- enum-ish catalog id
  account_id TEXT,                  -- provider account id (non-secret)
  status TEXT NOT NULL,             -- enum
  expires_at INTEGER,               -- epoch seconds or NULL
  credential_ref TEXT NOT NULL,     -- opaque key into keyring (NOT the token)
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] display identity, scopes, health
  payload_nonce BLOB NOT NULL
);

CREATE TABLE backend_connection (
  provider_id TEXT PRIMARY KEY,     -- enum-ish catalog id, non-secret
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);  -- secret stays in keyring com.fable.workspace; no payload needed

-- knowledge + memory
CREATE TABLE knowledge_source (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,       -- enum-ish
  kind TEXT NOT NULL,               -- enum
  trust TEXT NOT NULL,              -- enum
  pinned INTEGER NOT NULL DEFAULT 0,
  content_fingerprint TEXT NOT NULL,-- non-secret
  size_bytes INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  origin TEXT NOT NULL,             -- enum-ish
  payload BLOB NOT NULL,            -- [enc] title, provenance, freshness, preview, metadata
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_knowledge_connector ON knowledge_source(connector_id);
CREATE INDEX idx_knowledge_pinned ON knowledge_source(pinned);

CREATE TABLE memory_record (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- enum MEMORY_KINDS
  pinned INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] title, value, source, freshness
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_memory_kind ON memory_record(kind);
CREATE INDEX idx_memory_pinned ON memory_record(pinned);

-- scheduler (stable surface for Goal 8)
CREATE TABLE schedule (
  id TEXT PRIMARY KEY,
  weekday TEXT NOT NULL,            -- enum SCHEDULE_WEEKDAYS
  time TEXT NOT NULL,               -- "HH:MM"
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] name, description
  payload_nonce BLOB NOT NULL
);
CREATE INDEX idx_schedule_enabled ON schedule(enabled);

-- model/provider config (no secrets)
CREATE TABLE model_config (
  provider_id TEXT NOT NULL,        -- enum-ish
  model_id TEXT NOT NULL,           -- catalog model id
  selected INTEGER NOT NULL DEFAULT 0,
  payload BLOB NOT NULL,            -- [enc] label, capabilities, params
  payload_nonce BLOB NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);

-- drafts + resumable run state
CREATE TABLE draft (
  id TEXT PRIMARY KEY,              -- e.g. "composer" or thread id
  updated_at TEXT NOT NULL,
  payload BLOB NOT NULL,            -- [enc] draft text + context refs
  payload_nonce BLOB NOT NULL
);

CREATE TABLE run_state (
  id TEXT PRIMARY KEY,              -- run id
  payload BLOB NOT NULL,            -- [enc] resumable state
  payload_nonce BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- migration bookkeeping (idempotency + diagnostics)
CREATE TABLE migration_log (
  source TEXT PRIMARY KEY,          -- legacy file or 'localStorage.shell'
  checksum TEXT NOT NULL,
  status TEXT NOT NULL,             -- enum: pending/done/skipped/failed
  migrated_at TEXT NOT NULL,
  diagnostics BLOB NOT NULL,        -- [enc] structured diagnostics (no secrets)
  diagnostics_nonce BLOB NOT NULL
);
```

## Encryption wire format

Each encrypted payload is stored as two columns:

- `payload_nonce`: 12 random bytes (one unique nonce per write).
- `payload`: `AES-256-GCM(master_key, nonce, plaintext_json_bytes, aad)`
  where `aad` binds the row's identity to prevent row-swapping attacks:
  `aad = table_name || ':' || row_id`. AAD is derived from non-secret plaintext
  columns, so it can be recomputed on read without the key.

On read: fetch nonce + ciphertext + recompute AAD → `decrypt`. Any AEAD failure
is treated as corruption/tamper and fails closed (D7).

## Tauri command surface (preserved, no breaking changes)

The existing command names stay (frontend `runtime.ts` is unchanged in its
contract). The command *implementations* switch their storage backend from JSON
files to repositories. New commands added for the objective:

- `store_status` — vault/key/DB health for the recovery UI.
- `export_user_data` — portable documented export (no credentials).
- `delete_project`, `delete_connector_account`, `delete_knowledge_source`,
  `delete_schedule`, etc. — deletion with referential cleanup.
- `backup_vault`, `restore_vault` — backup/recovery.
- `rotate_vault_key` — key rotation (explicit, logged).

localStorage on the frontend becomes purely the preview store (no Tauri) and a
write-only best-effort mirror; it is no longer a source of truth on desktop.

## Testing matrix (maps to the objective's test list)

Fresh install · migration · repeat migration · interrupted migration · malformed
legacy data · missing key · invalid key · corruption · concurrent writes ·
rollback · deletion (referential cleanup) · export (no credentials) · restart
recovery · large-data behavior · no-secrets-in-ordinary-storage. Plus the full
gate: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm tauri:check`,
`cargo test`, `cargo clippy -D warnings`, `cargo fmt --check`.

## Goal 8 integration (stable interfaces)

The `KnowledgeSourceRepo` and `ScheduleRepo` traits are the stable surfaces the
knowledge-retrieval and scheduler branches implement against. They expose typed
CRUD + query methods over rows, take a `&Store`, and hide all encryption/SQL.
Goal 8 replaces their *implementations* (e.g. adds a vector index behind
knowledge) without changing the trait, and wires scheduler execution to
`ScheduleRepo::list_enabled()`. Detailed integration notes will be in the final
report.

## Out of scope (per objective)

Knowledge retrieval reimplementation, scheduler execution, provider connectors,
UI redesign beyond minimal recovery states, installer/updater/signing, push/merge.
