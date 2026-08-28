//! Explicit member-private standing capability grants.
//!
//! A grant is durable policy, never an approval over one exact action. Creation
//! requires a separate native approval boundary; execution still passes through
//! the exact-action approval path after this repository authorizes capability use.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    authorized_scope::AuthorizedCommandScope,
    store::{Result, Store, StoreError},
};

use super::{connection_record, open_json, seal_json};

const CONSEQUENCES: &[&str] = &[
    "read",
    "draft",
    "write",
    "publish",
    "destructive",
    "financial",
    "identity-sensitive",
];

#[derive(Clone, Debug)]
pub(crate) struct CreateCapabilityGrant<'a> {
    pub id: &'a str,
    pub capability_key: &'a str,
    pub connection_id: &'a str,
    pub connection_revision_at_grant: i64,
    pub consequence_class: &'a str,
    pub max_uses: Option<i64>,
    pub expires_at: Option<&'a str>,
    pub granted_at: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeCapabilityGrant {
    pub id: String,
    pub capability_id: String,
    pub connection_id: String,
    pub consequence: String,
    pub scope_kind: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i64>,
    pub uses_consumed: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub approval_requirement: String,
    pub revision: i64,
    pub granted_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GrantFailure {
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrantPayload {
    composition: String,
    approval_requirement: String,
    member_id: Option<String>,
    project_id: Option<String>,
    eligible_connection_id: String,
    allowed_consequence: String,
}

struct PartialCapabilityGrant {
    workspace_id: String,
    owner_subject: String,
    owner_member_id: Option<String>,
    id: String,
    revision: i64,
    capability_key: String,
    connection_id: String,
    consequence_class: String,
    scope_kind: String,
    project_id: Option<String>,
    state: String,
    max_uses: Option<i64>,
    uses_consumed: i64,
    expires_at: Option<String>,
    granted_at: String,
    updated_at: String,
    sealed: crate::store::vault::Sealed,
}

fn bounded_id(value: &str, label: &str, max: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
    {
        return Err(StoreError::Invalid(format!(
            "{label} must be 1-{max} URL-safe characters."
        )));
    }
    Ok(value.to_string())
}

fn parsed_time(value: &str, label: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| StoreError::Invalid(format!("{label} must be an RFC 3339 timestamp.")))
}

fn aad(workspace_id: &str, owner_subject: &str, id: &str) -> String {
    format!("capability_grant:{workspace_id}:{owner_subject}:{id}")
}

fn scope_parts(scope: &AuthorizedCommandScope) -> (String, String, Option<String>) {
    match scope.data.project_id() {
        Some(project_id) => (
            "project".into(),
            format!("project:{project_id}"),
            Some(project_id.to_string()),
        ),
        None => ("workspace".into(), "workspace".into(), None),
    }
}

fn read_partial(row: &rusqlite::Row<'_>) -> rusqlite::Result<PartialCapabilityGrant> {
    Ok(PartialCapabilityGrant {
        workspace_id: row.get("workspace_id")?,
        owner_subject: row.get("owner_subject")?,
        owner_member_id: row.get("owner_member_id")?,
        id: row.get("id")?,
        revision: row.get("revision")?,
        capability_key: row.get("capability_key")?,
        connection_id: row.get("connection_id")?,
        consequence_class: row.get("consequence_class")?,
        scope_kind: row.get("scope_kind")?,
        project_id: row.get("project_id")?,
        state: row.get("state")?,
        max_uses: row.get("max_uses")?,
        uses_consumed: row.get("uses_consumed")?,
        expires_at: row.get("expires_at")?,
        granted_at: row.get("granted_at")?,
        updated_at: row.get("updated_at")?,
        sealed: crate::store::vault::Sealed {
            ciphertext: row.get("payload")?,
            nonce: row.get("payload_nonce")?,
        },
    })
}

fn open_safe(row: PartialCapabilityGrant, store: &Store) -> Result<SafeCapabilityGrant> {
    let payload = open_json(
        store,
        &row.sealed,
        &aad(&row.workspace_id, &row.owner_subject, &row.id),
    )?;
    let payload: GrantPayload = serde_json::from_value(payload)
        .map_err(|_| StoreError::Invalid("Capability grant payload is invalid.".into()))?;
    if payload.composition != "default-deny"
        || payload.approval_requirement != "required-for-every-action"
    {
        return Err(StoreError::Invalid(
            "Capability grant policy is unsupported.".into(),
        ));
    }
    if payload.member_id.as_deref() != row.owner_member_id.as_deref()
        || payload.project_id != row.project_id
        || payload.eligible_connection_id != row.connection_id
        || payload.allowed_consequence != row.consequence_class
    {
        return Err(StoreError::Invalid(
            "Capability grant payload crosses its authority columns.".into(),
        ));
    }
    Ok(SafeCapabilityGrant {
        id: row.id,
        capability_id: row.capability_key,
        connection_id: row.connection_id,
        consequence: row.consequence_class,
        scope_kind: row.scope_kind,
        workspace_id: row.workspace_id,
        project_id: row.project_id,
        state: row.state,
        max_uses: row.max_uses,
        uses_consumed: row.uses_consumed,
        expires_at: row.expires_at,
        approval_requirement: payload.approval_requirement,
        revision: row.revision,
        granted_at: row.granted_at,
        updated_at: row.updated_at,
    })
}

const SELECT: &str = "SELECT workspace_id,owner_subject,owner_member_id,id,revision,
 capability_key,connection_id,consequence_class,scope_kind,scope_key,project_id,state,
 max_uses,uses_consumed,expires_at,granted_at,updated_at,payload,payload_nonce
 FROM capability_grant";

pub(crate) fn create(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    draft: CreateCapabilityGrant<'_>,
) -> Result<SafeCapabilityGrant> {
    scope.private.ensure_exists(tx)?;
    let id = bounded_id(draft.id, "Capability grant", 160)?;
    let capability_key = bounded_id(draft.capability_key, "Capability", 160)?;
    let connection_id = bounded_id(draft.connection_id, "Connection", 160)?;
    if !CONSEQUENCES.contains(&draft.consequence_class) {
        return Err(StoreError::Invalid(
            "Capability consequence is unsupported.".into(),
        ));
    }
    if draft.connection_revision_at_grant < 1 {
        return Err(StoreError::Invalid(
            "Connection revision is invalid.".into(),
        ));
    }
    if draft.max_uses.is_some_and(|value| value < 1) {
        return Err(StoreError::Invalid(
            "Capability grant use limit must be positive.".into(),
        ));
    }
    let granted_at = parsed_time(draft.granted_at, "Grant time")?;
    if let Some(expires_at) = draft.expires_at {
        if parsed_time(expires_at, "Grant expiry")? <= granted_at {
            return Err(StoreError::Invalid(
                "Capability grant expiry must be after its grant time.".into(),
            ));
        }
    }
    let connection_scope = crate::authorized_scope::resolve(
        tx,
        Some(scope.data.workspace_id()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let connection = connection_record::get(tx, store, &connection_scope, &connection_id)?
        .ok_or_else(|| StoreError::Invalid("Capability grant Connection is unavailable.".into()))?;
    if connection.revision != draft.connection_revision_at_grant {
        return Err(StoreError::Invalid(
            "Capability grant Connection changed before confirmation.".into(),
        ));
    }
    let (scope_kind, scope_key, project_id) = scope_parts(scope);
    let payload = GrantPayload {
        composition: "default-deny".into(),
        approval_requirement: "required-for-every-action".into(),
        member_id: scope.member_id.clone(),
        project_id: project_id.clone(),
        eligible_connection_id: connection_id.clone(),
        allowed_consequence: draft.consequence_class.into(),
    };
    let sealed = seal_json(
        store,
        &serde_json::to_value(payload)
            .map_err(|_| StoreError::Invalid("Capability grant is invalid.".into()))?,
        &aad(
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            &id,
        ),
    )?;
    tx.execute(
        "INSERT INTO capability_grant(
           workspace_id,owner_subject,owner_member_id,id,revision,capability_key,connection_id,
           connection_revision_at_grant,consequence_class,scope_kind,scope_key,project_id,state,
           max_uses,uses_consumed,expires_at,granted_by_internal_user_id,granted_at,updated_at,
           payload,payload_nonce)
         VALUES(?1,?2,?3,?4,1,?5,?6,?7,?8,?9,?10,?11,'active',?12,0,?13,?14,?15,?15,?16,?17)",
        rusqlite::params![
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            scope.member_id,
            id,
            capability_key,
            connection_id,
            draft.connection_revision_at_grant,
            draft.consequence_class,
            scope_kind,
            scope_key,
            project_id,
            draft.max_uses,
            draft.expires_at,
            scope.internal_user_id,
            draft.granted_at,
            sealed.ciphertext,
            sealed.nonce,
        ],
    )?;
    get(tx, store, scope, draft.id)?.ok_or_else(|| {
        StoreError::Invalid("Capability grant could not be read after creation.".into())
    })
}

pub(crate) fn get(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
) -> Result<Option<SafeCapabilityGrant>> {
    let sql = format!("{SELECT} WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3");
    tx.query_row(
        &sql,
        rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject(), id],
        read_partial,
    )
    .optional()?
    .map(|row| open_safe(row, store))
    .transpose()
}

pub(crate) fn list(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Vec<SafeCapabilityGrant>> {
    let sql =
        format!("{SELECT} WHERE workspace_id=?1 AND owner_subject=?2 ORDER BY updated_at DESC,id");
    let mut statement = tx.prepare(&sql)?;
    let rows = statement
        .query_map(
            rusqlite::params![scope.data.workspace_id(), scope.private.owner_subject()],
            read_partial,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|row| open_safe(row, store)).collect()
}

pub(crate) fn authorize_and_consume(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    capability_key: &str,
    connection_id: &str,
    consequence: &str,
    now: &str,
) -> Result<std::result::Result<Vec<SafeCapabilityGrant>, GrantFailure>> {
    let now = parsed_time(now, "Capability use time")?;
    let active = match check(
        tx,
        store,
        scope,
        capability_key,
        connection_id,
        consequence,
        &now.to_rfc3339(),
    )? {
        Ok(active) => active,
        Err(failure) => return Ok(Err(failure)),
    };
    for grant in &active {
        let changed = tx.execute(
            "UPDATE capability_grant SET uses_consumed=uses_consumed+1,revision=revision+1,updated_at=?1
             WHERE workspace_id=?2 AND owner_subject=?3 AND id=?4 AND revision=?5 AND state='active'
               AND (max_uses IS NULL OR uses_consumed < max_uses)",
            rusqlite::params![
                now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                scope.data.workspace_id(),
                scope.private.owner_subject(),
                grant.id,
                grant.revision,
            ],
        )?;
        if changed != 1 {
            return Ok(Err(GrantFailure {
                code: "budget-exhausted",
                message: "Capability grant authority changed before execution.",
            }));
        }
    }
    let mut consumed = Vec::with_capacity(active.len());
    for grant in active {
        consumed.push(get(tx, store, scope, &grant.id)?.ok_or_else(|| {
            StoreError::Invalid("Capability grant disappeared during use.".into())
        })?);
    }
    Ok(Ok(consumed))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn authorize_and_consume_exact(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    grant_id: &str,
    capability_key: &str,
    connection_id: &str,
    consequence: &str,
    now: &str,
) -> Result<std::result::Result<SafeCapabilityGrant, GrantFailure>> {
    let now = parsed_time(now, "Capability use time")?;
    let active = match check(
        tx,
        store,
        scope,
        capability_key,
        connection_id,
        consequence,
        &now.to_rfc3339(),
    )? {
        Ok(active) => active,
        Err(failure) => return Ok(Err(failure)),
    };
    let Some(grant) = active.into_iter().find(|grant| grant.id == grant_id) else {
        return Ok(Err(GrantFailure {
            code: "grant-missing",
            message:
                "The worker's exact capability grant is not active for this Connection and scope.",
        }));
    };
    let changed = tx.execute(
        "UPDATE capability_grant SET uses_consumed=uses_consumed+1,revision=revision+1,updated_at=?1
         WHERE workspace_id=?2 AND owner_subject=?3 AND id=?4 AND revision=?5 AND state='active'
           AND (max_uses IS NULL OR uses_consumed < max_uses)",
        rusqlite::params![now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), scope.data.workspace_id(), scope.private.owner_subject(), grant.id, grant.revision],
    )?;
    if changed != 1 {
        return Ok(Err(GrantFailure {
            code: "budget-exhausted",
            message: "The worker's capability grant changed before execution.",
        }));
    }
    Ok(Ok(get(tx, store, scope, grant_id)?.ok_or_else(|| {
        StoreError::Invalid("Capability grant disappeared during use.".into())
    })?))
}

pub(crate) fn check(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    capability_key: &str,
    connection_id: &str,
    consequence: &str,
    now: &str,
) -> Result<std::result::Result<Vec<SafeCapabilityGrant>, GrantFailure>> {
    let now = parsed_time(now, "Capability check time")?;
    let project_id = scope.data.project_id();
    let candidates = list(tx, store, scope)?
        .into_iter()
        .filter(|grant| {
            grant.capability_id == capability_key
                && grant.connection_id == connection_id
                && grant.consequence == consequence
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(Err(GrantFailure {
            code: "grant-missing",
            message: "This capability has no explicit grant for the selected Connection and scope.",
        }));
    }
    let grants = candidates
        .into_iter()
        .filter(|grant| {
            grant.scope_kind == "workspace"
                || (grant.scope_kind == "project" && grant.project_id.as_deref() == project_id)
        })
        .collect::<Vec<_>>();
    if grants.is_empty() {
        return Ok(Err(GrantFailure {
            code: "scope-denied",
            message: "The capability grant does not include this project scope.",
        }));
    }
    // An exact project grant is the least-privilege authority for a project
    // action. Fall back to workspace authority only when no project-specific
    // policy exists; never consume both budgets for one action.
    let has_project_policy = project_id.is_some()
        && grants.iter().any(|grant| {
            grant.scope_kind == "project" && grant.project_id.as_deref() == project_id
        });
    let active = grants
        .into_iter()
        .filter(|grant| !has_project_policy || grant.scope_kind == "project")
        .filter(|grant| grant.state == "active")
        .collect::<Vec<_>>();
    if active.is_empty()
        || active.iter().any(|grant| {
            grant
                .expires_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|expires| expires.with_timezone(&Utc) <= now)
        })
    {
        return Ok(Err(GrantFailure {
            code: "grant-expired-or-revoked",
            message: "The matching capability grant is expired, suspended, or revoked.",
        }));
    }
    if active.iter().any(|grant| {
        grant
            .max_uses
            .is_some_and(|limit| grant.uses_consumed >= limit)
    }) {
        return Ok(Err(GrantFailure {
            code: "budget-exhausted",
            message: "The matching capability grant has reached its use limit.",
        }));
    }
    Ok(Ok(active))
}

pub(crate) fn revoke(
    tx: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
    expected_revision: i64,
    now: &str,
) -> Result<SafeCapabilityGrant> {
    parsed_time(now, "Revocation time")?;
    let changed = tx.execute(
        "UPDATE capability_grant SET state='revoked',revoked_at=?1,updated_at=?1,revision=revision+1
         WHERE workspace_id=?2 AND owner_subject=?3 AND id=?4 AND revision=?5 AND state='active'",
        rusqlite::params![
            now,
            scope.data.workspace_id(),
            scope.private.owner_subject(),
            id,
            expected_revision,
        ],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Capability grant changed before revocation.".into(),
        ));
    }
    get(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("Capability grant disappeared after revocation.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authorized_scope::{resolve, ScopeAccess};
    use crate::store::repos::connection_record::{
        upsert_native_connector, NativeConnectorConnectionWrite,
    };
    use crate::store::vault::{MasterKey, Vault};

    fn setup() -> (Store, AuthorizedCommandScope, String) {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = store
            .transaction(|tx| resolve(tx, None, None, ScopeAccess::Write))
            .unwrap();
        let connection = store
            .transaction(|tx| {
                upsert_native_connector(
                    tx,
                    &store,
                    &scope,
                    NativeConnectorConnectionWrite {
                        connector_definition_key: "notion",
                        external_account_id: "private-provider-account",
                        display_name: "Work Notion",
                        lifecycle: "authorized",
                        authorization_state: "authorized",
                        health_state: "healthy",
                        credential_state: "available",
                        expected_revision: None,
                        updated_at: "2026-07-11T20:00:00Z",
                    },
                )
            })
            .unwrap();
        (store, scope, connection.id)
    }

    #[test]
    fn explicit_grant_is_encrypted_bounded_consumed_and_revocable() {
        let (store, scope, connection_id) = setup();
        let grant = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    CreateCapabilityGrant {
                        id: "grant-a",
                        capability_key: "knowledge.content.search",
                        connection_id: &connection_id,
                        connection_revision_at_grant: 1,
                        consequence_class: "read",
                        max_uses: Some(1),
                        expires_at: Some("2026-07-12T20:00:00Z"),
                        granted_at: "2026-07-11T20:00:00Z",
                    },
                )
            })
            .unwrap();
        assert_eq!(grant.approval_requirement, "required-for-every-action");
        assert_eq!(grant.scope_kind, "workspace");
        assert_eq!(grant.uses_consumed, 0);

        let payload = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT payload FROM capability_grant WHERE id='grant-a'",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        let raw = String::from_utf8_lossy(&payload);
        assert!(!raw.contains("knowledge.content.search"));
        assert!(!raw.contains("member-a"));

        let consumed = store
            .transaction(|tx| {
                authorize_and_consume(
                    tx,
                    &store,
                    &scope,
                    "knowledge.content.search",
                    &connection_id,
                    "read",
                    "2026-07-11T20:01:00Z",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(consumed[0].uses_consumed, 1);
        let exhausted = store
            .transaction(|tx| {
                authorize_and_consume(
                    tx,
                    &store,
                    &scope,
                    "knowledge.content.search",
                    &connection_id,
                    "read",
                    "2026-07-11T20:02:00Z",
                )
            })
            .unwrap()
            .unwrap_err();
        assert_eq!(exhausted.code, "budget-exhausted");

        let revoked = store
            .transaction(|tx| {
                revoke(
                    tx,
                    &store,
                    &scope,
                    "grant-a",
                    consumed[0].revision,
                    "2026-07-11T20:03:00Z",
                )
            })
            .unwrap();
        assert_eq!(revoked.state, "revoked");
    }

    #[test]
    fn exact_worker_grant_never_substitutes_or_consumes_a_sibling() {
        let (store, scope, connection_id) = setup();
        store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    CreateCapabilityGrant {
                        id: "grant-sibling",
                        capability_key: "knowledge.content.search",
                        connection_id: &connection_id,
                        connection_revision_at_grant: 1,
                        consequence_class: "read",
                        max_uses: Some(2),
                        expires_at: None,
                        granted_at: "2026-07-11T20:00:00Z",
                    },
                )
            })
            .unwrap();
        let missing = store
            .transaction(|tx| {
                authorize_and_consume_exact(
                    tx,
                    &store,
                    &scope,
                    "grant-worker",
                    "knowledge.content.search",
                    &connection_id,
                    "read",
                    "2026-07-11T20:01:00Z",
                )
            })
            .unwrap()
            .unwrap_err();
        assert_eq!(missing.code, "grant-missing");
        let sibling = store
            .with_conn(|tx| get(tx, &store, &scope, "grant-sibling"))
            .unwrap()
            .unwrap();
        assert_eq!(sibling.uses_consumed, 0);
        let consumed = store
            .transaction(|tx| {
                authorize_and_consume_exact(
                    tx,
                    &store,
                    &scope,
                    "grant-sibling",
                    "knowledge.content.search",
                    &connection_id,
                    "read",
                    "2026-07-11T20:02:00Z",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(consumed.uses_consumed, 1);
    }

    #[test]
    fn missing_grant_and_connection_revision_change_fail_closed() {
        let (store, scope, connection_id) = setup();
        let missing = store
            .with_conn(|tx| {
                check(
                    tx,
                    &store,
                    &scope,
                    "knowledge.content.search",
                    &connection_id,
                    "read",
                    "2026-07-11T20:00:00Z",
                )
            })
            .unwrap()
            .unwrap_err();
        assert_eq!(missing.code, "grant-missing");
        let changed = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    CreateCapabilityGrant {
                        id: "grant-stale",
                        capability_key: "knowledge.content.search",
                        connection_id: &connection_id,
                        connection_revision_at_grant: 2,
                        consequence_class: "read",
                        max_uses: None,
                        expires_at: None,
                        granted_at: "2026-07-11T20:00:00Z",
                    },
                )
            })
            .unwrap_err();
        assert!(changed.to_string().contains("changed before confirmation"));
    }
}
