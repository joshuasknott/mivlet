//! Local encrypted cloud-team sync skeleton.
//!
//! Convex is the shared workspace authority. These tables hold only local link
//! metadata, cursors, encrypted pending mutations, shadows, and conflicts so
//! the desktop can stay local-first and retry idempotently.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

pub const ROLES: &[&str] = &["owner", "admin", "editor", "viewer"];
pub const LINK_STATES: &[&str] = &["active", "stale", "revoked", "disabled"];
pub const OUTBOX_STATUSES: &[&str] = &["queued", "flushing", "accepted", "rejected", "conflict"];
pub const OPERATIONS: &[&str] = &["create", "update", "delete"];
pub const ALLOWED_RECORD_TYPES: &[&str] = &["project"];
pub const DENIED_RECORD_TYPES: &[&str] = &[
    "credential",
    "connectorCredential",
    "oauthToken",
    "refreshToken",
    "pkceState",
    "approvalPermit",
    "rawConnectorResponse",
    "privateAuditInternal",
    "localModelPrompt",
    "localModelResponse",
    "privateKnowledge",
    "schedulerQueue",
    "workflowExecutionPermit",
];

const SECRET_MARKERS: &[&str] = &[
    "access_token",
    "refresh_token",
    "oauth_token",
    "authorization",
    "bearer ",
    "client_secret",
    "pkce",
    "approval_permit",
    "permit_token",
    "prompt",
    "response",
    "raw_connector_response",
    "credential",
    "password",
    "secret",
    "ghp_",
    "github_pat_",
    "xoxb-",
    "ya29.",
    "1//",
    "sk-",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspaceLink {
    pub local_workspace_id: String,
    pub cloud_workspace_id: String,
    pub clerk_org_id: String,
    pub role: String,
    pub sync_state: String,
    pub linked_device_id: String,
    pub last_accepted_revision: i64,
    pub linked_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncCursor {
    pub local_workspace_id: String,
    pub device_id: String,
    pub last_pulled_revision: i64,
    pub last_realtime_sequence: i64,
    pub last_successful_sync_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMutationOutboxRow {
    pub local_mutation_id: String,
    pub idempotency_key: String,
    pub local_workspace_id: String,
    pub cloud_workspace_id: String,
    pub device_id: String,
    pub client_mutation_id: String,
    pub base_revision: i64,
    pub record_type: String,
    pub record_id: String,
    pub operation: String,
    pub status: String,
    pub attempt_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkWorkspaceInput {
    pub local_workspace_id: String,
    pub cloud_workspace_id: String,
    pub clerk_org_id: String,
    pub role: String,
    pub sync_state: String,
    pub linked_device_id: String,
    pub last_accepted_revision: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnqueueMutationInput {
    pub local_workspace_id: String,
    pub local_mutation_id: String,
    pub client_mutation_id: String,
    pub base_revision: i64,
    pub record_type: String,
    pub record_id: String,
    pub operation: String,
    pub payload: Value,
}

pub fn upsert_link(conn: &Connection, input: &LinkWorkspaceInput, now: &str) -> Result<()> {
    validate_workspace_id(&input.local_workspace_id)?;
    validate_id(&input.cloud_workspace_id, "Cloud workspace")?;
    validate_id(&input.clerk_org_id, "Clerk organization")?;
    validate_id(&input.linked_device_id, "Cloud device")?;
    if !ROLES.contains(&input.role.as_str()) {
        return Err(StoreError::Invalid(
            "Cloud workspace role is not recognized.".into(),
        ));
    }
    if !LINK_STATES.contains(&input.sync_state.as_str()) {
        return Err(StoreError::Invalid(
            "Cloud workspace sync state is not recognized.".into(),
        ));
    }
    if input.last_accepted_revision < 0 {
        return Err(StoreError::Invalid(
            "Cloud workspace revision cannot be negative.".into(),
        ));
    }
    conn.execute(
        "INSERT INTO cloud_workspace_link (
           local_workspace_id, cloud_workspace_id, clerk_org_id, role, sync_state,
           linked_device_id, last_accepted_revision, linked_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT(local_workspace_id) DO UPDATE SET
           cloud_workspace_id=excluded.cloud_workspace_id,
           clerk_org_id=excluded.clerk_org_id,
           role=excluded.role,
           sync_state=excluded.sync_state,
           linked_device_id=excluded.linked_device_id,
           last_accepted_revision=excluded.last_accepted_revision,
           updated_at=excluded.updated_at;",
        rusqlite::params![
            input.local_workspace_id,
            input.cloud_workspace_id,
            input.clerk_org_id,
            input.role,
            input.sync_state,
            input.linked_device_id,
            input.last_accepted_revision,
            now,
        ],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO cloud_sync_cursor (
           local_workspace_id, device_id, last_pulled_revision,
           last_realtime_sequence, last_successful_sync_at
         ) VALUES (?1, ?2, ?3, 0, '');",
        rusqlite::params![
            input.local_workspace_id,
            input.linked_device_id,
            input.last_accepted_revision
        ],
    )?;
    Ok(())
}

pub fn get_link(conn: &Connection, local_workspace_id: &str) -> Result<Option<CloudWorkspaceLink>> {
    validate_workspace_id(local_workspace_id)?;
    conn.query_row(
        "SELECT local_workspace_id, cloud_workspace_id, clerk_org_id, role,
                sync_state, linked_device_id, last_accepted_revision, linked_at, updated_at
         FROM cloud_workspace_link WHERE local_workspace_id=?1;",
        [local_workspace_id],
        read_link,
    )
    .optional()
    .map_err(Into::into)
}

pub fn get_cursor(
    conn: &Connection,
    local_workspace_id: &str,
    device_id: &str,
) -> Result<Option<CloudSyncCursor>> {
    validate_workspace_id(local_workspace_id)?;
    validate_id(device_id, "Cloud device")?;
    conn.query_row(
        "SELECT local_workspace_id, device_id, last_pulled_revision,
                last_realtime_sequence, last_successful_sync_at
         FROM cloud_sync_cursor WHERE local_workspace_id=?1 AND device_id=?2;",
        rusqlite::params![local_workspace_id, device_id],
        |row| {
            Ok(CloudSyncCursor {
                local_workspace_id: row.get(0)?,
                device_id: row.get(1)?,
                last_pulled_revision: row.get(2)?,
                last_realtime_sequence: row.get(3)?,
                last_successful_sync_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn enqueue_mutation(
    conn: &Connection,
    store: &Store,
    input: &EnqueueMutationInput,
    now: &str,
) -> Result<CloudMutationOutboxRow> {
    validate_workspace_id(&input.local_workspace_id)?;
    validate_id(&input.local_mutation_id, "Local mutation")?;
    validate_id(&input.client_mutation_id, "Client mutation")?;
    validate_id(&input.record_id, "Cloud record")?;
    if input.base_revision < 0 {
        return Err(StoreError::Invalid(
            "Base revision cannot be negative.".into(),
        ));
    }
    validate_sync_record(&input.record_type, &input.payload)?;
    if !OPERATIONS.contains(&input.operation.as_str()) {
        return Err(StoreError::Invalid(
            "Cloud sync operation is not recognized.".into(),
        ));
    }
    let link = get_link(conn, &input.local_workspace_id)?.ok_or_else(|| {
        StoreError::Invalid("Local workspace is not linked to a shared cloud workspace.".into())
    })?;
    if link.sync_state != "active" {
        return Err(StoreError::Invalid(
            "Cloud workspace link is not active; queued writes cannot be flushed.".into(),
        ));
    }
    if link.role == "viewer" {
        return Err(StoreError::Invalid(
            "Viewer members cannot queue shared workspace writes.".into(),
        ));
    }
    let idempotency_key = format!(
        "{}:{}:{}",
        link.cloud_workspace_id, link.linked_device_id, input.client_mutation_id
    );
    let sealed = seal_json(store, &input.payload, &outbox_aad(&input.local_mutation_id))?;
    conn.execute(
        "INSERT OR IGNORE INTO cloud_mutation_outbox (
           local_mutation_id, idempotency_key, local_workspace_id, cloud_workspace_id,
           device_id, client_mutation_id, base_revision, record_type, record_id,
           operation, status, attempt_count, created_at, updated_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', 0, ?11, ?11, ?12, ?13);",
        rusqlite::params![
            input.local_mutation_id,
            idempotency_key,
            input.local_workspace_id,
            link.cloud_workspace_id,
            link.linked_device_id,
            input.client_mutation_id,
            input.base_revision,
            input.record_type,
            input.record_id,
            input.operation,
            now,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    get_outbox(conn, store, &input.local_mutation_id)?
        .ok_or_else(|| StoreError::Invalid("Cloud mutation outbox row could not be read.".into()))
}

pub fn get_outbox(
    conn: &Connection,
    store: &Store,
    local_mutation_id: &str,
) -> Result<Option<CloudMutationOutboxRow>> {
    validate_id(local_mutation_id, "Local mutation")?;
    let partial = conn
        .query_row(
            "SELECT local_mutation_id, idempotency_key, local_workspace_id,
                    cloud_workspace_id, device_id, client_mutation_id,
                    base_revision, record_type, record_id, operation, status,
                    attempt_count, created_at, updated_at, payload, payload_nonce
             FROM cloud_mutation_outbox WHERE local_mutation_id=?1;",
            [local_mutation_id],
            read_outbox_partial,
        )
        .optional()?;
    partial
        .map(|row| {
            let payload = open_json(store, &row.sealed, &outbox_aad(&row.local_mutation_id))?;
            Ok(CloudMutationOutboxRow {
                local_mutation_id: row.local_mutation_id,
                idempotency_key: row.idempotency_key,
                local_workspace_id: row.local_workspace_id,
                cloud_workspace_id: row.cloud_workspace_id,
                device_id: row.device_id,
                client_mutation_id: row.client_mutation_id,
                base_revision: row.base_revision,
                record_type: row.record_type,
                record_id: row.record_id,
                operation: row.operation,
                status: row.status,
                attempt_count: row.attempt_count,
                created_at: row.created_at,
                updated_at: row.updated_at,
                payload,
            })
        })
        .transpose()
}

pub fn list_queued(
    conn: &Connection,
    store: &Store,
    local_workspace_id: &str,
) -> Result<Vec<CloudMutationOutboxRow>> {
    validate_workspace_id(local_workspace_id)?;
    let mut stmt = conn.prepare(
        "SELECT local_mutation_id, idempotency_key, local_workspace_id,
                cloud_workspace_id, device_id, client_mutation_id,
                base_revision, record_type, record_id, operation, status,
                attempt_count, created_at, updated_at, payload, payload_nonce
         FROM cloud_mutation_outbox
         WHERE local_workspace_id=?1 AND status='queued'
         ORDER BY created_at, local_mutation_id;",
    )?;
    let partials = stmt
        .query_map([local_workspace_id], read_outbox_partial)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    partials
        .into_iter()
        .map(|row| {
            let payload = open_json(store, &row.sealed, &outbox_aad(&row.local_mutation_id))?;
            Ok(CloudMutationOutboxRow {
                local_mutation_id: row.local_mutation_id,
                idempotency_key: row.idempotency_key,
                local_workspace_id: row.local_workspace_id,
                cloud_workspace_id: row.cloud_workspace_id,
                device_id: row.device_id,
                client_mutation_id: row.client_mutation_id,
                base_revision: row.base_revision,
                record_type: row.record_type,
                record_id: row.record_id,
                operation: row.operation,
                status: row.status,
                attempt_count: row.attempt_count,
                created_at: row.created_at,
                updated_at: row.updated_at,
                payload,
            })
        })
        .collect()
}

pub fn validate_sync_record(record_type: &str, payload: &Value) -> Result<()> {
    if DENIED_RECORD_TYPES.contains(&record_type) || !ALLOWED_RECORD_TYPES.contains(&record_type) {
        return Err(StoreError::Invalid(
            "This record class is not allowed to leave the device through cloud sync.".into(),
        ));
    }
    if value_contains_denied_marker(payload) {
        return Err(StoreError::Invalid(
            "Cloud sync payload contains private or credential-shaped data.".into(),
        ));
    }
    Ok(())
}

fn read_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudWorkspaceLink> {
    Ok(CloudWorkspaceLink {
        local_workspace_id: row.get(0)?,
        cloud_workspace_id: row.get(1)?,
        clerk_org_id: row.get(2)?,
        role: row.get(3)?,
        sync_state: row.get(4)?,
        linked_device_id: row.get(5)?,
        last_accepted_revision: row.get(6)?,
        linked_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

struct OutboxPartial {
    local_mutation_id: String,
    idempotency_key: String,
    local_workspace_id: String,
    cloud_workspace_id: String,
    device_id: String,
    client_mutation_id: String,
    base_revision: i64,
    record_type: String,
    record_id: String,
    operation: String,
    status: String,
    attempt_count: i64,
    created_at: String,
    updated_at: String,
    sealed: Sealed,
}

fn read_outbox_partial(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutboxPartial> {
    Ok(OutboxPartial {
        local_mutation_id: row.get(0)?,
        idempotency_key: row.get(1)?,
        local_workspace_id: row.get(2)?,
        cloud_workspace_id: row.get(3)?,
        device_id: row.get(4)?,
        client_mutation_id: row.get(5)?,
        base_revision: row.get(6)?,
        record_type: row.get(7)?,
        record_id: row.get(8)?,
        operation: row.get(9)?,
        status: row.get(10)?,
        attempt_count: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        sealed: Sealed {
            ciphertext: row.get(14)?,
            nonce: row.get(15)?,
        },
    })
}

fn validate_workspace_id(value: &str) -> Result<()> {
    validate_id(value, "Workspace")
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || !trimmed.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
    {
        return Err(StoreError::Invalid(format!("{label} id is invalid.")));
    }
    Ok(())
}

fn value_contains_denied_marker(value: &Value) -> bool {
    match value {
        Value::String(text) => looks_denied(text),
        Value::Array(items) => items.iter().any(value_contains_denied_marker),
        Value::Object(map) => map
            .iter()
            .any(|(key, value)| looks_denied(key) || value_contains_denied_marker(value)),
        _ => false,
    }
}

fn looks_denied(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    SECRET_MARKERS.iter().any(|marker| lower.contains(marker))
}

fn outbox_aad(local_mutation_id: &str) -> String {
    format!("cloud_mutation_outbox:{local_mutation_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn link() -> LinkWorkspaceInput {
        LinkWorkspaceInput {
            local_workspace_id: "default".into(),
            cloud_workspace_id: "cloud-ws".into(),
            clerk_org_id: "org-a".into(),
            role: "editor".into(),
            sync_state: "active".into(),
            linked_device_id: "device-a".into(),
            last_accepted_revision: 3,
        }
    }

    fn mutation(record_type: &str) -> EnqueueMutationInput {
        EnqueueMutationInput {
            local_workspace_id: "default".into(),
            local_mutation_id: format!("local-{record_type}"),
            client_mutation_id: format!("client-{record_type}"),
            base_revision: 3,
            record_type: record_type.into(),
            record_id: "project-a".into(),
            operation: "update".into(),
            payload: serde_json::json!({ "name": "Launch" }),
        }
    }

    #[test]
    fn links_workspace_and_initializes_cursor() {
        let store = store();
        store
            .transaction(|tx| upsert_link(tx, &link(), "now"))
            .unwrap();
        let link = store
            .with_conn(|conn| get_link(conn, "default"))
            .unwrap()
            .unwrap();
        assert_eq!(link.cloud_workspace_id, "cloud-ws");
        assert_eq!(link.last_accepted_revision, 3);
        let cursor = store
            .with_conn(|conn| get_cursor(conn, "default", "device-a"))
            .unwrap()
            .unwrap();
        assert_eq!(cursor.last_pulled_revision, 3);
    }

    #[test]
    fn enqueue_uses_stable_idempotency_key_and_encrypted_payload() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_link(tx, &link(), "now")?;
                enqueue_mutation(tx, &store, &mutation("project"), "now")?;
                enqueue_mutation(tx, &store, &mutation("project"), "later")?;
                Ok(())
            })
            .unwrap();
        let rows = store
            .with_conn(|conn| list_queued(conn, &store, "default"))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].idempotency_key, "cloud-ws:device-a:client-project");
        assert_eq!(rows[0].payload["name"], "Launch");
    }

    #[test]
    fn viewer_link_cannot_enqueue_outbox() {
        let store = store();
        let mut link = link();
        link.role = "viewer".into();
        store
            .transaction(|tx| upsert_link(tx, &link, "now"))
            .unwrap();
        let err = store
            .transaction(|tx| enqueue_mutation(tx, &store, &mutation("project"), "now"))
            .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM cloud_mutation_outbox;", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn revoked_link_cannot_enqueue_outbox() {
        let store = store();
        let mut link = link();
        link.sync_state = "revoked".into();
        store
            .transaction(|tx| upsert_link(tx, &link, "now"))
            .unwrap();
        let err = store
            .transaction(|tx| enqueue_mutation(tx, &store, &mutation("project"), "now"))
            .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }

    #[test]
    fn denied_record_classes_are_rejected_before_persisting() {
        let store = store();
        store
            .transaction(|tx| upsert_link(tx, &link(), "now"))
            .unwrap();
        for record_type in DENIED_RECORD_TYPES {
            let err = store
                .transaction(|tx| enqueue_mutation(tx, &store, &mutation(record_type), "now"))
                .unwrap_err();
            assert!(matches!(err, StoreError::Invalid(_)));
        }
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM cloud_mutation_outbox;", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn secret_shaped_payload_is_rejected_before_persisting() {
        let store = store();
        store
            .transaction(|tx| upsert_link(tx, &link(), "now"))
            .unwrap();
        let mut input = mutation("project");
        input.payload = serde_json::json!({ "name": "Launch", "accessToken": "sk-secret" });
        store
            .transaction(|tx| enqueue_mutation(tx, &store, &input, "now"))
            .unwrap_err();
        let count: i64 = store
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM cloud_mutation_outbox;", [], |row| {
                    row.get(0)
                })
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
