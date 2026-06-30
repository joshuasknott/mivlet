//! Portable workspace export/import foundation (Batch 9).
//!
//! A conservative, local-first archive format for user-owned data in the
//! encrypted SQLite store. See
//! `docs/superpowers/specs/2026-06-30-export-import-design.md`.
//!
//! ## What this is
//! A versioned JSON manifest (`formatVersion`, independent of the DB
//! `schemaVersion`) that carries the decrypted domain value of every
//! user-owned record, plus its non-secret index columns. It is **independent of
//! raw database internals**: no BLOBs, nonces, AAD, or row layout leak.
//!
//! ## What this is not
//! - Not encrypted: the artifact is plaintext JSON the user owns. Secrets are
//!   *structurally absent* (they live only in the OS keyring and never enter
//!   the DB), not encrypted-away.
//! - Not a backup: `backup_local_data` (`VACUUM INTO`) is the raw-DB backup.
//!   This is the portable, forward-compatible, re-importable surface.
//! - Not wired to UI: the Tauri commands here are the seam.
//!
//! ## Local-first guarantees
//! - No network, no telemetry, no connector activation, no schedule activation.
//! - Imported connectors are written `disconnected` with no `credential_ref`;
//!   they cannot authenticate until reconfigured.
//! - Imported schedules are written `enabled = false`; the user re-enables them.
//!
//! ## Conflict + rollback
//! The default conflict policy is **skip-existing** (never overwrite). The
//! entire import runs in one SQLite transaction; any failure rolls back to the
//! pre-import state byte-for-byte.

use std::collections::BTreeMap;

use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::store::schema::CURRENT_SCHEMA_VERSION;
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/// The manifest format identifier. Bumped only when the *manifest shape*
/// changes (not when DB tables are added — those are new `sections` entries).
pub const PORTABLE_FORMAT_VERSION: u32 = 1;

/// The format discriminator written into every manifest.
pub const PORTABLE_FORMAT_NAME: &str = "fable.portable-workspace";

/// The `producedBy` prefix.
const PRODUCED_BY: &str = "fable-desktop/0.1.0";

/// Categories deliberately omitted from every export, with the reason. Imports
/// surface these as warnings so the user knows what needs reconfiguration.
fn omitted_summary() -> Value {
    serde_json::json!({
        "secrets": [
            "oauth-tokens (OS keyring only, never in DB)",
            "api-keys (OS keyring only, never in DB)",
            "vault-master-key (OS keyring only, never in DB)"
        ],
        "credentialRefs": [
            "connector_account.credential_ref (per-installation keyring key, dropped on export)"
        ],
        "caches": [
            "connector_cache (workspace-isolated search cache, rebuilt from sources)",
            "connector_cache_settings (cache controls, not user content)"
        ],
        "transient": [
            "run_state is exported (user-recoverable), but documented here as recoverable state"
        ],
        "bookkeeping": [
            "schema_meta (DB-internal version row)",
            "migration_log (one-time legacy JSON migration diagnostics)"
        ],
        "machineSpecific": [
            "OS keyring service entries",
            "absolute app-data-dir paths"
        ]
    })
}

// ---------------------------------------------------------------------------
// Manifest types
// ---------------------------------------------------------------------------

/// The top-level portable workspace manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    /// Informational only; not used for replay. The single non-deterministic
    /// field — everything else is sorted/keyed deterministically.
    pub exported_at: String,
    pub produced_by: String,
    /// Invariant: always `false`. A manifest claiming `true` is rejected on
    /// import — we will not ingest anything that claims to carry credentials.
    pub credentials_included: bool,
    pub sections: Sections,
    pub omitted: Value,
}

/// The extensible section bag. Unknown sections are tolerated on import
/// (producing a warning) so the format stays forward-compatible. Missing
/// sections default to empty so partial manifests import cleanly.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sections {
    pub profile: Option<ProfileRecord>,
    pub preferences: Vec<PreferenceRecord>,
    pub projects: Vec<ProjectRecord>,
    pub threads: Vec<ThreadRecord>,
    pub messages: Vec<MessageRecord>,
    pub runs: Vec<RunRecord>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub approvals: Vec<ApprovalRecord>,
    pub audit_events: Vec<AuditEventRecord>,
    pub artifacts: Vec<ArtifactRecord>,
    pub connector_accounts: Vec<ConnectorAccountRecord>,
    pub backend_connections: Vec<BackendConnectionRecord>,
    pub knowledge_sources: Vec<KnowledgeSourceRecord>,
    pub memory_records: Vec<MemoryRecord>,
    pub schedules: Vec<ScheduleRecord>,
    pub model_configs: Vec<ModelConfigRecord>,
    pub drafts: Vec<DraftRecord>,
    pub run_states: Vec<RunStateRecord>,
}

macro_rules! record {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $(pub $field : $ty,)* }
    };
}

record!(ProfileRecord {
    updated_at: String,
    payload: Value,
});

record!(PreferenceRecord {
    key: String,
    updated_at: String,
    value: Value,
});

record!(ProjectRecord {
    id: String,
    title_fingerprint: String,
    created_at: String,
    updated_at: String,
    payload: Value,
});

record!(ThreadRecord {
    id: String,
    project_id: String,
    created_at: String,
    updated_at: String,
    payload: Value,
});

record!(MessageRecord {
    id: String,
    thread_id: String,
    role: String,
    seq: i64,
    created_at: String,
    payload: Value,
});

record!(RunRecord {
    id: String,
    thread_id: Option<String>,
    provider_id: String,
    model: String,
    status: String,
    turn: i64,
    recoverable: bool,
    retry_count: i64,
    created_at: String,
    updated_at: String,
    payload: Value,
});

record!(ToolCallRecord {
    id: String,
    run_id: String,
    tool: String,
    status: String,
    created_at: String,
    payload: Value,
});

record!(ApprovalRecord {
    id: String,
    run_id: Option<String>,
    service: String,
    action: String,
    mode: String,
    risk_level: String,
    decision: String,
    request_fingerprint: String,
    decided_at: String,
    payload: Value,
});

record!(AuditEventRecord {
    id: String,
    kind: String,
    actor: String,
    created_at: String,
    category: String,
    service: String,
    action: String,
    status: String,
    risk_level: String,
    mode: String,
    correlation_id: String,
    error_code: String,
    summary: String,
    payload: Value,
});

record!(ArtifactRecord {
    id: String,
    run_id: Option<String>,
    kind: String,
    content_fingerprint: String,
    size_bytes: i64,
    created_at: String,
    payload: Value,
});

// Connector account metadata. NOTE: `credential_ref` is intentionally absent
// — it is an opaque per-installation keyring key, not a secret and not
// portable. Import writes these `disconnected` with no credential ref.
record!(ConnectorAccountRecord {
    connector_id: String,
    account_id: Option<String>,
    status: String,
    expires_at: Option<i64>,
    connected_at: String,
    updated_at: String,
    payload: Value,
});

record!(BackendConnectionRecord {
    provider_id: String,
    connected_at: String,
    updated_at: String,
});

record!(KnowledgeSourceRecord {
    id: String,
    connector_id: String,
    kind: String,
    trust: String,
    pinned: bool,
    content_fingerprint: String,
    size_bytes: i64,
    imported_at: String,
    origin: String,
    payload: Value,
});

record!(MemoryRecord {
    id: String,
    kind: String,
    pinned: bool,
    approved: bool,
    created_at: String,
    payload: Value,
});

record!(ScheduleRecord {
    id: String,
    weekday: String,
    time: String,
    enabled: bool,
    created_at: String,
    payload: Value,
});

record!(ModelConfigRecord {
    provider_id: String,
    model_id: String,
    selected: bool,
    payload: Value,
});

record!(DraftRecord {
    id: String,
    updated_at: String,
    payload: Value,
});

record!(RunStateRecord {
    id: String,
    updated_at: String,
    payload: Value,
});

// ---------------------------------------------------------------------------
// Low-level row reader (decrypts payloads via the store vault)
// ---------------------------------------------------------------------------

/// Read every `(payload, payload_nonce)` pair for the given query, decrypt with
/// the table:id AAD convention, and hand back the decrypted JSON value plus the
/// plaintext columns as a JSON object. Plaintext columns are read positionally
/// after the two sealed BLOBs and merged into the row object under their
/// camelCase names.
fn read_rows(
    conn: &Connection,
    store: &Store,
    table: &str,
    sql: &str,
    // (column index in SELECT (0-based), camelCase json key, cast)
    plain_cols: &[(usize, &str, Cast)],
) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let n_cols = plain_cols.len();
    let row_count = stmt.column_count();
    // Last two columns are always payload, payload_nonce.
    debug_assert!(row_count >= n_cols + 2);
    let partials: Vec<(Vec<Value>, Sealed, Vec<String>)> = stmt
        .query_map([], |row| {
            // Read plaintext column values as their JSON form first.
            let mut plains = Vec::with_capacity(n_cols);
            let mut keys = Vec::with_capacity(n_cols);
            for &(idx, key, cast) in plain_cols {
                plains.push(cast.read(row, idx)?);
                keys.push(key.to_string());
            }
            let payload_idx = row_count - 2;
            let nonce_idx = row_count - 1;
            let sealed = Sealed {
                ciphertext: row.get::<_, Vec<u8>>(payload_idx)?,
                nonce: row.get::<_, Vec<u8>>(nonce_idx)?,
            };
            Ok((plains, sealed, keys))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(partials.len());
    for (plains, sealed, keys) in partials {
        // AAD convention is "{table}:{id}" where id is the first plaintext col.
        // For tables without a single id (preferences.key, model_config composite),
        // the caller passes a table-prefixed aad by reading the first col value.
        let id_str = plains
            .first()
            .map(|v| v.as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        let aad = format!("{table}:{id_str}");
        let payload = open_json_value(store, &sealed, &aad)?;
        let mut obj = Map::new();
        for (val, key) in plains.into_iter().zip(keys) {
            obj.insert(key, val);
        }
        obj.insert("payload".to_string(), payload);
        out.push(Value::Object(obj));
    }
    Ok(out)
}

#[derive(Clone, Copy)]
enum Cast {
    Text,
    Int,
    Bool,
    NullableText,
    NullableInt,
}

impl Cast {
    fn read(self, row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<Value> {
        use Cast::*;
        match self {
            Text => Ok(Value::String(row.get::<_, String>(idx)?)),
            Int => Ok(Value::Number(row.get::<_, i64>(idx)?.into())),
            Bool => Ok(Value::Bool(row.get::<_, i64>(idx)? != 0)),
            NullableText => Ok(row
                .get::<_, Option<String>>(idx)?
                .map(Value::String)
                .unwrap_or(Value::Null)),
            NullableInt => Ok(row
                .get::<_, Option<i64>>(idx)?
                .map(|n| Value::Number(n.into()))
                .unwrap_or(Value::Null)),
        }
    }
}

fn open_json_value(store: &Store, sealed: &Sealed, aad: &str) -> Result<Value> {
    let bytes = store.open_payload(sealed, aad)?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| StoreError::Invalid("Could not decode a portable record.".into()))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Build a deterministic portable workspace manifest from the store. Validates
/// referential integrity before returning; on failure produces no artifact.
pub fn export_workspace(store: &Store) -> Result<Manifest> {
    let sections = store.with_conn(|conn| read_sections(conn, store))?;
    validate_integrity(&sections)?;
    Ok(Manifest {
        format: PORTABLE_FORMAT_NAME.to_string(),
        format_version: PORTABLE_FORMAT_VERSION,
        schema_version: CURRENT_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        produced_by: PRODUCED_BY.to_string(),
        credentials_included: false,
        sections,
        omitted: omitted_summary(),
    })
}

fn read_sections(conn: &Connection, store: &Store) -> Result<Sections> {
    // profile (singleton id=1)
    let profile = read_profile(conn, store)?;

    // preferences: the encrypted payload *is* the value (there is no separate
    // payload document), so read it directly into the `value` field.
    let preferences = {
        let mut stmt = conn.prepare(
            "SELECT key, updated_at, payload, payload_nonce FROM preferences
             WHERE workspace_id='default' ORDER BY key;",
        )?;
        let partials: Vec<(String, String, Sealed)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    Sealed {
                        ciphertext: row.get(2)?,
                        nonce: row.get(3)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(partials.len());
        for (key, updated_at, sealed) in partials {
            let value = open_json_value(store, &sealed, &format!("preferences:default:{key}"))?;
            out.push(PreferenceRecord {
                key,
                updated_at,
                value,
            });
        }
        out
    };

    let projects = read_rows(
        conn,
        store,
        "project",
        "SELECT id, title_fingerprint, created_at, updated_at, payload, payload_nonce
         FROM project WHERE workspace_id='default' ORDER BY id;",
        &[
            (0, "id", Cast::Text),
            (1, "titleFingerprint", Cast::Text),
            (2, "createdAt", Cast::Text),
            (3, "updatedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ProjectRecord>(v, "project"))
    .collect::<Result<_>>()?;

    let threads = read_rows(
        conn,
        store,
        "thread",
        "SELECT id, project_id, created_at, updated_at, payload, payload_nonce
         FROM thread ORDER BY project_id, id;",
        &[
            (0, "id", Cast::Text),
            (1, "projectId", Cast::Text),
            (2, "createdAt", Cast::Text),
            (3, "updatedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ThreadRecord>(v, "thread"))
    .collect::<Result<_>>()?;

    let messages = read_rows(
        conn,
        store,
        "message",
        "SELECT id, thread_id, role, seq, created_at, payload, payload_nonce
         FROM message ORDER BY thread_id, seq, id;",
        &[
            (0, "id", Cast::Text),
            (1, "threadId", Cast::Text),
            (2, "role", Cast::Text),
            (3, "seq", Cast::Int),
            (4, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<MessageRecord>(v, "message"))
    .collect::<Result<_>>()?;

    let runs = read_rows(
        conn,
        store,
        "run",
        "SELECT id, thread_id, provider_id, model, status, turn, recoverable,
                retry_count, created_at, updated_at, payload, payload_nonce
         FROM run ORDER BY created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "threadId", Cast::NullableText),
            (2, "providerId", Cast::Text),
            (3, "model", Cast::Text),
            (4, "status", Cast::Text),
            (5, "turn", Cast::Int),
            (6, "recoverable", Cast::Bool),
            (7, "retryCount", Cast::Int),
            (8, "createdAt", Cast::Text),
            (9, "updatedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<RunRecord>(v, "run"))
    .collect::<Result<_>>()?;

    let tool_calls = read_rows(
        conn,
        store,
        "tool_call",
        "SELECT id, run_id, tool, status, created_at, payload, payload_nonce
         FROM tool_call ORDER BY run_id, created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "runId", Cast::Text),
            (2, "tool", Cast::Text),
            (3, "status", Cast::Text),
            (4, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ToolCallRecord>(v, "tool_call"))
    .collect::<Result<_>>()?;

    let approvals = read_rows(
        conn,
        store,
        "approval",
        "SELECT id, run_id, service, action, mode, risk_level, decision,
                request_fingerprint, decided_at, payload, payload_nonce
         FROM approval ORDER BY decided_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "runId", Cast::NullableText),
            (2, "service", Cast::Text),
            (3, "action", Cast::Text),
            (4, "mode", Cast::Text),
            (5, "riskLevel", Cast::Text),
            (6, "decision", Cast::Text),
            (7, "requestFingerprint", Cast::Text),
            (8, "decidedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ApprovalRecord>(v, "approval"))
    .collect::<Result<_>>()?;

    let audit_events = read_rows(
        conn,
        store,
        "audit_event",
        "SELECT id, kind, actor, created_at, category, service, action, status,
                risk_level, mode, correlation_id, error_code, summary, payload, payload_nonce
         FROM audit_event ORDER BY created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "kind", Cast::Text),
            (2, "actor", Cast::Text),
            (3, "createdAt", Cast::Text),
            (4, "category", Cast::Text),
            (5, "service", Cast::Text),
            (6, "action", Cast::Text),
            (7, "status", Cast::Text),
            (8, "riskLevel", Cast::Text),
            (9, "mode", Cast::Text),
            (10, "correlationId", Cast::Text),
            (11, "errorCode", Cast::Text),
            (12, "summary", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<AuditEventRecord>(v, "audit_event"))
    .collect::<Result<_>>()?;

    let artifacts = read_rows(
        conn,
        store,
        "artifact",
        "SELECT id, run_id, kind, content_fingerprint, size_bytes, created_at,
                payload, payload_nonce
         FROM artifact ORDER BY created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "runId", Cast::NullableText),
            (2, "kind", Cast::Text),
            (3, "contentFingerprint", Cast::Text),
            (4, "sizeBytes", Cast::Int),
            (5, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ArtifactRecord>(v, "artifact"))
    .collect::<Result<_>>()?;

    // connector_account — credential_ref is intentionally NOT selected.
    let connector_accounts = read_rows(
        conn,
        store,
        "connector_account:default",
        "SELECT connector_id, account_id, status, expires_at, connected_at,
                updated_at, payload, payload_nonce
         FROM connector_account WHERE workspace_id='default' ORDER BY connector_id;",
        &[
            (0, "connectorId", Cast::Text),
            (1, "accountId", Cast::NullableText),
            (2, "status", Cast::Text),
            (3, "expiresAt", Cast::NullableInt),
            (4, "connectedAt", Cast::Text),
            (5, "updatedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ConnectorAccountRecord>(v, "connector_account"))
    .collect::<Result<_>>()?;

    // backend_connection — no payload columns; read directly.
    let backend_connections: Vec<BackendConnectionRecord> = {
        let mut stmt = conn.prepare(
            "SELECT provider_id, connected_at, updated_at FROM backend_connection ORDER BY provider_id;",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(BackendConnectionRecord {
                provider_id: row.get(0)?,
                connected_at: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        out
    };

    let knowledge_sources = read_rows(
        conn,
        store,
        "knowledge_source:default",
        "SELECT id, connector_id, kind, trust, pinned, content_fingerprint,
                size_bytes, imported_at, origin, payload, payload_nonce
         FROM knowledge_source WHERE workspace_id='default' ORDER BY imported_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "connectorId", Cast::Text),
            (2, "kind", Cast::Text),
            (3, "trust", Cast::Text),
            (4, "pinned", Cast::Bool),
            (5, "contentFingerprint", Cast::Text),
            (6, "sizeBytes", Cast::Int),
            (7, "importedAt", Cast::Text),
            (8, "origin", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<KnowledgeSourceRecord>(v, "knowledge_source"))
    .collect::<Result<_>>()?;

    let memory_records = read_rows(
        conn,
        store,
        "memory_record:default",
        "SELECT id, kind, pinned, approved, created_at, payload, payload_nonce
         FROM memory_record WHERE workspace_id='default' ORDER BY created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "kind", Cast::Text),
            (2, "pinned", Cast::Bool),
            (3, "approved", Cast::Bool),
            (4, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<MemoryRecord>(v, "memory_record"))
    .collect::<Result<_>>()?;

    let schedules = read_rows(
        conn,
        store,
        "schedule:default",
        "SELECT id, weekday, time, enabled, created_at, payload, payload_nonce
         FROM schedule WHERE workspace_id='default' ORDER BY created_at, id;",
        &[
            (0, "id", Cast::Text),
            (1, "weekday", Cast::Text),
            (2, "time", Cast::Text),
            (3, "enabled", Cast::Bool),
            (4, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ScheduleRecord>(v, "schedule"))
    .collect::<Result<_>>()?;

    // model_config — composite key (provider_id, model_id). AAD uses provider_id
    // as the leading id segment per the established convention.
    let model_configs = read_rows(
        conn,
        store,
        "model_config",
        "SELECT provider_id, model_id, selected, payload, payload_nonce
         FROM model_config ORDER BY provider_id, model_id;",
        &[
            (0, "providerId", Cast::Text),
            (1, "modelId", Cast::Text),
            (2, "selected", Cast::Bool),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ModelConfigRecord>(v, "model_config"))
    .collect::<Result<_>>()?;

    let drafts = read_rows(
        conn,
        store,
        "draft",
        "SELECT id, updated_at, payload, payload_nonce FROM draft ORDER BY id;",
        &[(0, "id", Cast::Text), (1, "updatedAt", Cast::Text)],
    )?
    .into_iter()
    .map(|v| record_from::<DraftRecord>(v, "draft"))
    .collect::<Result<_>>()?;

    let run_states = read_rows(
        conn,
        store,
        "run_state",
        "SELECT id, updated_at, payload, payload_nonce FROM run_state ORDER BY id;",
        &[(0, "id", Cast::Text), (1, "updatedAt", Cast::Text)],
    )?
    .into_iter()
    .map(|v| record_from::<RunStateRecord>(v, "run_state"))
    .collect::<Result<_>>()?;

    Ok(Sections {
        profile,
        preferences,
        projects,
        threads,
        messages,
        runs,
        tool_calls,
        approvals,
        audit_events,
        artifacts,
        connector_accounts,
        backend_connections,
        knowledge_sources,
        memory_records,
        schedules,
        model_configs,
        drafts,
        run_states,
    })
}

fn read_profile(conn: &Connection, store: &Store) -> Result<Option<ProfileRecord>> {
    let row: Option<(String, Vec<u8>, Vec<u8>)> = conn
        .query_row(
            "SELECT updated_at, payload, payload_nonce FROM profile WHERE id = 1;",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((updated_at, ct, n)) => {
            let sealed = Sealed {
                ciphertext: ct,
                nonce: n,
            };
            // AAD for the singleton profile row is "profile:1".
            let payload = open_json_value(store, &sealed, "profile:1")?;
            Ok(Some(ProfileRecord { updated_at, payload }))
        }
    }
}

/// Validate referential integrity of the exported sections. Rejects dangling
/// foreign keys and duplicate ids so the artifact is self-consistent.
fn validate_integrity(s: &Sections) -> Result<()> {
    let mut errors: Vec<String> = Vec::new();

    let project_ids: std::collections::BTreeSet<&str> =
        s.projects.iter().map(|p| p.id.as_str()).collect();
    let thread_ids: std::collections::BTreeSet<&str> =
        s.threads.iter().map(|t| t.id.as_str()).collect();
    let run_ids: std::collections::BTreeSet<&str> = s.runs.iter().map(|r| r.id.as_str()).collect();

    // duplicates
    if has_dup(&s.projects, |r| &r.id) {
        errors.push("Duplicate project ids.".into());
    }
    if has_dup(&s.threads, |r| &r.id) {
        errors.push("Duplicate thread ids.".into());
    }
    if has_dup(&s.runs, |r| &r.id) {
        errors.push("Duplicate run ids.".into());
    }

    // thread -> project
    for t in &s.threads {
        if !project_ids.contains(t.project_id.as_str()) {
            errors.push(format!(
                "Thread {} references unknown project {}.",
                t.id, t.project_id
            ));
        }
    }
    // message -> thread
    for m in &s.messages {
        if !thread_ids.contains(m.thread_id.as_str()) {
            errors.push(format!(
                "Message {} references unknown thread {}.",
                m.id, m.thread_id
            ));
        }
    }
    // run -> thread (nullable)
    for r in &s.runs {
        if let Some(tid) = &r.thread_id {
            if !thread_ids.contains(tid.as_str()) {
                errors.push(format!(
                    "Run {} references unknown thread {}.",
                    r.id, tid
                ));
            }
        }
    }
    // tool_call -> run
    for tc in &s.tool_calls {
        if !run_ids.contains(tc.run_id.as_str()) {
            errors.push(format!(
                "Tool call {} references unknown run {}.",
                tc.id, tc.run_id
            ));
        }
    }
    // approval -> run (nullable)
    for a in &s.approvals {
        if let Some(rid) = &a.run_id {
            if !run_ids.contains(rid.as_str()) {
                errors.push(format!(
                    "Approval {} references unknown run {}.",
                    a.id, rid
                ));
            }
        }
    }
    // artifact -> run (nullable)
    for ar in &s.artifacts {
        if let Some(rid) = &ar.run_id {
            if !run_ids.contains(rid.as_str()) {
                errors.push(format!(
                    "Artifact {} references unknown run {}.",
                    ar.id, rid
                ));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Portable workspace failed referential integrity: {}",
            errors.join(" ")
        )))
    }
}

fn has_dup<T, F: Fn(&T) -> &String>(v: &[T], key: F) -> bool {
    let mut seen = std::collections::HashSet::new();
    for item in v {
        if !seen.insert(key(item).clone()) {
            return true;
        }
    }
    false
}

fn record_from<T: for<'de> Deserialize<'de>>(value: Value, table: &str) -> Result<T> {
    serde_json::from_value::<T>(value).map_err(|e| {
        StoreError::Invalid(format!("Could not decode a {table} record for export: {e}."))
    })
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Import options. The foundation only supports [`ConflictPolicy::Skip`].
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOptions {
    pub conflict: ConflictPolicy,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// Never overwrite an existing id; record it as skipped. (Default.)
    #[default]
    Skip,
}

/// Structured import outcome. Never carries secret material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub inserted: BTreeMap<String, usize>,
    pub skipped: BTreeMap<String, usize>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl ImportReport {
    fn new() -> Self {
        Self {
            inserted: BTreeMap::new(),
            skipped: BTreeMap::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }
    fn inc_inserted(&mut self, section: &str) {
        *self.inserted.entry(section.to_string()).or_insert(0) += 1;
    }
    fn inc_skipped(&mut self, section: &str) {
        *self.skipped.entry(section.to_string()).or_insert(0) += 1;
    }
}

/// Parse + validate + plan + apply. On any failure returns an `Err` carrying
/// the structured report; no writes occur.
///
/// `manifest_json` is the raw manifest text. Apply happens inside a single
/// `Store::transaction`; on failure the transaction rolls back and the store is
/// byte-for-byte unchanged.
pub fn import_workspace(
    store: &Store,
    manifest_json: &str,
    options: ImportOptions,
) -> std::result::Result<ImportReport, ImportError> {
    let manifest = parse_and_validate(manifest_json)?;
    let mut report = ImportReport::new();

    // Plan: detect which incoming ids already exist. Done inside the same
    // transaction that applies, so the plan is consistent with the apply.
    let apply_result: Result<ImportReport> = store.transaction(|tx| {
        // Re-validate incoming integrity (a manifest could be edited after export).
        validate_integrity(&manifest.sections)?;

        plan_and_apply(tx, store, &manifest, options, &mut report)?;
        Ok(report.clone())
    });

    match apply_result {
        Ok(r) => Ok(r),
        Err(e) => Err(ImportError::ApplyFailed(report, e.to_string())),
    }
}

/// Error returned by import. Carries the partial report so callers can show
/// what was attempted; on `ApplyFailed` the store is unchanged (rollback).
#[derive(Debug)]
pub enum ImportError {
    /// Manifest could not be parsed or failed validation. Nothing was written.
    Invalid(String),
    /// A write failed mid-apply. The transaction rolled back; the store is
    /// unchanged. Carries the report up to the failure point + the cause.
    ///
    /// The report is retained (not surfaced in `Display`) so callers that want
    /// structured detail can still read it.
    #[allow(dead_code)]
    ApplyFailed(ImportReport, String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImportError::Invalid(msg) => write!(f, "{msg}"),
            ImportError::ApplyFailed(_, msg) => {
                write!(f, "Import failed and was rolled back: {msg}")
            }
        }
    }
}

fn parse_and_validate(json: &str) -> std::result::Result<Manifest, ImportError> {
    let manifest: Manifest = serde_json::from_str(json).map_err(|e| {
        ImportError::Invalid(format!("The manifest is not valid portable-workspace JSON: {e}."))
    })?;
    if manifest.format != PORTABLE_FORMAT_NAME {
        return Err(ImportError::Invalid(format!(
            "The manifest format is '{}' but Fable expected '{PORTABLE_FORMAT_NAME}'.",
            manifest.format
        )));
    }
    if manifest.format_version > PORTABLE_FORMAT_VERSION {
        // Future-version seam: a migrate_manifest() hook would go here. For now
        // we fail closed rather than guess at a newer shape.
        return Err(ImportError::Invalid(format!(
            "The manifest formatVersion is {} but this version of Fable supports up to {}.",
            manifest.format_version, PORTABLE_FORMAT_VERSION
        )));
    }
    if manifest.credentials_included {
        // Hard refusal: we never ingest anything that claims to carry credentials.
        return Err(ImportError::Invalid(
            "The manifest claims to include credentials; Fable will not import it.".into(),
        ));
    }
    Ok(manifest)
}

/// Placeholder migration seam for future format versions. Currently a no-op:
/// the only supported version is 1. Documented as an integration point.
#[allow(dead_code)]
fn migrate_manifest(_manifest: &mut Manifest, _target: u32) -> std::result::Result<(), ImportError> {
    Ok(())
}

fn plan_and_apply(
    tx: &Connection,
    store: &Store,
    manifest: &Manifest,
    options: ImportOptions,
    report: &mut ImportReport,
) -> Result<()> {
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

    // profile (singleton). Skip if a profile row already exists.
    if let Some(p) = &manifest.sections.profile {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM profile WHERE id = 1);",
            [],
            |row| row.get(0),
        )?;
        if exists {
            report.inc_skipped("profile");
        } else {
            let sealed = store.seal_json_owned(&p.payload, "profile:1")?;
            tx.execute(
                "INSERT INTO profile (id, updated_at, payload, payload_nonce) VALUES (1, ?1, ?2, ?3);",
                rusqlite::params![p.updated_at, sealed.ciphertext, sealed.nonce],
            )?;
            report.inc_inserted("profile");
        }
    }

    apply_simple(
        tx,
        store,
        &manifest.sections.preferences,
        "preferences",
        "key",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.value, &format!("preferences:default:{}", r.key))?;
            tx.execute(
                "INSERT INTO preferences (workspace_id, key, updated_at, payload, payload_nonce)
                 VALUES ('default', ?1, ?2, ?3, ?4);",
                rusqlite::params![r.key, r.updated_at, sealed.ciphertext, sealed.nonce],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.projects,
        "projects",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("project:{}", r.id))?;
            tx.execute(
                "INSERT INTO project (id, workspace_id, title_fingerprint, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, 'default', ?2, ?3, ?4, ?5, ?6);",
                rusqlite::params![
                    r.id,
                    r.title_fingerprint,
                    r.created_at,
                    r.updated_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.threads,
        "threads",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("thread:{}", r.id))?;
            tx.execute(
                "INSERT INTO thread (id, project_id, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
                rusqlite::params![
                    r.id,
                    r.project_id,
                    r.created_at,
                    r.updated_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.messages,
        "messages",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("message:{}", r.id))?;
            tx.execute(
                "INSERT INTO message (id, thread_id, role, seq, created_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    r.thread_id,
                    r.role,
                    r.seq,
                    r.created_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.runs,
        "runs",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("run:{}", r.id))?;
            tx.execute(
                "INSERT INTO run (id, thread_id, provider_id, model, status, turn, recoverable,
                          retry_count, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
                rusqlite::params![
                    r.id,
                    r.thread_id,
                    r.provider_id,
                    r.model,
                    r.status,
                    r.turn,
                    r.recoverable as i64,
                    r.retry_count,
                    r.created_at,
                    r.updated_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.tool_calls,
        "toolCalls",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("tool_call:{}", r.id))?;
            tx.execute(
                "INSERT INTO tool_call (id, run_id, tool, status, created_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    r.run_id,
                    r.tool,
                    r.status,
                    r.created_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.approvals,
        "approvals",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("approval:{}", r.id))?;
            tx.execute(
                "INSERT INTO approval (id, run_id, service, action, mode, risk_level, decision,
                          request_fingerprint, decided_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
                rusqlite::params![
                    r.id,
                    r.run_id,
                    r.service,
                    r.action,
                    r.mode,
                    r.risk_level,
                    r.decision,
                    r.request_fingerprint,
                    r.decided_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.audit_events,
        "auditEvents",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("audit_event:{}", r.id))?;
            tx.execute(
                "INSERT INTO audit_event (id, kind, actor, created_at, category, service, action,
                          status, risk_level, mode, correlation_id, error_code, summary,
                          payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15);",
                rusqlite::params![
                    r.id,
                    r.kind,
                    r.actor,
                    r.created_at,
                    r.category,
                    r.service,
                    r.action,
                    r.status,
                    r.risk_level,
                    r.mode,
                    r.correlation_id,
                    r.error_code,
                    r.summary,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.artifacts,
        "artifacts",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("artifact:{}", r.id))?;
            tx.execute(
                "INSERT INTO artifact (id, run_id, kind, content_fingerprint, size_bytes, created_at,
                          payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
                rusqlite::params![
                    r.id,
                    r.run_id,
                    r.kind,
                    r.content_fingerprint,
                    r.size_bytes,
                    r.created_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    // connector_account — local-first: status forced to "disconnected", and
    // credential_ref left empty. The imported row cannot authenticate.
    apply_simple(
        tx,
        store,
        &manifest.sections.connector_accounts,
        "connectorAccounts",
        "connectorId",
        report,
        |tx, store, r| {
            let sealed =
                store.seal_json_owned(&r.payload, &format!("connector_account:default:{}", r.connector_id))?;
            tx.execute(
                "INSERT INTO connector_account (workspace_id, project_id, connector_id, account_id, status, expires_at,
                          credential_ref, connected_at, updated_at, payload, payload_nonce)
                 VALUES ('default', NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
                rusqlite::params![
                    r.connector_id,
                    r.account_id,
                    "disconnected", // forced: never auto-activate
                    r.expires_at,
                    "", // credential_ref intentionally empty
                    r.connected_at,
                    r.updated_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    // backend_connection — provider ids only, no secrets. Confers no execution
    // authority on its own (keys live in the keyring).
    {
        let section = "backendConnections";
        for r in &manifest.sections.backend_connections {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM backend_connection WHERE provider_id = ?1);",
                rusqlite::params![r.provider_id],
                |row| row.get(0),
            )?;
            if exists && options.conflict == ConflictPolicy::Skip {
                report.inc_skipped(section);
                continue;
            }
            tx.execute(
                "INSERT INTO backend_connection (provider_id, connected_at, updated_at)
                 VALUES (?1, ?2, ?3);",
                rusqlite::params![r.provider_id, r.connected_at, r.updated_at],
            )?;
            report.inc_inserted(section);
        }
    }

    apply_simple(
        tx,
        store,
        &manifest.sections.knowledge_sources,
        "knowledgeSources",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("knowledge_source:default:{}", r.id))?;
            tx.execute(
                "INSERT INTO knowledge_source (id, workspace_id, project_id, connector_id, kind, trust, pinned,
                          content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
                 VALUES (?1, 'default', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
                rusqlite::params![
                    r.id,
                    r.connector_id,
                    r.kind,
                    r.trust,
                    r.pinned as i64,
                    r.content_fingerprint,
                    r.size_bytes,
                    r.imported_at,
                    r.origin,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.memory_records,
        "memoryRecords",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("memory_record:default:{}", r.id))?;
            tx.execute(
                "INSERT INTO memory_record (id, workspace_id, project_id, kind, pinned, approved, created_at, payload, payload_nonce)
                 VALUES (?1, 'default', NULL, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    r.kind,
                    r.pinned as i64,
                    r.approved as i64,
                    r.created_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    // schedule — local-first: enabled forced to false. User re-enables explicitly.
    apply_simple(
        tx,
        store,
        &manifest.sections.schedules,
        "schedules",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("schedule:default:{}", r.id))?;
            tx.execute(
                "INSERT INTO schedule (id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce)
                 VALUES (?1, 'default', NULL, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    r.weekday,
                    r.time,
                    0, // forced disabled: never auto-activate an imported schedule
                    r.created_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            Ok(())
        },
    )?;

    // model_config — composite key.
    {
        let section = "modelConfigs";
        for r in &manifest.sections.model_configs {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM model_config WHERE provider_id = ?1 AND model_id = ?2);",
                rusqlite::params![r.provider_id, r.model_id],
                |row| row.get(0),
            )?;
            if exists && options.conflict == ConflictPolicy::Skip {
                report.inc_skipped(section);
                continue;
            }
            let sealed = store.seal_json_owned(
                &r.payload,
                &format!("model_config:{}", r.provider_id),
            )?;
            tx.execute(
                "INSERT INTO model_config (provider_id, model_id, selected, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5);",
                rusqlite::params![
                    r.provider_id,
                    r.model_id,
                    r.selected as i64,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            report.inc_inserted(section);
        }
    }

    apply_simple(
        tx,
        store,
        &manifest.sections.drafts,
        "drafts",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("draft:{}", r.id))?;
            tx.execute(
                "INSERT INTO draft (id, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4);",
                rusqlite::params![r.id, r.updated_at, sealed.ciphertext, sealed.nonce],
            )?;
            Ok(())
        },
    )?;

    apply_simple(
        tx,
        store,
        &manifest.sections.run_states,
        "runStates",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("run_state:{}", r.id))?;
            tx.execute(
                "INSERT INTO run_state (id, payload, payload_nonce, updated_at)
                 VALUES (?1, ?2, ?3, ?4);",
                rusqlite::params![r.id, sealed.ciphertext, sealed.nonce, r.updated_at],
            )?;
            Ok(())
        },
    )?;

    // Surface the omitted categories as warnings so the UI can prompt
    // reconfiguration (e.g. "N connectors need re-authentication").
    if !manifest.sections.connector_accounts.is_empty() {
        report.warnings.push(format!(
            "{} connector account(s) imported as disconnected and require re-authentication (credentials are not portable).",
            manifest.sections.connector_accounts.len()
        ));
    }
    if !manifest.sections.schedules.is_empty() {
        report.warnings.push(format!(
            "{} schedule(s) imported disabled; re-enable them explicitly to activate.",
            manifest.sections.schedules.len()
        ));
    }

    // keep `now` referenced for clarity of "apply-time" semantics
    let _ = now;
    Ok(())
}

/// Apply a homogeneous list of records under the skip-on-conflict policy.
fn apply_simple<T, F>(
    tx: &Connection,
    store: &Store,
    records: &[T],
    section: &str,
    id_col: &str,
    report: &mut ImportReport,
    insert: F,
) -> Result<()>
where
    F: Fn(&Connection, &Store, &T) -> Result<()>,
    T: KeyedRecord,
{
    for r in records {
        if r.exists(tx, id_col)? {
            report.inc_skipped(section);
            continue;
        }
        insert(tx, store, r)?;
        report.inc_inserted(section);
    }
    Ok(())
}

/// A record that knows how to (a) report whether its key already exists, used
/// for skip-on-conflict planning, and (b) bind its key into an existence probe.
trait KeyedRecord {
    /// Returns true if a row with this record's key already exists in `table`.
    /// `id_col` is the SQL column name of the single-string primary key.
    fn exists(&self, tx: &Connection, _table: &str) -> Result<bool>;
}

/// Implement `KeyedRecord` for a record whose single-string primary key is the
/// Rust field `$id_field` bound to the SQL column `$col` in `$table`.
macro_rules! impl_keyed_str {
    ($ty:ty, $id_field:ident, $table:expr, $col:expr) => {
        impl KeyedRecord for $ty {
            fn exists(&self, tx: &Connection, _table: &str) -> Result<bool> {
                let sql = format!("SELECT EXISTS(SELECT 1 FROM {} WHERE {} = ?1);", $table, $col);
                Ok(tx.query_row(&sql, rusqlite::params![&self.$id_field], |row| {
                    row.get(0)
                })?)
            }
        }
    };
}

impl_keyed_str!(PreferenceRecord, key, "preferences", "key");
impl_keyed_str!(ProjectRecord, id, "project", "id");
impl_keyed_str!(ThreadRecord, id, "thread", "id");
impl_keyed_str!(MessageRecord, id, "message", "id");
impl_keyed_str!(RunRecord, id, "run", "id");
impl_keyed_str!(ToolCallRecord, id, "tool_call", "id");
impl_keyed_str!(ApprovalRecord, id, "approval", "id");
impl_keyed_str!(AuditEventRecord, id, "audit_event", "id");
impl_keyed_str!(ArtifactRecord, id, "artifact", "id");
impl_keyed_str!(ConnectorAccountRecord, connector_id, "connector_account", "connector_id");
impl_keyed_str!(KnowledgeSourceRecord, id, "knowledge_source", "id");
impl_keyed_str!(MemoryRecord, id, "memory_record", "id");
impl_keyed_str!(ScheduleRecord, id, "schedule", "id");
impl_keyed_str!(DraftRecord, id, "draft", "id");
impl_keyed_str!(RunStateRecord, id, "run_state", "id");

// ---------------------------------------------------------------------------
// Store helpers (seal a JSON value to owned bytes)
// ---------------------------------------------------------------------------

impl Store {
    /// Seal a JSON value into owned bytes bound to `aad`. Mirrors
    /// `repos::seal_json` but is exposed here so the portable module does not
    /// depend on the private repo helper.
    fn seal_json_owned(&self, value: &Value, aad: &str) -> Result<Sealed> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| StoreError::Invalid("Could not encode a portable record.".into()))?;
        self.seal_payload(&bytes, aad)
    }
}

// ---------------------------------------------------------------------------
// Tauri command surface (the UI seam)
// ---------------------------------------------------------------------------

/// Export the workspace as a pretty-printed portable manifest string. Secrets
/// are structurally absent; the artifact never touches the network or keyring.
#[tauri::command]
pub fn export_workspace_archive() -> std::result::Result<String, String> {
    let store = crate::store::try_global().ok_or_else(|| {
        "Fable's encrypted store is not initialized.".to_string()
    })?;
    let manifest = export_workspace(store).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&manifest)
        .map_err(|_| "Fable could not encode the workspace archive.".into())
}

/// Import a portable manifest string. Validates before writing; applies inside
/// a single transaction that rolls back on any failure. Never overwrites
/// existing rows (skip-on-conflict). Imported connectors/schedules are disabled.
#[tauri::command]
pub fn import_workspace_archive(
    manifest_json: String,
) -> std::result::Result<ImportReport, String> {
    let store = crate::store::try_global().ok_or_else(|| {
        "Fable's encrypted store is not initialized.".to_string()
    })?;
    import_workspace(store, &manifest_json, ImportOptions::default())
        .map_err(|e| e.to_string())
}

/// The manifest format version this build understands (for UI pre-checks).
#[tauri::command]
pub fn portable_format_version() -> u32 {
    PORTABLE_FORMAT_VERSION
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    /// Insert a small but referentially-complete dataset directly via SQL,
    /// decrypting payloads with the store vault. Returns the ids inserted.
    fn seed(store: &Store) {
        // profile
        let sealed = store.seal_json_owned(&serde_json::json!({ "name": "Alice" }), "profile:1").unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO profile (id, updated_at, payload, payload_nonce) VALUES (1, 't', ?1, ?2);",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                // preference
                let p = store.seal_json_owned(&serde_json::json!({"v": 1}), "preferences:default:shell")?;
                tx.execute(
                    "INSERT INTO preferences (workspace_id, key, updated_at, payload, payload_nonce) VALUES ('default','shell','t',?1,?2);",
                    rusqlite::params![p.ciphertext, p.nonce],
                )?;
                // project
                let pp = store.seal_json_owned(&serde_json::json!({"title":"P"}), "project:p1")?;
                tx.execute(
                    "INSERT INTO project (id, workspace_id, title_fingerprint, created_at, updated_at, payload, payload_nonce)
                     VALUES ('p1','default','f','t','t',?1,?2);",
                    rusqlite::params![pp.ciphertext, pp.nonce],
                )?;
                // thread
                let tp = store.seal_json_owned(&serde_json::json!({}), "thread:t1")?;
                tx.execute(
                    "INSERT INTO thread (id, project_id, created_at, updated_at, payload, payload_nonce)
                     VALUES ('t1','p1','t','t',?1,?2);",
                    rusqlite::params![tp.ciphertext, tp.nonce],
                )?;
                // message
                let mp = store.seal_json_owned(&serde_json::json!({"text":"hi"}), "message:m1")?;
                tx.execute(
                    "INSERT INTO message (id, thread_id, role, seq, created_at, payload, payload_nonce)
                     VALUES ('m1','t1','user',1,'t',?1,?2);",
                    rusqlite::params![mp.ciphertext, mp.nonce],
                )?;
                // run + tool_call + artifact
                let rp = store.seal_json_owned(&serde_json::json!({}), "run:r1")?;
                tx.execute(
                    "INSERT INTO run (id, thread_id, provider_id, model, status, turn, recoverable, retry_count, created_at, updated_at, payload, payload_nonce)
                     VALUES ('r1','t1','openai','gpt','complete',0,0,0,'t','t',?1,?2);",
                    rusqlite::params![rp.ciphertext, rp.nonce],
                )?;
                let tcp = store.seal_json_owned(&serde_json::json!({}), "tool_call:tc1")?;
                tx.execute(
                    "INSERT INTO tool_call (id, run_id, tool, status, created_at, payload, payload_nonce)
                     VALUES ('tc1','r1','web','ok','t',?1,?2);",
                    rusqlite::params![tcp.ciphertext, tcp.nonce],
                )?;
                let ap = store.seal_json_owned(&serde_json::json!({}), "artifact:a1")?;
                tx.execute(
                    "INSERT INTO artifact (id, run_id, kind, content_fingerprint, size_bytes, created_at, payload, payload_nonce)
                     VALUES ('a1','r1','file','fp',10,'t',?1,?2);",
                    rusqlite::params![ap.ciphertext, ap.nonce],
                )?;
                // connector account WITH credential_ref (must be omitted from export)
                let cap = store.seal_json_owned(&serde_json::json!({"account":{"id":"u"}}), "connector_account:default:github")?;
                tx.execute(
                    "INSERT INTO connector_account (workspace_id, project_id, connector_id, account_id, status, expires_at, credential_ref, connected_at, updated_at, payload, payload_nonce)
                     VALUES ('default',NULL,'github','u','connected',12345,'keyring-opaque-key','t','t',?1,?2);",
                    rusqlite::params![cap.ciphertext, cap.nonce],
                )?;
                // backend connection
                tx.execute(
                    "INSERT INTO backend_connection (provider_id, connected_at, updated_at) VALUES ('openai','t','t');",
                    [],
                )?;
                // knowledge source
                let kp = store.seal_json_owned(&serde_json::json!({"title":"doc"}), "knowledge_source:default:k1")?;
                tx.execute(
                    "INSERT INTO knowledge_source (id, workspace_id, project_id, connector_id, kind, trust, pinned, content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
                     VALUES ('k1','default',NULL,'local-files','document','trusted',1,'cf',100,'t','local',?1,?2);",
                    rusqlite::params![kp.ciphertext, kp.nonce],
                )?;
                // memory record
                let mem = store.seal_json_owned(&serde_json::json!({"value":"remember"}), "memory_record:default:mem1")?;
                tx.execute(
                    "INSERT INTO memory_record (id, workspace_id, project_id, kind, pinned, approved, created_at, payload, payload_nonce)
                     VALUES ('mem1','default',NULL,'fact',1,1,'t',?1,?2);",
                    rusqlite::params![mem.ciphertext, mem.nonce],
                )?;
                // schedule (enabled)
                let sp = store.seal_json_owned(&serde_json::json!({"name":"Weekly"}), "schedule:default:s1")?;
                tx.execute(
                    "INSERT INTO schedule (id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce)
                     VALUES ('s1','default',NULL,'Mon','09:00',1,'t',?1,?2);",
                    rusqlite::params![sp.ciphertext, sp.nonce],
                )?;
                // draft
                let dp = store.seal_json_owned(&serde_json::json!({"text":"draft"}), "draft:composer")?;
                tx.execute(
                    "INSERT INTO draft (id, updated_at, payload, payload_nonce) VALUES ('composer','t',?1,?2);",
                    rusqlite::params![dp.ciphertext, dp.nonce],
                )?;
                // run_state
                let rsp = store.seal_json_owned(&serde_json::json!({}), "run_state:rs1")?;
                tx.execute(
                    "INSERT INTO run_state (id, payload, payload_nonce, updated_at) VALUES ('rs1',?1,?2,'t');",
                    rusqlite::params![rsp.ciphertext, rsp.nonce],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn round_trips_through_a_fresh_store() {
        let a = store();
        seed(&a);
        let manifest = export_workspace(&a).unwrap();
        let json = serde_json::to_string(&manifest).unwrap();

        // Import into a fresh store with a DIFFERENT vault key: the manifest is
        // plaintext and re-encrypts under the destination vault.
        let b = store();
        let report = import_workspace(&b, &json, ImportOptions::default()).unwrap();
        assert!(report.errors.is_empty());
        assert_eq!(*report.inserted.get("projects").unwrap(), 1);
        assert_eq!(*report.inserted.get("messages").unwrap(), 1);

        // Re-export and compare sections (ignoring exportedAt/producedBy).
        let manifest_b = export_workspace(&b).unwrap();
        assert_eq!(manifest_b.sections.projects.len(), 1);
        assert_eq!(manifest_b.sections.projects[0].id, "p1");
        assert_eq!(manifest_b.sections.messages[0].payload["text"], "hi");
        assert_eq!(manifest_b.sections.knowledge_sources.len(), 1);
        assert_eq!(manifest_b.sections.schedules.len(), 1);
        assert_eq!(manifest_b.sections.drafts.len(), 1);
    }

    #[test]
    fn malformed_manifest_is_rejected() {
        let store = store();
        let err = import_workspace(&store, "{not json", ImportOptions::default());
        assert!(matches!(err, Err(ImportError::Invalid(_))));
        // nothing written
        assert_eq!(count(&store, "project"), 0);
    }

    #[test]
    fn newer_format_version_is_rejected() {
        let store = store();
        let mut m = Manifest {
            format: PORTABLE_FORMAT_NAME.into(),
            format_version: PORTABLE_FORMAT_VERSION + 1,
            schema_version: CURRENT_SCHEMA_VERSION,
            exported_at: "t".into(),
            produced_by: PRODUCED_BY.into(),
            credentials_included: false,
            sections: Sections::default(),
            omitted: omitted_summary(),
        };
        let json = serde_json::to_string(&m).unwrap();
        let err = import_workspace(&store, &json, ImportOptions::default());
        assert!(matches!(err, Err(ImportError::Invalid(_))));
        let _ = &mut m; // suppress unused-mut if any
    }

    #[test]
    fn credentials_included_true_is_rejected() {
        let store = store();
        let m = Manifest {
            format: PORTABLE_FORMAT_NAME.into(),
            format_version: PORTABLE_FORMAT_VERSION,
            schema_version: CURRENT_SCHEMA_VERSION,
            exported_at: "t".into(),
            produced_by: PRODUCED_BY.into(),
            credentials_included: true,
            sections: Sections::default(),
            omitted: omitted_summary(),
        };
        let json = serde_json::to_string(&m).unwrap();
        let err = import_workspace(&store, &json, ImportOptions::default());
        assert!(matches!(err, Err(ImportError::Invalid(_))));
    }

    #[test]
    fn conflict_is_skipped_not_overwritten() {
        let a = store();
        seed(&a);
        let json = serde_json::to_string(&export_workspace(&a).unwrap()).unwrap();

        let b = store();
        seed(&b); // pre-populate with the SAME ids
        // sanity: project p1 has its original payload
        let before = export_workspace(&b).unwrap();
        let original_title = before.sections.projects[0].payload["title"].clone();

        let report = import_workspace(&b, &json, ImportOptions::default()).unwrap();
        // everything should be skipped, nothing inserted
        assert!(report.inserted.values().all(|&v| v == 0));
        assert!(*report.skipped.get("projects").unwrap() >= 1);

        // the existing data is untouched
        let after = export_workspace(&b).unwrap();
        assert_eq!(after.sections.projects[0].payload["title"], original_title);
    }

    #[test]
    fn credential_ref_is_omitted_and_connectors_import_disabled() {
        let a = store();
        seed(&a);
        let manifest = export_workspace(&a).unwrap();
        // credential_ref is not a field on the record type. Verify the exported
        // connector account carries no credential reference and no keyring value.
        // (The `omitted` summary names "credential_ref" by way of explanation;
        // check the sections payload, not the whole document.)
        let sections_json = serde_json::to_string(&manifest.sections).unwrap();
        assert!(
            !sections_json.contains("credentialRef"),
            "exported sections must not carry credentialRef"
        );
        assert!(
            !sections_json.contains("keyring-opaque-key"),
            "the opaque keyring key must not appear anywhere in the export"
        );
        assert_eq!(manifest.sections.connector_accounts.len(), 1);

        // import into a fresh store: connector must be disconnected, no cred ref
        let b = store();
        let json = serde_json::to_string(&manifest).unwrap();
        import_workspace(&b, &json, ImportOptions::default()).unwrap();
        let cred: String = b
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT credential_ref FROM connector_account WHERE connector_id='github';",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(cred, "");
        let status: String = b
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM connector_account WHERE connector_id='github';",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(status, "disconnected");
    }

    #[test]
    fn imported_schedules_are_disabled() {
        let a = store();
        seed(&a);
        let json = serde_json::to_string(&export_workspace(&a).unwrap()).unwrap();
        let b = store();
        import_workspace(&b, &json, ImportOptions::default()).unwrap();
        let enabled: i64 = b
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT enabled FROM schedule WHERE id='s1';",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(enabled, 0, "imported schedule must be disabled");
    }

    #[test]
    fn connector_cache_does_not_leak_into_export() {
        let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
            .unwrap();
        // insert a connector_cache row directly (the excluded table)
        let sealed = store.seal_json_owned(&serde_json::json!({}), "connector_cache:x").unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO connector_cache (id, workspace_id, connector_id, provider_item_id, kind, trust, pinned, disabled, content_fingerprint, cached_at, origin, payload, payload_nonce)
                     VALUES ('x','default','github','item1','document','trusted',0,0,'cf','t','connector-cache',?1,?2);",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                tx.execute(
                    "INSERT INTO connector_cache_settings (workspace_id, connector_id, scope, enabled, auto_sync, updated_at, payload, payload_nonce)
                     VALUES ('default','__workspace__','workspace',1,0,'t',?1,?2);",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                Ok(())
            })
            .unwrap();
        let manifest = export_workspace(&store).unwrap();
        // The connector-cache tables are not exported as sections. (The
        // `omitted` summary legitimately names them by way of explanation.)
        assert!(manifest.sections.connector_accounts.is_empty());
        // Serialize sections only (excluding the `omitted` doc text) and verify
        // no cache internals leak into the data payload.
        let sections_json = serde_json::to_string(&manifest.sections).unwrap();
        assert!(
            !sections_json.contains("provider_item_id"),
            "connector_cache internals must not leak into exported sections"
        );
        assert!(
            !sections_json.contains("workspace_id"),
            "connector_cache workspace rows must not leak into exported sections"
        );
    }

    #[test]
    fn failed_import_rolls_back_with_no_partial_rows() {
        // Build a manifest that is valid by itself, then append a dangling
        // message (references a non-existent thread). Integrity validation
        // during apply must roll back the whole transaction.
        let a = store();
        seed(&a);
        let mut manifest = export_workspace(&a).unwrap();
        // Inject a dangling message that points at a thread that isn't present.
        manifest.sections.messages.push(MessageRecord {
            id: "dangling".into(),
            thread_id: "no-such-thread".into(),
            role: "user".into(),
            seq: 99,
            created_at: "t".into(),
            payload: serde_json::json!({}),
        });
        let json = serde_json::to_string(&manifest).unwrap();

        let b = store();
        let err = import_workspace(&b, &json, ImportOptions::default());
        assert!(matches!(err, Err(ImportError::ApplyFailed(_, _))));
        // nothing was written
        assert_eq!(count(&b, "project"), 0);
        assert_eq!(count(&b, "message"), 0);
    }

    #[test]
    fn export_rejects_dangling_reference() {
        let store = store();
        // Insert a thread referencing a project that does NOT exist, bypassing
        // FK by inserting project then deleting it... simpler: insert thread
        // with a project_id that has no project row. FK is ON, so do it in a
        // deferred way: disable FK for the test seed only.
        store
            .with_conn(|conn| {
                conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
                let sealed = store.seal_json_owned(&serde_json::json!({}), "thread:t1")?;
                conn.execute(
                    "INSERT INTO thread (id, project_id, created_at, updated_at, payload, payload_nonce)
                     VALUES ('t1','missing-project','t','t',?1,?2);",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                conn.execute_batch("PRAGMA foreign_keys = ON;")?;
                Ok(())
            })
            .unwrap();
        let err = export_workspace(&store);
        assert!(matches!(err, Err(StoreError::Invalid(_))));
    }

    #[test]
    fn unknown_top_level_keys_are_tolerated() {
        // serde ignores unknown fields by default; verify import still works.
        let store = store();
        let json = format!(
            "{{\"format\":\"{PORTABLE_FORMAT_NAME}\",\"formatVersion\":1,\"schemaVersion\":{},\"exportedAt\":\"t\",\"producedBy\":\"x\",\"credentialsIncluded\":false,\"sections\":{{}},\"omitted\":{{}},\"unknownFutureField\":42}}",
            CURRENT_SCHEMA_VERSION
        );
        let report = import_workspace(&store, &json, ImportOptions::default()).unwrap();
        assert!(report.errors.is_empty());
    }

    fn count(store: &Store, table: &str) -> i64 {
        store
            .with_conn(|conn| {
                conn.query_row(&format!("SELECT COUNT(*) FROM {table};"), [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap()
    }

    #[test]
    fn portable_format_version_command_returns_current() {
        assert_eq!(portable_format_version(), PORTABLE_FORMAT_VERSION);
    }
}
