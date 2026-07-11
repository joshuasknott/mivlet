//! Local encrypted cloud-team sync skeleton.
//!
//! Convex is the shared workspace authority. These tables hold only local link
//! metadata, cursors, encrypted pending mutations, shadows, and conflicts so
//! the desktop can stay local-first and retry idempotently.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::store::repos::project;
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
    #[serde(skip_serializing)]
    pub intent_fingerprint: String,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedSharedProject {
    pub id: String,
    pub workspace_id: String,
    pub authority: String,
    pub visibility: String,
    pub schema_version: i64,
    pub revision: i64,
    pub workspace_revision: i64,
    pub created_by_internal_user_id: String,
    pub created_by_device_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    pub lifecycle: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedSharedTombstone {
    pub workspace_id: String,
    pub record_type: String,
    pub record_id: String,
    pub revision: i64,
    pub deleted_at: String,
    pub actor_internal_user_id: String,
    pub actor_member_id: String,
    pub actor_device_id: String,
    pub reason_class: String,
}

#[derive(Clone, Debug)]
pub enum Settlement {
    Record {
        workspace_revision: i64,
        record: AcceptedSharedProject,
    },
    Tombstone {
        workspace_revision: i64,
        tombstone: AcceptedSharedTombstone,
    },
    Rejected {
        status: String,
        code: String,
        server_revision: i64,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum DeltaChange {
    Record { record: AcceptedSharedProject },
    Tombstone { tombstone: AcceptedSharedTombstone },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDelta {
    pub workspace_id: String,
    pub after_revision: i64,
    pub workspace_revision: i64,
    pub changes: Vec<DeltaChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedProjectPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instructions: Option<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealedOutboxIntent {
    intent_fingerprint: String,
    payload: Value,
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
    let canonical_payload = canonical_project_payload(&input.operation, &input.payload)?;
    validate_sync_record(&input.record_type, &canonical_payload)?;
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
    let intent_fingerprint = mutation_fingerprint(
        &link.fable_workspace_id,
        &link.device_id,
        &input.client_mutation_id,
        input.base_revision,
        &input.record_type,
        &input.record_id,
        &input.operation,
        &canonical_payload,
    );
    let existing = find_outbox_by_identity(
        conn,
        store,
        &input.local_mutation_id,
        &link.fable_workspace_id,
        &link.device_id,
        &input.client_mutation_id,
    )?;
    if let Some(existing) = existing {
        if existing.idempotency_key == idempotency_key
            && existing.intent_fingerprint == intent_fingerprint
            && existing.local_workspace_id == input.local_workspace_id
            && existing.base_revision == input.base_revision
            && existing.record_type == input.record_type
            && existing.record_id == input.record_id
            && existing.operation == input.operation
            && existing.payload == canonical_payload
        {
            return Ok(existing);
        }
        return Err(StoreError::Invalid(
            "Cloud mutation identity was reused for a different intent.".into(),
        ));
    }
    let sealed = seal_json(
        store,
        &serde_json::to_value(SealedOutboxIntent {
            intent_fingerprint: intent_fingerprint.clone(),
            payload: canonical_payload,
        })
        .map_err(|_| StoreError::Invalid("Cloud mutation intent is invalid.".into()))?,
        &outbox_aad(&input.local_mutation_id),
    )?;
    conn.execute(
        "INSERT INTO cloud_mutation_outbox (
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
            let envelope = open_outbox_intent(store, &row)?;
            Ok(CloudMutationOutboxRow {
                local_mutation_id: row.local_mutation_id,
                idempotency_key: row.idempotency_key,
                intent_fingerprint: envelope.intent_fingerprint,
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
                payload: envelope.payload,
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
            let envelope = open_outbox_intent(store, &row)?;
            Ok(CloudMutationOutboxRow {
                local_mutation_id: row.local_mutation_id,
                idempotency_key: row.idempotency_key,
                intent_fingerprint: envelope.intent_fingerprint,
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
                payload: envelope.payload,
            })
        })
        .collect()
}

fn find_outbox_by_identity(
    conn: &Connection,
    store: &Store,
    local_mutation_id: &str,
    workspace_id: &str,
    device_id: &str,
    client_mutation_id: &str,
) -> Result<Option<CloudMutationOutboxRow>> {
    let mut statement = conn.prepare(
        "SELECT local_mutation_id FROM cloud_mutation_outbox
         WHERE local_mutation_id=?1 OR (fable_workspace_id=?2 AND device_id=?3 AND client_mutation_id=?4);",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![
                local_mutation_id,
                workspace_id,
                device_id,
                client_mutation_id
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.len() > 1 {
        return Err(StoreError::Invalid(
            "Cloud mutation identity is ambiguous.".into(),
        ));
    }
    ids.first()
        .map(|id| get_outbox(conn, store, id))
        .transpose()
        .map(Option::flatten)
}

fn canonical_project_payload(operation: &str, payload: &Value) -> Result<Value> {
    if operation == "delete" {
        if !payload.is_null() && payload.as_object().is_none_or(|object| !object.is_empty()) {
            return Err(StoreError::Invalid(
                "Shared project delete cannot carry content.".into(),
            ));
        }
        return Ok(Value::Null);
    }
    let mut parsed: SharedProjectPayload = serde_json::from_value(payload.clone())
        .map_err(|_| StoreError::Invalid("Shared project payload is invalid.".into()))?;
    parsed.title = normalize_text(parsed.title, "title", 200)?;
    parsed.description = normalize_patch_text(parsed.description, "description", 4_000)?;
    parsed.instructions = normalize_patch_text(parsed.instructions, "instructions", 32_000)?;
    if operation == "create" && parsed.title.is_none() {
        return Err(StoreError::Invalid(
            "Shared project create requires a title.".into(),
        ));
    }
    if operation == "create"
        && (parsed.description == Some(None) || parsed.instructions == Some(None))
    {
        return Err(StoreError::Invalid(
            "Shared project create cannot clear missing content.".into(),
        ));
    }
    if operation == "update"
        && parsed.title.is_none()
        && parsed.description.is_none()
        && parsed.instructions.is_none()
    {
        return Err(StoreError::Invalid(
            "Shared project update has no changes.".into(),
        ));
    }
    serde_json::to_value(parsed)
        .map_err(|_| StoreError::Invalid("Shared project payload is invalid.".into()))
}

fn normalize_text(value: Option<String>, label: &str, max: usize) -> Result<Option<String>> {
    value
        .map(|value| {
            let value = value.trim();
            if value.is_empty()
                || value.chars().count() > max
                || value.chars().any(char::is_control)
            {
                return Err(StoreError::Invalid(format!(
                    "Shared project {label} is invalid."
                )));
            }
            Ok(value.to_string())
        })
        .transpose()
}

fn normalize_patch_text(
    value: Option<Option<String>>,
    label: &str,
    max: usize,
) -> Result<Option<Option<String>>> {
    value
        .map(|value| normalize_text(value, label, max))
        .transpose()
}

fn mutation_fingerprint(
    workspace_id: &str,
    device_id: &str,
    client_mutation_id: &str,
    base_revision: i64,
    record_type: &str,
    record_id: &str,
    operation: &str,
    payload: &Value,
) -> String {
    let canonical = serde_json::json!({
        "workspaceId": workspace_id,
        "deviceId": device_id,
        "clientMutationId": client_mutation_id,
        "baseRevision": base_revision,
        "recordType": record_type,
        "recordId": record_id,
        "operation": operation,
        "payload": payload,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical).expect("canonical mutation serializes"))
    )
}

pub fn mark_attempt(conn: &Connection, local_mutation_id: &str, now: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE cloud_mutation_outbox SET attempt_count=attempt_count+1,updated_at=?1
         WHERE local_mutation_id=?2 AND status='pending';",
        rusqlite::params![now, local_mutation_id],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid("Cloud mutation is not pending.".into()));
    }
    Ok(())
}

pub fn settle_mutation(
    tx: &Connection,
    store: &Store,
    local_mutation_id: &str,
    settlement: Settlement,
    now: &str,
) -> Result<String> {
    let outbox = get_outbox(tx, store, local_mutation_id)?
        .ok_or_else(|| StoreError::Invalid("Cloud mutation is unavailable.".into()))?;
    if outbox.status != "pending" {
        return Err(StoreError::Invalid("Cloud mutation is not pending.".into()));
    }
    match settlement {
        Settlement::Record {
            workspace_revision,
            record,
        } => {
            validate_accepted_project(&outbox, workspace_revision, &record)?;
            project::upsert_shared_mirror(
                tx,
                store,
                &project::SharedProjectMirror {
                    id: record.id.clone(),
                    workspace_id: outbox.local_workspace_id.clone(),
                    revision: record.revision,
                    created_by_internal_user_id: record.created_by_internal_user_id.clone(),
                    created_by_device_id: record.created_by_device_id.clone(),
                    created_at: record.created_at.clone(),
                    updated_at: record.updated_at.clone(),
                    title: record.title.clone(),
                    description: record.description.clone(),
                    instructions: record.instructions.clone(),
                },
            )?;
            let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&serde_json::json!({
                "title":record.title,"description":record.description,"instructions":record.instructions
            })).map_err(|_| StoreError::Invalid("Shared project record is invalid.".into()))?));
            upsert_shadow(
                tx,
                &outbox,
                record.revision,
                "accepted",
                &fingerprint,
                "",
                "",
                now,
            )?;
            accept_outbox(tx, &outbox, workspace_revision, "", now)?;
            Ok("accepted".into())
        }
        Settlement::Tombstone {
            workspace_revision,
            tombstone,
        } => {
            validate_tombstone(&outbox, workspace_revision, &tombstone)?;
            project::delete_shared_mirror(
                tx,
                &outbox.local_workspace_id,
                &tombstone.record_id,
                tombstone.revision,
            )?;
            tx.execute(
                "INSERT INTO cloud_record_tombstone (local_workspace_id,fable_workspace_id,record_type,record_id,deleted_at,server_revision,accepted_at)
                 VALUES (?1,?2,'project',?3,?4,?5,?6)
                 ON CONFLICT(local_workspace_id,record_type,record_id) DO UPDATE SET
                  deleted_at=excluded.deleted_at,server_revision=excluded.server_revision,accepted_at=excluded.accepted_at
                 WHERE cloud_record_tombstone.server_revision<=excluded.server_revision;",
                rusqlite::params![outbox.local_workspace_id,outbox.fable_workspace_id,tombstone.record_id,tombstone.deleted_at,tombstone.revision,now],
            )?;
            upsert_shadow(
                tx,
                &outbox,
                tombstone.revision,
                "accepted",
                "",
                &tombstone.deleted_at,
                "",
                now,
            )?;
            accept_outbox(tx, &outbox, workspace_revision, &tombstone.deleted_at, now)?;
            Ok("accepted".into())
        }
        Settlement::Rejected {
            status,
            code,
            server_revision,
        } => {
            if !["rejected", "conflict"].contains(&status.as_str()) || code.trim().is_empty() {
                return Err(StoreError::Invalid(
                    "Cloud mutation rejection is invalid.".into(),
                ));
            }
            let conflict_id = format!("conflict:{}", outbox.local_mutation_id);
            let sealed = seal_json(
                store,
                &outbox.payload,
                &format!("cloud_conflict:{conflict_id}"),
            )?;
            tx.execute(
                "INSERT INTO cloud_conflict (id,local_workspace_id,fable_workspace_id,local_mutation_id,record_type,record_id,base_revision,server_revision,reason_code,created_at,payload,payload_nonce)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(id) DO NOTHING;",
                rusqlite::params![conflict_id,outbox.local_workspace_id,outbox.fable_workspace_id,outbox.local_mutation_id,
                    outbox.record_type,outbox.record_id,outbox.base_revision,server_revision,code,now,sealed.ciphertext,sealed.nonce],
            )?;
            tx.execute("UPDATE cloud_mutation_outbox SET status=?1,updated_at=?2 WHERE local_mutation_id=?3 AND status='pending';",
                rusqlite::params![status,now,outbox.local_mutation_id])?;
            upsert_shadow(
                tx,
                &outbox,
                server_revision,
                "conflict",
                "",
                "",
                &conflict_id,
                now,
            )?;
            Ok(status)
        }
    }
}

fn accept_outbox(
    tx: &Connection,
    outbox: &CloudMutationOutboxRow,
    workspace_revision: i64,
    deleted_at: &str,
    now: &str,
) -> Result<()> {
    tx.execute("UPDATE cloud_mutation_outbox SET status='accepted',accepted_revision=?1,deleted_at=?2,updated_at=?3 WHERE local_mutation_id=?4 AND status='pending';",
        rusqlite::params![workspace_revision,deleted_at,now,outbox.local_mutation_id])?;
    tx.execute("UPDATE cloud_workspace_link SET last_accepted_revision=MAX(last_accepted_revision,?1),updated_at=?2 WHERE local_workspace_id=?3;",
        rusqlite::params![workspace_revision,now,outbox.local_workspace_id])?;
    Ok(())
}

fn upsert_shadow(
    tx: &Connection,
    outbox: &CloudMutationOutboxRow,
    revision: i64,
    state: &str,
    fingerprint: &str,
    deleted_at: &str,
    conflict_id: &str,
    now: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO cloud_record_shadow (local_workspace_id,fable_workspace_id,record_type,record_id,server_revision,sync_state,content_fingerprint,deleted_at,conflict_id,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(local_workspace_id,record_type,record_id) DO UPDATE SET server_revision=excluded.server_revision,
          sync_state=excluded.sync_state,content_fingerprint=excluded.content_fingerprint,deleted_at=excluded.deleted_at,
          conflict_id=excluded.conflict_id,updated_at=excluded.updated_at WHERE cloud_record_shadow.server_revision<=excluded.server_revision;",
        rusqlite::params![outbox.local_workspace_id,outbox.fable_workspace_id,outbox.record_type,outbox.record_id,
            revision,state,fingerprint,deleted_at,conflict_id,now],
    )?;
    Ok(())
}

fn validate_accepted_project(
    outbox: &CloudMutationOutboxRow,
    workspace_revision: i64,
    record: &AcceptedSharedProject,
) -> Result<()> {
    if workspace_revision < 1
        || record.workspace_revision != workspace_revision
        || record.revision != workspace_revision
        || record.workspace_id != outbox.fable_workspace_id
        || record.id != outbox.record_id
        || record.authority != "convex"
        || record.visibility != "workspace-shared"
        || record.schema_version != 1
        || record.lifecycle != "active"
        || record.created_by_internal_user_id.trim().is_empty()
        || record.created_by_device_id.trim().is_empty()
        || record.title.trim().is_empty()
        || record.created_at.trim().is_empty()
        || record.updated_at.trim().is_empty()
    {
        return Err(StoreError::Invalid(
            "Accepted shared project response is invalid.".into(),
        ));
    }
    if outbox.operation == "create"
        && (record.created_by_internal_user_id != outbox.internal_user_id
            || record.created_by_device_id != outbox.device_id)
    {
        return Err(StoreError::Invalid(
            "Accepted shared project creator attribution is invalid.".into(),
        ));
    }
    Ok(())
}

fn validate_tombstone(
    outbox: &CloudMutationOutboxRow,
    workspace_revision: i64,
    value: &AcceptedSharedTombstone,
) -> Result<()> {
    if workspace_revision < 1
        || value.revision != workspace_revision
        || value.workspace_id != outbox.fable_workspace_id
        || value.record_type != "project"
        || value.record_id != outbox.record_id
        || value.actor_internal_user_id.trim().is_empty()
        || value.actor_member_id.trim().is_empty()
        || value.actor_device_id.trim().is_empty()
        || value.deleted_at.trim().is_empty()
        || value.actor_internal_user_id != outbox.internal_user_id
        || value.actor_member_id != outbox.member_id
        || value.actor_device_id != outbox.device_id
        || !["user-delete", "member-removed", "workspace-deleted"]
            .contains(&value.reason_class.as_str())
    {
        return Err(StoreError::Invalid(
            "Accepted shared tombstone response is invalid.".into(),
        ));
    }
    Ok(())
}

pub fn apply_workspace_delta(
    tx: &Connection,
    store: &Store,
    local_workspace_id: &str,
    delta: &WorkspaceDelta,
    now: &str,
) -> Result<i64> {
    let link = get_link(tx, local_workspace_id)?.ok_or_else(|| {
        StoreError::Invalid("Local workspace is not linked to cloud sync.".into())
    })?;
    if link.sync_state != "active" {
        return Err(StoreError::Invalid(
            "Cloud workspace link is not active.".into(),
        ));
    }
    let cursor = get_cursor(tx, local_workspace_id, &link.device_id)?
        .ok_or_else(|| StoreError::Invalid("Cloud sync cursor is unavailable.".into()))?;
    if delta.workspace_id != link.fable_workspace_id
        || delta.after_revision != cursor.last_pulled_revision
        || delta.workspace_revision < delta.after_revision
    {
        return Err(StoreError::Invalid(
            "Cloud workspace delta cursor is invalid.".into(),
        ));
    }
    if delta.workspace_revision == delta.after_revision && delta.changes.is_empty() {
        return Ok(delta.workspace_revision);
    }
    let revisions = delta
        .changes
        .iter()
        .map(|change| match change {
            DeltaChange::Record { record } => record.revision,
            DeltaChange::Tombstone { tombstone } => tombstone.revision,
        })
        .collect::<Vec<_>>();
    let expected = ((delta.after_revision + 1)..=delta.workspace_revision).collect::<Vec<_>>();
    if revisions != expected {
        return Err(StoreError::Invalid(
            "Cloud workspace delta is not contiguous and ordered.".into(),
        ));
    }
    let mut tombstoned = std::collections::BTreeMap::new();
    for change in &delta.changes {
        if let DeltaChange::Tombstone { tombstone } = change {
            if tombstone.workspace_id != delta.workspace_id
                || tombstone.record_type != "project"
                || tombstone.revision < 1
                || tombstone.record_id.trim().is_empty()
                || tombstone.deleted_at.trim().is_empty()
                || tombstone.actor_internal_user_id.trim().is_empty()
                || tombstone.actor_member_id.trim().is_empty()
                || tombstone.actor_device_id.trim().is_empty()
            {
                return Err(StoreError::Invalid(
                    "Cloud workspace tombstone is invalid.".into(),
                ));
            }
            tombstoned.insert(tombstone.record_id.clone(), tombstone.revision);
        }
    }
    for change in &delta.changes {
        if let DeltaChange::Record { record } = change {
            if record.workspace_id != delta.workspace_id
                || record.workspace_revision != record.revision
                || record.authority != "convex"
                || record.visibility != "workspace-shared"
                || record.schema_version != 1
                || record.lifecycle != "active"
                || record.created_by_internal_user_id.trim().is_empty()
                || record.created_by_device_id.trim().is_empty()
                || record.title.trim().is_empty()
                || tombstoned
                    .get(&record.id)
                    .is_some_and(|deleted_revision| *deleted_revision <= record.revision)
            {
                return Err(StoreError::Invalid(
                    "Cloud workspace record would resurrect a tombstone.".into(),
                ));
            }
        }
    }
    // Deletes are applied first so a later failure can never expose stale content;
    // the surrounding transaction still rolls every write back together.
    for change in &delta.changes {
        if let DeltaChange::Tombstone { tombstone } = change {
            project::delete_shared_mirror(
                tx,
                local_workspace_id,
                &tombstone.record_id,
                tombstone.revision,
            )?;
            tx.execute("INSERT INTO cloud_record_tombstone (local_workspace_id,fable_workspace_id,record_type,record_id,deleted_at,server_revision,accepted_at)
                VALUES (?1,?2,'project',?3,?4,?5,?6) ON CONFLICT(local_workspace_id,record_type,record_id)
                DO UPDATE SET deleted_at=excluded.deleted_at,server_revision=excluded.server_revision,accepted_at=excluded.accepted_at
                WHERE cloud_record_tombstone.server_revision<=excluded.server_revision;",
                rusqlite::params![local_workspace_id,link.fable_workspace_id,tombstone.record_id,tombstone.deleted_at,tombstone.revision,now])?;
            upsert_delta_shadow(
                tx,
                local_workspace_id,
                &link.fable_workspace_id,
                "project",
                &tombstone.record_id,
                tombstone.revision,
                "",
                &tombstone.deleted_at,
                now,
            )?;
        }
    }
    for change in &delta.changes {
        if let DeltaChange::Record { record } = change {
            project::upsert_shared_mirror(
                tx,
                store,
                &project::SharedProjectMirror {
                    id: record.id.clone(),
                    workspace_id: local_workspace_id.to_string(),
                    revision: record.revision,
                    created_by_internal_user_id: record.created_by_internal_user_id.clone(),
                    created_by_device_id: record.created_by_device_id.clone(),
                    created_at: record.created_at.clone(),
                    updated_at: record.updated_at.clone(),
                    title: record.title.clone(),
                    description: record.description.clone(),
                    instructions: record.instructions.clone(),
                },
            )?;
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(record).map_err(|_| StoreError::Invalid(
                    "Cloud workspace record is invalid.".into()
                ))?)
            );
            upsert_delta_shadow(
                tx,
                local_workspace_id,
                &link.fable_workspace_id,
                "project",
                &record.id,
                record.revision,
                &fingerprint,
                "",
                now,
            )?;
        }
    }
    tx.execute(
        "UPDATE cloud_sync_cursor SET last_pulled_revision=?1,last_successful_sync_at=?2
        WHERE local_workspace_id=?3 AND device_id=?4;",
        rusqlite::params![
            delta.workspace_revision,
            now,
            local_workspace_id,
            link.device_id
        ],
    )?;
    tx.execute("UPDATE cloud_workspace_link SET last_accepted_revision=MAX(last_accepted_revision,?1),updated_at=?2
        WHERE local_workspace_id=?3;", rusqlite::params![delta.workspace_revision,now,local_workspace_id])?;
    Ok(delta.workspace_revision)
}

fn upsert_delta_shadow(
    tx: &Connection,
    local_workspace_id: &str,
    workspace_id: &str,
    record_type: &str,
    record_id: &str,
    revision: i64,
    fingerprint: &str,
    deleted_at: &str,
    now: &str,
) -> Result<()> {
    tx.execute("INSERT INTO cloud_record_shadow (local_workspace_id,fable_workspace_id,record_type,record_id,server_revision,sync_state,content_fingerprint,deleted_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,'accepted',?6,?7,?8) ON CONFLICT(local_workspace_id,record_type,record_id)
        DO UPDATE SET server_revision=excluded.server_revision,sync_state='accepted',content_fingerprint=excluded.content_fingerprint,
        deleted_at=excluded.deleted_at,conflict_id='',updated_at=excluded.updated_at
        WHERE cloud_record_shadow.server_revision<=excluded.server_revision;",
        rusqlite::params![local_workspace_id,workspace_id,record_type,record_id,revision,fingerprint,deleted_at,now])?;
    Ok(())
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

fn open_outbox_intent(store: &Store, row: &OutboxPartial) -> Result<SealedOutboxIntent> {
    let value = open_json(store, &row.sealed, &outbox_aad(&row.local_mutation_id))?;
    let envelope: SealedOutboxIntent = serde_json::from_value(value).map_err(|_| {
        StoreError::Invalid(
            "Legacy cloud mutation intent is unverifiable and cannot be flushed.".into(),
        )
    })?;
    if !is_sha256(&envelope.intent_fingerprint) {
        return Err(StoreError::Invalid(
            "Cloud mutation intent fingerprint is invalid.".into(),
        ));
    }
    Ok(envelope)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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
            payload: serde_json::json!({ "title": "Launch" }),
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
        assert_eq!(rows[0].payload["title"], "Launch");
        assert!(rows[0].intent_fingerprint.len() == 64);
        let public = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(public["cloudWorkspaceId"], "fable-ws");
        assert_eq!(public["status"], "queued");
        assert!(public.get("intentFingerprint").is_none());
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
        input.payload = serde_json::json!({ "title": "Launch", "accessToken": "sk-secret" });
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

    #[test]
    fn accepted_record_settles_outbox_and_installs_shared_mirror_atomically() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_link(tx, &link(), "t0")?;
                enqueue_mutation(tx, &store, &mutation("project"), "t1")?;
                settle_mutation(
                    tx,
                    &store,
                    "local-project",
                    Settlement::Record {
                        workspace_revision: 4,
                        record: AcceptedSharedProject {
                            id: "project-a".into(),
                            workspace_id: "fable-ws".into(),
                            authority: "convex".into(),
                            visibility: "workspace-shared".into(),
                            schema_version: 1,
                            revision: 4,
                            workspace_revision: 4,
                            created_by_internal_user_id: "user-a".into(),
                            created_by_device_id: "device-a".into(),
                            created_at: "t0".into(),
                            updated_at: "t2".into(),
                            title: "Launch".into(),
                            description: Some("Shared".into()),
                            instructions: None,
                            lifecycle: "active".into(),
                        },
                    },
                    "t2",
                )?;
                Ok(())
            })
            .unwrap();

        let row = store
            .with_conn(|conn| get_outbox(conn, &store, "local-project"))
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "accepted");
        assert_eq!(row.accepted_revision, 4);
        let mirror: (String, String, i64) = store
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT authority,visibility,revision FROM project WHERE id='project-a';",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert_eq!(mirror, ("convex".into(), "workspace-shared".into(), 4));
    }

    #[test]
    fn workspace_delta_requires_contiguous_order_and_rolls_back_on_collision() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_link(tx, &link(), "t0")?;
                project::create(
                    tx,
                    &store,
                    &DataScope::workspace("default")?,
                    "project-a",
                    "member-a",
                    "user-a",
                    "Private local",
                    None,
                    None,
                    "t0",
                )?;
                Ok(())
            })
            .unwrap();
        let delta = WorkspaceDelta {
            workspace_id: "fable-ws".into(),
            after_revision: 3,
            workspace_revision: 4,
            changes: vec![DeltaChange::Record {
                record: AcceptedSharedProject {
                    id: "project-a".into(),
                    workspace_id: "fable-ws".into(),
                    authority: "convex".into(),
                    visibility: "workspace-shared".into(),
                    schema_version: 1,
                    revision: 4,
                    workspace_revision: 4,
                    created_by_internal_user_id: "user-b".into(),
                    created_by_device_id: "device-b".into(),
                    created_at: "t1".into(),
                    updated_at: "t1".into(),
                    title: "Remote".into(),
                    description: None,
                    instructions: None,
                    lifecycle: "active".into(),
                },
            }],
        };
        store
            .transaction(|tx| apply_workspace_delta(tx, &store, "default", &delta, "t2"))
            .unwrap_err();
        let cursor = store
            .with_conn(|conn| get_cursor(conn, "default", "device-a"))
            .unwrap()
            .unwrap();
        assert_eq!(cursor.last_pulled_revision, 3);
        let project = store
            .with_conn(|conn| {
                project::get(
                    conn,
                    &store,
                    &DataScope::workspace("default")?,
                    "project-a",
                    "member-a",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(project.authority, "local");
        assert_eq!(project.title, "Private local");
    }

    #[test]
    fn legacy_plaintext_outbox_intent_fails_closed() {
        let store = store();
        store
            .transaction(|tx| {
                upsert_link(tx, &link(), "t0")?;
                enqueue_mutation(tx, &store, &mutation("project"), "t1")?;
                let sealed = seal_json(
                    &store,
                    &serde_json::json!({ "title": "Legacy" }),
                    &outbox_aad("local-project"),
                )?;
                tx.execute(
                    "UPDATE cloud_mutation_outbox SET payload=?1,payload_nonce=?2 WHERE local_mutation_id='local-project';",
                    rusqlite::params![sealed.ciphertext, sealed.nonce],
                )?;
                Ok(())
            })
            .unwrap();
        let error = store
            .with_conn(|conn| get_outbox(conn, &store, "local-project"))
            .unwrap_err();
        assert!(matches!(error, StoreError::Invalid(_)));
    }
}
