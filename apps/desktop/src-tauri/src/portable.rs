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
//! - Export and import are wired to Privacy settings through native file
//!   commands, so workspace content never enters renderer state.
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
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

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
const MAX_PORTABLE_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const IMPORT_CONFIRMATION: &str = "import workspace copy";

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
            "run_state is exported (user-recoverable), but documented here as recoverable state",
            "scheduler_queue_entry is execution state and is rebuilt; it is never imported as live authority",
            "routine scheduler authority, leases, cursors, retry state, and legacy-migration rollback evidence are node-local and never imported",
            "cloud_workspace_link, cloud_sync_cursor, cloud_mutation_outbox, cloud_record_shadow, and cloud_conflict are local shared-workspace sync state and are never imported as solo authority"
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
    pub routines: Vec<PortableRoutineRecord>,
    pub scheduled_jobs: Vec<ScheduledJobRecord>,
    pub workflow_definitions: Vec<WorkflowDefinitionRecord>,
    pub workflow_runs: Vec<WorkflowRunRecord>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionRecord {
    pub id: String,
    pub artifact_id: String,
    pub version: i64,
    pub status: String,
    pub content_fingerprint: String,
    pub size_bytes: i64,
    pub created_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactReviewRecord {
    pub id: String,
    pub artifact_id: String,
    pub version_id: String,
    pub status: String,
    pub requested_by_internal_user_id: String,
    pub reviewer_member_id: Option<String>,
    pub requested_at: String,
    pub resolved_at: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub owner_subject: String,
    pub authority: String,
    pub visibility: String,
    pub owner_member_id: Option<String>,
    pub owner_internal_user_id: Option<String>,
    pub run_id: Option<String>,
    pub thread_id: Option<String>,
    pub source_message_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub revision: i64,
    pub current_version_id: String,
    pub title_fingerprint: String,
    pub content_fingerprint: String,
    pub size_bytes: i64,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
    #[serde(default)]
    pub versions: Vec<ArtifactVersionRecord>,
    #[serde(default)]
    pub reviews: Vec<ArtifactReviewRecord>,
}

// Connector account metadata. NOTE: `credential_ref` is intentionally absent
// — it is an opaque per-installation keyring key, not a secret and not
// portable. Import writes these `disconnected` with no credential ref.
record!(ConnectorAccountRecord {
    connector_id: String,
    project_id: Option<String>,
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
    project_id: Option<String>,
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
    project_id: Option<String>,
    kind: String,
    pinned: bool,
    approved: bool,
    created_at: String,
    payload: Value,
});

record!(ScheduleRecord {
    id: String,
    project_id: Option<String>,
    weekday: String,
    time: String,
    enabled: bool,
    created_at: String,
    payload: Value,
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableRoutineRecord {
    pub source_workspace_id: String,
    pub owner_subject: String,
    pub owner_member_id: String,
    pub routine: Value,
    pub versions: Vec<Value>,
    pub triggers: Vec<Value>,
    pub occurrences: Vec<Value>,
}

record!(ScheduledJobRecord {
    id: String,
    project_id: Option<String>,
    payload: Value,
});

record!(WorkflowDefinitionRecord {
    id: String,
    project_id: Option<String>,
    version: u32,
    created_at: String,
    updated_at: String,
    payload: Value,
});

record!(WorkflowRunRecord {
    id: String,
    project_id: Option<String>,
    definition_id: String,
    definition_version: u32,
    status: String,
    started_at: String,
    updated_at: String,
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
    params: &[&dyn rusqlite::ToSql],
    // (column index in SELECT (0-based), camelCase json key, cast)
    plain_cols: &[(usize, &str, Cast)],
) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let n_cols = plain_cols.len();
    let row_count = stmt.column_count();
    // Last two columns are always payload, payload_nonce.
    debug_assert!(row_count >= n_cols + 2);
    let partials: Vec<(Vec<Value>, Sealed, Vec<String>)> = stmt
        .query_map(params, |row| {
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

fn read_artifact_records(
    conn: &Connection,
    store: &Store,
    owner: &crate::store::repos::scope::PrivateDataScope,
) -> Result<Vec<ArtifactRecord>> {
    let workspace_id = owner.workspace_id();
    let context = crate::store::repos::workspace_directory::require_active_workspace_context_for_current_user(conn)?;
    if context.active_workspace.local_workspace_id != workspace_id {
        return Err(StoreError::Invalid(
            "Artifact export requires the active workspace owner.".into(),
        ));
    }
    let mut stmt=conn.prepare(
        "SELECT owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,id,run_id,
                thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,
                content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce
         FROM artifact WHERE workspace_id=?1 AND owner_subject=?2 ORDER BY created_at,id")?;
    let rows = stmt
        .query_map(
            rusqlite::params![workspace_id, owner.owner_subject()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, i64>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                    Sealed {
                        ciphertext: row.get(18)?,
                        nonce: row.get(19)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut output = Vec::new();
    for (
        owner_subject,
        authority,
        visibility,
        owner_member_id,
        owner_internal_user_id,
        id,
        run_id,
        thread_id,
        source_message_id,
        kind,
        status,
        revision,
        current_version_id,
        title_fingerprint,
        content_fingerprint,
        size_bytes,
        created_at,
        updated_at,
        sealed,
    ) in rows
    {
        let payload = open_json_value(
            store,
            &sealed,
            &format!("artifact:{workspace_id}:{owner_subject}:{id}"),
        )?;
        let mut versions_stmt=conn.prepare(
            "SELECT id,artifact_id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce
             FROM artifact_version WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 ORDER BY version,id")?;
        let partials = versions_stmt
            .query_map(rusqlite::params![workspace_id, owner_subject, id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    Sealed {
                        ciphertext: row.get(7)?,
                        nonce: row.get(8)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut versions = Vec::new();
        for (
            version_id,
            artifact_id,
            version,
            status,
            version_fingerprint,
            version_size,
            version_created,
            sealed,
        ) in partials
        {
            let version_payload = open_json_value(
                store,
                &sealed,
                &format!(
                    "artifact_version:{workspace_id}:{owner_subject}:{artifact_id}:{version_id}"
                ),
            )?;
            versions.push(ArtifactVersionRecord {
                id: version_id,
                artifact_id,
                version,
                status,
                content_fingerprint: version_fingerprint,
                size_bytes: version_size,
                created_at: version_created,
                payload: version_payload,
            });
        }
        let mut reviews_stmt = conn.prepare(
            "SELECT id,artifact_id,version_id,status,requested_by_internal_user_id,
                    reviewer_member_id,requested_at,resolved_at,payload,payload_nonce
             FROM artifact_review
             WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3
             ORDER BY requested_at,id",
        )?;
        let review_rows = reviews_stmt
            .query_map(rusqlite::params![workspace_id, owner_subject, id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    Sealed {
                        ciphertext: row.get(8)?,
                        nonce: row.get(9)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut reviews = Vec::with_capacity(review_rows.len());
        for (
            review_id,
            review_artifact_id,
            version_id,
            review_status,
            requested_by_internal_user_id,
            reviewer_member_id,
            requested_at,
            resolved_at,
            sealed,
        ) in review_rows
        {
            let review_payload = open_json_value(
                store,
                &sealed,
                &format!(
                    "artifact_review:{workspace_id}:{owner_subject}:{review_artifact_id}:{review_id}"
                ),
            )?;
            reviews.push(ArtifactReviewRecord {
                id: review_id,
                artifact_id: review_artifact_id,
                version_id,
                status: review_status,
                requested_by_internal_user_id,
                reviewer_member_id,
                requested_at,
                resolved_at,
                payload: review_payload,
            });
        }
        let record = ArtifactRecord {
            id,
            owner_subject,
            authority,
            visibility,
            owner_member_id,
            owner_internal_user_id,
            run_id,
            thread_id,
            source_message_id,
            kind,
            status,
            revision,
            current_version_id,
            title_fingerprint,
            content_fingerprint,
            size_bytes,
            created_at,
            updated_at,
            payload,
            versions,
            reviews,
        };
        validate_portable_reviews(&record, &context.internal_user_id, owner.owner_member_id())?;
        output.push(record);
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Build a deterministic portable workspace manifest from the store. Validates
/// referential integrity before returning; on failure produces no artifact.
#[cfg(test)]
pub fn export_workspace(store: &Store) -> Result<Manifest> {
    export_workspace_for(store, crate::store::repos::scope::DEFAULT_WORKSPACE_ID)
}

pub fn export_workspace_for(store: &Store, workspace_id: &str) -> Result<Manifest> {
    let scope = crate::store::repos::scope::DataScope::workspace(workspace_id.to_string())?;
    let sections = store.with_conn(|conn| {
        scope.ensure_exists(conn)?;
        let mut foreign_key_check = conn.prepare("PRAGMA foreign_key_check;")?;
        if foreign_key_check.query([])?.next()?.is_some() {
            return Err(StoreError::Invalid(
                "The local database contains a broken ownership reference; export was cancelled."
                    .into(),
            ));
        }
        let artifact_owner=crate::store::repos::workspace_directory::require_active_workspace_context_for_current_user(conn)
            .ok().filter(|context|context.active_workspace.local_workspace_id==scope.workspace_id())
            .map(|context|crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
                scope.clone(),&context.internal_user_id,context.member_id.as_deref()))
            .transpose()?;
        read_sections(conn, store, scope.workspace_id(),artifact_owner.as_ref())
    })?;
    validate_integrity(&sections)?;
    validate_no_secrets(&sections)?;
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

fn read_sections(
    conn: &Connection,
    store: &Store,
    workspace_id: &str,
    artifact_owner: Option<&crate::store::repos::scope::PrivateDataScope>,
) -> Result<Sections> {
    // profile (singleton id=1)
    let profile = if workspace_id == crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
        read_profile(conn, store)?
    } else {
        None
    };

    // preferences: the encrypted payload *is* the value (there is no separate
    // payload document), so read it directly into the `value` field.
    let preferences = {
        let mut stmt = conn.prepare(
            "SELECT key, updated_at, payload, payload_nonce FROM preferences
             WHERE workspace_id=?1 ORDER BY key;",
        )?;
        let partials: Vec<(String, String, Sealed)> = stmt
            .query_map([workspace_id], |row| {
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
            let value =
                open_json_value(store, &sealed, &format!("preferences:{workspace_id}:{key}"))?;
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
         FROM project WHERE workspace_id=?1 ORDER BY id;",
        &[&workspace_id],
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
        "SELECT t.id, t.project_id, t.created_at, t.updated_at, t.payload, t.payload_nonce
         FROM thread t WHERE t.workspace_id=?1 ORDER BY t.project_id, t.id;",
        &[&workspace_id],
        &[
            (0, "id", Cast::Text),
            (1, "projectId", Cast::NullableText),
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
        "SELECT m.id, m.thread_id, m.kind, m.seq, m.created_at, m.payload, m.payload_nonce
         FROM message m WHERE m.workspace_id=?1 ORDER BY m.thread_id, m.seq, m.id;",
        &[&workspace_id],
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
        "SELECT r.id, r.thread_id, r.provider_id, r.model, r.status, r.turn, r.recoverable,
                r.retry_count, r.created_at, r.updated_at, r.payload, r.payload_nonce
         FROM run r WHERE r.workspace_id=?1
         ORDER BY r.created_at, r.id;",
        &[&workspace_id],
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
        "SELECT tc.id, tc.run_id, tc.tool, tc.status, tc.created_at, tc.payload, tc.payload_nonce
         FROM tool_call tc JOIN run r ON r.id=tc.run_id
         LEFT JOIN thread t ON t.id=r.thread_id LEFT JOIN project p ON p.id=t.project_id
         WHERE p.workspace_id=?1 OR (r.thread_id IS NULL AND ?1='default')
         ORDER BY tc.run_id, tc.created_at, tc.id;",
        &[&workspace_id],
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
        "SELECT a.id, a.run_id, a.service, a.action, a.mode, a.risk_level, a.decision,
                a.request_fingerprint, a.decided_at, a.payload, a.payload_nonce
         FROM approval a LEFT JOIN run r ON r.id=a.run_id
         LEFT JOIN thread t ON t.id=r.thread_id LEFT JOIN project p ON p.id=t.project_id
         WHERE p.workspace_id=?1 OR (a.run_id IS NULL AND ?1='default')
         ORDER BY a.decided_at, a.id;",
        &[&workspace_id],
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
         FROM audit_event WHERE ?1='default' ORDER BY created_at, id;",
        &[&workspace_id],
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

    // Artifact workspace authority comes directly from the durable artifact
    // row/run workspace, so projectless threads are included.
    let artifacts = artifact_owner
        .map(|owner| read_artifact_records(conn, store, owner))
        .transpose()?
        .unwrap_or_default();

    // connector_account — credential_ref is intentionally NOT selected.
    let connector_accounts = read_rows(
        conn,
        store,
        &format!("connector_account:{workspace_id}"),
        "SELECT connector_id, project_id, account_id, status, expires_at, connected_at,
                updated_at, payload, payload_nonce
         FROM connector_account WHERE workspace_id=?1 ORDER BY connector_id;",
        &[&workspace_id],
        &[
            (0, "connectorId", Cast::Text),
            (1, "projectId", Cast::NullableText),
            (2, "accountId", Cast::NullableText),
            (3, "status", Cast::Text),
            (4, "expiresAt", Cast::NullableInt),
            (5, "connectedAt", Cast::Text),
            (6, "updatedAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ConnectorAccountRecord>(v, "connector_account"))
    .collect::<Result<_>>()?;

    // backend_connection — no payload columns; read directly.
    // Provider connections are account-owned authorization metadata, not
    // workspace content. Credentials and connection claims stay local.
    let backend_connections: Vec<BackendConnectionRecord> = Vec::new();

    let knowledge_sources = read_rows(
        conn,
        store,
        &format!("knowledge_source:{workspace_id}"),
        "SELECT id, project_id, connector_id, kind, trust, pinned, content_fingerprint,
                size_bytes, imported_at, origin, payload, payload_nonce
         FROM knowledge_source WHERE workspace_id=?1 ORDER BY imported_at, id;",
        &[&workspace_id],
        &[
            (0, "id", Cast::Text),
            (1, "projectId", Cast::NullableText),
            (2, "connectorId", Cast::Text),
            (3, "kind", Cast::Text),
            (4, "trust", Cast::Text),
            (5, "pinned", Cast::Bool),
            (6, "contentFingerprint", Cast::Text),
            (7, "sizeBytes", Cast::Int),
            (8, "importedAt", Cast::Text),
            (9, "origin", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<KnowledgeSourceRecord>(v, "knowledge_source"))
    .collect::<Result<_>>()?;

    let memory_records = read_rows(
        conn,
        store,
        &format!("memory_record:{workspace_id}"),
        "SELECT id, project_id, kind, pinned, approved, created_at, payload, payload_nonce
         FROM memory_record WHERE workspace_id=?1 ORDER BY created_at, id;",
        &[&workspace_id],
        &[
            (0, "id", Cast::Text),
            (1, "projectId", Cast::NullableText),
            (2, "kind", Cast::Text),
            (3, "pinned", Cast::Bool),
            (4, "approved", Cast::Bool),
            (5, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<MemoryRecord>(v, "memory_record"))
    .collect::<Result<_>>()?;

    let schedules = read_rows(
        conn,
        store,
        &format!("schedule:{workspace_id}"),
        "SELECT id, project_id, weekday, time, enabled, created_at, payload, payload_nonce
         FROM schedule WHERE workspace_id=?1 ORDER BY created_at, id;",
        &[&workspace_id],
        &[
            (0, "id", Cast::Text),
            (1, "projectId", Cast::NullableText),
            (2, "weekday", Cast::Text),
            (3, "time", Cast::Text),
            (4, "enabled", Cast::Bool),
            (5, "createdAt", Cast::Text),
        ],
    )?
    .into_iter()
    .map(|v| record_from::<ScheduleRecord>(v, "schedule"))
    .collect::<Result<_>>()?;

    let routines = artifact_owner
        .map(|owner| read_portable_routines(conn, store, workspace_id, owner))
        .transpose()?
        .unwrap_or_default();

    let scheduled_jobs = read_rows(
        conn,
        store,
        &format!("scheduled_job:{workspace_id}"),
        "SELECT id, payload, payload_nonce FROM scheduled_job
         WHERE workspace_id=?1 ORDER BY created_at, id;",
        &[&workspace_id],
        &[(0, "id", Cast::Text)],
    )?
    .into_iter()
    .map(|mut value| {
        let project_id = value
            .get("payload")
            .and_then(|payload| payload.get("projectId"))
            .cloned()
            .unwrap_or(Value::Null);
        value
            .as_object_mut()
            .expect("portable row is an object")
            .insert("projectId".into(), project_id);
        record_from::<ScheduledJobRecord>(value, "scheduled_job")
    })
    .collect::<Result<_>>()?;

    let workflow_definitions = read_workflow_definitions(conn, store, workspace_id)?;
    let workflow_runs = read_workflow_runs(conn, store, workspace_id)?;

    // model_config — composite key (provider_id, model_id). AAD uses provider_id
    // as the leading id segment per the established convention.
    let model_configs = read_rows(
        conn,
        store,
        "model_config",
        "SELECT provider_id, model_id, selected, payload, payload_nonce
         FROM model_config WHERE ?1='default' ORDER BY provider_id, model_id;",
        &[&workspace_id],
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
        "SELECT id, updated_at, payload, payload_nonce FROM draft
         WHERE ?1='default' ORDER BY id;",
        &[&workspace_id],
        &[(0, "id", Cast::Text), (1, "updatedAt", Cast::Text)],
    )?
    .into_iter()
    .map(|v| record_from::<DraftRecord>(v, "draft"))
    .collect::<Result<_>>()?;

    let run_states = read_rows(
        conn,
        store,
        "run_state",
        "SELECT rs.id, rs.updated_at, rs.payload, rs.payload_nonce
         FROM run_state rs JOIN run r ON r.id=rs.id
         LEFT JOIN thread t ON t.id=r.thread_id LEFT JOIN project p ON p.id=t.project_id
         WHERE p.workspace_id=?1 OR (r.thread_id IS NULL AND ?1='default')
         ORDER BY rs.id;",
        &[&workspace_id],
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
        routines,
        scheduled_jobs,
        workflow_definitions,
        workflow_runs,
        model_configs,
        drafts,
        run_states,
    })
}

fn read_portable_routines(
    conn: &Connection,
    store: &Store,
    workspace_id: &str,
    owner: &crate::store::repos::scope::PrivateDataScope,
) -> Result<Vec<PortableRoutineRecord>> {
    let Some(owner_member_id) = owner.owner_member_id() else {
        return Ok(Vec::new());
    };
    let mut routine_stmt = conn.prepare(
        "SELECT id,payload,payload_nonce FROM routine_record
         WHERE workspace_id=?1 AND owner_subject=?2 ORDER BY created_at,id;",
    )?;
    let routine_rows = routine_stmt
        .query_map(
            rusqlite::params![workspace_id, owner.owner_subject()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Sealed {
                        ciphertext: row.get(1)?,
                        nonce: row.get(2)?,
                    },
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut records = Vec::with_capacity(routine_rows.len());
    for (routine_id, sealed) in routine_rows {
        let routine = open_json_value(
            store,
            &sealed,
            &format!(
                "routine:{workspace_id}:{}:{routine_id}",
                owner.owner_subject()
            ),
        )?;
        let versions = read_routine_values(
            conn,
            store,
            "SELECT version,payload,payload_nonce FROM routine_version
             WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3 ORDER BY version;",
            rusqlite::params![workspace_id, owner.owner_subject(), routine_id],
            |version: &i64| {
                format!(
                    "routine_version:{workspace_id}:{}:{routine_id}:{version}",
                    owner.owner_subject()
                )
            },
        )?;
        let triggers = read_routine_values(
            conn,
            store,
            "SELECT id,payload,payload_nonce FROM routine_trigger
             WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3 ORDER BY created_at,id;",
            rusqlite::params![workspace_id, owner.owner_subject(), routine_id],
            |trigger_id: &String| {
                format!(
                    "routine_trigger:{workspace_id}:{}:{trigger_id}",
                    owner.owner_subject()
                )
            },
        )?;
        let occurrences = read_routine_values(
            conn,
            store,
            "SELECT id,payload,payload_nonce FROM routine_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3 ORDER BY observed_at,id;",
            rusqlite::params![workspace_id, owner.owner_subject(), routine_id],
            |occurrence_id: &String| {
                format!(
                    "routine_occurrence:{workspace_id}:{}:{occurrence_id}",
                    owner.owner_subject()
                )
            },
        )?;
        records.push(PortableRoutineRecord {
            source_workspace_id: workspace_id.to_string(),
            owner_subject: owner.owner_subject().to_string(),
            owner_member_id: owner_member_id.to_string(),
            routine,
            versions,
            triggers,
            occurrences,
        });
    }
    Ok(records)
}

fn read_routine_values<T, P, A>(
    conn: &Connection,
    store: &Store,
    sql: &str,
    params: P,
    aad: A,
) -> Result<Vec<Value>>
where
    T: rusqlite::types::FromSql + std::fmt::Display,
    P: rusqlite::Params,
    A: Fn(&T) -> String,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params, |row| {
            Ok((
                row.get::<_, T>(0)?,
                Sealed {
                    ciphertext: row.get(1)?,
                    nonce: row.get(2)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(key, sealed)| open_json_value(store, &sealed, &aad(&key)))
        .collect()
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
            Ok(Some(ProfileRecord {
                updated_at,
                payload,
            }))
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
    let workflow_definition_ids: std::collections::BTreeSet<(&str, u32)> = s
        .workflow_definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition.version))
        .collect();

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
    let mut routine_ids = std::collections::HashSet::new();
    for record in &s.routines {
        let routine_id = portable_text(&record.routine, "id").unwrap_or_default();
        if routine_id.is_empty() || !routine_ids.insert(routine_id.to_string()) {
            errors.push("Portable Routine ids must be present and unique.".into());
            continue;
        }
        if record.owner_subject != format!("member:{}", record.owner_member_id)
            || portable_text(&record.routine, "workspaceId")
                != Some(record.source_workspace_id.as_str())
            || portable_text(&record.routine, "ownerMemberId")
                != Some(record.owner_member_id.as_str())
        {
            errors.push(format!(
                "Routine {routine_id} has invalid portable owner authority."
            ));
        }
        if record
            .routine
            .get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|project_id| !project_ids.contains(project_id))
        {
            errors.push(format!(
                "Routine {routine_id} references an unknown project."
            ));
        }
        let current_version = record
            .routine
            .get("currentVersion")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        if current_version < 1 || record.versions.len() != current_version as usize {
            errors.push(format!(
                "Routine {routine_id} does not contain its complete immutable version history."
            ));
        }
        let trigger_ids = record
            .triggers
            .iter()
            .filter_map(|trigger| portable_text(trigger, "id"))
            .collect::<std::collections::HashSet<_>>();
        if trigger_ids.len() != record.triggers.len()
            || record.triggers.iter().any(|trigger| {
                portable_text(trigger, "routineId") != Some(routine_id)
                    || portable_text(trigger, "workspaceId")
                        != Some(record.source_workspace_id.as_str())
            })
        {
            errors.push(format!(
                "Routine {routine_id} has invalid or duplicate triggers."
            ));
        }
        for (index, version) in record.versions.iter().enumerate() {
            let expected = index as i64 + 1;
            let valid_ids = version
                .get("triggerIds")
                .and_then(Value::as_array)
                .is_some_and(|ids| {
                    !ids.is_empty()
                        && ids
                            .iter()
                            .all(|id| id.as_str().is_some_and(|id| trigger_ids.contains(id)))
                });
            if portable_text(version, "routineId") != Some(routine_id)
                || version.get("version").and_then(Value::as_i64) != Some(expected)
                || !valid_ids
            {
                errors.push(format!(
                    "Routine {routine_id} has an invalid immutable version {expected}."
                ));
            }
        }
        if record.occurrences.iter().any(|occurrence| {
            portable_text(occurrence, "routineId") != Some(routine_id)
                || portable_text(occurrence, "triggerId").is_none_or(|id| !trigger_ids.contains(id))
                || occurrence
                    .get("routineVersion")
                    .and_then(Value::as_i64)
                    .is_none_or(|version| version < 1 || version > current_version)
        }) {
            errors.push(format!(
                "Routine {routine_id} has invalid occurrence history."
            ));
        }
    }

    // thread -> project
    for t in &s.threads {
        if t.project_id
            .as_ref()
            .is_some_and(|project_id| !project_ids.contains(project_id.as_str()))
        {
            errors.push(format!(
                "Thread {} references unknown project {}.",
                t.id,
                t.project_id.as_deref().unwrap_or_default()
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
                errors.push(format!("Run {} references unknown thread {}.", r.id, tid));
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
                errors.push(format!("Approval {} references unknown run {}.", a.id, rid));
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
        if ar.authority != "local"
            || ar.visibility != "member-private"
            || (ar.owner_member_id.is_some() == ar.owner_internal_user_id.is_some())
        {
            errors.push(format!(
                "Artifact {} has invalid private owner authority.",
                ar.id
            ));
        }
        if ar.versions.is_empty()
            || !ar
                .versions
                .iter()
                .any(|version| version.id == ar.current_version_id)
        {
            errors.push(format!("Artifact {} has no exact current version.", ar.id));
        }
        for (index, version) in ar.versions.iter().enumerate() {
            if version.artifact_id != ar.id || version.version != (index as i64 + 1) {
                errors.push(format!(
                    "Artifact {} has invalid immutable version order.",
                    ar.id
                ));
            }
        }
    }
    for (kind, id, project_id) in s
        .connector_accounts
        .iter()
        .map(|record| {
            (
                "connector account",
                record.connector_id.as_str(),
                record.project_id.as_deref(),
            )
        })
        .chain(s.knowledge_sources.iter().map(|record| {
            (
                "knowledge source",
                record.id.as_str(),
                record.project_id.as_deref(),
            )
        }))
        .chain(s.memory_records.iter().map(|record| {
            (
                "memory record",
                record.id.as_str(),
                record.project_id.as_deref(),
            )
        }))
        .chain(
            s.schedules
                .iter()
                .map(|record| ("schedule", record.id.as_str(), record.project_id.as_deref())),
        )
        .chain(s.scheduled_jobs.iter().map(|record| {
            (
                "scheduled job",
                record.id.as_str(),
                record.project_id.as_deref(),
            )
        }))
        .chain(s.workflow_definitions.iter().map(|record| {
            (
                "workflow definition",
                record.id.as_str(),
                record.project_id.as_deref(),
            )
        }))
        .chain(s.workflow_runs.iter().map(|record| {
            (
                "workflow run",
                record.id.as_str(),
                record.project_id.as_deref(),
            )
        }))
    {
        if let Some(project_id) = project_id {
            if !project_ids.contains(project_id) {
                errors.push(format!(
                    "Exported {kind} {id} references unknown project {project_id}."
                ));
            }
        }
    }
    for run in &s.workflow_runs {
        if !workflow_definition_ids.contains(&(run.definition_id.as_str(), run.definition_version))
        {
            errors.push(format!(
                "Workflow run {} references an unknown workflow definition version.",
                run.id
            ));
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

fn portable_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn portable_required_text<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str> {
    portable_text(value, key).ok_or_else(|| StoreError::Invalid(format!("{label} is required.")))
}

fn portable_i64(value: &Value, key: &str, label: &str) -> Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| StoreError::Invalid(format!("{label} is invalid.")))
}

fn record_from<T: for<'de> Deserialize<'de>>(value: Value, table: &str) -> Result<T> {
    serde_json::from_value::<T>(value).map_err(|e| {
        StoreError::Invalid(format!(
            "Could not decode a {table} record for export: {e}."
        ))
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
#[cfg(test)]
pub fn import_workspace(
    store: &Store,
    manifest_json: &str,
    options: ImportOptions,
) -> std::result::Result<ImportReport, ImportError> {
    import_workspace_for(
        store,
        crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
        manifest_json,
        options,
    )
}

fn read_workflow_definitions(
    conn: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<WorkflowDefinitionRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, version, created_at, updated_at, payload, payload_nonce
         FROM workflow_definition WHERE workspace_id=?1
         ORDER BY id, version;",
    )?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                Sealed {
                    ciphertext: row.get(5)?,
                    nonce: row.get(6)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(id, project_id, version, created_at, updated_at, sealed)| {
                let payload = open_json_value(
                    store,
                    &sealed,
                    &format!("workflow_definition:{workspace_id}:{id}:{version}"),
                )?;
                Ok(WorkflowDefinitionRecord {
                    id,
                    project_id,
                    version,
                    created_at,
                    updated_at,
                    payload,
                })
            },
        )
        .collect()
}

fn read_workflow_runs(
    conn: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<WorkflowRunRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, definition_id, definition_version, status,
                started_at, updated_at, payload, payload_nonce
         FROM workflow_run WHERE workspace_id=?1 ORDER BY updated_at, id;",
    )?;
    let rows = stmt
        .query_map([workspace_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u32>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                Sealed {
                    ciphertext: row.get(7)?,
                    nonce: row.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(
                id,
                project_id,
                definition_id,
                definition_version,
                status,
                started_at,
                updated_at,
                sealed,
            )| {
                let payload =
                    open_json_value(store, &sealed, &format!("workflow_run:{workspace_id}:{id}"))?;
                Ok(WorkflowRunRecord {
                    id,
                    project_id,
                    definition_id,
                    definition_version,
                    status,
                    started_at,
                    updated_at,
                    payload,
                })
            },
        )
        .collect()
}

fn validate_no_secrets(sections: &Sections) -> Result<()> {
    let value = serde_json::to_value(sections)
        .map_err(|_| StoreError::Invalid("Could not validate the portable archive.".into()))?;
    if contains_secret_material(&value, None) {
        return Err(StoreError::Invalid(
            "The workspace contains credential-shaped data that cannot be exported.".into(),
        ));
    }
    Ok(())
}

fn contains_secret_material(value: &Value, key: Option<&str>) -> bool {
    let normalized_key = key
        .map(|key| {
            key.chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .unwrap_or_default();
    if matches!(
        normalized_key.as_str(),
        "credentialref"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "secret"
            | "clientsecret"
            | "password"
            | "apikey"
            | "authorization"
            | "cookie"
            | "privatekey"
    ) {
        return true;
    }
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            let lower = trimmed.to_ascii_lowercase();
            lower.starts_with("bearer ")
                || lower.starts_with("oauth-token:")
                || lower.starts_with("ghp_")
                || lower.starts_with("github_pat_")
                || lower.starts_with("sk-")
                || lower.starts_with("ya29.")
                || lower.starts_with("1//")
        }
        Value::Array(items) => items
            .iter()
            .any(|item| contains_secret_material(item, None)),
        Value::Object(map) => map
            .iter()
            .any(|(key, item)| contains_secret_material(item, Some(key))),
        _ => false,
    }
}

pub fn import_workspace_for(
    store: &Store,
    workspace_id: &str,
    manifest_json: &str,
    options: ImportOptions,
) -> std::result::Result<ImportReport, ImportError> {
    let scope = crate::store::repos::scope::DataScope::workspace(workspace_id.to_string())
        .map_err(|error| ImportError::Invalid(error.to_string()))?;
    let manifest = parse_and_validate(manifest_json)?;
    validate_no_secrets(&manifest.sections)
        .map_err(|error| ImportError::Invalid(error.to_string()))?;
    let mut report = ImportReport::new();

    // Plan: detect which incoming ids already exist. Done inside the same
    // transaction that applies, so the plan is consistent with the apply.
    let apply_result: Result<ImportReport> = store.transaction(|tx| {
        scope.ensure_exists(tx)?;
        // Re-validate incoming integrity (a manifest could be edited after export).
        validate_integrity(&manifest.sections)?;

        plan_and_apply(
            tx,
            store,
            scope.workspace_id(),
            &manifest,
            options,
            &mut report,
        )?;
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
        ImportError::Invalid(format!(
            "The manifest is not valid portable-workspace JSON: {e}."
        ))
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
fn migrate_manifest(
    _manifest: &mut Manifest,
    _target: u32,
) -> std::result::Result<(), ImportError> {
    Ok(())
}

fn invalid_artifact(message: &str) -> StoreError {
    StoreError::Invalid(format!("Portable artifact is not canonical: {message}."))
}

fn bounded_nonempty(value: &str, max_chars: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max_chars
}

fn review_timestamp(value: &str) -> Option<DateTime<chrono::FixedOffset>> {
    bounded_nonempty(value, 64)
        .then(|| DateTime::parse_from_rfc3339(value).ok())
        .flatten()
}

fn validate_portable_reviews(
    artifact: &ArtifactRecord,
    acting_internal_user_id: &str,
    owner_member_id: Option<&str>,
) -> Result<()> {
    let version_ids = artifact
        .versions
        .iter()
        .map(|version| version.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut review_ids = std::collections::BTreeSet::new();
    let mut prior_order: Option<(&str, &str)> = None;
    let mut open_reviews = 0usize;

    for review in &artifact.reviews {
        if !review_ids.insert(review.id.as_str())
            || !bounded_nonempty(&review.id, 256)
            || review.artifact_id != artifact.id
            || !version_ids.contains(review.version_id.as_str())
            || review.requested_by_internal_user_id != acting_internal_user_id
            || review.reviewer_member_id.as_deref() != owner_member_id
        {
            return Err(invalid_artifact(
                "review identity, owner, or exact version differs",
            ));
        }
        if let Some((requested_at, id)) = prior_order {
            if (review.requested_at.as_str(), review.id.as_str()) < (requested_at, id) {
                return Err(invalid_artifact("review history order differs"));
            }
        }
        prior_order = Some((&review.requested_at, &review.id));

        let requested_at = review_timestamp(&review.requested_at)
            .ok_or_else(|| invalid_artifact("review request timestamp is invalid"))?;
        let resolved_at = review
            .resolved_at
            .as_deref()
            .map(|value| {
                review_timestamp(value)
                    .filter(|resolved| *resolved >= requested_at)
                    .ok_or_else(|| invalid_artifact("review resolution timestamp is invalid"))
            })
            .transpose()?;
        let payload = review
            .payload
            .as_object()
            .ok_or_else(|| invalid_artifact("review payload is malformed"))?;
        let allowed = [
            "id",
            "status",
            "requestedByInternalUserId",
            "reviewerMemberId",
            "versionId",
            "requestedAt",
            "resolvedAt",
            "summary",
            "requestedChanges",
            "acceptance",
        ];
        if payload.keys().any(|key| !allowed.contains(&key.as_str()))
            || payload.get("id").and_then(Value::as_str) != Some(review.id.as_str())
            || payload.get("status").and_then(Value::as_str) != Some(review.status.as_str())
            || payload
                .get("requestedByInternalUserId")
                .and_then(Value::as_str)
                != Some(acting_internal_user_id)
            || payload.get("reviewerMemberId").and_then(Value::as_str) != owner_member_id
            || payload.get("versionId").and_then(Value::as_str) != Some(review.version_id.as_str())
            || payload.get("requestedAt").and_then(Value::as_str)
                != Some(review.requested_at.as_str())
            || payload.get("resolvedAt").and_then(Value::as_str) != review.resolved_at.as_deref()
        {
            return Err(invalid_artifact("review wrapper and payload differ"));
        }
        if payload.get("summary").is_some_and(|summary| {
            summary
                .as_str()
                .is_none_or(|value| !bounded_nonempty(value, 2_000))
        }) {
            return Err(invalid_artifact("review summary is invalid"));
        }

        match review.status.as_str() {
            "requested" => {
                open_reviews += 1;
                if resolved_at.is_some()
                    || payload.contains_key("requestedChanges")
                    || payload.contains_key("acceptance")
                    || review.version_id != artifact.current_version_id
                {
                    return Err(invalid_artifact("open review state is inconsistent"));
                }
            }
            "changes-requested" => {
                let changes = payload
                    .get("requestedChanges")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid_artifact("requested changes are missing"))?;
                let mut unique = std::collections::BTreeSet::new();
                if resolved_at.is_none()
                    || changes.is_empty()
                    || changes.len() > 32
                    || changes.iter().any(|change| {
                        change.as_str().is_none_or(|value| {
                            !bounded_nonempty(value, 500) || !unique.insert(value)
                        })
                    })
                    || payload.contains_key("acceptance")
                {
                    return Err(invalid_artifact("requested changes are inconsistent"));
                }
            }
            "approved" => {
                let acceptance = payload
                    .get("acceptance")
                    .and_then(Value::as_object)
                    .ok_or_else(|| invalid_artifact("review acceptance is missing"))?;
                let acceptance_allowed = ["acceptedByInternalUserId", "acceptedAt", "note"];
                let acceptance_note = acceptance.get("note").and_then(Value::as_str);
                if resolved_at.is_none()
                    || payload.contains_key("requestedChanges")
                    || acceptance
                        .keys()
                        .any(|key| !acceptance_allowed.contains(&key.as_str()))
                    || acceptance
                        .get("acceptedByInternalUserId")
                        .and_then(Value::as_str)
                        != Some(acting_internal_user_id)
                    || acceptance.get("acceptedAt").and_then(Value::as_str)
                        != review.resolved_at.as_deref()
                    || acceptance.get("note").is_some_and(|note| {
                        note.as_str()
                            .is_none_or(|value| !bounded_nonempty(value, 2_000))
                    })
                    || acceptance_note != payload.get("summary").and_then(Value::as_str)
                {
                    return Err(invalid_artifact("review acceptance is inconsistent"));
                }
            }
            _ => return Err(invalid_artifact("review status is unsupported")),
        }
    }
    if open_reviews > 1 {
        return Err(invalid_artifact("more than one review is open"));
    }
    let current_review = artifact
        .reviews
        .iter()
        .rev()
        .find(|review| review.version_id == artifact.current_version_id);
    let expected_status = match current_review.map(|review| review.status.as_str()) {
        None => "draft",
        Some("requested") => "in-review",
        Some("changes-requested") => "changes-requested",
        Some("approved") => "accepted",
        Some(_) => unreachable!("review status was validated above"),
    };
    if artifact.status != expected_status {
        return Err(invalid_artifact(
            "artifact status differs from its current-version review",
        ));
    }
    Ok(())
}

fn validate_portable_artifact(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    owner: &crate::store::repos::scope::PrivateDataScope,
    acting_internal_user_id: &str,
    r: &ArtifactRecord,
) -> Result<()> {
    let artifact = r
        .payload
        .as_object()
        .ok_or_else(|| invalid_artifact("artifact payload is malformed"))?;
    let exact_str =
        |key: &str, expected: &str| artifact.get(key).and_then(Value::as_str) == Some(expected);
    if !exact_str("id", &r.id)
        || !exact_str("workspaceId", workspace_id)
        || !exact_str("authority", "local")
        || !exact_str("visibility", "member-private")
        || !exact_str("kind", &r.kind)
        || !exact_str("status", &r.status)
        || !exact_str("createdAt", &r.created_at)
        || !exact_str("updatedAt", &r.updated_at)
        || artifact.get("schemaVersion").and_then(Value::as_i64) != Some(1)
        || artifact
            .get("createdByInternalUserId")
            .and_then(Value::as_str)
            != Some(acting_internal_user_id)
        || artifact.get("revision").and_then(Value::as_i64) != Some(r.revision)
        || !exact_str("currentVersionId", &r.current_version_id)
        || artifact.get("producingRunId").and_then(Value::as_str) != r.run_id.as_deref()
        || r.payload
            .pointer("/context/threadId")
            .and_then(Value::as_str)
            != r.thread_id.as_deref()
    {
        return Err(invalid_artifact(
            "wrapper and artifact identity or scope differ",
        ));
    }
    let owner_exact = match owner.owner_member_id() {
        Some(member) => {
            artifact.get("ownerMemberId").and_then(Value::as_str) == Some(member)
                && artifact.get("ownerInternalUserId").is_none()
        }
        None => {
            artifact.get("ownerInternalUserId").and_then(Value::as_str)
                == owner.owner_internal_user_id()
                && artifact.get("ownerMemberId").is_none()
        }
    };
    if !owner_exact {
        return Err(invalid_artifact("payload owner differs from active owner"));
    }
    let title = artifact
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_artifact("title is missing"))?;
    if title.is_empty()
        || title.chars().count() > 256
        || format!("{:x}", Sha256::digest(title.as_bytes())) != r.title_fingerprint
    {
        return Err(invalid_artifact("title or title hash differs"));
    }
    if artifact
        .get("reviews")
        .and_then(Value::as_array)
        .is_none_or(|reviews| !reviews.is_empty())
        || artifact.get("publication").is_some_and(|v| !v.is_null())
    {
        return Err(invalid_artifact(
            "raw review or publication claims are not canonical",
        ));
    }
    if r.payload
        .pointer("/retention/status")
        .and_then(Value::as_str)
        != Some("active")
    {
        return Err(invalid_artifact("retention is not active"));
    }
    let run_id = r
        .run_id
        .as_deref()
        .ok_or_else(|| invalid_artifact("producing run is missing"))?;
    let thread_id = r
        .thread_id
        .as_deref()
        .ok_or_else(|| invalid_artifact("thread is missing"))?;
    let message_id = r
        .source_message_id
        .as_deref()
        .ok_or_else(|| invalid_artifact("source message is missing"))?;
    let thread:(Option<String>,Option<String>)=tx.query_row(
        "SELECT project_id,owner_member_id FROM thread WHERE id=?1 AND workspace_id=?2 AND deleted_at IS NULL",
        rusqlite::params![thread_id,workspace_id],|row|Ok((row.get(0)?,row.get(1)?)))
        .optional()?.ok_or_else(||invalid_artifact("thread is not native in the target workspace"))?;
    if thread.1.as_deref() != owner.owner_member_id()
        || r.payload
            .pointer("/context/projectId")
            .and_then(Value::as_str)
            != thread.0.as_deref()
    {
        return Err(invalid_artifact("thread owner or project scope differs"));
    }
    let run_ok:bool=tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM run WHERE id=?1 AND workspace_id=?2 AND thread_id=?3 AND status='completed')",
        rusqlite::params![run_id,workspace_id,thread_id],|row|row.get(0))?;
    if !run_ok {
        return Err(invalid_artifact(
            "completed producing run is not native in the target thread",
        ));
    }
    let revision = tx
        .query_row(
            "SELECT m.current_revision_id,r.payload,r.payload_nonce FROM message m
         JOIN message_revision r ON r.id=m.current_revision_id
         WHERE m.id=?1 AND m.workspace_id=?2 AND m.thread_id=?3 AND m.run_id=?4
           AND m.kind='assistant' AND m.current_revision_state='terminal' AND m.deleted_at IS NULL",
            rusqlite::params![message_id, workspace_id, thread_id, run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Sealed {
                        ciphertext: row.get(1)?,
                        nonce: row.get(2)?,
                    },
                ))
            },
        )
        .optional()?
        .ok_or_else(|| invalid_artifact("terminal assistant source message is not native"))?;
    let review_transitions = r
        .reviews
        .iter()
        .map(|review| if review.status == "requested" { 1 } else { 2 })
        .sum::<i64>();
    if r.versions.is_empty() || r.revision != r.versions.len() as i64 + review_transitions {
        return Err(invalid_artifact(
            "revision does not equal immutable version and review history",
        ));
    }
    let mut previous_id: Option<&str> = None;
    let mut version_ids = std::collections::HashSet::new();
    for (index, version) in r.versions.iter().enumerate() {
        let payload = version
            .payload
            .as_object()
            .ok_or_else(|| invalid_artifact("version payload is malformed"))?;
        let expected_number = index as i64 + 1;
        if payload.get("id").and_then(Value::as_str) != Some(version.id.as_str())
            || payload.get("artifactId").and_then(Value::as_str) != Some(r.id.as_str())
            || payload.get("version").and_then(Value::as_i64) != Some(expected_number)
            || payload.get("status").and_then(Value::as_str) != Some("available")
            || version.artifact_id != r.id
            || version.version != expected_number
            || version.status != "available"
            || payload.get("createdAt").and_then(Value::as_str) != Some(version.created_at.as_str())
        {
            return Err(invalid_artifact("version wrapper and payload differ"));
        }
        if !version_ids.insert(version.id.as_str()) {
            return Err(invalid_artifact("version id is duplicated"));
        }
        if payload
            .get("createdByInternalUserId")
            .and_then(Value::as_str)
            != Some(acting_internal_user_id)
        {
            return Err(invalid_artifact("version actor differs from active owner"));
        }
        let text = version
            .payload
            .pointer("/content/text")
            .and_then(Value::as_str)
            .filter(|_| {
                version
                    .payload
                    .pointer("/content/kind")
                    .and_then(Value::as_str)
                    == Some("inline")
            })
            .ok_or_else(|| invalid_artifact("version content is not bounded inline text"))?;
        if text.is_empty() || text.len() > 65_536 {
            return Err(invalid_artifact("inline content is out of bounds"));
        }
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let media = serde_json::json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
        let content_hash = serde_json::json!({"algorithm":"sha-256","value":hash});
        if version.content_fingerprint != hash
            || version.size_bytes != text.len() as i64
            || payload.get("media") != Some(&media)
            || version.payload.pointer("/content/media") != Some(&media)
            || payload.get("contentHash") != Some(&content_hash)
            || version.payload.pointer("/content/contentHash") != Some(&content_hash)
        {
            return Err(invalid_artifact("content bytes, media, and hash differ"));
        }
        for evidence in ["citations", "inputs", "decisions"] {
            if payload
                .get(evidence)
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
            {
                return Err(invalid_artifact(
                    "portable evidence claims are not independently verifiable",
                ));
            }
        }
        let provenance = payload
            .get("provenance")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid_artifact("version provenance is missing"))?;
        let lineage = payload
            .get("lineage")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid_artifact("version lineage is missing"))?;
        if index == 0 {
            if provenance.get("kind").and_then(Value::as_str) != Some("run")
                || provenance.get("runId").and_then(Value::as_str) != Some(run_id)
                || provenance.get("observedAt").and_then(Value::as_str)
                    != Some(version.created_at.as_str())
                || !lineage.is_empty()
            {
                return Err(invalid_artifact(
                    "first version provenance is not the producing run",
                ));
            }
        } else {
            let previous = previous_id.unwrap();
            if provenance.get("kind").and_then(Value::as_str) != Some("artifact-version")
                || provenance
                    .get("sourceArtifactVersionId")
                    .and_then(Value::as_str)
                    != Some(previous)
                || provenance.get("observedAt").and_then(Value::as_str)
                    != Some(version.created_at.as_str())
                || lineage.len() != 1
                || lineage[0].get("relation").and_then(Value::as_str) != Some("supersedes")
                || lineage[0].get("artifactId").and_then(Value::as_str) != Some(r.id.as_str())
                || lineage[0].get("artifactVersionId").and_then(Value::as_str) != Some(previous)
                || lineage[0].get("recordedAt").and_then(Value::as_str)
                    != Some(version.created_at.as_str())
            {
                return Err(invalid_artifact("supersedes lineage is not exact"));
            }
        }
        previous_id = Some(&version.id);
    }
    let current = r.versions.last().unwrap();
    if current.id != r.current_version_id
        || current.content_fingerprint != r.content_fingerprint
        || current.size_bytes != r.size_bytes
    {
        return Err(invalid_artifact("current version pointer differs"));
    }
    let sources = artifact
        .get("sourceProvenance")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_artifact("artifact source provenance is missing"))?;
    if sources.len() != 1 || sources[0] != r.versions[0].payload["provenance"] {
        return Err(invalid_artifact(
            "artifact source provenance differs from version one",
        ));
    }
    let durable = open_json_value(
        store,
        &revision.1,
        &format!("message-revision:{workspace_id}:{}", revision.0),
    )?;
    if durable.as_str()
        != r.versions[0]
            .payload
            .pointer("/content/text")
            .and_then(Value::as_str)
    {
        return Err(invalid_artifact(
            "first version does not match the native source response",
        ));
    }
    validate_portable_reviews(r, acting_internal_user_id, owner.owner_member_id())
}

fn pause_imported_routine(value: &mut Value, actor: &str, at: &str) -> Result<()> {
    if portable_text(value, "status") != Some("active") {
        return Ok(());
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid("Portable Routine content is invalid.".into()))?;
    object.insert("status".into(), Value::String("paused".into()));
    object.insert("updatedAt".into(), Value::String(at.into()));
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| StoreError::Invalid("Portable Routine revision is invalid.".into()))?;
    object.insert("revision".into(), Value::Number((revision + 1).into()));
    object.insert(
        "pause".into(),
        serde_json::json!({
            "pausedAt": at,
            "pausedByInternalUserId": actor,
            "reason": "Imported workspace copies never activate execution."
        }),
    );
    Ok(())
}

fn pause_imported_trigger(value: &mut Value, at: &str) -> Result<()> {
    if portable_text(value, "status") != Some("active") {
        return Ok(());
    }
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid("Portable Routine trigger is invalid.".into()))?;
    object.insert("status".into(), Value::String("paused".into()));
    object.insert("updatedAt".into(), Value::String(at.into()));
    let revision = object
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| StoreError::Invalid("Portable trigger revision is invalid.".into()))?;
    object.insert("revision".into(), Value::Number((revision + 1).into()));
    Ok(())
}

fn apply_portable_routines(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    records: &[PortableRoutineRecord],
    report: &mut ImportReport,
    at: &str,
) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    let context =
        crate::store::repos::workspace_directory::require_active_workspace_context_for_current_user(
            tx,
        )?;
    if context.active_workspace.local_workspace_id != workspace_id {
        return Err(StoreError::Invalid(
            "Routine import requires the active authenticated workspace.".into(),
        ));
    }
    let member_id = context
        .member_id
        .as_deref()
        .ok_or_else(|| StoreError::Invalid("Routine import requires an active member.".into()))?;
    let mut inserted_count = 0usize;

    for record in records {
        if record.source_workspace_id != workspace_id
            || record.owner_member_id != member_id
            || record.owner_subject != format!("member:{member_id}")
        {
            return Err(StoreError::Invalid(
                "Portable Routine owner does not match the active authenticated workspace.".into(),
            ));
        }
        let routine_id = crate::store::repos::scope::normalize_id(
            portable_text(&record.routine, "id")
                .ok_or_else(|| StoreError::Invalid("Portable Routine id is required.".into()))?,
            "Routine",
        )?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM routine_record
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3);",
            rusqlite::params![workspace_id, record.owner_subject, routine_id],
            |row| row.get(0),
        )?;
        if exists {
            report.inc_skipped("routines");
            continue;
        }

        let project_id = record
            .routine
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::to_string);
        ensure_target_project(tx, workspace_id, project_id.as_deref())?;
        let scope = crate::store::repos::scope::DataScope::new(
            workspace_id.to_string(),
            project_id.clone(),
        )?;
        let owner = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            scope.clone(),
            &context.internal_user_id,
            Some(member_id),
        )?;

        let mut routine = record.routine.clone();
        let (_, _, current_version) = crate::store::repos::routine::validate_routine(
            &scope,
            &owner,
            &context.internal_user_id,
            &routine,
        )?;
        if current_version as usize != record.versions.len() {
            return Err(StoreError::Invalid(
                "Portable Routine immutable version history is incomplete.".into(),
            ));
        }
        for (index, version) in record.versions.iter().enumerate() {
            crate::store::repos::routine::validate_version(
                &context.internal_user_id,
                &routine_id,
                version,
                index as i64 + 1,
            )?;
        }
        for trigger in &record.triggers {
            crate::store::repos::routine::validate_trigger(
                &scope,
                &owner,
                &context.internal_user_id,
                &routine_id,
                trigger,
            )?;
        }

        pause_imported_routine(&mut routine, &context.internal_user_id, at)?;
        let (_, status, current_version) = crate::store::repos::routine::validate_routine(
            &scope,
            &owner,
            &context.internal_user_id,
            &routine,
        )?;
        let routine_sealed = store.seal_json_owned(
            &routine,
            &format!(
                "routine:{workspace_id}:{}:{routine_id}",
                owner.owner_subject()
            ),
        )?;
        tx.execute(
            "INSERT INTO routine_record(
               workspace_id,owner_subject,id,project_id,visibility,owner_member_id,status,
               current_version,revision,created_by_internal_user_id,created_at,updated_at,
               deleted_at,payload,payload_nonce
             ) VALUES (?1,?2,?3,?4,'member-private',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14);",
            rusqlite::params![
                workspace_id,
                owner.owner_subject(),
                routine_id,
                project_id,
                member_id,
                status,
                current_version,
                portable_i64(&routine, "revision", "Portable Routine revision")?,
                context.internal_user_id,
                portable_required_text(&routine, "createdAt", "Portable Routine created time")?,
                portable_required_text(&routine, "updatedAt", "Portable Routine updated time")?,
                portable_text(&routine, "deletedAt"),
                routine_sealed.ciphertext,
                routine_sealed.nonce
            ],
        )?;

        for (index, version) in record.versions.iter().enumerate() {
            let version_number = index as i64 + 1;
            let sealed = store.seal_json_owned(
                version,
                &format!(
                    "routine_version:{workspace_id}:{}:{routine_id}:{version_number}",
                    owner.owner_subject()
                ),
            )?;
            tx.execute(
                "INSERT INTO routine_version(
                   workspace_id,owner_subject,routine_id,version,
                   created_by_internal_user_id,created_at,payload,payload_nonce
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8);",
                rusqlite::params![
                    workspace_id,
                    owner.owner_subject(),
                    routine_id,
                    version_number,
                    context.internal_user_id,
                    portable_required_text(
                        version,
                        "createdAt",
                        "Portable Routine version created time"
                    )?,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
        }

        for original in &record.triggers {
            let mut trigger = original.clone();
            pause_imported_trigger(&mut trigger, at)?;
            let (trigger_id, trigger_status, kind) =
                crate::store::repos::routine::validate_trigger(
                    &scope,
                    &owner,
                    &context.internal_user_id,
                    &routine_id,
                    &trigger,
                )?;
            let sealed = store.seal_json_owned(
                &trigger,
                &format!(
                    "routine_trigger:{workspace_id}:{}:{trigger_id}",
                    owner.owner_subject()
                ),
            )?;
            tx.execute(
                "INSERT INTO routine_trigger(
                   workspace_id,owner_subject,id,routine_id,project_id,status,kind,revision,
                   created_at,updated_at,deleted_at,payload,payload_nonce
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13);",
                rusqlite::params![
                    workspace_id,
                    owner.owner_subject(),
                    trigger_id,
                    routine_id,
                    project_id,
                    trigger_status,
                    kind,
                    portable_i64(&trigger, "revision", "Portable trigger revision")?,
                    portable_required_text(&trigger, "createdAt", "Portable trigger created time")?,
                    portable_required_text(&trigger, "updatedAt", "Portable trigger updated time")?,
                    portable_text(&trigger, "deletedAt"),
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
        }
        for occurrence in &record.occurrences {
            crate::store::repos::routine::append_occurrence(tx, store, &scope, &owner, occurrence)?;
        }
        report.inc_inserted("routines");
        inserted_count += 1;
    }
    if inserted_count > 0 {
        report.warnings.push(format!(
            "{inserted_count} canonical Routine(s) imported paused; scheduler authority and node-local driver state were not imported."
        ));
    }
    Ok(())
}

fn plan_and_apply(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
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
        workspace_id,
        &manifest.sections.preferences,
        "preferences",
        "key",
        report,
        |tx, store, r| {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM preferences WHERE workspace_id=?1 AND key=?2);",
                rusqlite::params![workspace_id, r.key],
                |row| row.get(0),
            )?;
            if exists {
                return Ok(());
            }
            let sealed = store
                .seal_json_owned(&r.value, &format!("preferences:{workspace_id}:{}", r.key))?;
            tx.execute(
                "INSERT INTO preferences (workspace_id, key, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5);",
                rusqlite::params![
                    workspace_id,
                    r.key,
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
        workspace_id,
        &manifest.sections.projects,
        "projects",
        "id",
        report,
        |tx, store, r| {
            let owner: Option<String> = tx
                .query_row(
                    "SELECT workspace_id FROM project WHERE id=?1;",
                    [&r.id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(owner) = owner {
                if owner != workspace_id {
                    return Err(StoreError::Invalid(
                        "An imported project id is owned by another workspace.".into(),
                    ));
                }
                return Ok(());
            }
            let sealed = store.seal_json_owned(&r.payload, &format!("project:{}", r.id))?;
            tx.execute(
                "INSERT INTO project (id, workspace_id, title_fingerprint, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    workspace_id,
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
        workspace_id,
        &manifest.sections.threads,
        "threads",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("thread:{}", r.id))?;
            tx.execute(
                "INSERT INTO thread (id, workspace_id, project_id, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
                rusqlite::params![
                    r.id,
                    workspace_id,
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
        workspace_id,
        &manifest.sections.messages,
        "messages",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("message:{}", r.id))?;
            tx.execute(
                "INSERT INTO message (id, workspace_id, thread_id, kind, seq, idempotency_key, current_revision_id, created_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);",
                rusqlite::params![
                    r.id,
                    workspace_id,
                    r.thread_id,
                    r.role,
                    r.seq,
                    format!("portable:{}",r.id),
                    format!("portable:{}",r.id),
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
        workspace_id,
        &manifest.sections.runs,
        "runs",
        "id",
        report,
        |tx, store, r| {
            let sealed = store.seal_json_owned(&r.payload, &format!("run:{}", r.id))?;
            tx.execute(
                "INSERT INTO run (id, workspace_id, thread_id, provider_id, model, status, turn, recoverable,
                          retry_count, created_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13);",
                rusqlite::params![
                    r.id,
                    workspace_id,
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
        workspace_id,
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
        workspace_id,
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
        workspace_id,
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
        workspace_id,
        &manifest.sections.artifacts,
        "artifacts",
        "id",
        report,
        |tx, store, r| {
            let context=crate::store::repos::workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            if context.active_workspace.local_workspace_id != workspace_id {
                return Err(StoreError::Invalid(
                    "Artifact import requires the active workspace owner.".into(),
                ));
            }
            let data = crate::store::repos::scope::DataScope::workspace(workspace_id.to_string())?;
            let owner = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
                data,
                &context.internal_user_id,
                context.member_id.as_deref(),
            )?;
            if r.owner_subject != owner.owner_subject()
                || r.owner_member_id.as_deref() != owner.owner_member_id()
                || r.owner_internal_user_id.as_deref() != owner.owner_internal_user_id()
                || r.authority != "local"
                || r.visibility != "member-private"
            {
                return Err(StoreError::Invalid(
                    "Artifact archive owner does not match the active private owner.".into(),
                ));
            }
            validate_portable_artifact(
                tx,
                store,
                workspace_id,
                &owner,
                &context.internal_user_id,
                r,
            )?;
            let sealed = store.seal_json_owned(
                &r.payload,
                &format!("artifact:{workspace_id}:{}:{}", owner.owner_subject(), r.id),
            )?;
            tx.execute(
                "INSERT INTO artifact (workspace_id,owner_subject,authority,visibility,owner_member_id,
                          owner_internal_user_id,id,run_id,thread_id,source_message_id,kind,status,revision,
                          current_version_id,title_fingerprint,content_fingerprint,size_bytes,created_at,updated_at,
                          payload,payload_nonce)
                 VALUES (?1,?2,'local','member-private',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19);",
                rusqlite::params![
                    workspace_id,owner.owner_subject(),owner.owner_member_id(),owner.owner_internal_user_id(),
                    r.id,r.run_id,r.thread_id,r.source_message_id,r.kind,r.status,r.revision,r.current_version_id,
                    r.title_fingerprint,r.content_fingerprint,r.size_bytes,r.created_at,r.updated_at,
                    sealed.ciphertext,
                    sealed.nonce
                ],
            )?;
            for version in &r.versions {
                let sealed = store.seal_json_owned(
                    &version.payload,
                    &format!(
                        "artifact_version:{workspace_id}:{}:{}:{}",
                        owner.owner_subject(),
                        r.id,
                        version.id
                    ),
                )?;
                tx.execute(
                    "INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,
                      content_fingerprint,size_bytes,created_at,payload,payload_nonce)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    rusqlite::params![workspace_id,owner.owner_subject(),r.id,version.id,version.version,
                        version.status,version.content_fingerprint,version.size_bytes,version.created_at,
                        sealed.ciphertext,sealed.nonce])?;
            }
            for review in &r.reviews {
                let sealed = store.seal_json_owned(
                    &review.payload,
                    &format!(
                        "artifact_review:{workspace_id}:{}:{}:{}",
                        owner.owner_subject(),
                        r.id,
                        review.id
                    ),
                )?;
                tx.execute(
                    "INSERT INTO artifact_review(workspace_id,owner_subject,artifact_id,id,version_id,status,
                       requested_by_internal_user_id,reviewer_member_id,requested_at,resolved_at,payload,payload_nonce)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    rusqlite::params![
                        workspace_id,
                        owner.owner_subject(),
                        r.id,
                        review.id,
                        review.version_id,
                        review.status,
                        review.requested_by_internal_user_id,
                        review.reviewer_member_id,
                        review.requested_at,
                        review.resolved_at,
                        sealed.ciphertext,
                        sealed.nonce
                    ],
                )?;
            }
            Ok(())
        },
    )?;

    // connector_account — local-first: status forced to "disconnected", and
    // credential_ref left empty. The imported row cannot authenticate.
    apply_simple(
        tx,
        store,
        workspace_id,
        &manifest.sections.connector_accounts,
        "connectorAccounts",
        "connectorId",
        report,
        |tx, store, r| {
            ensure_target_project(tx, workspace_id, r.project_id.as_deref())?;
            let sealed = store.seal_json_owned(
                &r.payload,
                &format!("connector_account:{workspace_id}:{}", r.connector_id),
            )?;
            tx.execute(
                "INSERT INTO connector_account (workspace_id, project_id, connector_id, account_id, status, expires_at,
                          credential_ref, connected_at, updated_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11);",
                rusqlite::params![
                    workspace_id,
                    r.project_id,
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
        for _ in &manifest.sections.backend_connections {
            report.inc_skipped(section);
        }
    }

    apply_simple(
        tx,
        store,
        workspace_id,
        &manifest.sections.knowledge_sources,
        "knowledgeSources",
        "id",
        report,
        |tx, store, r| {
            ensure_target_project(tx, workspace_id, r.project_id.as_deref())?;
            let sealed = store.seal_json_owned(
                &r.payload,
                &format!("knowledge_source:{workspace_id}:{}", r.id),
            )?;
            tx.execute(
                "INSERT INTO knowledge_source (id, workspace_id, project_id, connector_id, kind, trust, pinned,
                          content_fingerprint, size_bytes, imported_at, origin, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13);",
                rusqlite::params![
                    r.id,
                    workspace_id,
                    r.project_id,
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
        workspace_id,
        &manifest.sections.memory_records,
        "memoryRecords",
        "id",
        report,
        |tx, store, r| {
            ensure_target_project(tx, workspace_id, r.project_id.as_deref())?;
            let sealed = store.seal_json_owned(
                &r.payload,
                &format!("memory_record:{workspace_id}:{}", r.id),
            )?;
            tx.execute(
                "INSERT INTO memory_record (id, workspace_id, project_id, kind, pinned, approved, created_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
                rusqlite::params![
                    r.id,
                    workspace_id,
                    r.project_id,
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
        workspace_id,
        &manifest.sections.schedules,
        "schedules",
        "id",
        report,
        |tx, store, r| {
            ensure_target_project(tx, workspace_id, r.project_id.as_deref())?;
            let sealed =
                store.seal_json_owned(&r.payload, &format!("schedule:{workspace_id}:{}", r.id))?;
            tx.execute(
                "INSERT INTO schedule (id, workspace_id, project_id, weekday, time, enabled, created_at, payload, payload_nonce)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);",
                rusqlite::params![
                    r.id,
                    workspace_id,
                    r.project_id,
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

    apply_portable_routines(
        tx,
        store,
        workspace_id,
        &manifest.sections.routines,
        report,
        &now,
    )?;

    for record in &manifest.sections.workflow_definitions {
        ensure_target_project(tx, workspace_id, record.project_id.as_deref())?;
        let existing_project: Option<Option<String>> = tx
            .query_row(
                "SELECT project_id FROM workflow_definition
                 WHERE workspace_id=?1 AND id=?2 AND version=?3;",
                rusqlite::params![workspace_id, record.id, record.version],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_project) = existing_project {
            if existing_project != record.project_id {
                return Err(StoreError::Invalid(
                    "An imported workflow definition is owned by another project.".into(),
                ));
            }
            report.inc_skipped("workflowDefinitions");
            continue;
        }
        let scope = crate::store::repos::scope::DataScope::new(
            workspace_id.to_string(),
            record.project_id.clone(),
        )?;
        crate::store::repos::workflow::upsert_definition(
            tx,
            store,
            &scope,
            &record.id,
            record.version,
            &record.created_at,
            &record.updated_at,
            &record.payload,
        )?;
        report.inc_inserted("workflowDefinitions");
    }

    for record in &manifest.sections.workflow_runs {
        ensure_target_project(tx, workspace_id, record.project_id.as_deref())?;
        let existing_project: Option<Option<String>> = tx
            .query_row(
                "SELECT project_id FROM workflow_run WHERE workspace_id=?1 AND id=?2;",
                rusqlite::params![workspace_id, record.id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing_project) = existing_project {
            if existing_project != record.project_id {
                return Err(StoreError::Invalid(
                    "An imported workflow run is owned by another project.".into(),
                ));
            }
            report.inc_skipped("workflowRuns");
            continue;
        }
        let scope = crate::store::repos::scope::DataScope::new(
            workspace_id.to_string(),
            record.project_id.clone(),
        )?;
        crate::store::repos::workflow::upsert_run(
            tx,
            store,
            &scope,
            &record.id,
            &record.definition_id,
            record.definition_version,
            &record.status,
            &record.started_at,
            &record.updated_at,
            &record.payload,
        )?;
        report.inc_inserted("workflowRuns");
    }

    for record in &manifest.sections.scheduled_jobs {
        ensure_target_project(tx, workspace_id, record.project_id.as_deref())?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT workspace_id FROM scheduled_job WHERE id=?1;",
                [&record.id],
                |row| row.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == workspace_id => {
                report.inc_skipped("scheduledJobs");
                continue;
            }
            Some(_) => {
                return Err(StoreError::Invalid(
                    "An imported scheduled job id is owned by another workspace.".into(),
                ));
            }
            None => {}
        }
        let mut payload = record.payload.clone();
        let object = payload.as_object_mut().ok_or_else(|| {
            StoreError::Invalid("An imported scheduled job payload is not an object.".into())
        })?;
        object.insert("id".into(), Value::String(record.id.clone()));
        object.insert(
            "workspaceId".into(),
            Value::String(workspace_id.to_string()),
        );
        object.insert(
            "projectId".into(),
            record
                .project_id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        object.insert("status".into(), Value::String("paused".into()));
        crate::store::repos::scheduled_job::upsert_from_value(
            tx,
            store,
            workspace_id,
            payload,
            &now,
        )?;
        report.inc_inserted("scheduledJobs");
    }

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
            let sealed =
                store.seal_json_owned(&r.payload, &format!("model_config:{}", r.provider_id))?;
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
        workspace_id,
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
        workspace_id,
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
    if !manifest.sections.scheduled_jobs.is_empty() {
        report.warnings.push(format!(
            "{} scheduled job(s) imported paused; re-enable them explicitly to activate.",
            manifest.sections.scheduled_jobs.len()
        ));
    }

    // keep `now` referenced for clarity of "apply-time" semantics
    let _ = now;
    Ok(())
}

fn ensure_target_project(
    tx: &Connection,
    workspace_id: &str,
    project_id: Option<&str>,
) -> Result<()> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let owner: Option<String> = tx
        .query_row(
            "SELECT workspace_id FROM project WHERE id=?1;",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref() != Some(workspace_id) {
        return Err(StoreError::Invalid(
            "An imported record references a project outside the target workspace.".into(),
        ));
    }
    Ok(())
}

/// Apply a homogeneous list of records under the skip-on-conflict policy.
#[allow(clippy::too_many_arguments)]
fn apply_simple<T, F>(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
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
        if r.exists(tx, id_col, workspace_id)? {
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
    fn exists(&self, tx: &Connection, _table: &str, workspace_id: &str) -> Result<bool>;
}

/// Implement `KeyedRecord` for a record whose single-string primary key is the
/// Rust field `$id_field` bound to the SQL column `$col` in `$table`.
macro_rules! impl_keyed_str {
    ($ty:ty, $id_field:ident, $table:expr, $col:expr) => {
        impl KeyedRecord for $ty {
            fn exists(&self, tx: &Connection, _table: &str, _workspace_id: &str) -> Result<bool> {
                let sql = format!(
                    "SELECT EXISTS(SELECT 1 FROM {} WHERE {} = ?1);",
                    $table, $col
                );
                Ok(tx.query_row(&sql, rusqlite::params![&self.$id_field], |row| row.get(0))?)
            }
        }
    };
}

impl KeyedRecord for PreferenceRecord {
    fn exists(&self, tx: &Connection, _table: &str, workspace_id: &str) -> Result<bool> {
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM preferences WHERE workspace_id=?1 AND key=?2);",
            rusqlite::params![workspace_id, self.key],
            |row| row.get(0),
        )?)
    }
}

impl KeyedRecord for ProjectRecord {
    fn exists(&self, tx: &Connection, _table: &str, workspace_id: &str) -> Result<bool> {
        let owner: Option<String> = tx
            .query_row(
                "SELECT workspace_id FROM project WHERE id=?1;",
                [&self.id],
                |row| row.get(0),
            )
            .optional()?;
        match owner {
            Some(owner) if owner == workspace_id => Ok(true),
            Some(_) => Err(StoreError::Invalid(
                "An imported project id is owned by another workspace.".into(),
            )),
            None => Ok(false),
        }
    }
}
impl_keyed_str!(ThreadRecord, id, "thread", "id");
impl_keyed_str!(MessageRecord, id, "message", "id");
impl_keyed_str!(RunRecord, id, "run", "id");
impl_keyed_str!(ToolCallRecord, id, "tool_call", "id");
impl_keyed_str!(ApprovalRecord, id, "approval", "id");
impl_keyed_str!(AuditEventRecord, id, "audit_event", "id");
impl KeyedRecord for ArtifactRecord {
    fn exists(&self, tx: &Connection, _table: &str, workspace_id: &str) -> Result<bool> {
        Ok(tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3)",
            rusqlite::params![workspace_id,self.owner_subject,self.id],|row|row.get(0))?)
    }
}
impl KeyedRecord for ConnectorAccountRecord {
    fn exists(&self, tx: &Connection, _table: &str, workspace_id: &str) -> Result<bool> {
        Ok(tx.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM connector_account WHERE workspace_id=?1 AND connector_id=?2
             );",
            rusqlite::params![workspace_id, self.connector_id],
            |row| row.get(0),
        )?)
    }
}
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

fn authorized_workspace_id(
    store: &Store,
    _caller_workspace_id: Option<String>,
) -> std::result::Result<String, String> {
    store
        .with_conn(|conn| {
            crate::store::repos::workspace_directory::require_active_workspace_for_current_user(
                conn,
            )
            .map(|active| active.local_workspace_id)
        })
        .map_err(|error| error.to_string())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableExportReceipt {
    path: String,
    format_version: u32,
    schema_version: u32,
    bytes: u64,
    sha256: String,
    credentials_included: bool,
}

fn write_workspace_archive_file(
    store: &Store,
    workspace_id: &str,
    target: &Path,
) -> std::result::Result<PortableExportReceipt, String> {
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Choose a new .json file for the portable workspace copy.".into());
    }
    if target.exists() {
        return Err("Fable will not overwrite an existing workspace copy.".into());
    }
    let parent = target
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| "Choose an existing folder for the workspace copy.".to_string())?;
    if crate::paths::contains_symlink(parent) {
        return Err("The workspace-copy folder cannot contain links.".into());
    }

    let manifest = export_workspace_for(store, workspace_id).map_err(|error| error.to_string())?;
    let encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| "Fable could not encode the workspace copy.".to_string())?;
    let sha256 = format!("{:x}", Sha256::digest(&encoded));
    let bytes = u64::try_from(encoded.len())
        .map_err(|_| "The workspace copy is too large to save.".to_string())?;

    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Fable could not prepare the workspace-copy file.".to_string())?;
    staged
        .write_all(&encoded)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|_| "Fable could not write the workspace copy.".to_string())?;
    staged.persist_noclobber(target).map_err(|_| {
        "Fable could not save the workspace copy without overwriting a file.".to_string()
    })?;

    Ok(PortableExportReceipt {
        path: target.to_string_lossy().to_string(),
        format_version: manifest.format_version,
        schema_version: manifest.schema_version,
        bytes,
        sha256,
        credentials_included: false,
    })
}

/// Atomically save the active authenticated workspace as a credential-free,
/// plaintext portable archive. The destination must be a new local JSON file.
#[tauri::command]
pub fn export_workspace_archive_to_file(
    destination: String,
    workspace_id: Option<String>,
) -> std::result::Result<PortableExportReceipt, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let workspace_id = authorized_workspace_id(store, workspace_id)?;
    let target = PathBuf::from(destination);
    write_workspace_archive_file(store, &workspace_id, &target)
}

fn read_workspace_archive_file(
    store: &Store,
    workspace_id: &str,
    source: &Path,
    confirmation: &str,
) -> std::result::Result<ImportReport, String> {
    if confirmation != IMPORT_CONFIRMATION {
        return Err("Type “import workspace copy” to confirm.".into());
    }
    if crate::paths::contains_symlink(source) {
        return Err("The workspace-copy file cannot contain links.".into());
    }
    let canonical = source
        .canonicalize()
        .map_err(|_| "Choose an existing workspace-copy file.".to_string())?;
    let metadata = canonical
        .metadata()
        .map_err(|_| "Fable could not inspect the workspace-copy file.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular workspace-copy file.".into());
    }
    if metadata.len() > MAX_PORTABLE_ARCHIVE_BYTES {
        return Err("That workspace copy is too large to import safely.".into());
    }
    if !canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Choose a .json workspace-copy file.".into());
    }
    let manifest_json = std::fs::read_to_string(&canonical)
        .map_err(|_| "Fable could not read that workspace-copy file as JSON.".to_string())?;
    import_workspace_for(
        store,
        workspace_id,
        &manifest_json,
        ImportOptions::default(),
    )
    .map_err(|error| error.to_string())
}

/// Read, validate, and transactionally import a portable workspace copy
/// entirely inside the native boundary. Existing records are never
/// overwritten; imported Connections and schedules remain disabled.
#[tauri::command]
pub fn import_workspace_archive_from_file(
    source: String,
    confirmation: String,
    workspace_id: Option<String>,
) -> std::result::Result<ImportReport, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let workspace_id = authorized_workspace_id(store, workspace_id)?;
    read_workspace_archive_file(store, &workspace_id, &PathBuf::from(source), &confirmation)
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

    #[test]
    fn archive_scope_requires_sign_in_and_ignores_caller_selected_workspace() {
        use crate::store::repos::workspace_directory::{
            clear_current_internal_user, select_active_workspace_for_current_user,
            set_current_internal_user, upsert_authoritative_summary, WorkspaceDirectoryUpsert,
        };

        let store = store();
        assert!(authorized_workspace_id(&store, Some("arbitrary-workspace".into())).is_err());
        let input = WorkspaceDirectoryUpsert {
            internal_user_id: "user-alpha".into(),
            fable_workspace_id: "workspace-alpha".into(),
            name: "Alpha".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: "member-alpha".into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "now".into(),
        };
        let selected = store
            .transaction(|conn| {
                upsert_authoritative_summary(conn, &input)?;
                set_current_internal_user(conn, "user-alpha", "now")?;
                select_active_workspace_for_current_user(conn, "workspace-alpha", "now")
            })
            .unwrap();

        assert_eq!(
            authorized_workspace_id(&store, Some("arbitrary-workspace".into())).unwrap(),
            selected.local_workspace_id
        );
        store
            .transaction(|tx| clear_current_internal_user(tx))
            .unwrap();
        assert!(authorized_workspace_id(&store, None).is_err());
    }

    /// Insert a small but referentially-complete dataset directly via SQL,
    /// decrypting payloads with the store vault. Returns the ids inserted.
    fn seed(store: &Store) {
        // profile
        let sealed = store
            .seal_json_owned(&serde_json::json!({ "name": "Alice" }), "profile:1")
            .unwrap();
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
                // Private artifacts require an authenticated owner and exact
                // immutable versions. The dedicated artifact round-trip test
                // below supplies that authority; this generic fixture does not.
                // connector account WITH credential_ref (must be omitted from export)
                let cap = store.seal_json_owned(&serde_json::json!({"account":{"id":"u"}}), "connector_account:default:github")?;
                tx.execute(
                    "INSERT INTO connector_account (workspace_id, project_id, connector_id, account_id, status, expires_at, credential_ref, connected_at, updated_at, payload, payload_nonce)
                     VALUES ('default',NULL,'github','u','connected',12345,'keyring-opaque-key','t','t',?1,?2);",
                    rusqlite::params![cap.ciphertext, cap.nonce],
                )?;
                // Private Knowledge and Memory require an authenticated owner.
                // This portable fixture intentionally has none, so it must not
                // invent one merely to exercise unrelated archive sections.
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
        assert!(manifest_b.sections.knowledge_sources.is_empty());
        assert!(manifest_b.sections.memory_records.is_empty());
        assert_eq!(manifest_b.sections.schedules.len(), 1);
        assert_eq!(manifest_b.sections.drafts.len(), 1);
    }

    fn bind_local_user(store: &Store) {
        store.transaction(|tx|{
            tx.execute("INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES ('user-local','active',1,'t')",[])?;
            crate::store::repos::workspace_directory::set_current_internal_user(tx,"user-local","t")
        }).unwrap();
    }

    fn bind_member_owner(store: &Store) {
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO fable_workspace_mirror(
                       fable_workspace_id,local_workspace_id,status,revision,policy_revision,updated_at
                     ) VALUES ('shared','default','active',1,1,'t')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO fable_internal_user_mirror(
                       internal_user_id,status,revision,updated_at
                     ) VALUES ('user-a','active',1,'t')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO fable_membership_mirror(
                       fable_workspace_id,member_id,internal_user_id,role,status,revision,updated_at
                     ) VALUES ('shared','member-a','user-a','owner','active',1,'t')",
                    [],
                )?;
                crate::store::repos::workspace_directory::set_current_internal_user(
                    tx, "user-a", "t",
                )?;
                crate::store::repos::workspace_directory::select_active_workspace(
                    tx, "user-a", "shared", "t",
                )
            })
            .unwrap();
    }

    fn seed_portable_routine(store: &Store) {
        let scope = crate::store::repos::scope::DataScope::workspace("default").unwrap();
        let owner = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            scope.clone(),
            "user-a",
            Some("member-a"),
        )
        .unwrap();
        let routine = serde_json::json!({
            "id":"portable-routine","status":"active","title":"Daily brief",
            "currentVersion":1,"scope":{},"authorityPolicy":"no-expansion",
            "workspaceId":"default","authority":"local","schemaVersion":1,"revision":1,
            "visibility":"member-private","ownerMemberId":"member-a",
            "createdByInternalUserId":"user-a","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z"
        });
        let version = serde_json::json!({
            "routineId":"portable-routine","version":1,
            "createdAt":"2026-01-01T00:00:00Z","createdByInternalUserId":"user-a",
            "action":{"kind":"direct-request","title":"Brief","instruction":"Summarize."},
            "scope":{},"routePolicy":{"kind":"resolve-at-run"},
            "placementPolicy":{"kind":"resolve-at-run"},
            "budgets":{"capabilityGrantIds":[]},"triggerIds":["portable-trigger"]
        });
        let trigger = serde_json::json!({
            "id":"portable-trigger","routineId":"portable-routine","status":"active",
            "spec":{"kind":"time-recurring","timezone":"Europe/London",
                "recurrence":{"frequency":"daily","expression":"0 9 * * *"},
                "missedRunPolicy":"run-latest"},
            "deduplication":{"strategy":"per-trigger-event"},
            "workspaceId":"default","authority":"local","schemaVersion":1,"revision":1,
            "visibility":"member-private","ownerMemberId":"member-a",
            "createdByInternalUserId":"user-a","createdAt":"2026-01-01T00:00:00Z",
            "updatedAt":"2026-01-01T00:00:00Z"
        });
        let occurrence = serde_json::json!({
            "id":"portable-occurrence","routineId":"portable-routine",
            "triggerId":"portable-trigger","routineVersion":1,"status":"completed",
            "scheduledFor":"2026-01-02T09:00:00Z","observedAt":"2026-01-02T09:01:00Z",
            "deduplicationKey":"portable-trigger:2026-01-02T09:00:00Z"
        });
        store
            .transaction(|tx| {
                crate::store::repos::routine::create(
                    tx,
                    store,
                    &scope,
                    &owner,
                    "user-a",
                    &routine,
                    &version,
                    &[trigger],
                )?;
                crate::store::repos::routine::append_occurrence(
                    tx,
                    store,
                    &scope,
                    &owner,
                    &occurrence,
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn canonical_routines_round_trip_paused_without_node_authority() {
        let source = store();
        bind_member_owner(&source);
        seed_portable_routine(&source);
        let manifest = export_workspace(&source).unwrap();
        assert_eq!(manifest.sections.routines.len(), 1);
        assert_eq!(manifest.sections.routines[0].versions.len(), 1);
        assert_eq!(manifest.sections.routines[0].occurrences.len(), 1);

        let destination = store();
        bind_member_owner(&destination);
        let json = serde_json::to_string(&manifest).unwrap();
        let report = import_workspace(&destination, &json, ImportOptions::default()).unwrap();
        assert_eq!(report.inserted.get("routines"), Some(&1));
        let status: String = destination
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT status FROM routine_record WHERE id='portable-routine'",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(status, "paused");
        assert_eq!(count(&destination, "routine_version"), 1);
        assert_eq!(count(&destination, "routine_trigger"), 1);
        assert_eq!(count(&destination, "routine_occurrence"), 1);
        assert_eq!(count(&destination, "routine_driver_occurrence"), 0);
        assert_eq!(count(&destination, "routine_trigger_cursor"), 0);
        assert_eq!(count(&destination, "routine_scheduler_authority"), 0);

        let second = import_workspace(&destination, &json, ImportOptions::default()).unwrap();
        assert_eq!(second.skipped.get("routines"), Some(&1));
        assert_eq!(count(&destination, "routine_occurrence"), 1);
    }

    #[test]
    fn portable_routines_reject_owner_substitution_and_incomplete_history() {
        let source = store();
        bind_member_owner(&source);
        seed_portable_routine(&source);
        let manifest = export_workspace(&source).unwrap();

        let destination = store();
        bind_member_owner(&destination);
        let mut substituted = manifest.clone();
        let record = &mut substituted.sections.routines[0];
        record.owner_member_id = "member-b".into();
        record.owner_subject = "member:member-b".into();
        record.routine["ownerMemberId"] = Value::String("member-b".into());
        for trigger in &mut record.triggers {
            trigger["ownerMemberId"] = Value::String("member-b".into());
        }
        let json = serde_json::to_string(&substituted).unwrap();
        assert!(import_workspace(&destination, &json, ImportOptions::default()).is_err());
        assert_eq!(count(&destination, "routine_record"), 0);

        let mut incomplete = manifest;
        incomplete.sections.routines[0].versions.clear();
        let json = serde_json::to_string(&incomplete).unwrap();
        assert!(import_workspace(&destination, &json, ImportOptions::default()).is_err());
        assert_eq!(count(&destination, "routine_record"), 0);
    }

    fn seed_native_artifact_source(store: &Store) {
        store.transaction(|tx|{
            let thread=store.seal_json_owned(&serde_json::json!({}),"thread:artifact-thread")?;
            tx.execute("INSERT INTO thread(id,workspace_id,title,created_at,updated_at,payload,payload_nonce) VALUES ('artifact-thread','default','T','t','t',?1,?2)",rusqlite::params![thread.ciphertext,thread.nonce])?;
            let run=store.seal_json_owned(&serde_json::json!({}),"run:artifact-run")?;
            tx.execute("INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,created_at,updated_at,payload,payload_nonce) VALUES ('artifact-run','default','artifact-thread','p','m','completed','t','t',?1,?2)",rusqlite::params![run.ciphertext,run.nonce])?;
            let message=store.seal_json_owned(&serde_json::json!({}),"message:artifact-message")?;
            let revision=store.seal_json_owned(&serde_json::json!("One"),"message-revision:default:artifact-revision")?;
            tx.execute("INSERT INTO message(id,workspace_id,thread_id,kind,run_id,seq,idempotency_key,current_revision_id,current_revision_state,created_at,payload,payload_nonce) VALUES ('artifact-message','default','artifact-thread','assistant','artifact-run',1,'artifact-message','artifact-revision','terminal','t',?1,?2)",rusqlite::params![message.ciphertext,message.nonce])?;
            tx.execute("INSERT INTO message_revision(id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,run_id,created_at,payload,payload_nonce) VALUES ('artifact-revision','default','artifact-thread','artifact-message',1,0,'terminal','initial','artifact-revision','t','artifact-run','t',?1,?2)",rusqlite::params![revision.ciphertext,revision.nonce])?;
            Ok(())
        }).unwrap();
    }

    #[test]
    fn projectless_artifact_exports_all_versions_and_round_trips_for_exact_owner() {
        let source = store();
        bind_local_user(&source);
        seed_native_artifact_source(&source);
        source.transaction(|tx|{
            let run_provenance=serde_json::json!({"kind":"run","runId":"artifact-run","observedAt":"t"});
            let artifact_payload=serde_json::json!({"id":"artifact-1","workspaceId":"default","authority":"local","visibility":"member-private","ownerInternalUserId":"user-local","schemaVersion":1,"revision":2,"createdByInternalUserId":"user-local","createdAt":"t","updatedAt":"t2","kind":"document","status":"draft","title":"Artifact","currentVersionId":"artifact-1:v2","producingRunId":"artifact-run","sourceProvenance":[run_provenance],"context":{"threadId":"artifact-thread"},"reviews":[],"retention":{"status":"active"}});
            let artifact=source.seal_json_owned(&artifact_payload,"artifact:default:user:user-local:artifact-1")?;
            let title_hash=format!("{:x}",Sha256::digest(b"Artifact"));
            let current_hash=format!("{:x}",Sha256::digest(b"Two"));
            tx.execute("INSERT INTO artifact(workspace_id,owner_subject,authority,visibility,owner_internal_user_id,id,run_id,thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce) VALUES ('default','user:user-local','local','member-private','user-local','artifact-1','artifact-run','artifact-thread','artifact-message','document','draft',2,'artifact-1:v2',?1,?2,3,'t','t2',?3,?4)",rusqlite::params![title_hash,current_hash,artifact.ciphertext,artifact.nonce])?;
            for (id,version,text) in [("artifact-1:v1",1,"One"),("artifact-1:v2",2,"Two")] {
                let hash=format!("{:x}",Sha256::digest(text.as_bytes()));
                let media=serde_json::json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
                let content_hash=serde_json::json!({"algorithm":"sha-256","value":hash});
                let (created,provenance,lineage)=if version==1 {("t",run_provenance.clone(),serde_json::json!([]))} else {("t2",serde_json::json!({"kind":"artifact-version","sourceArtifactVersionId":"artifact-1:v1","observedAt":"t2"}),serde_json::json!([{"relation":"supersedes","artifactId":"artifact-1","artifactVersionId":"artifact-1:v1","recordedAt":"t2"}]))};
                let payload=serde_json::json!({"id":id,"artifactId":"artifact-1","version":version,"status":"available","createdAt":created,"createdByInternalUserId":"user-local","content":{"kind":"inline","text":text,"media":media,"contentHash":content_hash},"media":media,"contentHash":content_hash,"provenance":provenance,"citations":[],"inputs":[],"decisions":[],"lineage":lineage});
                let sealed=source.seal_json_owned(&payload,&format!("artifact_version:default:user:user-local:artifact-1:{id}"))?;
                tx.execute("INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce) VALUES ('default','user:user-local','artifact-1',?1,?2,'available',?3,3,?4,?5,?6)",rusqlite::params![id,version,hash,created,sealed.ciphertext,sealed.nonce])?;
            }
            Ok(())
        }).unwrap();
        let scope = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            crate::store::repos::scope::DataScope::workspace("default").unwrap(),
            "user-local",
            None,
        )
        .unwrap();
        source
            .transaction(|tx| {
                crate::store::repos::artifact::review_action(
                    tx,
                    &source,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    2,
                    "request-review",
                    "user-local",
                    Some("Please review"),
                    &[],
                    "2026-07-11T01:00:00Z",
                )?;
                crate::store::repos::artifact::review_action(
                    tx,
                    &source,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    3,
                    "request-changes",
                    "user-local",
                    Some("Needs one change"),
                    &["Clarify the result".into()],
                    "2026-07-11T01:01:00Z",
                )?;
                let hash = format!("{:x}", Sha256::digest(b"Three"));
                let media = serde_json::json!({"mediaType":"text/markdown","byteLength":5,"encoding":"utf-8"});
                let content_hash = serde_json::json!({"algorithm":"sha-256","value":hash});
                let artifact_payload=serde_json::json!({"id":"artifact-1","workspaceId":"default","authority":"local","visibility":"member-private","ownerInternalUserId":"user-local","schemaVersion":1,"revision":5,"createdByInternalUserId":"user-local","createdAt":"t","updatedAt":"2026-07-11T01:02:00Z","kind":"document","status":"draft","title":"Artifact","currentVersionId":"artifact-1:v3","producingRunId":"artifact-run","sourceProvenance":[{"kind":"run","runId":"artifact-run","observedAt":"t"}],"context":{"threadId":"artifact-thread"},"reviews":[],"retention":{"status":"active"}});
                let version_payload=serde_json::json!({"id":"artifact-1:v3","artifactId":"artifact-1","version":3,"status":"available","createdAt":"2026-07-11T01:02:00Z","createdByInternalUserId":"user-local","content":{"kind":"inline","text":"Three","media":media,"contentHash":content_hash},"media":media,"contentHash":content_hash,"provenance":{"kind":"artifact-version","sourceArtifactVersionId":"artifact-1:v2","observedAt":"2026-07-11T01:02:00Z"},"citations":[],"inputs":[],"decisions":[],"lineage":[{"relation":"supersedes","artifactId":"artifact-1","artifactVersionId":"artifact-1:v2","recordedAt":"2026-07-11T01:02:00Z"}]});
                crate::store::repos::artifact::append_version(
                    tx,
                    &source,
                    &scope,
                    "artifact-1",
                    4,
                    "artifact-1:v2",
                    &format!("{:x}", Sha256::digest(b"Artifact")),
                    &hash,
                    5,
                    "2026-07-11T01:02:00Z",
                    &artifact_payload,
                    &version_payload,
                )?;
                crate::store::repos::artifact::review_action(
                    tx,
                    &source,
                    &scope,
                    "artifact-1",
                    "artifact-1:v3",
                    5,
                    "request-review",
                    "user-local",
                    None,
                    &[],
                    "2026-07-11T01:03:00Z",
                )?;
                crate::store::repos::artifact::review_action(
                    tx,
                    &source,
                    &scope,
                    "artifact-1",
                    "artifact-1:v3",
                    6,
                    "accept",
                    "user-local",
                    Some("Approved"),
                    &[],
                    "2026-07-11T01:04:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        let manifest = export_workspace(&source).unwrap();
        assert_eq!(manifest.sections.artifacts.len(), 1);
        assert_eq!(manifest.sections.artifacts[0].versions.len(), 3);
        assert_eq!(manifest.sections.artifacts[0].reviews.len(), 2);
        assert_eq!(
            manifest.sections.artifacts[0].reviews[0].status,
            "changes-requested"
        );
        assert_eq!(manifest.sections.artifacts[0].reviews[1].status, "approved");
        assert_eq!(
            manifest.sections.artifacts[0].payload["reviews"],
            serde_json::json!([])
        );
        assert_eq!(
            manifest.sections.artifacts[0].thread_id.as_deref(),
            Some("artifact-thread")
        );
        let json = serde_json::to_string(&manifest).unwrap();
        let directory = tempfile::TempDir::new().unwrap();
        let database = directory.path().join("portable-review.db");
        let vault = Vault::new(&MasterKey::generate().unwrap()).unwrap();
        let destination = Store::open(&database, vault.clone()).unwrap();
        bind_local_user(&destination);
        seed_native_artifact_source(&destination);
        import_workspace(&destination, &json, ImportOptions::default()).unwrap();
        let roundtrip = export_workspace(&destination).unwrap();
        assert_eq!(roundtrip.sections.artifacts[0].versions.len(), 3);
        assert_eq!(roundtrip.sections.artifacts[0].reviews.len(), 2);
        assert_eq!(
            roundtrip.sections.artifacts[0].current_version_id,
            "artifact-1:v3"
        );
        drop(destination);
        let reopened = Store::open(&database, vault).unwrap();
        let restored = reopened
            .transaction(|tx| {
                crate::store::repos::artifact::get_bundle(tx, &reopened, &scope, "artifact-1")
            })
            .unwrap()
            .unwrap();
        assert_eq!(restored["artifact"]["status"], "accepted");
        assert_eq!(restored["artifact"]["reviews"].as_array().unwrap().len(), 2);

        let rejects = |bad: Manifest| {
            let target = store();
            bind_local_user(&target);
            seed_native_artifact_source(&target);
            let encoded = serde_json::to_string(&bad).unwrap();
            assert!(import_workspace(&target, &encoded, ImportOptions::default()).is_err());
        };
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].owner_internal_user_id = Some("attacker".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].current_version_id = "artifact-1:forged".into();
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].versions[0].payload["id"] = Value::String("wrong-version".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].versions[1].content_fingerprint = "forged-hash".into();
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].versions[0].payload["citations"] = serde_json::json!([{
            "id":"forged","source":{"kind":"run","runId":"artifact-run"}
        }]);
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].versions[0].payload["decisions"] = serde_json::json!([{
            "id":"forged","kind":"approval","summary":"Forged","decidedAt":"t","approvalId":"missing"
        }]);
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].thread_id = Some("foreign-thread".into());
        bad.sections.artifacts[0].payload["context"]["threadId"] =
            Value::String("foreign-thread".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].source_message_id = Some("foreign-message".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].reviews[0].requested_by_internal_user_id = "attacker".into();
        bad.sections.artifacts[0].reviews[0].payload["requestedByInternalUserId"] =
            Value::String("attacker".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].reviews[1].payload["acceptance"]["acceptedByInternalUserId"] =
            Value::String("attacker".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].reviews[0].version_id = "artifact-1:foreign".into();
        bad.sections.artifacts[0].reviews[0].payload["versionId"] =
            Value::String("artifact-1:foreign".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].reviews[0].status = "rejected".into();
        bad.sections.artifacts[0].reviews[0].payload["status"] = Value::String("rejected".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].reviews[0].reviewer_member_id = Some("foreign-member".into());
        bad.sections.artifacts[0].reviews[0].payload["reviewerMemberId"] =
            Value::String("foreign-member".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].status = "draft".into();
        bad.sections.artifacts[0].payload["status"] = Value::String("draft".into());
        rejects(bad);
        let mut bad = manifest.clone();
        bad.sections.artifacts[0].status = "in-review".into();
        bad.sections.artifacts[0].revision = 9;
        bad.sections.artifacts[0].payload["status"] = Value::String("in-review".into());
        bad.sections.artifacts[0].payload["revision"] = serde_json::json!(9);
        for (id, requested_at) in [
            ("review:artifact-1:forged-1", "2026-07-11T01:05:00Z"),
            ("review:artifact-1:forged-2", "2026-07-11T01:06:00Z"),
        ] {
            bad.sections.artifacts[0].reviews.push(ArtifactReviewRecord {
                id: id.into(),
                artifact_id: "artifact-1".into(),
                version_id: "artifact-1:v3".into(),
                status: "requested".into(),
                requested_by_internal_user_id: "user-local".into(),
                reviewer_member_id: None,
                requested_at: requested_at.into(),
                resolved_at: None,
                payload: serde_json::json!({"id":id,"status":"requested","requestedByInternalUserId":"user-local","versionId":"artifact-1:v3","requestedAt":requested_at}),
            });
        }
        rejects(bad);
    }

    #[test]
    fn artifact_export_is_exactly_active_member_private() {
        let store = store();
        store.transaction(|tx|{
            tx.execute("INSERT INTO fable_workspace_mirror(fable_workspace_id,local_workspace_id,status,revision,policy_revision,updated_at) VALUES ('shared','default','active',1,1,'t')",[])?;
            for (user,member) in [("user-a","member-a"),("user-b","member-b")] {
                tx.execute("INSERT INTO fable_internal_user_mirror(internal_user_id,status,revision,updated_at) VALUES (?1,'active',1,'t')",[user])?;
                tx.execute("INSERT INTO fable_membership_mirror(fable_workspace_id,member_id,internal_user_id,role,status,revision,updated_at) VALUES ('shared',?1,?2,'member','active',1,'t')",rusqlite::params![member,user])?;
            }
            for (id,member,marker) in [("artifact-a","member-a","A PRIVATE"),("artifact-b","member-b","B PRIVATE")] {
                let subject=format!("member:{member}");let version_id=format!("{id}:v1");
                let artifact=store.seal_json_owned(&serde_json::json!({"id":id,"title":marker}),&format!("artifact:default:{subject}:{id}"))?;
                tx.execute("INSERT INTO artifact(workspace_id,owner_subject,authority,visibility,owner_member_id,id,kind,status,revision,current_version_id,title_fingerprint,content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce) VALUES ('default',?1,'local','member-private',?2,?3,'document','draft',1,?4,'title','hash',1,'t','t',?5,?6)",rusqlite::params![subject,member,id,version_id,artifact.ciphertext,artifact.nonce])?;
                let version=store.seal_json_owned(&serde_json::json!({"id":version_id,"artifactId":id,"version":1,"marker":marker}),&format!("artifact_version:default:{subject}:{id}:{version_id}"))?;
                tx.execute("INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce) VALUES ('default',?1,?2,?3,1,'available','hash',1,'t',?4,?5)",rusqlite::params![subject,id,version_id,version.ciphertext,version.nonce])?;
            }
            crate::store::repos::workspace_directory::set_current_internal_user(tx,"user-a","t")?;
            crate::store::repos::workspace_directory::select_active_workspace(tx,"user-a","shared","t")?;
            Ok(())
        }).unwrap();
        let alpha = export_workspace(&store).unwrap();
        let alpha_json = serde_json::to_string(&alpha.sections.artifacts).unwrap();
        assert_eq!(alpha.sections.artifacts.len(), 1);
        assert!(alpha_json.contains("A PRIVATE"));
        assert!(!alpha_json.contains("B PRIVATE"));
        store
            .transaction(|tx| {
                crate::store::repos::workspace_directory::set_current_internal_user(
                    tx, "user-b", "t2",
                )?;
                crate::store::repos::workspace_directory::select_active_workspace(
                    tx, "user-b", "shared", "t2",
                )
            })
            .unwrap();
        let beta = export_workspace(&store).unwrap();
        let beta_json = serde_json::to_string(&beta.sections.artifacts).unwrap();
        assert_eq!(beta.sections.artifacts.len(), 1);
        assert!(beta_json.contains("B PRIVATE"));
        assert!(!beta_json.contains("A PRIVATE"));
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
                conn.query_row("SELECT enabled FROM schedule WHERE id='s1';", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(enabled, 0, "imported schedule must be disabled");
    }

    #[test]
    fn connector_cache_does_not_leak_into_export() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        // insert a connector_cache row directly (the excluded table)
        let sealed = store
            .seal_json_owned(&serde_json::json!({}), "connector_cache:x")
            .unwrap();
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
    fn cloud_sync_state_does_not_leak_into_export_or_import() {
        let a =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        a.transaction(|tx| {
            tx.execute(
                "INSERT INTO fable_internal_user_mirror
                   (internal_user_id,status,revision,updated_at)
                 VALUES ('user-a','active',7,'t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO fable_workspace_mirror
                   (fable_workspace_id,local_workspace_id,status,revision,policy_revision,updated_at)
                 VALUES ('cloud-ws-secret','default','active',7,0,'t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO fable_membership_mirror
                   (fable_workspace_id,member_id,internal_user_id,role,status,revision,updated_at)
                 VALUES ('cloud-ws-secret','member-a','user-a','owner','active',7,'t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO fable_device_mirror
                   (device_id,internal_user_id,status,revision,updated_at)
                 VALUES ('device-a','user-a','active',7,'t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO fable_workspace_device_mirror
                   (fable_workspace_id,device_id,member_id,status,revision,updated_at)
                 VALUES ('cloud-ws-secret','device-a','member-a','active',7,'t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO cloud_workspace_link (
                   local_workspace_id, fable_workspace_id, internal_user_id, member_id,
                   device_id, role, sync_state, last_accepted_revision, linked_at, updated_at
                 ) VALUES ('default','cloud-ws-secret','user-a','member-a','device-a','owner','active',7,'t','t');",
                [],
            )?;
            tx.execute(
                "INSERT INTO cloud_sync_cursor (
                   local_workspace_id, fable_workspace_id, device_id, last_pulled_revision,
                   last_realtime_sequence, last_successful_sync_at
                 ) VALUES ('default','cloud-ws-secret','device-a',7,1,'t');",
                [],
            )?;
            let sealed = a.seal_json_owned(&serde_json::json!({"name":"Shared"}), "cloud_mutation_outbox:m1")?;
            tx.execute(
                "INSERT INTO cloud_mutation_outbox (
                   local_mutation_id, idempotency_key, local_workspace_id,
                   fable_workspace_id, internal_user_id, member_id, device_id, client_mutation_id, base_revision,
                   record_type, record_id, operation, status, attempt_count,
                   created_at, updated_at, payload, payload_nonce
                 ) VALUES ('m1','cloud-ws-secret:device-a:c1','default','cloud-ws-secret',
                   'user-a','member-a','device-a','c1',7,'project','p1','update','pending',0,'t','t',?1,?2);",
                rusqlite::params![sealed.ciphertext, sealed.nonce],
            )?;
            Ok(())
        })
        .unwrap();

        let manifest = export_workspace(&a).unwrap();
        let sections_json = serde_json::to_string(&manifest.sections).unwrap();
        assert!(!sections_json.contains("cloud-ws-secret"));
        assert!(!sections_json.contains("cloudWorkspaceId"));
        assert!(!sections_json.contains("idempotencyKey"));

        let b =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let json = serde_json::to_string(&manifest).unwrap();
        import_workspace(&b, &json, ImportOptions::default()).unwrap();
        for table in [
            "fable_internal_user_mirror",
            "fable_workspace_mirror",
            "fable_membership_mirror",
            "fable_device_mirror",
            "fable_workspace_device_mirror",
            "cloud_workspace_link",
            "cloud_sync_cursor",
            "cloud_mutation_outbox",
            "cloud_record_shadow",
            "cloud_conflict",
            "cloud_record_tombstone",
        ] {
            assert_eq!(count(&b, table), 0, "{table} must not import cloud state");
        }
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
    fn portable_file_export_is_atomic_non_overwriting_and_credential_free() {
        let store = store();
        seed(&store);
        let directory = tempfile::TempDir::new().unwrap();
        let target = directory.path().join("workspace-copy.json");

        let receipt = write_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &target,
        )
        .unwrap();
        let bytes = std::fs::read(&target).unwrap();
        let manifest: Manifest = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(receipt.path, target.to_string_lossy());
        assert_eq!(receipt.format_version, PORTABLE_FORMAT_VERSION);
        assert_eq!(receipt.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(receipt.bytes, bytes.len() as u64);
        assert_eq!(receipt.sha256, format!("{:x}", Sha256::digest(&bytes)));
        assert!(!receipt.credentials_included);
        assert!(!manifest.credentials_included);
        assert!(serde_json::to_string(&manifest)
            .unwrap()
            .contains("\"credentialsIncluded\":false"));
        assert!(write_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &target,
        )
        .unwrap_err()
        .contains("will not overwrite"));
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn portable_file_export_requires_a_json_target_in_an_existing_folder() {
        let store = store();
        let directory = tempfile::TempDir::new().unwrap();
        assert!(write_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &directory.path().join("workspace-copy.txt"),
        )
        .unwrap_err()
        .contains(".json"));
        assert!(write_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &directory.path().join("missing").join("workspace-copy.json"),
        )
        .unwrap_err()
        .contains("existing folder"));
        assert!(write_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &directory.path().join("workspace-copy.JSON"),
        )
        .is_ok());
    }

    #[test]
    fn portable_file_import_is_confirmed_bounded_and_transactional() {
        let source_store = store();
        seed(&source_store);
        let destination_store = store();
        let directory = tempfile::TempDir::new().unwrap();
        let source = directory.path().join("workspace-copy.json");
        write_workspace_archive_file(
            &source_store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &source,
        )
        .unwrap();

        assert!(read_workspace_archive_file(
            &destination_store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &source,
            "anything else",
        )
        .unwrap_err()
        .contains(IMPORT_CONFIRMATION));
        assert_eq!(count(&destination_store, "project"), 0);

        let report = read_workspace_archive_file(
            &destination_store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &source,
            IMPORT_CONFIRMATION,
        )
        .unwrap();
        assert!(report.errors.is_empty());
        assert_eq!(count(&destination_store, "project"), 1);
        assert_eq!(count(&destination_store, "schedule"), 1);
        let schedule_enabled: i64 = destination_store
            .with_conn(|conn| {
                conn.query_row("SELECT enabled FROM schedule LIMIT 1;", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(schedule_enabled, 0);
    }

    #[test]
    fn portable_file_import_rejects_non_json_and_oversized_files() {
        let store = store();
        let directory = tempfile::TempDir::new().unwrap();
        let wrong_extension = directory.path().join("workspace-copy.txt");
        std::fs::write(&wrong_extension, "{}").unwrap();
        assert!(read_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &wrong_extension,
            IMPORT_CONFIRMATION,
        )
        .unwrap_err()
        .contains(".json"));

        let oversized = directory.path().join("oversized.json");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_PORTABLE_ARCHIVE_BYTES + 1).unwrap();
        assert!(read_workspace_archive_file(
            &store,
            crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            &oversized,
            IMPORT_CONFIRMATION,
        )
        .unwrap_err()
        .contains("too large"));
    }

    #[test]
    fn portable_format_version_command_returns_current() {
        assert_eq!(portable_format_version(), PORTABLE_FORMAT_VERSION);
    }
}
