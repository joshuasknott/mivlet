//! Owner-qualified durable artifacts and immutable version history.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::repos::{open_json, payload_of, scope::PrivateDataScope, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

fn artifact_aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "artifact:{}:{}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

fn version_aad(scope: &PrivateDataScope, artifact_id: &str, id: &str) -> String {
    format!(
        "artifact_version:{}:{}:{artifact_id}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

fn review_aad(scope: &PrivateDataScope, artifact_id: &str, id: &str) -> String {
    format!(
        "artifact_review:{}:{}:{artifact_id}:{id}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}

#[allow(clippy::too_many_arguments)]
pub fn create_private(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
    run_id: &str,
    thread_id: &str,
    message_id: &str,
    kind: &str,
    title_fingerprint: &str,
    fingerprint: &str,
    size_bytes: usize,
    created_at: &str,
    artifact_value: &Value,
    version_value: &Value,
) -> Result<Value> {
    scope.ensure_exists(tx)?;
    validate_source_response(
        tx,
        store,
        scope,
        run_id,
        thread_id,
        message_id,
        version_value,
    )?;
    if let Some(existing) = get_bundle(tx, store, scope, id)? {
        let same = existing
            .pointer("/artifact/producingRunId")
            .and_then(Value::as_str)
            == Some(run_id)
            && existing.get("sourceMessageId").and_then(Value::as_str) == Some(message_id)
            && existing
                .pointer("/currentVersion/contentHash/value")
                .and_then(Value::as_str)
                == Some(fingerprint);
        return if same {
            Ok(existing)
        } else {
            Err(StoreError::Invalid("Artifact id is already in use.".into()))
        };
    }
    let version_id = version_value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Artifact version id is missing.".into()))?;
    let sealed_artifact = seal_json(store, artifact_value, &artifact_aad(scope, id))?;
    let sealed_version = seal_json(store, version_value, &version_aad(scope, id, version_id))?;
    tx.execute(
        "INSERT INTO artifact
         (workspace_id,owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,
          id,run_id,thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,
          content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,'local','member-private',?3,?4,?5,?6,?7,?8,?9,'draft',1,?10,?11,?12,?13,?14,?14,?15,?16)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),scope.owner_member_id(),
            scope.owner_internal_user_id(),id,run_id,thread_id,message_id,kind,version_id,title_fingerprint,
            fingerprint,size_bytes as i64,created_at,sealed_artifact.ciphertext,sealed_artifact.nonce],
    )?;
    tx.execute(
        "INSERT INTO artifact_version
         (workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,1,'available',?5,?6,?7,?8,?9)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),id,version_id,fingerprint,
            size_bytes as i64,created_at,sealed_version.ciphertext,sealed_version.nonce],
    )?;
    get_bundle(tx, store, scope, id)?
        .ok_or_else(|| StoreError::Invalid("Artifact creation did not persist.".into()))
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &crate::store::repos::scope::DataScope,
    id: &str,
    run_id: &str,
    thread_id: &str,
    message_id: &str,
    kind: &str,
    fingerprint: &str,
    size_bytes: usize,
    created_at: &str,
    payload: &Value,
) -> Result<Value> {
    let private =
        PrivateDataScope::for_authenticated_user(scope.clone(), "legacy-test-user", None)?;
    let artifact = payload
        .get("artifact")
        .cloned()
        .unwrap_or_else(|| json!({"id":id,"producingRunId":run_id}));
    let version = payload
        .get("version")
        .cloned()
        .ok_or_else(|| StoreError::Invalid("Artifact test version is missing.".into()))?;
    create_private(
        tx,
        store,
        &private,
        id,
        run_id,
        thread_id,
        message_id,
        kind,
        "test-title",
        fingerprint,
        size_bytes,
        created_at,
        &artifact,
        &version,
    )
}

fn validate_source_response(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    run_id: &str,
    thread_id: &str,
    message_id: &str,
    version: &Value,
) -> Result<()> {
    let run_thread: Option<Option<String>> = tx
        .query_row(
            "SELECT thread_id FROM run WHERE id=?1 AND workspace_id=?2",
            rusqlite::params![run_id, scope.workspace_id()],
            |row| row.get(0),
        )
        .optional()?;
    if run_thread.flatten().as_deref() != Some(thread_id) {
        return Err(StoreError::Invalid(
            "Artifact run does not belong to this conversation.".into(),
        ));
    }
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2 AND authority='local'
          AND visibility='member-private' AND deleted_at IS NULL
          AND (owner_member_id=?3 OR (?3 IS NULL AND owner_member_id IS NULL)))",
        rusqlite::params![thread_id, scope.workspace_id(), scope.owner_member_id()],
        |row| row.get(0),
    )?;
    if !owns_thread {
        return Err(StoreError::Invalid(
            "Artifact conversation is unavailable for this owner.".into(),
        ));
    }
    let revision = tx
        .query_row(
            "SELECT m.current_revision_id,r.payload,r.payload_nonce FROM message m
         JOIN message_revision r ON r.id=m.current_revision_id
         WHERE m.id=?1 AND m.thread_id=?2 AND m.workspace_id=?3 AND m.run_id=?4
           AND m.kind='assistant' AND m.current_revision_state='terminal' AND m.deleted_at IS NULL",
            rusqlite::params![message_id, thread_id, scope.workspace_id(), run_id],
            |row| Ok((row.get::<_, String>(0)?, payload_of(row)?)),
        )
        .optional()?;
    let Some((revision_id, sealed)) = revision else {
        return Err(StoreError::Invalid(
            "Only a completed assistant response can become an artifact.".into(),
        ));
    };
    let durable = open_json(
        store,
        &sealed,
        &format!("message-revision:{}:{revision_id}", scope.workspace_id()),
    )?;
    if durable.as_str() != version.pointer("/content/text").and_then(Value::as_str) {
        return Err(StoreError::Invalid(
            "Artifact content no longer matches the completed response.".into(),
        ));
    }
    Ok(())
}

pub fn get_bundle(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    id: &str,
) -> Result<Option<Value>> {
    scope.ensure_exists(tx)?;
    let row = tx.query_row(
        "SELECT current_version_id,source_message_id,payload,payload_nonce FROM artifact
         WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3 AND authority='local' AND visibility='member-private'",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?,payload_of(row)?)),
    ).optional()?;
    let Some((current_id, source_message_id, sealed)) = row else {
        return Ok(None);
    };
    let mut artifact = open_json(store, &sealed, &artifact_aad(scope, id))?;
    let reviews = list_reviews(tx, store, scope, id)?;
    let object = artifact
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid("Artifact payload is invalid.".into()))?;
    object.insert("reviews".into(), Value::Array(reviews));
    let versions = list_versions(tx, store, scope, id)?;
    let current = versions
        .iter()
        .find(|version| version.get("id").and_then(Value::as_str) == Some(&current_id))
        .cloned()
        .ok_or_else(|| StoreError::Invalid("Artifact current version is unavailable.".into()))?;
    Ok(Some(
        json!({"artifact":artifact,"currentVersion":current,"versions":versions,"sourceMessageId":source_message_id}),
    ))
}

pub fn list_reviews(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
) -> Result<Vec<Value>> {
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM artifact_review
         WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 ORDER BY requested_at,id",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), artifact_id],
        |row| Ok((row.get::<_, String>(0)?, payload_of(row)?)),
    )?;
    rows.map(|row| {
        let (id, sealed) = row?;
        open_json(store, &sealed, &review_aad(scope, artifact_id, &id))
    })
    .collect()
}

#[allow(clippy::too_many_arguments)]
pub fn review_action(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
    version_id: &str,
    expected_revision: i64,
    action: &str,
    actor_internal_user_id: &str,
    note: Option<&str>,
    requested_changes: &[String],
    at: &str,
) -> Result<Value> {
    scope.ensure_exists(tx)?;
    let row=tx.query_row(
        "SELECT revision,current_version_id,status,payload,payload_nonce FROM artifact
         WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3 AND authority='local' AND visibility='member-private'",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id],
        |row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,payload_of(row)?)),
    ).optional()?.ok_or_else(||StoreError::Invalid("Artifact is unavailable for this owner.".into()))?;
    if row.0 != expected_revision {
        return Err(StoreError::Invalid(
            "Artifact changed elsewhere. Reload it and try again.".into(),
        ));
    }
    if row.1 != version_id {
        return Err(StoreError::Invalid(
            "Only the current artifact version can be reviewed.".into(),
        ));
    }
    let version_available: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM artifact_version WHERE workspace_id=?1 AND owner_subject=?2
          AND artifact_id=?3 AND id=?4 AND status='available')",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            artifact_id,
            version_id
        ],
        |row| row.get(0),
    )?;
    if !version_available {
        return Err(StoreError::Invalid(
            "Artifact version is unavailable.".into(),
        ));
    }
    let mut artifact_value = open_json(store, &row.3, &artifact_aad(scope, artifact_id))?;
    let (review_id, next_artifact_status) = match action {
        "request-review" => {
            if row.2 != "draft" {
                return Err(StoreError::Invalid(
                    "Only a draft artifact can request review.".into(),
                ));
            }
            let open:bool=tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM artifact_review WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 AND status='requested')",
                rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id],|row|row.get(0))?;
            if open {
                return Err(StoreError::Invalid(
                    "Artifact already has an open review.".into(),
                ));
            }
            let review_id = format!("review:{artifact_id}:r{}", expected_revision + 1);
            let mut review = json!({
                "id":review_id,"status":"requested","requestedByInternalUserId":actor_internal_user_id,
                "versionId":version_id,"requestedAt":at
            });
            if let Some(member) = scope.owner_member_id() {
                review["reviewerMemberId"] = Value::String(member.into())
            }
            if let Some(note) = note {
                review["summary"] = Value::String(note.into())
            }
            let sealed = seal_json(store, &review, &review_aad(scope, artifact_id, &review_id))?;
            tx.execute(
                "INSERT INTO artifact_review(workspace_id,owner_subject,artifact_id,id,version_id,status,
                  requested_by_internal_user_id,reviewer_member_id,requested_at,payload,payload_nonce)
                 VALUES (?1,?2,?3,?4,?5,'requested',?6,?7,?8,?9,?10)",
                rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id,review_id,version_id,
                    actor_internal_user_id,scope.owner_member_id(),at,sealed.ciphertext,sealed.nonce])?;
            (review_id, "in-review")
        }
        "request-changes" | "accept" => {
            if row.2 != "in-review" {
                return Err(StoreError::Invalid(
                    "Artifact has no open current-version review.".into(),
                ));
            }
            let open=tx.query_row(
                "SELECT id,payload,payload_nonce FROM artifact_review WHERE workspace_id=?1 AND owner_subject=?2
                  AND artifact_id=?3 AND version_id=?4 AND status='requested'",
                rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id,version_id],
                |row|Ok((row.get::<_,String>(0)?,payload_of(row)?)),
            ).optional()?.ok_or_else(||StoreError::Invalid("Artifact has no open current-version review.".into()))?;
            let mut review = open_json(store, &open.1, &review_aad(scope, artifact_id, &open.0))?;
            let (review_status, artifact_status) = if action == "accept" {
                ("approved", "accepted")
            } else {
                ("changes-requested", "changes-requested")
            };
            review["status"] = Value::String(review_status.into());
            review["resolvedAt"] = Value::String(at.into());
            if let Some(note) = note {
                review["summary"] = Value::String(note.into())
            }
            if action == "accept" {
                review["acceptance"] =
                    json!({"acceptedByInternalUserId":actor_internal_user_id,"acceptedAt":at});
                if let Some(note) = note {
                    review["acceptance"]["note"] = Value::String(note.into())
                }
            } else {
                review["requestedChanges"] = json!(requested_changes);
            }
            let sealed = seal_json(store, &review, &review_aad(scope, artifact_id, &open.0))?;
            let changed = tx.execute(
                "UPDATE artifact_review SET status=?1,resolved_at=?2,payload=?3,payload_nonce=?4
                 WHERE workspace_id=?5 AND owner_subject=?6 AND id=?7 AND status='requested'",
                rusqlite::params![
                    review_status,
                    at,
                    sealed.ciphertext,
                    sealed.nonce,
                    scope.workspace_id(),
                    scope.owner_subject(),
                    open.0
                ],
            )?;
            if changed != 1 {
                return Err(StoreError::Invalid(
                    "Artifact review changed elsewhere.".into(),
                ));
            }
            (open.0, artifact_status)
        }
        _ => {
            return Err(StoreError::Invalid(
                "That artifact review action is not supported yet.".into(),
            ))
        }
    };
    let object = artifact_value
        .as_object_mut()
        .ok_or_else(|| StoreError::Invalid("Artifact payload is invalid.".into()))?;
    object.insert("status".into(), Value::String(next_artifact_status.into()));
    object.insert("revision".into(), json!(expected_revision + 1));
    object.insert("updatedAt".into(), Value::String(at.into()));
    let sealed = seal_json(store, &artifact_value, &artifact_aad(scope, artifact_id))?;
    let changed=tx.execute(
        "UPDATE artifact SET status=?1,revision=?2,updated_at=?3,payload=?4,payload_nonce=?5
         WHERE workspace_id=?6 AND owner_subject=?7 AND id=?8 AND revision=?9 AND current_version_id=?10",
        rusqlite::params![next_artifact_status,expected_revision+1,at,sealed.ciphertext,sealed.nonce,
            scope.workspace_id(),scope.owner_subject(),artifact_id,expected_revision,version_id])?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Artifact changed elsewhere. Reload it and try again.".into(),
        ));
    }
    let _ = review_id;
    get_bundle(tx, store, scope, artifact_id)?
        .ok_or_else(|| StoreError::Invalid("Artifact review did not persist.".into()))
}

#[cfg(test)]
pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &crate::store::repos::scope::DataScope,
    id: &str,
) -> Result<Option<Value>> {
    let private =
        PrivateDataScope::for_authenticated_user(scope.clone(), "legacy-test-user", None)?;
    Ok(get_bundle(tx, store, &private, id)?.map(|bundle| {
        json!({
            "artifact":bundle["artifact"].clone(),"version":bundle["currentVersion"].clone(),
            "sourceMessageId":bundle.get("sourceMessageId").cloned().unwrap_or(Value::Null)
        })
    }))
}

pub fn list_versions(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
) -> Result<Vec<Value>> {
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM artifact_version
         WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 ORDER BY version,id",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), artifact_id],
        |row| Ok((row.get::<_, String>(0)?, payload_of(row)?)),
    )?;
    rows.map(|row| {
        let (id, sealed) = row?;
        open_json(store, &sealed, &version_aad(scope, artifact_id, &id))
    })
    .collect()
}

pub fn list_for_thread(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    thread_id: &str,
) -> Result<Vec<Value>> {
    scope.ensure_exists(tx)?;
    let mut stmt = tx.prepare(
        "SELECT id FROM artifact WHERE workspace_id=?1 AND owner_subject=?2 AND thread_id=?3
         AND authority='local' AND visibility='member-private' ORDER BY created_at,id",
    )?;
    let ids = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), thread_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    ids.into_iter()
        .map(|id| {
            get_bundle(tx, store, scope, &id)?
                .ok_or_else(|| StoreError::Invalid("Artifact disappeared during listing.".into()))
        })
        .collect()
}

pub struct ArtifactSearchFilter<'a> {
    pub query: Option<&'a str>,
    pub thread_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub kinds: &'a [String],
    pub statuses: &'a [String],
    pub limit: usize,
}

fn exact_owner_thread(tx: &Connection, scope: &PrivateDataScope, thread_id: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2
           AND authority='local' AND visibility='member-private' AND deleted_at IS NULL
           AND ((?3 IS NOT NULL AND owner_member_id=?3)
             OR (?3 IS NULL AND owner_member_id IS NULL)))",
        rusqlite::params![thread_id, scope.workspace_id(), scope.owner_member_id()],
        |row| row.get(0),
    )?)
}

fn exact_owner_project(
    tx: &Connection,
    scope: &PrivateDataScope,
    project_id: &str,
) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM project WHERE id=?1 AND workspace_id=?2
           AND authority='local' AND visibility='member-private' AND deleted_at IS NULL
           AND lifecycle!='deleted'
           AND ((?3 IS NOT NULL AND owner_member_id=?3)
             OR (?3 IS NULL AND owner_member_id IS NULL AND created_by_internal_user_id=?4)))",
        rusqlite::params![
            project_id,
            scope.workspace_id(),
            scope.owner_member_id(),
            scope.owner_internal_user_id()
        ],
        |row| row.get(0),
    )?)
}

fn includes_case_insensitive(value: Option<&str>, query: &str) -> bool {
    value.is_some_and(|value| value.to_lowercase().contains(query))
}

fn array_field_matches(value: &Value, pointer: &str, field: &str, query: &str) -> bool {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                includes_case_insensitive(item.get(field).and_then(Value::as_str), query)
            })
        })
}

pub fn search(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    filter: &ArtifactSearchFilter<'_>,
) -> Result<Vec<Value>> {
    scope.ensure_exists(tx)?;
    if let Some(thread_id) = filter.thread_id {
        if !exact_owner_thread(tx, scope, thread_id)? {
            return Err(StoreError::Invalid(
                "Artifact conversation is unavailable for this owner.".into(),
            ));
        }
    }
    if let Some(project_id) = filter.project_id {
        if !exact_owner_project(tx, scope, project_id)? {
            return Err(StoreError::Invalid(
                "Artifact project is unavailable for this owner.".into(),
            ));
        }
    }

    let mut sql = String::from(
        "SELECT a.id,a.current_version_id,a.payload,a.payload_nonce,v.payload,v.payload_nonce
         FROM artifact a
         JOIN artifact_version v ON v.workspace_id=a.workspace_id AND v.owner_subject=a.owner_subject
           AND v.artifact_id=a.id AND v.id=a.current_version_id
         LEFT JOIN thread t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id
         WHERE a.workspace_id=? AND a.owner_subject=? AND a.authority='local'
           AND a.visibility='member-private' AND a.status!='deleted' AND v.status='available'",
    );
    let mut params = vec![
        rusqlite::types::Value::Text(scope.workspace_id().into()),
        rusqlite::types::Value::Text(scope.owner_subject().into()),
    ];
    if let Some(thread_id) = filter.thread_id {
        sql.push_str(" AND a.thread_id=?");
        params.push(rusqlite::types::Value::Text(thread_id.into()));
    }
    if let Some(project_id) = filter.project_id {
        sql.push_str(
            " AND t.project_id=? AND t.authority='local' AND t.visibility='member-private'
              AND t.deleted_at IS NULL
              AND ((? IS NOT NULL AND t.owner_member_id=?)
                OR (? IS NULL AND t.owner_member_id IS NULL))",
        );
        params.push(rusqlite::types::Value::Text(project_id.into()));
        for _ in 0..3 {
            params.push(
                scope
                    .owner_member_id()
                    .map(|value| rusqlite::types::Value::Text(value.into()))
                    .unwrap_or(rusqlite::types::Value::Null),
            );
        }
    }
    for (column, values) in [("a.kind", filter.kinds), ("a.status", filter.statuses)] {
        if !values.is_empty() {
            sql.push_str(&format!(
                " AND {column} IN ({})",
                std::iter::repeat_n("?", values.len())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
            params.extend(values.iter().cloned().map(rusqlite::types::Value::Text));
        }
    }
    let result_limit = filter.limit.clamp(1, 50);
    let candidate_limit = (result_limit.saturating_mul(4)).clamp(50, 200);
    sql.push_str(" ORDER BY a.updated_at DESC,a.id LIMIT ?");
    params.push(rusqlite::types::Value::Integer(candidate_limit as i64));
    let mut stmt = tx.prepare(&sql)?;
    let candidates = stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                Sealed {
                    ciphertext: row.get(2)?,
                    nonce: row.get(3)?,
                },
                Sealed {
                    ciphertext: row.get(4)?,
                    nonce: row.get(5)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let query = filter.query.map(str::to_lowercase);
    let mut results = Vec::new();
    for (artifact_id, version_id, artifact_sealed, version_sealed) in candidates {
        let artifact_value =
            open_json(store, &artifact_sealed, &artifact_aad(scope, &artifact_id))?;
        let version_value = open_json(
            store,
            &version_sealed,
            &version_aad(scope, &artifact_id, &version_id),
        )?;
        let mut matched_on = Vec::new();
        if let Some(query) = query.as_deref() {
            if includes_case_insensitive(artifact_value.get("title").and_then(Value::as_str), query)
            {
                matched_on.push("title");
            }
            if includes_case_insensitive(
                version_value
                    .pointer("/content/text")
                    .and_then(Value::as_str),
                query,
            ) {
                matched_on.push("content");
            }
            if array_field_matches(&version_value, "/citations", "label", query)
                || array_field_matches(&version_value, "/inputs", "label", query)
                || array_field_matches(
                    &artifact_value,
                    "/sourceProvenance",
                    "externalReference",
                    query,
                )
            {
                matched_on.push("source");
            }
            if array_field_matches(&version_value, "/decisions", "summary", query) {
                matched_on.push("decision");
            }
            if matched_on.is_empty() {
                continue;
            }
        }
        let bundle = get_bundle(tx, store, scope, &artifact_id)?
            .ok_or_else(|| StoreError::Invalid("Artifact disappeared during search.".into()))?;
        results.push(json!({
            "artifact":bundle["artifact"].clone(),
            "currentVersion":bundle["currentVersion"].clone(),
            "matchedOn":matched_on,
        }));
        if results.len() == result_limit {
            break;
        }
    }
    Ok(results)
}

fn safe_locator(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("urn:") {
        return true;
    }
    !value.is_empty()
        && !value.starts_with(['/', '\\', '~'])
        && !value.contains(['/', '\\'])
        && !(value.len() > 1 && value.as_bytes()[1] == b':')
        && !lower.starts_with("file:")
}

fn sanitized_source(source: &Value) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "kind",
        "runId",
        "connectionId",
        "artifactVersionId",
        "observedAt",
    ] {
        if let Some(value) = source.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    if let Some(reference) = source.get("externalReference").and_then(Value::as_str) {
        if safe_locator(reference) {
            output.insert("externalReference".into(), Value::String(reference.into()));
        }
    }
    Value::Object(output)
}

fn sanitized_citations(version: &Value) -> Vec<Value> {
    version
        .get("citations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|citation| {
            let source = citation.get("source")?;
            let mut output = serde_json::Map::new();
            for key in ["id", "label", "quotedText", "contentHash"] {
                if let Some(value) = citation.get(key) {
                    output.insert(key.into(), value.clone());
                }
            }
            output.insert("source".into(), sanitized_source(source));
            if let Some(locator) = citation.get("locator").and_then(Value::as_str) {
                if safe_locator(locator) {
                    output.insert("locator".into(), Value::String(locator.into()));
                }
            }
            Some(Value::Object(output))
        })
        .collect()
}

fn sanitized_inputs(version: &Value) -> Vec<Value> {
    version
        .get("inputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|input| {
            input
                .get("referenceId")
                .and_then(Value::as_str)
                .is_some_and(safe_locator)
        })
        .map(|input| {
            let mut output = serde_json::Map::new();
            for key in ["kind", "referenceId", "label", "recordedAt", "contentHash"] {
                if let Some(value) = input.get(key) {
                    output.insert(key.into(), value.clone());
                }
            }
            Value::Object(output)
        })
        .collect()
}

fn whitelisted_array(version: &Value, key: &str, allowed: &[&str]) -> Vec<Value> {
    version
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let item = item.as_object()?;
            Some(Value::Object(
                allowed
                    .iter()
                    .filter_map(|key| item.get(*key).cloned().map(|value| ((*key).into(), value)))
                    .collect(),
            ))
        })
        .collect()
}

pub fn export_version(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
    version_id: &str,
    exported_at: &str,
) -> Result<Value> {
    scope.ensure_exists(tx)?;
    let row = tx
        .query_row(
            "SELECT a.kind,a.payload,a.payload_nonce,v.content_fingerprint,v.size_bytes,
                    v.payload,v.payload_nonce
             FROM artifact a JOIN artifact_version v
               ON v.workspace_id=a.workspace_id AND v.owner_subject=a.owner_subject AND v.artifact_id=a.id
             WHERE a.workspace_id=?1 AND a.owner_subject=?2 AND a.id=?3 AND v.id=?4
               AND a.authority='local' AND a.visibility='member-private'
               AND a.status!='deleted' AND v.status='available'",
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), artifact_id, version_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Sealed { ciphertext: row.get(1)?, nonce: row.get(2)? },
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    Sealed { ciphertext: row.get(5)?, nonce: row.get(6)? },
                ))
            },
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("Artifact version is unavailable for this owner.".into()))?;
    let artifact = open_json(store, &row.1, &artifact_aad(scope, artifact_id))?;
    let version = open_json(store, &row.4, &version_aad(scope, artifact_id, version_id))?;
    if artifact.get("id").and_then(Value::as_str) != Some(artifact_id)
        || artifact.get("kind").and_then(Value::as_str) != Some(row.0.as_str())
        || artifact.get("status").and_then(Value::as_str) == Some("deleted")
        || version.get("id").and_then(Value::as_str) != Some(version_id)
        || version.get("artifactId").and_then(Value::as_str) != Some(artifact_id)
        || version.get("status").and_then(Value::as_str) != Some("available")
    {
        return Err(StoreError::Invalid(
            "Artifact version identity or lifecycle is invalid.".into(),
        ));
    }
    let content = version
        .get("content")
        .ok_or_else(|| StoreError::Invalid("Artifact version content is missing.".into()))?;
    let text = content
        .get("text")
        .and_then(Value::as_str)
        .filter(|_| content.get("kind").and_then(Value::as_str) == Some("inline"))
        .ok_or_else(|| {
            StoreError::Invalid("Only verified inline artifact content can be exported.".into())
        })?;
    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
    let content_digest = content
        .pointer("/contentHash/value")
        .and_then(Value::as_str);
    let version_digest = version
        .pointer("/contentHash/value")
        .and_then(Value::as_str);
    let content_bytes = content.pointer("/media/byteLength").and_then(Value::as_i64);
    let version_bytes = version.pointer("/media/byteLength").and_then(Value::as_i64);
    if digest != row.2
        || content_digest != Some(digest.as_str())
        || version_digest != Some(digest.as_str())
        || content_bytes != Some(text.len() as i64)
        || version_bytes != Some(text.len() as i64)
        || row.3 != text.len() as i64
    {
        return Err(StoreError::Invalid(
            "Artifact version content integrity check failed.".into(),
        ));
    }
    Ok(json!({
        "artifactId":artifact_id,
        "versionId":version_id,
        "title":artifact.get("title").and_then(Value::as_str).unwrap_or("Artifact"),
        "kind":row.0,
        "exportedAt":exported_at,
        "content":content,
        "citations":sanitized_citations(&version),
        "inputs":sanitized_inputs(&version),
        "decisions":whitelisted_array(&version,"decisions",&["id","kind","summary","decidedAt","decidedByInternalUserId","approvalId"]),
        "lineage":whitelisted_array(&version,"lineage",&["relation","artifactId","artifactVersionId","recordedAt"]),
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn append_version(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
    expected_revision: i64,
    expected_current_version_id: &str,
    title_fingerprint: &str,
    content_fingerprint: &str,
    size_bytes: usize,
    updated_at: &str,
    artifact_value: &Value,
    version_value: &Value,
) -> Result<Value> {
    let current=tx.query_row(
        "SELECT revision,current_version_id,status FROM artifact WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id],
        |row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)),
    ).optional()?.ok_or_else(||StoreError::Invalid("Artifact is unavailable for this owner.".into()))?;
    if current.0 != expected_revision || current.1 != expected_current_version_id {
        return Err(StoreError::Invalid(
            "Artifact changed elsewhere. Reload it and try again.".into(),
        ));
    }
    if current.2 == "in-review" {
        return Err(StoreError::Invalid(
            "Resolve the open review before editing this artifact.".into(),
        ));
    }
    let version_id = version_value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Artifact version id is missing.".into()))?;
    let version_number = version_value
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| StoreError::Invalid("Artifact version number is missing.".into()))?;
    let sealed_version = seal_json(
        store,
        version_value,
        &version_aad(scope, artifact_id, version_id),
    )?;
    tx.execute(
        "INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,?5,'available',?6,?7,?8,?9,?10)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id,version_id,version_number,
            content_fingerprint,size_bytes as i64,updated_at,sealed_version.ciphertext,sealed_version.nonce])?;
    let sealed_artifact = seal_json(store, artifact_value, &artifact_aad(scope, artifact_id))?;
    let changed=tx.execute(
        "UPDATE artifact SET status='draft',revision=?1,current_version_id=?2,title_fingerprint=?3,content_fingerprint=?4,
          size_bytes=?5,updated_at=?6,payload=?7,payload_nonce=?8
         WHERE workspace_id=?9 AND owner_subject=?10 AND id=?11 AND revision=?12 AND current_version_id=?13",
        rusqlite::params![expected_revision+1,version_id,title_fingerprint,content_fingerprint,size_bytes as i64,
            updated_at,sealed_artifact.ciphertext,sealed_artifact.nonce,scope.workspace_id(),scope.owner_subject(),
            artifact_id,expected_revision,expected_current_version_id])?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Artifact changed elsewhere. Reload it and try again.".into(),
        ));
    }
    get_bundle(tx, store, scope, artifact_id)?
        .ok_or_else(|| StoreError::Invalid("Artifact update did not persist.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::DataScope;
    use crate::store::vault::{MasterKey, Vault};
    use tempfile::TempDir;

    fn vault() -> Vault {
        Vault::new(&MasterKey::generate().unwrap()).unwrap()
    }
    fn owner(workspace: &str, member: &str) -> PrivateDataScope {
        PrivateDataScope::for_authenticated_user(
            DataScope::workspace(workspace).unwrap(),
            &format!("user-{member}"),
            Some(member),
        )
        .unwrap()
    }
    fn seed(store: &Store, workspace: &str, member: &str) {
        store.transaction(|tx|{
            tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES (?1,'W','t','t')",[workspace])?;
            let project=seal_json(store,&json!({"id":"project-1"}),"project:project-1")?;
            tx.execute("INSERT INTO project(id,workspace_id,title_fingerprint,owner_member_id,created_by_internal_user_id,created_at,updated_at,payload,payload_nonce) VALUES ('project-1',?1,'title',?2,?3,'t','t',?4,?5)",
                rusqlite::params![workspace,member,format!("user-{member}"),project.ciphertext,project.nonce])?;
            let thread=seal_json(store,&json!({}),"thread:thread-1")?;
            tx.execute("INSERT INTO thread(id,workspace_id,project_id,title,owner_member_id,created_at,updated_at,payload,payload_nonce) VALUES ('thread-1',?1,'project-1','T',?2,'t','t',?3,?4)",
                rusqlite::params![workspace,member,thread.ciphertext,thread.nonce])?;
            let run=seal_json(store,&json!({}),"run:run-1")?;
            tx.execute("INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,created_at,updated_at,payload,payload_nonce) VALUES ('run-1',?1,'thread-1','p','m','completed','t','t',?2,?3)",
                rusqlite::params![workspace,run.ciphertext,run.nonce])?;
            let message=seal_json(store,&json!({}),"message:message-1")?;
            let revision=seal_json(store,&json!("One"),&format!("message-revision:{workspace}:revision-1"))?;
            tx.execute("INSERT INTO message(id,workspace_id,thread_id,kind,run_id,seq,idempotency_key,current_revision_id,current_revision_state,owner_member_id,created_at,payload,payload_nonce) VALUES ('message-1',?1,'thread-1','assistant','run-1',1,'m','revision-1','terminal',?2,'t',?3,?4)",
                rusqlite::params![workspace,member,message.ciphertext,message.nonce])?;
            tx.execute("INSERT INTO message_revision(id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,owner_member_id,created_at,payload,payload_nonce) VALUES ('revision-1',?1,'thread-1','message-1',1,0,'terminal','initial','r','t',?2,'t',?3,?4)",
                rusqlite::params![workspace,member,revision.ciphertext,revision.nonce])?;
            Ok(())
        }).unwrap();
    }
    fn artifact_value(workspace: &str, member: &str, current: &str, revision: i64) -> Value {
        json!({
            "id":"artifact-1","workspaceId":workspace,"authority":"local","visibility":"member-private",
            "ownerMemberId":member,"schemaVersion":1,"revision":revision,"createdByInternalUserId":"user",
            "createdAt":"t","updatedAt":"t","kind":"document","status":"draft","title":"Title",
            "currentVersionId":current,"producingRunId":"run-1","sourceProvenance":[],
            "context":{"threadId":"thread-1"},"reviews":[],"retention":{"status":"active"}
        })
    }
    fn version(id: &str, n: i64, text: &str, previous: Option<&str>) -> Value {
        json!({
            "id":id,"artifactId":"artifact-1","version":n,"status":"available","createdAt":"t",
            "createdByInternalUserId":"user","content":{"kind":"inline","text":text},
            "media":{"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"},
            "contentHash":{"algorithm":"sha-256","value":format!("hash-{n}")},
            "provenance":{"kind":"user","observedAt":"t"},"citations":[{"id":"citation"}],
            "inputs":[{"kind":"user-input","referenceId":"input","label":"Input","recordedAt":"t"}],
            "decisions":[{"id":"decision","kind":"user","summary":"Keep","decidedAt":"t"}],
            "lineage":previous.map(|id|vec![json!({"relation":"supersedes","artifactId":"artifact-1","artifactVersionId":id,"recordedAt":"t"})]).unwrap_or_default()
        })
    }

    fn exportable_version(id: &str, n: i64, text: &str, previous: Option<&str>) -> Value {
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        let media = json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
        json!({
            "id":id,"artifactId":"artifact-1","version":n,"status":"available","createdAt":"2026-07-11T01:00:00Z",
            "createdByInternalUserId":"user-member-a",
            "content":{"kind":"inline","text":text,"media":media,"contentHash":{"algorithm":"sha-256","value":digest}},
            "media":media,"contentHash":{"algorithm":"sha-256","value":digest},
            "provenance":{"kind":"user","observedAt":"2026-07-11T01:00:00Z"},
            "citations":[{"id":"citation-1","label":"Source Needle","source":{"kind":"import","externalReference":"C:\\private\\source.txt","observedAt":"2026-07-11T01:00:00Z"},"locator":"C:\\private\\source.txt","quotedText":"Safe excerpt"}],
            "inputs":[{"kind":"source","referenceId":"C:\\private\\input.txt","label":"Hidden path","recordedAt":"2026-07-11T01:00:00Z"}],
            "decisions":[{"id":"decision-1","kind":"user","summary":"Decision Needle","decidedAt":"2026-07-11T01:00:00Z"}],
            "lineage":previous.map(|id|vec![json!({"relation":"supersedes","artifactId":"artifact-1","artifactVersionId":id,"recordedAt":"2026-07-11T01:00:00Z"})]).unwrap_or_default(),
            "threadHistory":["hidden"],"reviews":[{"secret":"hidden"}],"grants":["hidden"],"authority":"hidden"
        })
    }

    #[test]
    fn search_and_exact_export_are_owner_bound_integrity_checked_and_survive_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("artifact-search.sqlite");
        let vault = vault();
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            seed(&store, "shared", "member-a");
            let scope = owner("shared", "member-a");
            let mut artifact = artifact_value("shared", "member-a", "version-1", 1);
            artifact["title"] = Value::String("Quarterly Title".into());
            artifact["context"]["projectId"] = Value::String("payload-forgery".into());
            let v1 = exportable_version("version-1", 1, "One", None);
            let hash1 = format!("{:x}", Sha256::digest(b"One"));
            store
                .transaction(|tx| {
                    create_private(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "run-1",
                        "thread-1",
                        "message-1",
                        "document",
                        "title",
                        &hash1,
                        3,
                        "t",
                        &artifact,
                        &v1,
                    )
                })
                .unwrap();
            let v2 = exportable_version("artifact-1:v2", 2, "Current Needle", Some("version-1"));
            let hash2 = format!("{:x}", Sha256::digest(b"Current Needle"));
            artifact["revision"] = json!(2);
            artifact["currentVersionId"] = Value::String("artifact-1:v2".into());
            artifact["updatedAt"] = Value::String("t2".into());
            store
                .transaction(|tx| {
                    append_version(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        1,
                        "version-1",
                        "title",
                        &hash2,
                        "Current Needle".len(),
                        "t2",
                        &artifact,
                        &v2,
                    )
                })
                .unwrap();

            // A second exact-owner artifact proves empty listing and limit behavior.
            store.transaction(|tx| {
                let artifact2=json!({"id":"artifact-2","workspaceId":"shared","authority":"local","visibility":"member-private","ownerMemberId":"member-a","schemaVersion":1,"revision":1,"createdByInternalUserId":"user-member-a","createdAt":"t","updatedAt":"t","kind":"report","status":"draft","title":"Second","currentVersionId":"artifact-2:v1","context":{"threadId":"thread-1","projectId":"payload-forgery"},"sourceProvenance":[],"reviews":[],"retention":{"status":"active"}});
                let text="Second";let digest=format!("{:x}",Sha256::digest(text.as_bytes()));
                let media=json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
                let version2=json!({"id":"artifact-2:v1","artifactId":"artifact-2","version":1,"status":"available","createdAt":"t","content":{"kind":"inline","text":text,"media":media,"contentHash":{"algorithm":"sha-256","value":digest}},"media":media,"contentHash":{"algorithm":"sha-256","value":digest},"citations":[],"inputs":[],"decisions":[],"lineage":[]});
                let sealed_artifact=seal_json(&store,&artifact2,&artifact_aad(&scope,"artifact-2"))?;
                let sealed_version=seal_json(&store,&version2,&version_aad(&scope,"artifact-2","artifact-2:v1"))?;
                tx.execute("INSERT INTO artifact(workspace_id,owner_subject,authority,visibility,owner_member_id,id,thread_id,kind,status,revision,current_version_id,title_fingerprint,content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce) VALUES ('shared',?1,'local','member-private','member-a','artifact-2','thread-1','report','draft',1,'artifact-2:v1','title',?2,6,'t','t',?3,?4)",rusqlite::params![scope.owner_subject(),digest,sealed_artifact.ciphertext,sealed_artifact.nonce])?;
                tx.execute("INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce) VALUES ('shared',?1,'artifact-2','artifact-2:v1',1,'available',?2,6,'t',?3,?4)",rusqlite::params![scope.owner_subject(),digest,sealed_version.ciphertext,sealed_version.nonce])?;
                tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('other','Other','t','t')",[])?;
                Ok(())
            }).unwrap();

            let find = |query: Option<&str>, thread: Option<&str>, project: Option<&str>, limit| {
                store
                    .with_conn(|tx| {
                        search(
                            tx,
                            &store,
                            &scope,
                            &ArtifactSearchFilter {
                                query,
                                thread_id: thread,
                                project_id: project,
                                kinds: &[],
                                statuses: &[],
                                limit,
                            },
                        )
                    })
                    .unwrap()
            };
            assert_eq!(find(None, None, None, 1).len(), 1);
            assert_eq!(find(None, None, None, 50).len(), 2);
            assert_eq!(
                find(Some("quarterly"), None, None, 50)[0]["matchedOn"],
                json!(["title"])
            );
            assert_eq!(
                find(Some("current needle"), None, None, 50)[0]["matchedOn"],
                json!(["content"])
            );
            assert_eq!(
                find(Some("source needle"), None, None, 50)[0]["matchedOn"],
                json!(["source"])
            );
            assert_eq!(
                find(Some("decision needle"), None, None, 50)[0]["matchedOn"],
                json!(["decision"])
            );
            assert_eq!(find(None, Some("thread-1"), None, 50).len(), 2);
            assert_eq!(find(None, None, Some("project-1"), 50).len(), 2);
            assert!(store
                .with_conn(|tx| search(
                    tx,
                    &store,
                    &scope,
                    &ArtifactSearchFilter {
                        query: None,
                        thread_id: Some("missing"),
                        project_id: None,
                        kinds: &[],
                        statuses: &[],
                        limit: 50
                    }
                ))
                .is_err());
            assert!(store
                .with_conn(|tx| search(
                    tx,
                    &store,
                    &scope,
                    &ArtifactSearchFilter {
                        query: None,
                        thread_id: None,
                        project_id: Some("missing"),
                        kinds: &[],
                        statuses: &[],
                        limit: 50
                    }
                ))
                .is_err());
            let other_owner = owner("shared", "member-b");
            assert!(store
                .with_conn(|tx| search(
                    tx,
                    &store,
                    &other_owner,
                    &ArtifactSearchFilter {
                        query: None,
                        thread_id: None,
                        project_id: None,
                        kinds: &[],
                        statuses: &[],
                        limit: 50
                    }
                ))
                .unwrap()
                .is_empty());
            let other_workspace = owner("other", "member-a");
            assert!(store
                .with_conn(|tx| search(
                    tx,
                    &store,
                    &other_workspace,
                    &ArtifactSearchFilter {
                        query: None,
                        thread_id: None,
                        project_id: None,
                        kinds: &[],
                        statuses: &[],
                        limit: 50
                    }
                ))
                .unwrap()
                .is_empty());

            let old = store
                .with_conn(|tx| {
                    export_version(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "version-1",
                        "2026-07-11T02:00:00Z",
                    )
                })
                .unwrap();
            let current = store
                .with_conn(|tx| {
                    export_version(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "artifact-1:v2",
                        "2026-07-11T02:00:00Z",
                    )
                })
                .unwrap();
            assert_eq!(old["content"]["text"], "One");
            assert_eq!(current["content"]["text"], "Current Needle");
            let encoded = serde_json::to_string(&old).unwrap();
            for forbidden in [
                "C:\\private",
                "threadHistory",
                "reviews",
                "grants",
                "authority",
            ] {
                assert!(!encoded.contains(forbidden), "leaked {forbidden}");
            }
            assert_eq!(old["citations"][0]["label"], "Source Needle");
            assert_eq!(old["citations"][0]["quotedText"], "Safe excerpt");
            assert!(old["citations"][0].get("locator").is_none());
            assert_eq!(old["inputs"], json!([]));
            assert!(store
                .with_conn(|tx| export_version(
                    tx,
                    &store,
                    &other_owner,
                    "artifact-1",
                    "version-1",
                    "t"
                ))
                .is_err());

            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET status='redacted' WHERE workspace_id='shared' AND owner_subject=?1 AND id='artifact-1:v2'",[scope.owner_subject()])?;Ok(())}).unwrap();
            assert!(find(None, None, None, 50)
                .iter()
                .all(|result| result["artifact"]["id"] != "artifact-1"));
            assert!(store
                .with_conn(|tx| export_version(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    "t"
                ))
                .is_err());
            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET status='available' WHERE workspace_id='shared' AND owner_subject=?1 AND id='artifact-1:v2'",[scope.owner_subject()])?;tx.execute("UPDATE artifact SET status='deleted' WHERE workspace_id='shared' AND owner_subject=?1 AND id='artifact-2'",[scope.owner_subject()])?;Ok(())}).unwrap();
            assert_eq!(find(None, None, None, 50).len(), 1);

            let original = vault
                .open(
                    &tx_sealed(&store, &scope, "artifact-1", "artifact-1:v2"),
                    version_aad(&scope, "artifact-1", "artifact-1:v2").as_bytes(),
                )
                .unwrap();
            let mut tampered: Value = serde_json::from_slice(&original).unwrap();
            tampered["content"]["text"] = Value::String("Tampered".into());
            let resealed = seal_json(
                &store,
                &tampered,
                &version_aad(&scope, "artifact-1", "artifact-1:v2"),
            )
            .unwrap();
            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET payload=?1,payload_nonce=?2 WHERE workspace_id='shared' AND owner_subject=?3 AND id='artifact-1:v2'",rusqlite::params![resealed.ciphertext,resealed.nonce,scope.owner_subject()])?;Ok(())}).unwrap();
            assert!(store
                .with_conn(|tx| export_version(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    "t"
                ))
                .is_err());
            let restored = seal_json(
                &store,
                &v2,
                &version_aad(&scope, "artifact-1", "artifact-1:v2"),
            )
            .unwrap();
            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET payload=?1,payload_nonce=?2 WHERE workspace_id='shared' AND owner_subject=?3 AND id='artifact-1:v2'",rusqlite::params![restored.ciphertext,restored.nonce,scope.owner_subject()])?;Ok(())}).unwrap();
        }
        let store = Store::open(&path, vault).unwrap();
        let scope = owner("shared", "member-a");
        assert_eq!(
            store
                .with_conn(|tx| search(
                    tx,
                    &store,
                    &scope,
                    &ArtifactSearchFilter {
                        query: Some("source needle"),
                        thread_id: None,
                        project_id: None,
                        kinds: &[],
                        statuses: &[],
                        limit: 50
                    }
                ))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .with_conn(|tx| export_version(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "2026-07-11T03:00:00Z"
                ))
                .unwrap()["content"]["text"],
            "One"
        );
    }

    fn tx_sealed(
        store: &Store,
        scope: &PrivateDataScope,
        artifact_id: &str,
        version_id: &str,
    ) -> Sealed {
        store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT payload,payload_nonce FROM artifact_version WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 AND id=?4",
                    rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id,version_id],
                    |row| Ok(Sealed { ciphertext: row.get(0)?, nonce: row.get(1)? }),
                )?)
            })
            .unwrap()
    }

    #[test]
    fn versions_are_immutable_owner_bound_cas_and_survive_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("artifact.sqlite");
        let vault = vault();
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            seed(&store, "shared", "member-a");
            let a = owner("shared", "member-a");
            let b = owner("shared", "member-b");
            let v1 = version("version-1", 1, "One", None);
            store
                .transaction(|tx| {
                    create_private(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "run-1",
                        "thread-1",
                        "message-1",
                        "document",
                        "title",
                        "hash-1",
                        3,
                        "t",
                        &artifact_value("shared", "member-a", "version-1", 1),
                        &v1,
                    )
                })
                .unwrap();
            assert!(store
                .with_conn(|tx| get_bundle(tx, &store, &b, "artifact-1"))
                .unwrap()
                .is_none());
            let v2 = version("artifact-1:v2", 2, "Two", Some("version-1"));
            store
                .transaction(|tx| {
                    append_version(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        1,
                        "version-1",
                        "title",
                        "hash-2",
                        3,
                        "t2",
                        &artifact_value("shared", "member-a", "artifact-1:v2", 2),
                        &v2,
                    )
                })
                .unwrap();
            let stale = store.transaction(|tx| {
                append_version(
                    tx,
                    &store,
                    &a,
                    "artifact-1",
                    1,
                    "version-1",
                    "title",
                    "hash-3",
                    5,
                    "t3",
                    &artifact_value("shared", "member-a", "artifact-1:v3", 3),
                    &version("artifact-1:v3", 3, "Three", Some("artifact-1:v2")),
                )
            });
            assert!(stale.unwrap_err().to_string().contains("changed elsewhere"));
            let bundle = store
                .with_conn(|tx| get_bundle(tx, &store, &a, "artifact-1"))
                .unwrap()
                .unwrap();
            assert_eq!(bundle["versions"].as_array().unwrap().len(), 2);
            assert_eq!(bundle["versions"][0]["content"]["text"], "One");
            assert_eq!(
                bundle["versions"][1]["lineage"][0]["artifactVersionId"],
                "version-1"
            );
            assert_eq!(
                bundle["currentVersion"]["citations"],
                bundle["versions"][0]["citations"]
            );
        }
        let store = Store::open(&path, vault).unwrap();
        let a = owner("shared", "member-a");
        let bundle = store
            .with_conn(|tx| get_bundle(tx, &store, &a, "artifact-1"))
            .unwrap()
            .unwrap();
        assert_eq!(bundle["currentVersion"]["id"], "artifact-1:v2");
        assert_eq!(bundle["versions"][0]["content"]["text"], "One");
    }

    #[test]
    fn review_lifecycle_is_owner_bound_cas_and_preserves_history() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("reviews.sqlite");
        let vault = vault();
        let first_review;
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            seed(&store, "shared", "member-a");
            let a = owner("shared", "member-a");
            let b = owner("shared", "member-b");
            store
                .transaction(|tx| {
                    create_private(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "run-1",
                        "thread-1",
                        "message-1",
                        "document",
                        "title",
                        "hash-1",
                        3,
                        "t",
                        &artifact_value("shared", "member-a", "version-1", 1),
                        &version("version-1", 1, "One", None),
                    )
                })
                .unwrap();
            let requested = store
                .transaction(|tx| {
                    review_action(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "version-1",
                        1,
                        "request-review",
                        "user-member-a",
                        Some("Please review"),
                        &[],
                        "r1",
                    )
                })
                .unwrap();
            assert_eq!(requested["artifact"]["status"], "in-review");
            let duplicate = store.transaction(|tx| {
                review_action(
                    tx,
                    &store,
                    &a,
                    "artifact-1",
                    "version-1",
                    2,
                    "request-review",
                    "user-member-a",
                    None,
                    &[],
                    "r1b",
                )
            });
            assert!(duplicate.is_err());
            let blocked = store.transaction(|tx| {
                append_version(
                    tx,
                    &store,
                    &a,
                    "artifact-1",
                    2,
                    "version-1",
                    "title",
                    "hash-2",
                    3,
                    "x",
                    &artifact_value("shared", "member-a", "artifact-1:v2", 3),
                    &version("artifact-1:v2", 2, "Two", Some("version-1")),
                )
            });
            assert!(blocked.unwrap_err().to_string().contains("Resolve"));
            let changes = vec!["Clarify the result".to_string()];
            let changed = store
                .transaction(|tx| {
                    review_action(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "version-1",
                        2,
                        "request-changes",
                        "user-member-a",
                        Some("Needs clarity"),
                        &changes,
                        "r2",
                    )
                })
                .unwrap();
            first_review = changed["artifact"]["reviews"][0].clone();
            assert_eq!(first_review["status"], "changes-requested");
            let draft = store
                .transaction(|tx| {
                    append_version(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        3,
                        "version-1",
                        "title",
                        "hash-2",
                        3,
                        "r3",
                        &artifact_value("shared", "member-a", "artifact-1:v2", 4),
                        &version("artifact-1:v2", 2, "Two", Some("version-1")),
                    )
                })
                .unwrap();
            assert_eq!(draft["artifact"]["status"], "draft");
            assert_eq!(draft["artifact"]["reviews"][0], first_review);
            let second = store
                .transaction(|tx| {
                    review_action(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "artifact-1:v2",
                        4,
                        "request-review",
                        "user-member-a",
                        None,
                        &[],
                        "r4",
                    )
                })
                .unwrap();
            assert_eq!(second["artifact"]["reviews"].as_array().unwrap().len(), 2);
            let old = store.transaction(|tx| {
                review_action(
                    tx,
                    &store,
                    &a,
                    "artifact-1",
                    "version-1",
                    5,
                    "accept",
                    "user-member-a",
                    None,
                    &[],
                    "bad",
                )
            });
            assert!(old.unwrap_err().to_string().contains("current"));
            let stale = store.transaction(|tx| {
                review_action(
                    tx,
                    &store,
                    &a,
                    "artifact-1",
                    "artifact-1:v2",
                    4,
                    "accept",
                    "user-member-a",
                    None,
                    &[],
                    "bad",
                )
            });
            assert!(stale.unwrap_err().to_string().contains("changed elsewhere"));
            let cross = store.transaction(|tx| {
                review_action(
                    tx,
                    &store,
                    &b,
                    "artifact-1",
                    "artifact-1:v2",
                    5,
                    "accept",
                    "user-member-b",
                    None,
                    &[],
                    "bad",
                )
            });
            assert!(cross.unwrap_err().to_string().contains("unavailable"));
            let accepted = store
                .transaction(|tx| {
                    review_action(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        "artifact-1:v2",
                        5,
                        "accept",
                        "user-member-a",
                        Some("Approved"),
                        &[],
                        "r5",
                    )
                })
                .unwrap();
            assert_eq!(accepted["artifact"]["status"], "accepted");
            assert_eq!(accepted["artifact"]["reviews"][1]["status"], "approved");
            assert_eq!(accepted["artifact"]["reviews"][0], first_review);
            let after = store
                .transaction(|tx| {
                    append_version(
                        tx,
                        &store,
                        &a,
                        "artifact-1",
                        6,
                        "artifact-1:v2",
                        "title",
                        "hash-3",
                        5,
                        "r6",
                        &artifact_value("shared", "member-a", "artifact-1:v3", 7),
                        &version("artifact-1:v3", 3, "Three", Some("artifact-1:v2")),
                    )
                })
                .unwrap();
            assert_eq!(after["artifact"]["status"], "draft");
            assert_eq!(after["artifact"]["reviews"][0], first_review);
        }
        let store = Store::open(&path, vault).unwrap();
        let a = owner("shared", "member-a");
        let reopened = store
            .with_conn(|tx| get_bundle(tx, &store, &a, "artifact-1"))
            .unwrap()
            .unwrap();
        assert_eq!(reopened["artifact"]["reviews"].as_array().unwrap().len(), 2);
        assert_eq!(reopened["artifact"]["reviews"][0], first_review);
        assert_eq!(reopened["artifact"]["status"], "draft");
    }
}
