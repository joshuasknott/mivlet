//! Canonical encrypted Routine persistence and node-local scheduler authority.
//!
//! Portable Routine records are owner-qualified and encrypted. Immutable
//! versions and occurrence history are separate from driver-local leases,
//! fencing, and retry state. The legacy scheduler remains the default writer
//! until an explicit, evidence-backed authority transition succeeds.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::repos::scope::{normalize_id, DataScope, PrivateDataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

const ROUTINE_STATUSES: [&str; 3] = ["active", "paused", "deleted"];
const TRIGGER_STATUSES: [&str; 3] = ["active", "paused", "deleted"];
const OCCURRENCE_STATUSES: [&str; 7] = [
    "scheduled",
    "running",
    "completed",
    "failed",
    "cancelled",
    "blocked",
    "missed",
];
const TRIGGER_KINDS: [&str; 7] = [
    "time-once",
    "time-recurring",
    "webhook",
    "connection-event",
    "threshold",
    "monitoring",
    "follow-up",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineBundleRow {
    pub routine: Value,
    pub current_version: Value,
    pub triggers: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerAuthorityRow {
    pub workspace_id: String,
    pub writer: String,
    pub phase: String,
    pub epoch: i64,
    pub fence_token: String,
    pub proof_hash: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverLeaseRow {
    pub occurrence_id: String,
    pub writer_epoch: i64,
    pub attempt_count: i64,
    pub lease_token: String,
    pub lease_expires_at: String,
    pub occurrence: Value,
    pub driver_evidence: Value,
}

#[derive(Clone, Debug)]
pub struct RoutineSchedulerInput {
    pub scope: DataScope,
    pub private: PrivateDataScope,
    pub bundle: RoutineBundleRow,
}

#[derive(Clone, Debug)]
pub struct TriggerCursorRow {
    pub writer_epoch: i64,
    pub last_evaluated_at: String,
    pub next_run_at: Option<String>,
}

fn required_text<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 16_384)
        .ok_or_else(|| StoreError::Invalid(format!("{label} is required.")))
}

fn required_i64(value: &Value, key: &str, label: &str) -> Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value >= 1)
        .ok_or_else(|| StoreError::Invalid(format!("{label} is invalid.")))
}

fn optional_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn ensure_text(value: &Value, key: &str, expected: &str, label: &str) -> Result<()> {
    if required_text(value, key, label)? != expected {
        return Err(StoreError::Invalid(format!(
            "{label} does not match its authenticated scope."
        )));
    }
    Ok(())
}

fn owner_subject(private: &PrivateDataScope) -> String {
    private.owner_subject().to_string()
}

pub(crate) fn validate_routine(
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    routine: &Value,
) -> Result<(String, String, i64)> {
    ensure_text(
        routine,
        "workspaceId",
        scope.workspace_id(),
        "Routine workspace",
    )?;
    ensure_text(
        routine,
        "createdByInternalUserId",
        internal_user_id,
        "Routine creator",
    )?;
    if required_text(routine, "authority", "Routine authority")? != "local"
        || required_text(routine, "authorityPolicy", "Routine authority policy")? != "no-expansion"
        || required_text(routine, "visibility", "Routine visibility")? != "member-private"
    {
        return Err(StoreError::Invalid(
            "Routine authority must remain local, member-private, and non-expanding.".into(),
        ));
    }
    let member = private.owner_member_id().ok_or_else(|| {
        StoreError::Invalid("An active member is required for a private Routine.".into())
    })?;
    ensure_text(routine, "ownerMemberId", member, "Routine owner")?;
    if optional_text(routine, "projectId") != scope.project_id() {
        return Err(StoreError::Invalid(
            "Routine project does not match its authenticated scope.".into(),
        ));
    }
    let status = required_text(routine, "status", "Routine status")?;
    if !ROUTINE_STATUSES.contains(&status) {
        return Err(StoreError::Invalid("Routine status is invalid.".into()));
    }
    let id = normalize_id(required_text(routine, "id", "Routine id")?, "Routine")?;
    let current_version = required_i64(routine, "currentVersion", "Routine version")?;
    Ok((id, status.to_string(), current_version))
}

pub(crate) fn validate_version(
    internal_user_id: &str,
    routine_id: &str,
    version: &Value,
    expected_version: i64,
) -> Result<()> {
    ensure_text(version, "routineId", routine_id, "Routine version id")?;
    ensure_text(
        version,
        "createdByInternalUserId",
        internal_user_id,
        "Routine version creator",
    )?;
    if required_i64(version, "version", "Routine version")? != expected_version {
        return Err(StoreError::Invalid(
            "Routine version does not match the requested immutable version.".into(),
        ));
    }
    let route = version
        .get("routePolicy")
        .and_then(Value::as_object)
        .ok_or_else(|| StoreError::Invalid("Routine route policy is required.".into()))?;
    match route.get("kind").and_then(Value::as_str) {
        Some("resolve-at-run") => {}
        Some("deliberate-pin")
            if route
                .get("providerRouteId")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && route
                    .get("pinnedByInternalUserId")
                    .and_then(Value::as_str)
                    == Some(internal_user_id)
                && route
                    .get("reason")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty()) => {}
        _ => {
            return Err(StoreError::Invalid(
                "Routine routes must resolve at run time unless the authenticated owner records an exact deliberate pin.".into(),
            ))
        }
    }
    if version
        .pointer("/budgets/capabilityGrantIds")
        .and_then(Value::as_array)
        .is_none()
    {
        return Err(StoreError::Invalid(
            "Routine capability grants must be an explicit list.".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_trigger(
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    routine_id: &str,
    trigger: &Value,
) -> Result<(String, String, String)> {
    ensure_text(
        trigger,
        "workspaceId",
        scope.workspace_id(),
        "Trigger workspace",
    )?;
    ensure_text(trigger, "routineId", routine_id, "Trigger Routine")?;
    ensure_text(
        trigger,
        "createdByInternalUserId",
        internal_user_id,
        "Trigger creator",
    )?;
    ensure_text(
        trigger,
        "ownerMemberId",
        private.owner_member_id().unwrap_or_default(),
        "Trigger owner",
    )?;
    if required_text(trigger, "visibility", "Trigger visibility")? != "member-private"
        || required_text(trigger, "authority", "Trigger authority")? != "local"
        || optional_text(trigger, "projectId") != scope.project_id()
    {
        return Err(StoreError::Invalid(
            "Trigger authority does not match its authenticated Routine scope.".into(),
        ));
    }
    let status = required_text(trigger, "status", "Trigger status")?;
    if !TRIGGER_STATUSES.contains(&status) {
        return Err(StoreError::Invalid("Trigger status is invalid.".into()));
    }
    let kind = trigger
        .pointer("/spec/kind")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Trigger kind is required.".into()))?;
    if !TRIGGER_KINDS.contains(&kind) {
        return Err(StoreError::Invalid("Trigger kind is invalid.".into()));
    }
    Ok((
        normalize_id(required_text(trigger, "id", "Trigger id")?, "Trigger")?,
        status.to_string(),
        kind.to_string(),
    ))
}

pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    routine: &Value,
    version: &Value,
    triggers: &[Value],
) -> Result<RoutineBundleRow> {
    scope.ensure_exists(tx)?;
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let (routine_id, status, current_version) = validate_routine(scope, private, &actor, routine)?;
    if current_version != 1 {
        return Err(StoreError::Invalid(
            "A new Routine must begin at immutable version 1.".into(),
        ));
    }
    validate_version(&actor, &routine_id, version, 1)?;
    if triggers.is_empty() {
        return Err(StoreError::Invalid(
            "A Routine requires at least one trigger.".into(),
        ));
    }
    let declared = version
        .get("triggerIds")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Routine version trigger ids are required.".into()))?;
    if declared.len() != triggers.len() {
        return Err(StoreError::Invalid(
            "Routine version trigger ids do not match its triggers.".into(),
        ));
    }
    let subject = owner_subject(private);
    let routine_sealed = seal_json(
        store,
        routine,
        &routine_aad(scope.workspace_id(), &subject, &routine_id),
    )?;
    let version_sealed = seal_json(
        store,
        version,
        &version_aad(scope.workspace_id(), &subject, &routine_id, 1),
    )?;
    let created_at = required_text(routine, "createdAt", "Routine created time")?;
    let updated_at = required_text(routine, "updatedAt", "Routine updated time")?;
    tx.execute(
        "INSERT INTO routine_record(workspace_id,owner_subject,id,project_id,visibility,owner_member_id,status,current_version,revision,created_by_internal_user_id,created_at,updated_at,deleted_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,'member-private',?5,?6,1,1,?7,?8,?9,?10,?11,?12);",
        rusqlite::params![
            scope.workspace_id(),
            subject,
            routine_id,
            scope.project_id(),
            private.owner_member_id(),
            status,
            actor,
            created_at,
            updated_at,
            optional_text(routine, "deletedAt"),
            routine_sealed.ciphertext,
            routine_sealed.nonce
        ],
    )?;
    tx.execute(
        "INSERT INTO routine_version(workspace_id,owner_subject,routine_id,version,created_by_internal_user_id,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,1,?4,?5,?6,?7);",
        rusqlite::params![
            scope.workspace_id(),
            subject,
            routine_id,
            actor,
            required_text(version, "createdAt", "Routine version created time")?,
            version_sealed.ciphertext,
            version_sealed.nonce
        ],
    )?;
    for trigger in triggers {
        let (trigger_id, trigger_status, kind) =
            validate_trigger(scope, private, &actor, &routine_id, trigger)?;
        if !declared
            .iter()
            .any(|value| value.as_str() == Some(trigger_id.as_str()))
        {
            return Err(StoreError::Invalid(
                "A Routine trigger is absent from its immutable version.".into(),
            ));
        }
        let sealed = seal_json(
            store,
            trigger,
            &trigger_aad(scope.workspace_id(), &subject, &trigger_id),
        )?;
        tx.execute(
            "INSERT INTO routine_trigger(workspace_id,owner_subject,id,routine_id,project_id,status,kind,revision,created_at,updated_at,deleted_at,payload,payload_nonce)
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12);",
            rusqlite::params![
                scope.workspace_id(),
                subject,
                trigger_id,
                routine_id,
                scope.project_id(),
                trigger_status,
                kind,
                required_text(trigger, "createdAt", "Trigger created time")?,
                required_text(trigger, "updatedAt", "Trigger updated time")?,
                optional_text(trigger, "deletedAt"),
                sealed.ciphertext,
                sealed.nonce
            ],
        )?;
    }
    get(tx, store, scope, private, &routine_id)?
        .ok_or_else(|| StoreError::Invalid("Routine was not saved.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    routine_id: &str,
) -> Result<Option<RoutineBundleRow>> {
    scope.ensure_exists(tx)?;
    let routine_id = normalize_id(routine_id, "Routine")?;
    let subject = owner_subject(private);
    let row = tx
        .query_row(
            "SELECT current_version,payload,payload_nonce FROM routine_record
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
            rusqlite::params![scope.workspace_id(), subject, routine_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    Sealed {
                        ciphertext: row.get(1)?,
                        nonce: row.get(2)?,
                    },
                ))
            },
        )
        .optional()?;
    let Some((current_version, routine_sealed)) = row else {
        return Ok(None);
    };
    let version_sealed = tx.query_row(
        "SELECT payload,payload_nonce FROM routine_version
         WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3 AND version=?4;",
        rusqlite::params![scope.workspace_id(), subject, routine_id, current_version],
        |row| {
            Ok(Sealed {
                ciphertext: row.get(0)?,
                nonce: row.get(1)?,
            })
        },
    )?;
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM routine_trigger
         WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3
         ORDER BY created_at,id;",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.workspace_id(), subject, routine_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                Sealed {
                    ciphertext: row.get(1)?,
                    nonce: row.get(2)?,
                },
            ))
        },
    )?;
    let mut triggers = Vec::new();
    for row in rows {
        let (trigger_id, sealed) = row?;
        triggers.push(open_json(
            store,
            &sealed,
            &trigger_aad(scope.workspace_id(), &subject, &trigger_id),
        )?);
    }
    Ok(Some(RoutineBundleRow {
        routine: open_json(
            store,
            &routine_sealed,
            &routine_aad(scope.workspace_id(), &subject, &routine_id),
        )?,
        current_version: open_json(
            store,
            &version_sealed,
            &version_aad(scope.workspace_id(), &subject, &routine_id, current_version),
        )?,
        triggers,
    }))
}

pub fn list(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
) -> Result<Vec<RoutineBundleRow>> {
    let subject = owner_subject(private);
    let mut stmt = tx.prepare(
        "SELECT id FROM routine_record
         WHERE workspace_id=?1 AND owner_subject=?2
           AND (?3 IS NULL OR project_id=?3)
         ORDER BY updated_at DESC,id LIMIT 1000;",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.workspace_id(), subject, scope.project_id()],
        |row| row.get::<_, String>(0),
    )?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(bundle) = get(tx, store, scope, private, &row?)? {
            out.push(bundle);
        }
    }
    Ok(out)
}

/// Detach canonical Routines from a project that is being deleted while
/// preserving their immutable versions and occurrence history.
pub fn detach_project(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    project_id: &str,
    updated_at: &str,
) -> Result<usize> {
    let subject = format!("member:{owner_member_id}");
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM routine_record
         WHERE workspace_id=?1 AND owner_subject=?2 AND project_id=?3;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), subject, project_id],
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
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut detached = 0;
    for (routine_id, sealed) in rows {
        let mut routine = open_json(
            store,
            &sealed,
            &routine_aad(scope.workspace_id(), &subject, &routine_id),
        )?;
        detach_project_fields(&mut routine, project_id, updated_at, "Routine")?;
        let sealed = seal_json(
            store,
            &routine,
            &routine_aad(scope.workspace_id(), &subject, &routine_id),
        )?;
        tx.execute(
            "UPDATE routine_record SET project_id=NULL,revision=revision+1,updated_at=?1,
             payload=?2,payload_nonce=?3
             WHERE workspace_id=?4 AND owner_subject=?5 AND id=?6 AND project_id=?7;",
            rusqlite::params![
                updated_at,
                sealed.ciphertext,
                sealed.nonce,
                scope.workspace_id(),
                subject,
                routine_id,
                project_id
            ],
        )?;

        let mut trigger_stmt = tx.prepare(
            "SELECT id,payload,payload_nonce FROM routine_trigger
             WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3 AND project_id=?4;",
        )?;
        let triggers = trigger_stmt
            .query_map(
                rusqlite::params![scope.workspace_id(), subject, routine_id, project_id],
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
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (trigger_id, sealed) in triggers {
            let mut trigger = open_json(
                store,
                &sealed,
                &trigger_aad(scope.workspace_id(), &subject, &trigger_id),
            )?;
            detach_project_fields(&mut trigger, project_id, updated_at, "Trigger")?;
            let sealed = seal_json(
                store,
                &trigger,
                &trigger_aad(scope.workspace_id(), &subject, &trigger_id),
            )?;
            tx.execute(
                "UPDATE routine_trigger SET project_id=NULL,revision=revision+1,updated_at=?1,
                 payload=?2,payload_nonce=?3
                 WHERE workspace_id=?4 AND owner_subject=?5 AND id=?6 AND project_id=?7;",
                rusqlite::params![
                    updated_at,
                    sealed.ciphertext,
                    sealed.nonce,
                    scope.workspace_id(),
                    subject,
                    trigger_id,
                    project_id
                ],
            )?;
        }
        detached += 1;
    }
    Ok(detached)
}

fn detach_project_fields(
    value: &mut Value,
    project_id: &str,
    updated_at: &str,
    label: &str,
) -> Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid(format!("{label} content is invalid.")))?;
    if object.get("projectId").and_then(Value::as_str) != Some(project_id) {
        return Err(StoreError::Invalid(format!(
            "{label} project does not match its encrypted content."
        )));
    }
    object.remove("projectId");
    object.insert("updatedAt".into(), Value::String(updated_at.into()));
    if let Some(scope) = object.get_mut("scope").and_then(Value::as_object_mut) {
        scope.remove("projectId");
    }
    Ok(())
}

pub fn scheduler_inputs(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
) -> Result<Vec<RoutineSchedulerInput>> {
    let mut stmt = tx.prepare(
        "SELECT owner_subject,id,project_id,payload,payload_nonce
         FROM routine_record
         WHERE workspace_id=?1 AND status='active'
         ORDER BY owner_subject,id;",
    )?;
    let rows = stmt.query_map([workspace_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            Sealed {
                ciphertext: row.get(3)?,
                nonce: row.get(4)?,
            },
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (subject, routine_id, project_id, sealed) = row?;
        let routine = open_json(
            store,
            &sealed,
            &routine_aad(workspace_id, &subject, &routine_id),
        )?;
        let internal_user_id =
            required_text(&routine, "createdByInternalUserId", "Routine creator")?;
        let member_id = required_text(&routine, "ownerMemberId", "Routine owner")?;
        let scope = DataScope::new(workspace_id, project_id)?;
        let private = PrivateDataScope::for_authenticated_user(
            scope.clone(),
            internal_user_id,
            Some(member_id),
        )?;
        if private.owner_subject() != subject {
            return Err(StoreError::Invalid(
                "Stored Routine owner does not match its encrypted row identity.".into(),
            ));
        }
        let bundle = get(tx, store, &scope, &private, &routine_id)?
            .ok_or_else(|| StoreError::Invalid("Stored Routine disappeared.".into()))?;
        out.push(RoutineSchedulerInput {
            scope,
            private,
            bundle,
        });
    }
    Ok(out)
}

pub fn scheduler_workspaces(tx: &Connection) -> Result<Vec<String>> {
    let mut stmt = tx.prepare(
        "SELECT workspace_id FROM routine_record
         UNION
         SELECT workspace_id FROM routine_scheduler_authority
         ORDER BY workspace_id;",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(StoreError::from)
}

pub fn latest_scheduled_for(
    tx: &Connection,
    scope: &DataScope,
    private: &PrivateDataScope,
    trigger_id: &str,
) -> Result<Option<String>> {
    let trigger_id = normalize_id(trigger_id, "Trigger")?;
    tx.query_row(
        "SELECT scheduled_for FROM routine_occurrence
         WHERE workspace_id=?1 AND owner_subject=?2 AND trigger_id=?3
           AND scheduled_for IS NOT NULL
         ORDER BY scheduled_for DESC,id DESC LIMIT 1;",
        rusqlite::params![scope.workspace_id(), private.owner_subject(), trigger_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(StoreError::from)
}

pub fn trigger_cursor(
    tx: &Connection,
    scope: &DataScope,
    private: &PrivateDataScope,
    trigger_id: &str,
) -> Result<Option<TriggerCursorRow>> {
    let trigger_id = normalize_id(trigger_id, "Trigger")?;
    tx.query_row(
        "SELECT writer_epoch,last_evaluated_at,next_run_at
         FROM routine_trigger_cursor
         WHERE workspace_id=?1 AND owner_subject=?2 AND trigger_id=?3;",
        rusqlite::params![scope.workspace_id(), private.owner_subject(), trigger_id],
        |row| {
            Ok(TriggerCursorRow {
                writer_epoch: row.get(0)?,
                last_evaluated_at: row.get(1)?,
                next_run_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

#[allow(clippy::too_many_arguments)]
pub fn upsert_trigger_cursor(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    trigger_id: &str,
    expected_epoch: i64,
    last_evaluated_at: &str,
    next_run_at: Option<&str>,
    evidence: &Value,
    updated_at: &str,
) -> Result<()> {
    let authority = read_scheduler_authority(tx, scope.workspace_id())?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine"
        || authority.phase != "routine"
        || authority.epoch != expected_epoch
    {
        return Err(StoreError::Invalid(
            "Routine trigger cursor fence is stale.".into(),
        ));
    }
    let trigger_id = normalize_id(trigger_id, "Trigger")?;
    let sealed = seal_json(
        store,
        evidence,
        &cursor_aad(scope.workspace_id(), private.owner_subject(), &trigger_id),
    )?;
    tx.execute(
        "INSERT INTO routine_trigger_cursor(
           workspace_id,owner_subject,trigger_id,writer_epoch,last_evaluated_at,
           next_run_at,updated_at,payload,payload_nonce
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(workspace_id,owner_subject,trigger_id) DO UPDATE SET
           writer_epoch=excluded.writer_epoch,
           last_evaluated_at=excluded.last_evaluated_at,
           next_run_at=excluded.next_run_at,
           updated_at=excluded.updated_at,
           payload=excluded.payload,
           payload_nonce=excluded.payload_nonce;",
        rusqlite::params![
            scope.workspace_id(),
            private.owner_subject(),
            trigger_id,
            expected_epoch,
            last_evaluated_at,
            next_run_at,
            updated_at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(())
}

pub fn append_version(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    routine_id: &str,
    expected_revision: i64,
    routine: &Value,
    version: &Value,
    new_triggers: &[Value],
    at: &str,
) -> Result<RoutineBundleRow> {
    let routine_id = normalize_id(routine_id, "Routine")?;
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let (payload_id, status, next_version) = validate_routine(scope, private, &actor, routine)?;
    if payload_id != routine_id {
        return Err(StoreError::Invalid(
            "Routine identity cannot change.".into(),
        ));
    }
    let subject = owner_subject(private);
    let current_version: i64 = tx
        .query_row(
            "SELECT current_version FROM routine_record
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3 AND revision=?4;",
            rusqlite::params![scope.workspace_id(), subject, routine_id, expected_revision],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::Invalid("Routine changed before this edit could be saved.".into())
        })?;
    if next_version != current_version + 1 {
        return Err(StoreError::Invalid(
            "Routine edits must create the next immutable version.".into(),
        ));
    }
    validate_version(&actor, &routine_id, version, next_version)?;
    for trigger in new_triggers {
        let (trigger_id, trigger_status, kind) =
            validate_trigger(scope, private, &actor, &routine_id, trigger)?;
        let sealed = seal_json(
            store,
            trigger,
            &trigger_aad(scope.workspace_id(), &subject, &trigger_id),
        )?;
        tx.execute(
            "INSERT INTO routine_trigger(workspace_id,owner_subject,id,routine_id,project_id,status,kind,revision,created_at,updated_at,deleted_at,payload,payload_nonce)
             VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12);",
            rusqlite::params![
                scope.workspace_id(),
                subject,
                trigger_id,
                routine_id,
                scope.project_id(),
                trigger_status,
                kind,
                required_text(trigger, "createdAt", "Trigger created time")?,
                required_text(trigger, "updatedAt", "Trigger updated time")?,
                optional_text(trigger, "deletedAt"),
                sealed.ciphertext,
                sealed.nonce
            ],
        )?;
    }
    let trigger_ids = version
        .get("triggerIds")
        .and_then(Value::as_array)
        .filter(|ids| !ids.is_empty())
        .ok_or_else(|| StoreError::Invalid("Routine version requires a trigger.".into()))?;
    for trigger_id in trigger_ids {
        let trigger_id = trigger_id
            .as_str()
            .ok_or_else(|| StoreError::Invalid("Routine trigger id is invalid.".into()))?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM routine_trigger
             WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3 AND routine_id=?4);",
            rusqlite::params![scope.workspace_id(), subject, trigger_id, routine_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::Invalid(
                "Routine version references an unavailable trigger.".into(),
            ));
        }
    }
    let version_sealed = seal_json(
        store,
        version,
        &version_aad(scope.workspace_id(), &subject, &routine_id, next_version),
    )?;
    tx.execute(
        "INSERT INTO routine_version(workspace_id,owner_subject,routine_id,version,created_by_internal_user_id,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8);",
        rusqlite::params![scope.workspace_id(),subject,routine_id,next_version,actor,required_text(version,"createdAt","Routine version created time")?,version_sealed.ciphertext,version_sealed.nonce],
    )?;
    let routine_sealed = seal_json(
        store,
        routine,
        &routine_aad(scope.workspace_id(), &subject, &routine_id),
    )?;
    let changed = tx.execute(
        "UPDATE routine_record SET status=?1,current_version=?2,revision=revision+1,updated_at=?3,deleted_at=?4,payload=?5,payload_nonce=?6
         WHERE workspace_id=?7 AND owner_subject=?8 AND id=?9 AND revision=?10 AND current_version=?11;",
        rusqlite::params![status,next_version,at,optional_text(routine,"deletedAt"),routine_sealed.ciphertext,routine_sealed.nonce,scope.workspace_id(),subject,routine_id,expected_revision,current_version],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Routine changed before this edit could be saved.".into(),
        ));
    }
    get(tx, store, scope, private, &routine_id)?
        .ok_or_else(|| StoreError::Invalid("Routine disappeared.".into()))
}

pub fn transition(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    internal_user_id: &str,
    routine_id: &str,
    expected_revision: i64,
    status: &str,
    reason: Option<&str>,
    at: &str,
) -> Result<RoutineBundleRow> {
    if !ROUTINE_STATUSES.contains(&status) {
        return Err(StoreError::Invalid("Routine status is invalid.".into()));
    }
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let routine_id = normalize_id(routine_id, "Routine")?;
    let subject = owner_subject(private);
    let mut bundle = get(tx, store, scope, private, &routine_id)?
        .ok_or_else(|| StoreError::Invalid("Routine was not found.".into()))?;
    if bundle.routine.get("revision").and_then(Value::as_i64) != Some(expected_revision) {
        return Err(StoreError::Invalid(
            "Routine changed before this action could be saved.".into(),
        ));
    }
    bundle.routine["status"] = Value::String(status.to_string());
    bundle.routine["revision"] = Value::Number((expected_revision + 1).into());
    bundle.routine["updatedAt"] = Value::String(at.to_string());
    let object = bundle
        .routine
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid("Stored Routine is invalid.".into()))?;
    match status {
        "paused" => {
            object.insert(
                "pause".into(),
                serde_json::json!({
                    "pausedAt":at,
                    "pausedByInternalUserId":actor,
                    "reason":reason
                }),
            );
            object.remove("deletedAt");
        }
        "active" => {
            object.remove("pause");
            object.remove("deletedAt");
        }
        "deleted" => {
            object.remove("pause");
            object.insert("deletedAt".into(), Value::String(at.to_string()));
        }
        _ => unreachable!(),
    }
    let sealed = seal_json(
        store,
        &bundle.routine,
        &routine_aad(scope.workspace_id(), &subject, &routine_id),
    )?;
    let changed = tx.execute(
        "UPDATE routine_record SET status=?1,revision=revision+1,updated_at=?2,deleted_at=?3,payload=?4,payload_nonce=?5
         WHERE workspace_id=?6 AND owner_subject=?7 AND id=?8 AND revision=?9;",
        rusqlite::params![
            status,
            at,
            (status == "deleted").then_some(at),
            sealed.ciphertext,
            sealed.nonce,
            scope.workspace_id(),
            subject,
            routine_id,
            expected_revision
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Routine changed before this action could be saved.".into(),
        ));
    }
    get(tx, store, scope, private, &routine_id)?
        .ok_or_else(|| StoreError::Invalid("Routine disappeared.".into()))
}

pub fn append_occurrence(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    occurrence: &Value,
) -> Result<Value> {
    let subject = owner_subject(private);
    let occurrence_id = normalize_id(
        required_text(occurrence, "id", "Occurrence id")?,
        "Occurrence",
    )?;
    let routine_id = normalize_id(
        required_text(occurrence, "routineId", "Occurrence Routine")?,
        "Routine",
    )?;
    let trigger_id = normalize_id(
        required_text(occurrence, "triggerId", "Occurrence trigger")?,
        "Trigger",
    )?;
    let version = required_i64(occurrence, "routineVersion", "Occurrence Routine version")?;
    let status = required_text(occurrence, "status", "Occurrence status")?;
    if !OCCURRENCE_STATUSES.contains(&status) {
        return Err(StoreError::Invalid("Occurrence status is invalid.".into()));
    }
    let deduplication_key = required_text(
        occurrence,
        "deduplicationKey",
        "Occurrence deduplication key",
    )?;
    let sealed = seal_json(
        store,
        occurrence,
        &occurrence_aad(scope.workspace_id(), &subject, &occurrence_id),
    )?;
    let inserted = tx.execute(
        "INSERT INTO routine_occurrence(workspace_id,owner_subject,id,routine_id,trigger_id,routine_version,status,scheduled_for,observed_at,deduplication_key,run_id,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(workspace_id,owner_subject,deduplication_key) DO NOTHING;",
        rusqlite::params![scope.workspace_id(),subject,occurrence_id,routine_id,trigger_id,version,status,optional_text(occurrence,"scheduledFor"),required_text(occurrence,"observedAt","Occurrence observed time")?,deduplication_key,optional_text(occurrence,"runId"),sealed.ciphertext,sealed.nonce],
    )?;
    if inserted == 0 {
        let existing = tx.query_row(
            "SELECT id,payload,payload_nonce FROM routine_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND deduplication_key=?3;",
            rusqlite::params![scope.workspace_id(), subject, deduplication_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Sealed {
                        ciphertext: row.get(1)?,
                        nonce: row.get(2)?,
                    },
                ))
            },
        )?;
        let value = open_json(
            store,
            &existing.1,
            &occurrence_aad(scope.workspace_id(), &subject, &existing.0),
        )?;
        if value != *occurrence {
            return Err(StoreError::Invalid(
                "Occurrence deduplication key collides with different evidence.".into(),
            ));
        }
        return Ok(value);
    }
    Ok(occurrence.clone())
}

pub fn occurrence_history(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    routine_id: &str,
) -> Result<Vec<Value>> {
    let routine_id = normalize_id(routine_id, "Routine")?;
    let subject = owner_subject(private);
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM routine_occurrence
         WHERE workspace_id=?1 AND owner_subject=?2 AND routine_id=?3
         ORDER BY observed_at DESC,id LIMIT 1000;",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.workspace_id(), subject, routine_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                Sealed {
                    ciphertext: row.get(1)?,
                    nonce: row.get(2)?,
                },
            ))
        },
    )?;
    let mut out = Vec::new();
    for row in rows {
        let (id, sealed) = row?;
        out.push(open_json(
            store,
            &sealed,
            &occurrence_aad(scope.workspace_id(), &subject, &id),
        )?);
    }
    Ok(out)
}

pub fn scheduler_authority(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    at: &str,
) -> Result<SchedulerAuthorityRow> {
    if let Some(row) = read_scheduler_authority(tx, workspace_id)? {
        return Ok(row);
    }
    let payload = serde_json::json!({
        "reason": "Legacy remains the only writer until Routine shadow validation succeeds."
    });
    let sealed = seal_json(store, &payload, &authority_aad(workspace_id))?;
    tx.execute(
        "INSERT INTO routine_scheduler_authority(workspace_id,writer,phase,epoch,fence_token,proof_hash,updated_at,payload,payload_nonce)
         VALUES (?1,'legacy','legacy',1,'legacy:1',NULL,?2,?3,?4)
         ON CONFLICT(workspace_id) DO NOTHING;",
        rusqlite::params![workspace_id,at,sealed.ciphertext,sealed.nonce],
    )?;
    read_scheduler_authority(tx, workspace_id)?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority was not initialized.".into()))
}

pub fn legacy_writer_permitted(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    at: &str,
) -> Result<bool> {
    let authority = scheduler_authority(tx, store, workspace_id, at)?;
    Ok(authority.writer == "legacy"
        && matches!(authority.phase.as_str(), "legacy" | "shadow" | "rollback"))
}

pub fn transition_scheduler_authority(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    expected_epoch: i64,
    writer: &str,
    phase: &str,
    fence_token: &str,
    proof_hash: Option<&str>,
    evidence: &Value,
    at: &str,
) -> Result<SchedulerAuthorityRow> {
    let current = scheduler_authority(tx, store, workspace_id, at)?;
    let allowed = matches!(
        (
            current.writer.as_str(),
            current.phase.as_str(),
            writer,
            phase
        ),
        ("legacy", "legacy", "legacy", "shadow")
            | ("legacy", "shadow", "routine", "routine")
            | ("legacy", "shadow", "legacy", "legacy")
            | ("routine", "routine", "legacy", "rollback")
            | ("legacy", "rollback", "legacy", "legacy")
    );
    if current.epoch != expected_epoch || !allowed {
        return Err(StoreError::Invalid(
            "Scheduler authority transition is stale or unsafe.".into(),
        ));
    }
    let fence = normalize_id(fence_token, "Scheduler fence")?;
    if fence == current.fence_token {
        return Err(StoreError::Invalid(
            "Scheduler transitions require a fresh fence token.".into(),
        ));
    }
    if matches!(phase, "routine" | "rollback")
        && !proof_hash.is_some_and(|value| value.starts_with("sha256:") && value.len() == 71)
    {
        return Err(StoreError::Invalid(
            "Scheduler cutover and rollback require exact reconciliation evidence.".into(),
        ));
    }
    let next_epoch = current.epoch + 1;
    let sealed = seal_json(store, evidence, &authority_aad(workspace_id))?;
    let changed = tx.execute(
        "UPDATE routine_scheduler_authority SET writer=?1,phase=?2,epoch=?3,fence_token=?4,proof_hash=?5,updated_at=?6,payload=?7,payload_nonce=?8
         WHERE workspace_id=?9 AND epoch=?10 AND fence_token=?11;",
        rusqlite::params![writer,phase,next_epoch,fence,proof_hash,at,sealed.ciphertext,sealed.nonce,workspace_id,expected_epoch,current.fence_token],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Scheduler authority changed before the transition could commit.".into(),
        ));
    }
    read_scheduler_authority(tx, workspace_id)?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority disappeared.".into()))
}

pub fn enqueue_driver_occurrence(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    occurrence_id: &str,
    expected_epoch: i64,
    available_at: &str,
    driver_evidence: &Value,
) -> Result<bool> {
    let authority = read_scheduler_authority(tx, scope.workspace_id())?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine"
        || authority.phase != "routine"
        || authority.epoch != expected_epoch
    {
        return Err(StoreError::Invalid(
            "The Routine scheduler is not the fenced workspace writer.".into(),
        ));
    }
    let occurrence_id = normalize_id(occurrence_id, "Occurrence")?;
    let subject = owner_subject(private);
    let sealed = seal_json(
        store,
        driver_evidence,
        &driver_aad(scope.workspace_id(), &subject, &occurrence_id),
    )?;
    let inserted = tx.execute(
        "INSERT INTO routine_driver_occurrence(workspace_id,owner_subject,occurrence_id,writer_epoch,state,available_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,'queued',?5,?5,?6,?7)
         ON CONFLICT(workspace_id,owner_subject,occurrence_id) DO NOTHING;",
        rusqlite::params![scope.workspace_id(),subject,occurrence_id,expected_epoch,available_at,sealed.ciphertext,sealed.nonce],
    )?;
    Ok(inserted == 1)
}

pub fn lease_due(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    private: &PrivateDataScope,
    expected_epoch: i64,
    lease_holder: &str,
    lease_token: &str,
    now: &str,
    lease_expires_at: &str,
) -> Result<Option<DriverLeaseRow>> {
    let authority = read_scheduler_authority(tx, scope.workspace_id())?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine"
        || authority.phase != "routine"
        || authority.epoch != expected_epoch
    {
        return Err(StoreError::Invalid(
            "Routine scheduler fence is stale.".into(),
        ));
    }
    let holder = normalize_id(lease_holder, "Lease holder")?;
    let token = normalize_id(lease_token, "Lease token")?;
    let subject = owner_subject(private);
    let occurrence_id: Option<String> = tx
        .query_row(
            "SELECT occurrence_id FROM routine_driver_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND writer_epoch=?3
               AND state='queued' AND available_at<=?4
             ORDER BY available_at,occurrence_id LIMIT 1;",
            rusqlite::params![scope.workspace_id(), subject, expected_epoch, now],
            |row| row.get(0),
        )
        .optional()?;
    let Some(occurrence_id) = occurrence_id else {
        return Ok(None);
    };
    let changed = tx.execute(
        "UPDATE routine_driver_occurrence
         SET state='leased',lease_holder=?1,lease_token=?2,lease_expires_at=?3,updated_at=?4
         WHERE workspace_id=?5 AND owner_subject=?6 AND occurrence_id=?7
           AND writer_epoch=?8 AND state='queued';",
        rusqlite::params![
            holder,
            token,
            lease_expires_at,
            now,
            scope.workspace_id(),
            subject,
            occurrence_id,
            expected_epoch
        ],
    )?;
    if changed != 1 {
        return Ok(None);
    }
    let (occurrence_sealed, driver_sealed, attempt_count) = tx.query_row(
        "SELECT o.payload,o.payload_nonce,d.payload,d.payload_nonce,d.attempt_count
         FROM routine_occurrence o
         JOIN routine_driver_occurrence d
           ON d.workspace_id=o.workspace_id
          AND d.owner_subject=o.owner_subject
          AND d.occurrence_id=o.id
         WHERE o.workspace_id=?1 AND o.owner_subject=?2 AND o.id=?3;",
        rusqlite::params![scope.workspace_id(), subject, occurrence_id],
        |row| {
            Ok((
                Sealed {
                    ciphertext: row.get(0)?,
                    nonce: row.get(1)?,
                },
                Sealed {
                    ciphertext: row.get(2)?,
                    nonce: row.get(3)?,
                },
                row.get::<_, i64>(4)?,
            ))
        },
    )?;
    Ok(Some(DriverLeaseRow {
        occurrence: open_json(
            store,
            &occurrence_sealed,
            &occurrence_aad(scope.workspace_id(), &subject, &occurrence_id),
        )?,
        driver_evidence: open_json(
            store,
            &driver_sealed,
            &driver_aad(scope.workspace_id(), &subject, &occurrence_id),
        )?,
        occurrence_id,
        writer_epoch: expected_epoch,
        attempt_count,
        lease_token: token,
        lease_expires_at: lease_expires_at.to_string(),
    }))
}

pub fn renew_driver_lease(
    tx: &Connection,
    workspace_id: &str,
    owner_subject: &str,
    occurrence_id: &str,
    expected_epoch: i64,
    lease_token: &str,
    now: &str,
    lease_expires_at: &str,
) -> Result<bool> {
    let authority = read_scheduler_authority(tx, workspace_id)?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine"
        || authority.phase != "routine"
        || authority.epoch != expected_epoch
    {
        return Err(StoreError::Invalid(
            "Routine scheduler fence is stale.".into(),
        ));
    }
    let occurrence_id = normalize_id(occurrence_id, "Occurrence")?;
    let token = normalize_id(lease_token, "Lease token")?;
    Ok(tx.execute(
        "UPDATE routine_driver_occurrence
         SET lease_expires_at=?1,updated_at=?2
         WHERE workspace_id=?3 AND owner_subject=?4 AND occurrence_id=?5
           AND writer_epoch=?6 AND lease_token=?7 AND state IN ('leased','running');",
        rusqlite::params![
            lease_expires_at,
            now,
            workspace_id,
            owner_subject,
            occurrence_id,
            expected_epoch,
            token
        ],
    )? == 1)
}

#[allow(clippy::too_many_arguments)]
pub fn report_driver_attempt(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    owner_subject: &str,
    occurrence_id: &str,
    expected_epoch: i64,
    lease_token: &str,
    run_id: &str,
    expected_attempt_number: i64,
    status: &str,
    at: &str,
    lease_expires_at: Option<&str>,
    retry_at: Option<&str>,
) -> Result<String> {
    let authority = read_scheduler_authority(tx, workspace_id)?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine"
        || authority.phase != "routine"
        || authority.epoch != expected_epoch
    {
        return Err(StoreError::Invalid(
            "Routine scheduler fence is stale.".into(),
        ));
    }
    if !matches!(
        status,
        "running" | "completed" | "failed" | "cancelled" | "blocked"
    ) {
        return Err(StoreError::Invalid(
            "Routine driver status is invalid.".into(),
        ));
    }
    let occurrence_id = normalize_id(occurrence_id, "Occurrence")?;
    let lease_token = normalize_id(lease_token, "Lease token")?;
    let run_id = normalize_id(run_id, "Run")?;
    let current = tx
        .query_row(
            "SELECT state,attempt_count,payload,payload_nonce
             FROM routine_driver_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND occurrence_id=?3
               AND writer_epoch=?4 AND lease_token=?5;",
            rusqlite::params![
                workspace_id,
                owner_subject,
                occurrence_id,
                expected_epoch,
                lease_token
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    Sealed {
                        ciphertext: row.get(2)?,
                        nonce: row.get(3)?,
                    },
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("Routine driver lease is stale.".into()))?;
    if expected_attempt_number != current.1 + 1 {
        return Err(StoreError::Invalid(
            "Routine driver attempt number is stale.".into(),
        ));
    }
    let driver_evidence = open_json(
        store,
        &current.2,
        &driver_aad(workspace_id, owner_subject, &occurrence_id),
    )?;
    if driver_evidence.get("runId").and_then(Value::as_str) != Some(run_id.as_str()) {
        return Err(StoreError::Invalid(
            "Routine driver result does not match its leased run.".into(),
        ));
    }
    if !matches!(current.0.as_str(), "leased" | "running") {
        return Err(StoreError::Invalid(
            "Routine occurrence is no longer leased.".into(),
        ));
    }

    let next_attempt_count = current.1 + i64::from(status != "running");
    let (driver_state, occurrence_status, available_at) = match status {
        "running" => (
            "running",
            "running",
            lease_expires_at.ok_or_else(|| {
                StoreError::Invalid("Running Routine work requires a lease deadline.".into())
            })?,
        ),
        "completed" => ("done", "completed", at),
        "cancelled" => ("cancelled", "cancelled", at),
        "blocked" => ("blocked", "blocked", at),
        "failed" if next_attempt_count < 3 => (
            "queued",
            "scheduled",
            retry_at.ok_or_else(|| {
                StoreError::Invalid("Retryable Routine work requires a retry time.".into())
            })?,
        ),
        "failed" => ("dead", "failed", at),
        _ => unreachable!(),
    };
    let terminal = matches!(driver_state, "done" | "cancelled" | "blocked" | "dead");
    let changed = tx.execute(
        "UPDATE routine_driver_occurrence
         SET state=?1,available_at=?2,attempt_count=?3,updated_at=?4,
             lease_holder=CASE WHEN ?5 THEN '' ELSE lease_holder END,
             lease_token=CASE WHEN ?5 THEN '' ELSE lease_token END,
             lease_expires_at=CASE WHEN ?5 THEN NULL ELSE ?6 END
         WHERE workspace_id=?7 AND owner_subject=?8 AND occurrence_id=?9
           AND writer_epoch=?10 AND lease_token=?11 AND state IN ('leased','running');",
        rusqlite::params![
            driver_state,
            available_at,
            next_attempt_count,
            at,
            terminal || driver_state == "queued",
            lease_expires_at,
            workspace_id,
            owner_subject,
            occurrence_id,
            expected_epoch,
            lease_token
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Routine driver lease changed before its result was saved.".into(),
        ));
    }
    set_occurrence_state(
        tx,
        store,
        workspace_id,
        owner_subject,
        &occurrence_id,
        occurrence_status,
        Some(&run_id),
        next_attempt_count,
        at,
    )?;
    Ok(driver_state.to_string())
}

pub fn recover_expired_leases(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    expected_epoch: i64,
    now: &str,
) -> Result<usize> {
    let authority = read_scheduler_authority(tx, workspace_id)?
        .ok_or_else(|| StoreError::Invalid("Scheduler authority is unavailable.".into()))?;
    if authority.writer != "routine" || authority.epoch != expected_epoch {
        return Err(StoreError::Invalid(
            "Routine scheduler fence is stale.".into(),
        ));
    }
    let mut stmt = tx.prepare(
        "SELECT owner_subject,occurrence_id FROM routine_driver_occurrence
         WHERE workspace_id=?1 AND writer_epoch=?2 AND state IN ('leased','running')
           AND lease_expires_at IS NOT NULL AND lease_expires_at<=?3
         ORDER BY owner_subject,occurrence_id;",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![workspace_id, expected_epoch, now],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )?;
    let expired = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    let changed = tx.execute(
        "UPDATE routine_driver_occurrence
         SET state='queued',lease_holder='',lease_token='',lease_expires_at=NULL,
             attempt_count=attempt_count+1,updated_at=?1
         WHERE workspace_id=?2 AND writer_epoch=?3 AND state IN ('leased','running')
           AND lease_expires_at IS NOT NULL AND lease_expires_at<=?1;",
        rusqlite::params![now, workspace_id, expected_epoch],
    )?;
    for (owner, occurrence_id) in &expired {
        let attempt_count = tx.query_row(
            "SELECT attempt_count FROM routine_driver_occurrence
             WHERE workspace_id=?1 AND owner_subject=?2 AND occurrence_id=?3;",
            rusqlite::params![workspace_id, owner, occurrence_id],
            |row| row.get::<_, i64>(0),
        )?;
        set_occurrence_state(
            tx,
            store,
            workspace_id,
            owner,
            occurrence_id,
            "scheduled",
            None,
            attempt_count,
            now,
        )?;
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
fn set_occurrence_state(
    tx: &Connection,
    store: &Store,
    workspace_id: &str,
    owner_subject: &str,
    occurrence_id: &str,
    status: &str,
    run_id: Option<&str>,
    attempt_count: i64,
    at: &str,
) -> Result<()> {
    let sealed = tx.query_row(
        "SELECT payload,payload_nonce FROM routine_occurrence
         WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3;",
        rusqlite::params![workspace_id, owner_subject, occurrence_id],
        |row| {
            Ok(Sealed {
                ciphertext: row.get(0)?,
                nonce: row.get(1)?,
            })
        },
    )?;
    let mut occurrence = open_json(
        store,
        &sealed,
        &occurrence_aad(workspace_id, owner_subject, occurrence_id),
    )?;
    occurrence["status"] = Value::String(status.to_string());
    occurrence["observedAt"] = Value::String(at.to_string());
    occurrence["attemptCount"] = Value::Number(attempt_count.into());
    if let Some(run_id) = run_id {
        occurrence["runId"] = Value::String(run_id.to_string());
    }
    let sealed = seal_json(
        store,
        &occurrence,
        &occurrence_aad(workspace_id, owner_subject, occurrence_id),
    )?;
    let changed = tx.execute(
        "UPDATE routine_occurrence
         SET status=?1,observed_at=?2,run_id=COALESCE(?3,run_id),payload=?4,payload_nonce=?5
         WHERE workspace_id=?6 AND owner_subject=?7 AND id=?8;",
        rusqlite::params![
            status,
            at,
            run_id,
            sealed.ciphertext,
            sealed.nonce,
            workspace_id,
            owner_subject,
            occurrence_id
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Routine occurrence disappeared during driver settlement.".into(),
        ));
    }
    Ok(())
}

fn read_scheduler_authority(
    tx: &Connection,
    workspace_id: &str,
) -> Result<Option<SchedulerAuthorityRow>> {
    tx.query_row(
        "SELECT workspace_id,writer,phase,epoch,fence_token,proof_hash,updated_at
         FROM routine_scheduler_authority WHERE workspace_id=?1;",
        [workspace_id],
        |row| {
            Ok(SchedulerAuthorityRow {
                workspace_id: row.get(0)?,
                writer: row.get(1)?,
                phase: row.get(2)?,
                epoch: row.get(3)?,
                fence_token: row.get(4)?,
                proof_hash: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(StoreError::from)
}

fn routine_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("routine:{workspace}:{owner}:{id}")
}
fn version_aad(workspace: &str, owner: &str, id: &str, version: i64) -> String {
    format!("routine_version:{workspace}:{owner}:{id}:{version}")
}
fn trigger_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("routine_trigger:{workspace}:{owner}:{id}")
}
fn occurrence_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("routine_occurrence:{workspace}:{owner}:{id}")
}
fn driver_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("routine_driver:{workspace}:{owner}:{id}")
}
fn cursor_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("routine_cursor:{workspace}:{owner}:{id}")
}
fn authority_aad(workspace: &str) -> String {
    format!("routine_scheduler_authority:{workspace}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::{project, workspace};
    use crate::store::vault::{MasterKey, Vault};

    fn fixture() -> (Store, DataScope, PrivateDataScope) {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store
            .transaction(|tx| {
                workspace::upsert(tx, "w1", "One", "2026-01-01T00:00:00Z")?;
                Ok(())
            })
            .unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-1", Some("member-1"))
                .unwrap();
        (store, scope, private)
    }

    fn bundle() -> (Value, Value, Vec<Value>) {
        (
            serde_json::json!({
                "id":"routine-1","status":"active","title":"Daily brief",
                "currentVersion":1,"scope":{},"authorityPolicy":"no-expansion",
                "workspaceId":"w1","authority":"local","schemaVersion":1,"revision":1,
                "visibility":"member-private","ownerMemberId":"member-1",
                "createdByInternalUserId":"user-1","createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z"
            }),
            serde_json::json!({
                "routineId":"routine-1","version":1,"createdAt":"2026-01-01T00:00:00Z",
                "createdByInternalUserId":"user-1",
                "action":{"kind":"direct-request","title":"Brief","instruction":"Summarize."},
                "scope":{},"routePolicy":{"kind":"resolve-at-run"},
                "placementPolicy":{"kind":"resolve-at-run"},
                "budgets":{"capabilityGrantIds":[]},"triggerIds":["trigger-1"]
            }),
            vec![serde_json::json!({
                "id":"trigger-1","routineId":"routine-1","status":"active",
                "spec":{"kind":"time-recurring","timezone":"Europe/London",
                    "recurrence":{"frequency":"daily","expression":"0 9 * * *"},
                    "missedRunPolicy":"run-latest"},
                "deduplication":{"strategy":"per-trigger-event"},
                "workspaceId":"w1","authority":"local","schemaVersion":1,"revision":1,
                "visibility":"member-private","ownerMemberId":"member-1",
                "createdByInternalUserId":"user-1","createdAt":"2026-01-01T00:00:00Z",
                "updatedAt":"2026-01-01T00:00:00Z"
            })],
        )
    }

    #[test]
    fn routine_is_owner_scoped_encrypted_and_versions_are_immutable() {
        let (store, scope, private) = fixture();
        let (routine, version, triggers) = bundle();
        let created = store
            .transaction(|tx| {
                create(
                    tx, &store, &scope, &private, "user-1", &routine, &version, &triggers,
                )
            })
            .unwrap();
        assert_eq!(created.routine["title"], "Daily brief");
        store
            .with_conn(|tx| {
                let raw: Vec<u8> = tx.query_row(
                    "SELECT payload FROM routine_record WHERE id='routine-1'",
                    [],
                    |row| row.get(0),
                )?;
                assert!(!String::from_utf8_lossy(&raw).contains("Daily brief"));
                Ok(())
            })
            .unwrap();
        let foreign =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-2", Some("member-2"))
                .unwrap();
        assert!(store
            .with_conn(|tx| get(tx, &store, &scope, &foreign, "routine-1"))
            .unwrap()
            .is_none());
        let duplicate = store.transaction(|tx| {
            create(
                tx, &store, &scope, &private, "user-1", &routine, &version, &triggers,
            )
        });
        assert!(duplicate.is_err());
    }

    #[test]
    fn occurrence_dedup_is_exact_and_collision_fails_closed() {
        let (store, scope, private) = fixture();
        let (routine, version, triggers) = bundle();
        store
            .transaction(|tx| {
                create(
                    tx, &store, &scope, &private, "user-1", &routine, &version, &triggers,
                )
            })
            .unwrap();
        let occurrence = serde_json::json!({
            "id":"occ-1","routineId":"routine-1","triggerId":"trigger-1",
            "routineVersion":1,"status":"scheduled",
            "scheduledFor":"2026-01-02T09:00:00Z","observedAt":"2026-01-01T10:00:00Z",
            "deduplicationKey":"trigger-1:2026-01-02T09:00:00Z"
        });
        store
            .transaction(|tx| append_occurrence(tx, &store, &scope, &private, &occurrence))
            .unwrap();
        store
            .transaction(|tx| append_occurrence(tx, &store, &scope, &private, &occurrence))
            .unwrap();
        let mut conflicting = occurrence.clone();
        conflicting["id"] = Value::String("occ-2".into());
        assert!(store
            .transaction(|tx| append_occurrence(tx, &store, &scope, &private, &conflicting))
            .is_err());
        assert_eq!(
            store
                .with_conn(|tx| occurrence_history(tx, &store, &scope, &private, "routine-1"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn scheduler_cutover_is_fenced_and_expired_leases_recover() {
        let (store, scope, private) = fixture();
        let (routine, version, triggers) = bundle();
        store
            .transaction(|tx| {
                create(
                    tx, &store, &scope, &private, "user-1", &routine, &version, &triggers,
                )
            })
            .unwrap();
        let occurrence = serde_json::json!({
            "id":"occ-1","routineId":"routine-1","triggerId":"trigger-1",
            "routineVersion":1,"status":"scheduled",
            "scheduledFor":"2026-01-02T09:00:00Z","observedAt":"2026-01-01T10:00:00Z",
            "deduplicationKey":"trigger-1:2026-01-02T09:00:00Z"
        });
        store
            .transaction(|tx| append_occurrence(tx, &store, &scope, &private, &occurrence))
            .unwrap();
        let shadow = store
            .transaction(|tx| {
                transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    1,
                    "legacy",
                    "shadow",
                    "shadow-2",
                    None,
                    &serde_json::json!({"replay":"matched"}),
                    "2026-01-01T11:00:00Z",
                )
            })
            .unwrap();
        let active = store
            .transaction(|tx| {
                transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    shadow.epoch,
                    "routine",
                    "routine",
                    "routine-3",
                    Some(&format!("sha256:{}", "a".repeat(64))),
                    &serde_json::json!({"replay":"matched","legacyWriterPaused":true}),
                    "2026-01-01T12:00:00Z",
                )
            })
            .unwrap();
        store
            .transaction(|tx| {
                enqueue_driver_occurrence(
                    tx,
                    &store,
                    &scope,
                    &private,
                    "occ-1",
                    active.epoch,
                    "2026-01-02T09:00:00Z",
                    &serde_json::json!({"deduplicated":true,"runId":"run-1"}),
                )
            })
            .unwrap();
        let lease = store
            .transaction(|tx| {
                lease_due(
                    tx,
                    &store,
                    &scope,
                    &private,
                    active.epoch,
                    "node-1",
                    "lease-1",
                    "2026-01-02T09:00:00Z",
                    "2026-01-02T09:01:00Z",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(lease.occurrence_id, "occ-1");
        assert_eq!(
            store
                .transaction(|tx| {
                    recover_expired_leases(tx, &store, "w1", active.epoch, "2026-01-02T09:02:00Z")
                })
                .unwrap(),
            1
        );
        assert!(store
            .transaction(|tx| {
                lease_due(
                    tx,
                    &store,
                    &scope,
                    &private,
                    active.epoch - 1,
                    "node-1",
                    "lease-2",
                    "2026-01-02T09:02:00Z",
                    "2026-01-02T09:03:00Z",
                )
            })
            .is_err());
        let recovered_lease = store
            .transaction(|tx| {
                lease_due(
                    tx,
                    &store,
                    &scope,
                    &private,
                    active.epoch,
                    "node-1",
                    "lease-2",
                    "2026-01-02T09:02:00Z",
                    "2026-01-02T09:03:00Z",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(recovered_lease.attempt_count, 1);
        assert!(store
            .transaction(|tx| {
                report_driver_attempt(
                    tx,
                    &store,
                    "w1",
                    private.owner_subject(),
                    "occ-1",
                    active.epoch,
                    "lease-1",
                    "run-1",
                    2,
                    "completed",
                    "2026-01-02T09:02:01Z",
                    None,
                    None,
                )
            })
            .is_err());
        assert!(store
            .transaction(|tx| {
                report_driver_attempt(
                    tx,
                    &store,
                    "w1",
                    private.owner_subject(),
                    "occ-1",
                    active.epoch,
                    "lease-2",
                    "wrong-run",
                    2,
                    "completed",
                    "2026-01-02T09:02:01Z",
                    None,
                    None,
                )
            })
            .is_err());
        assert_eq!(
            store
                .transaction(|tx| {
                    report_driver_attempt(
                        tx,
                        &store,
                        "w1",
                        private.owner_subject(),
                        "occ-1",
                        active.epoch,
                        "lease-2",
                        "run-1",
                        2,
                        "completed",
                        "2026-01-02T09:02:01Z",
                        None,
                        None,
                    )
                })
                .unwrap(),
            "done"
        );
        let occurrence = store
            .with_conn(|tx| occurrence_history(tx, &store, &scope, &private, "routine-1"))
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(occurrence["status"], "completed");
        assert_eq!(occurrence["runId"], "run-1");
    }

    #[test]
    fn project_scope_must_be_owned_and_exact() {
        let (store, _, _) = fixture();
        let project_scope = DataScope::new("w1", Some("p1".into())).unwrap();
        let private = PrivateDataScope::for_authenticated_user(
            project_scope.clone(),
            "user-1",
            Some("member-1"),
        )
        .unwrap();
        store
            .transaction(|tx| {
                project::create(
                    tx,
                    &store,
                    &DataScope::workspace("w1")?,
                    "p1",
                    "member-1",
                    "user-1",
                    "Project",
                    None,
                    None,
                    "now",
                )?;
                Ok(())
            })
            .unwrap();
        let (mut routine, version, mut triggers) = bundle();
        routine["projectId"] = Value::String("p1".into());
        routine["scope"] = serde_json::json!({"projectId":"p1"});
        triggers[0]["projectId"] = Value::String("p1".into());
        assert!(store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &project_scope,
                    &private,
                    "user-1",
                    &routine,
                    &version,
                    &triggers,
                )
            })
            .is_ok());
        store
            .transaction(|tx| {
                project::delete(
                    tx,
                    &store,
                    &DataScope::workspace("w1")?,
                    "member-1",
                    "user-1",
                    "p1",
                    1,
                    "later",
                )?;
                Ok(())
            })
            .unwrap();
        let workspace_scope = DataScope::workspace("w1").unwrap();
        let workspace_private = PrivateDataScope::for_authenticated_user(
            workspace_scope.clone(),
            "user-1",
            Some("member-1"),
        )
        .unwrap();
        let detached = store
            .with_conn(|tx| list(tx, &store, &workspace_scope, &workspace_private))
            .unwrap();
        assert_eq!(detached.len(), 1);
        assert_eq!(detached[0].routine.get("projectId"), None);
        assert_eq!(detached[0].routine.pointer("/scope/projectId"), None);
        assert_eq!(detached[0].routine["updatedAt"], "later");
        assert_eq!(detached[0].triggers[0].get("projectId"), None);
        assert_eq!(detached[0].triggers[0]["updatedAt"], "later");
    }
}
