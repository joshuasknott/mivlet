//! Local encrypted cloud-team sync skeleton.
//!
//! Convex is the shared workspace authority. These tables hold only local link
//! metadata, cursors, encrypted pending mutations, shadows, and conflicts so
//! the desktop can stay local-first and retry idempotently.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::repos::{open_json, scope::DataScope, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

pub const ROLES: &[&str] = &["owner", "admin", "editor", "viewer"];
pub const LINK_STATES: &[&str] = &["active", "stale", "revoked", "disabled"];
pub const OUTBOX_STATUSES: &[&str] = &["pending", "accepted", "rejected", "conflict"];
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
    #[serde(rename = "cloudWorkspaceId")]
    pub fable_workspace_id: String,
    pub internal_user_id: String,
    pub member_id: String,
    pub device_id: String,
    pub role: String,
    pub sync_state: String,
    pub last_accepted_revision: i64,
    pub linked_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncCursor {
    pub local_workspace_id: String,
    pub fable_workspace_id: String,
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
    #[serde(rename = "cloudWorkspaceId")]
    pub fable_workspace_id: String,
    pub internal_user_id: String,
    pub member_id: String,
    pub device_id: String,
    pub client_mutation_id: String,
    pub base_revision: i64,
    pub accepted_revision: i64,
    pub record_type: String,
    pub record_id: String,
    pub operation: String,
    #[serde(serialize_with = "serialize_public_outbox_status")]
    pub status: String,
    pub deleted_at: String,
    pub attempt_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkWorkspaceInput {
    pub local_workspace_id: String,
    pub fable_workspace_id: String,
    pub internal_user_id: String,
    pub member_id: String,
    pub role: String,
    pub sync_state: String,
    pub device_id: String,
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
    DataScope::workspace(input.local_workspace_id.clone())?.ensure_exists(conn)?;
    validate_id(&input.fable_workspace_id, "Fable workspace")?;
    validate_id(&input.internal_user_id, "Internal user")?;
    validate_id(&input.member_id, "Member")?;
    validate_id(&input.device_id, "Device")?;
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
    let existing_device_owner: Option<String> = conn
        .query_row(
            "SELECT internal_user_id FROM fable_device_mirror WHERE device_id=?1;",
            [&input.device_id],
            |row| row.get(0),
        )
        .optional()?;
    if existing_device_owner
        .as_deref()
        .is_some_and(|owner| owner != input.internal_user_id)
    {
        return Err(StoreError::Invalid(
            "A Fable device is already bound to another internal user.".into(),
        ));
    }
    let existing_member_owner: Option<String> = conn
        .query_row(
            "SELECT internal_user_id FROM fable_membership_mirror
             WHERE fable_workspace_id=?1 AND member_id=?2;",
            rusqlite::params![input.fable_workspace_id, input.member_id],
            |row| row.get(0),
        )
        .optional()?;
    if existing_member_owner
        .as_deref()
        .is_some_and(|owner| owner != input.internal_user_id)
    {
        return Err(StoreError::Invalid(
            "A Fable membership is already bound to another internal user.".into(),
        ));
    }
    let existing_member_id: Option<String> = conn
        .query_row(
            "SELECT member_id FROM fable_membership_mirror
             WHERE fable_workspace_id=?1 AND internal_user_id=?2;",
            rusqlite::params![input.fable_workspace_id, input.internal_user_id],
            |row| row.get(0),
        )
        .optional()?;
    if existing_member_id
        .as_deref()
        .is_some_and(|member| member != input.member_id)
    {
        return Err(StoreError::Invalid(
            "An internal user is already bound to another Fable membership in this workspace."
                .into(),
        ));
    }
    let existing_device_member: Option<String> = conn
        .query_row(
            "SELECT member_id FROM fable_workspace_device_mirror
             WHERE fable_workspace_id=?1 AND device_id=?2;",
            rusqlite::params![input.fable_workspace_id, input.device_id],
            |row| row.get(0),
        )
        .optional()?;
    if existing_device_member
        .as_deref()
        .is_some_and(|member| member != input.member_id)
    {
        return Err(StoreError::Invalid(
            "A Fable device link is already bound to another membership.".into(),
        ));
    }
    let existing_link: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT fable_workspace_id, internal_user_id, member_id, device_id
             FROM cloud_workspace_link WHERE local_workspace_id=?1;",
            [&input.local_workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if existing_link
        .as_ref()
        .is_some_and(|(workspace, user, member, device)| {
            workspace != &input.fable_workspace_id
                || user != &input.internal_user_id
                || member != &input.member_id
                || device != &input.device_id
        })
    {
        return Err(StoreError::Invalid(
            "The local cloud link is already bound to different Fable authority facts.".into(),
        ));
    }
    let existing_local_workspace = conn
        .query_row(
            "SELECT local_workspace_id FROM fable_workspace_mirror WHERE fable_workspace_id=?1;",
            [&input.fable_workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing_local_workspace
        .as_deref()
        .is_some_and(|existing| existing != input.local_workspace_id)
    {
        return Err(StoreError::Invalid(
            "A Fable workspace mirror is already bound to another local workspace.".into(),
        ));
    }
    let existing_fable_workspace = conn
        .query_row(
            "SELECT fable_workspace_id FROM fable_workspace_mirror WHERE local_workspace_id=?1;",
            [&input.local_workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing_fable_workspace
        .as_deref()
        .is_some_and(|existing| existing != input.fable_workspace_id)
    {
        let has_link: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM cloud_workspace_link WHERE local_workspace_id=?1);",
            [&input.local_workspace_id],
            |row| row.get(0),
        )?;
        if has_link
            || !existing_fable_workspace
                .as_deref()
                .is_some_and(|id| id.starts_with("legacy-workspace:"))
        {
            return Err(StoreError::Invalid(
                "This local workspace is already bound to another Fable workspace mirror.".into(),
            ));
        }
        // A migration-created unlinked placeholder is not cloud tenancy. It is
        // safe to replace once with the authoritative Fable workspace id.
        conn.execute(
            "DELETE FROM fable_workspace_mirror WHERE local_workspace_id=?1;",
            [&input.local_workspace_id],
        )?;
    }
    // These are a display/offline-authorization mirror only. Convex is still
    // canonical; local writes never fabricate an authority revision.
    conn.execute(
        "INSERT INTO fable_internal_user_mirror
           (internal_user_id, status, revision, updated_at)
         VALUES (?1, 'active', ?2, ?3)
         ON CONFLICT(internal_user_id) DO UPDATE SET updated_at=excluded.updated_at;",
        rusqlite::params![input.internal_user_id, input.last_accepted_revision, now],
    )?;
    conn.execute(
        "INSERT INTO fable_workspace_mirror
           (fable_workspace_id, local_workspace_id, status, revision, policy_revision, updated_at)
         VALUES (?1, ?2, 'active', ?3, 0, ?4)
         ON CONFLICT(fable_workspace_id) DO UPDATE SET
           local_workspace_id=excluded.local_workspace_id, updated_at=excluded.updated_at;",
        rusqlite::params![
            input.fable_workspace_id,
            input.local_workspace_id,
            input.last_accepted_revision,
            now
        ],
    )?;
    conn.execute(
        "INSERT INTO fable_membership_mirror
           (fable_workspace_id, member_id, internal_user_id, role, status, revision, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6)
         ON CONFLICT(fable_workspace_id, member_id) DO UPDATE SET
           internal_user_id=excluded.internal_user_id, role=excluded.role, updated_at=excluded.updated_at;",
        rusqlite::params![input.fable_workspace_id, input.member_id, input.internal_user_id, input.role, input.last_accepted_revision, now],
    )?;
    conn.execute(
        "INSERT INTO fable_device_mirror (device_id, internal_user_id, status, revision, updated_at)
         VALUES (?1, ?2, 'active', ?3, ?4)
         ON CONFLICT(device_id) DO UPDATE SET internal_user_id=excluded.internal_user_id, updated_at=excluded.updated_at;",
        rusqlite::params![input.device_id, input.internal_user_id, input.last_accepted_revision, now],
    )?;
    conn.execute(
        "INSERT INTO fable_workspace_device_mirror
           (fable_workspace_id, device_id, member_id, status, revision, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?5)
         ON CONFLICT(fable_workspace_id, device_id) DO UPDATE SET
           member_id=excluded.member_id, updated_at=excluded.updated_at;",
        rusqlite::params![
            input.fable_workspace_id,
            input.device_id,
            input.member_id,
            input.last_accepted_revision,
            now
        ],
    )?;
    conn.execute(
        "INSERT INTO cloud_workspace_link (
           local_workspace_id, fable_workspace_id, internal_user_id, member_id,
           device_id, role, sync_state, last_accepted_revision, linked_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(local_workspace_id) DO UPDATE SET
           fable_workspace_id=excluded.fable_workspace_id,
           internal_user_id=excluded.internal_user_id,
           member_id=excluded.member_id,
           role=excluded.role,
           sync_state=excluded.sync_state,
           device_id=excluded.device_id,
           last_accepted_revision=excluded.last_accepted_revision,
           updated_at=excluded.updated_at;",
        rusqlite::params![
            input.local_workspace_id,
            input.fable_workspace_id,
            input.internal_user_id,
            input.member_id,
            input.device_id,
            input.role,
            input.sync_state,
            input.last_accepted_revision,
            now,
        ],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO cloud_sync_cursor (
           local_workspace_id, fable_workspace_id, device_id, last_pulled_revision,
           last_realtime_sequence, last_successful_sync_at
         ) VALUES (?1, ?2, ?3, ?4, 0, '');",
        rusqlite::params![
            input.local_workspace_id,
            input.fable_workspace_id,
            input.device_id,
            input.last_accepted_revision
        ],
    )?;
    Ok(())
}

pub fn get_link(conn: &Connection, local_workspace_id: &str) -> Result<Option<CloudWorkspaceLink>> {
    validate_workspace_id(local_workspace_id)?;
    conn.query_row(
        "SELECT local_workspace_id, fable_workspace_id, internal_user_id, member_id,
                device_id, role, sync_state, last_accepted_revision, linked_at, updated_at
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
    validate_id(device_id, "Device")?;
    conn.query_row(
        "SELECT local_workspace_id, fable_workspace_id, device_id, last_pulled_revision,
                last_realtime_sequence, last_successful_sync_at
         FROM cloud_sync_cursor WHERE local_workspace_id=?1 AND device_id=?2;",
        rusqlite::params![local_workspace_id, device_id],
        |row| {
            Ok(CloudSyncCursor {
                local_workspace_id: row.get(0)?,
                fable_workspace_id: row.get(1)?,
                device_id: row.get(2)?,
                last_pulled_revision: row.get(3)?,
                last_realtime_sequence: row.get(4)?,
                last_successful_sync_at: row.get(5)?,
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
    DataScope::workspace(input.local_workspace_id.clone())?.ensure_exists(conn)?;
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
        link.fable_workspace_id, link.device_id, input.client_mutation_id
    );
    let sealed = seal_json(store, &input.payload, &outbox_aad(&input.local_mutation_id))?;
    conn.execute(
        "INSERT OR IGNORE INTO cloud_mutation_outbox (
           local_mutation_id, idempotency_key, local_workspace_id, fable_workspace_id,
           internal_user_id, member_id, device_id, client_mutation_id, base_revision,
           record_type, record_id, operation, status, attempt_count, created_at, updated_at, payload, payload_nonce
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', 0, ?13, ?13, ?14, ?15);",
        rusqlite::params![
            input.local_mutation_id,
            idempotency_key,
            input.local_workspace_id,
            link.fable_workspace_id,
            link.internal_user_id,
            link.member_id,
            link.device_id,
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
                    fable_workspace_id, internal_user_id, member_id, device_id, client_mutation_id,
                    base_revision, accepted_revision, record_type, record_id, operation, status,
                    deleted_at, attempt_count, created_at, updated_at, payload, payload_nonce
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
                fable_workspace_id: row.fable_workspace_id,
                internal_user_id: row.internal_user_id,
                member_id: row.member_id,
                device_id: row.device_id,
                client_mutation_id: row.client_mutation_id,
                base_revision: row.base_revision,
                accepted_revision: row.accepted_revision,
                record_type: row.record_type,
                record_id: row.record_id,
                operation: row.operation,
                status: row.status,
                deleted_at: row.deleted_at,
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
                fable_workspace_id, internal_user_id, member_id, device_id, client_mutation_id,
                base_revision, accepted_revision, record_type, record_id, operation, status,
                deleted_at, attempt_count, created_at, updated_at, payload, payload_nonce
         FROM cloud_mutation_outbox
         WHERE local_workspace_id=?1 AND status='pending'
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
                fable_workspace_id: row.fable_workspace_id,
                internal_user_id: row.internal_user_id,
                member_id: row.member_id,
                device_id: row.device_id,
                client_mutation_id: row.client_mutation_id,
                base_revision: row.base_revision,
                accepted_revision: row.accepted_revision,
                record_type: row.record_type,
                record_id: row.record_id,
                operation: row.operation,
                status: row.status,
                deleted_at: row.deleted_at,
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
        fable_workspace_id: row.get(1)?,
        internal_user_id: row.get(2)?,
        member_id: row.get(3)?,
        device_id: row.get(4)?,
        role: row.get(5)?,
        sync_state: row.get(6)?,
        last_accepted_revision: row.get(7)?,
        linked_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

struct OutboxPartial {
    local_mutation_id: String,
    idempotency_key: String,
    local_workspace_id: String,
    fable_workspace_id: String,
    internal_user_id: String,
    member_id: String,
    device_id: String,
    client_mutation_id: String,
    base_revision: i64,
    accepted_revision: i64,
    record_type: String,
    record_id: String,
    operation: String,
    status: String,
    deleted_at: String,
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
        fable_workspace_id: row.get(3)?,
        internal_user_id: row.get(4)?,
        member_id: row.get(5)?,
        device_id: row.get(6)?,
        client_mutation_id: row.get(7)?,
        base_revision: row.get(8)?,
        accepted_revision: row.get(9)?,
        record_type: row.get(10)?,
        record_id: row.get(11)?,
        operation: row.get(12)?,
        status: row.get(13)?,
        deleted_at: row.get(14)?,
        attempt_count: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        sealed: Sealed {
            ciphertext: row.get(18)?,
            nonce: row.get(19)?,
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

fn serialize_public_outbox_status<S>(
    status: &String,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(if status == "pending" {
        "queued"
    } else {
        status
    })
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
            fable_workspace_id: "fable-ws".into(),
            internal_user_id: "user-a".into(),
            member_id: "member-a".into(),
            role: "editor".into(),
            sync_state: "active".into(),
            device_id: "device-a".into(),
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
        assert_eq!(link.fable_workspace_id, "fable-ws");
        assert_eq!(link.internal_user_id, "user-a");
        assert_eq!(link.last_accepted_revision, 3);
        let cursor = store
            .with_conn(|conn| get_cursor(conn, "default", "device-a"))
            .unwrap()
            .unwrap();
        assert_eq!(cursor.last_pulled_revision, 3);
    }

    #[test]
    fn link_cannot_reassign_a_device_to_another_internal_user() {
        let store = store();
        store
            .transaction(|tx| upsert_link(tx, &link(), "now"))
            .unwrap();
        let mut conflicting = link();
        conflicting.local_workspace_id = "other-local".into();
        conflicting.fable_workspace_id = "other-fable-ws".into();
        conflicting.internal_user_id = "user-b".into();
        conflicting.member_id = "member-b".into();
        store
            .transaction(|tx| {
                crate::store::repos::workspace::upsert(
                    tx,
                    &conflicting.local_workspace_id,
                    "Other",
                    "later",
                )?;
                upsert_link(tx, &conflicting, "later")
            })
            .unwrap_err();
        let owner: String = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT internal_user_id FROM fable_device_mirror WHERE device_id='device-a';",
                    [],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(owner, "user-a");
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
        assert_eq!(rows[0].idempotency_key, "fable-ws:device-a:client-project");
        assert_eq!(rows[0].status, "pending");
        assert_eq!(rows[0].payload["name"], "Launch");
        let public = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(public["cloudWorkspaceId"], "fable-ws");
        assert_eq!(public["status"], "queued");
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

    #[test]
    fn fable_workspace_and_outbox_are_isolated_by_local_workspace() {
        let store = store();
        store
            .transaction(|tx| {
                crate::store::repos::workspace::upsert(tx, "alpha", "Alpha", "now")?;
                crate::store::repos::workspace::upsert(tx, "beta", "Beta", "now")?;
                let mut alpha_link = link();
                alpha_link.local_workspace_id = "alpha".into();
                alpha_link.fable_workspace_id = "fable-alpha".into();
                upsert_link(tx, &alpha_link, "now")?;
                let mut alpha_mutation = mutation("project");
                alpha_mutation.local_workspace_id = "alpha".into();
                enqueue_mutation(tx, &store, &alpha_mutation, "now")?;
                Ok(())
            })
            .unwrap();

        assert!(store
            .with_conn(|tx| list_queued(tx, &store, "beta"))
            .unwrap()
            .is_empty());
        let err = store
            .transaction(|tx| {
                let mut conflicting = link();
                conflicting.local_workspace_id = "beta".into();
                conflicting.fable_workspace_id = "fable-alpha".into();
                upsert_link(tx, &conflicting, "later")
            })
            .unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }
}
