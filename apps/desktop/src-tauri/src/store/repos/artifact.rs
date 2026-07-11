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

fn handoff_aad(scope: &PrivateDataScope, id: &str) -> String {
    format!(
        "artifact_handoff:{}:{}:{id}",
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

#[allow(clippy::too_many_arguments)]
pub fn propose_handoff(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
    version_id: &str,
    target_project_id: &str,
    actor_internal_user_id: &str,
    note: Option<&str>,
    at: &str,
) -> Result<Value> {
    scope.ensure_exists(tx)?;
    let owner_member_id = scope.owner_member_id().ok_or_else(|| {
        StoreError::Invalid("Artifact handoff requires an active private workspace member.".into())
    })?;
    let source = tx
        .query_row(
            "SELECT a.thread_id,t.project_id FROM artifact a
             JOIN artifact_version v ON v.workspace_id=a.workspace_id AND v.owner_subject=a.owner_subject
               AND v.artifact_id=a.id AND v.id=?4
             JOIN thread t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id
             WHERE a.workspace_id=?1 AND a.owner_subject=?2 AND a.id=?3
               AND a.authority='local' AND a.visibility='member-private' AND a.status!='deleted'
               AND v.status='available' AND t.authority='local' AND t.visibility='member-private'
               AND t.owner_member_id=?5 AND t.deleted_at IS NULL",
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                artifact_id,
                version_id,
                owner_member_id
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::Invalid("Artifact version is unavailable for handoff by this owner.".into())
        })?;
    let target_is_exact: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM project WHERE id=?1 AND workspace_id=?2
           AND authority='local' AND visibility='member-private' AND owner_member_id=?3
           AND lifecycle='active' AND deleted_at IS NULL)",
        rusqlite::params![target_project_id, scope.workspace_id(), owner_member_id],
        |row| row.get(0),
    )?;
    if !target_is_exact {
        return Err(StoreError::Invalid(
            "Target project is not an active private project owned by this member.".into(),
        ));
    }
    if source.1.as_deref() == Some(target_project_id) {
        return Err(StoreError::Invalid(
            "Artifact source and target project must be different.".into(),
        ));
    }
    let duplicate = tx
        .query_row(
            "SELECT id,status,revision,proposed_by_internal_user_id,payload,payload_nonce
         FROM artifact_handoff WHERE workspace_id=?1 AND owner_subject=?2
           AND artifact_id=?3 AND version_id=?4 AND target_project_id=?5",
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                artifact_id,
                version_id,
                target_project_id
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    payload_of(row)?,
                ))
            },
        )
        .optional()?;
    if let Some((id, status, revision, proposed_by, sealed)) = duplicate {
        if status == "accepted" {
            return Err(StoreError::Invalid(
                "This exact artifact version is already associated with the target project.".into(),
            ));
        }
        if status != "proposed" {
            return Err(StoreError::Invalid(
                "Artifact handoff status is invalid.".into(),
            ));
        }
        let payload = open_json(store, &sealed, &handoff_aad(scope, &id))?;
        validate_proposed_handoff(
            &payload,
            scope,
            &id,
            version_id,
            &source.0,
            source.1.as_deref(),
            target_project_id,
            &proposed_by,
            revision,
        )?;
        return Ok(payload);
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}:{}:{artifact_id}:{version_id}:{target_project_id}:{at}",
                scope.workspace_id(),
                scope.owner_subject()
            )
            .as_bytes()
        )
    );
    let id = format!("handoff:{}", &digest[..24]);
    let mut payload = json!({
        "id":id,"workspaceId":scope.workspace_id(),"authority":"local","visibility":"member-private",
        "ownerMemberId":owner_member_id,"schemaVersion":1,"revision":1,
        "createdByInternalUserId":actor_internal_user_id,"createdAt":at,"updatedAt":at,
        "status":"proposed",
        "source":{"workspaceId":scope.workspace_id(),"threadId":source.0},
        "target":{"workspaceId":scope.workspace_id(),"projectId":target_project_id},
        "artifactVersionIds":[version_id],"includedContext":[],"authorityTransfer":"none",
        "proposedByInternalUserId":actor_internal_user_id,"proposedAt":at
    });
    if let Some(project_id) = source.1.as_deref() {
        payload["source"]["projectId"] = Value::String(project_id.into());
    }
    if let Some(note) = note {
        payload["note"] = Value::String(note.into());
    }
    let sealed = seal_json(store, &payload, &handoff_aad(scope, &id))?;
    tx.execute(
        "INSERT INTO artifact_handoff(workspace_id,owner_subject,artifact_id,id,version_id,
           source_thread_id,source_project_id,target_project_id,status,revision,
           proposed_by_internal_user_id,proposed_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'proposed',1,?9,?10,?11,?12)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            artifact_id,
            id,
            version_id,
            source.0,
            source.1,
            target_project_id,
            actor_internal_user_id,
            at,
            sealed.ciphertext,
            sealed.nonce
        ],
    )?;
    Ok(payload)
}

fn validate_proposed_handoff(
    payload: &Value,
    scope: &PrivateDataScope,
    id: &str,
    version_id: &str,
    source_thread_id: &str,
    source_project_id: Option<&str>,
    target_project_id: &str,
    proposed_by: &str,
    revision: i64,
) -> Result<()> {
    let exact = payload.get("id").and_then(Value::as_str) == Some(id)
        && payload.get("workspaceId").and_then(Value::as_str) == Some(scope.workspace_id())
        && payload.get("authority").and_then(Value::as_str) == Some("local")
        && payload.get("visibility").and_then(Value::as_str) == Some("member-private")
        && payload.get("ownerMemberId").and_then(Value::as_str) == scope.owner_member_id()
        && payload.get("status").and_then(Value::as_str) == Some("proposed")
        && payload.get("revision").and_then(Value::as_i64) == Some(revision)
        && payload
            .pointer("/source/workspaceId")
            .and_then(Value::as_str)
            == Some(scope.workspace_id())
        && payload.pointer("/source/threadId").and_then(Value::as_str) == Some(source_thread_id)
        && payload.pointer("/source/projectId").and_then(Value::as_str) == source_project_id
        && payload
            .pointer("/target/workspaceId")
            .and_then(Value::as_str)
            == Some(scope.workspace_id())
        && payload.pointer("/target/projectId").and_then(Value::as_str) == Some(target_project_id)
        && payload.get("artifactVersionIds").and_then(Value::as_array)
            == Some(&vec![Value::String(version_id.into())])
        && payload
            .get("includedContext")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        && payload.get("authorityTransfer").and_then(Value::as_str) == Some("none")
        && payload
            .get("proposedByInternalUserId")
            .and_then(Value::as_str)
            == Some(proposed_by);
    if exact {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "Artifact handoff payload integrity check failed.".into(),
        ))
    }
}

pub fn accept_handoff(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    handoff_id: &str,
    expected_revision: i64,
    actor_internal_user_id: &str,
    at: &str,
) -> Result<Value> {
    scope.ensure_exists(tx)?;
    let row=tx.query_row(
        "SELECT artifact_id,version_id,source_thread_id,source_project_id,target_project_id,status,
           revision,proposed_by_internal_user_id,payload,payload_nonce
         FROM artifact_handoff WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),handoff_id],
        |row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,
            row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,
            row.get::<_,i64>(6)?,row.get::<_,String>(7)?,payload_of(row)?)),
    ).optional()?.ok_or_else(||StoreError::Invalid("Artifact handoff is unavailable for this owner.".into()))?;
    if row.5 != "proposed" {
        return Err(StoreError::Invalid(
            "Artifact handoff is already resolved.".into(),
        ));
    }
    if row.6 != expected_revision {
        return Err(StoreError::Invalid(
            "Artifact handoff changed elsewhere. Reload it and try again.".into(),
        ));
    }
    let version_still_available: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM artifact_version WHERE workspace_id=?1 AND owner_subject=?2
          AND artifact_id=?3 AND id=?4 AND status='available')",
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), row.0, row.1],
        |row| row.get(0),
    )?;
    let target_still_active:bool=tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM project WHERE id=?1 AND workspace_id=?2 AND authority='local'
          AND visibility='member-private' AND owner_member_id=?3 AND lifecycle='active' AND deleted_at IS NULL)",
        rusqlite::params![row.4,scope.workspace_id(),scope.owner_member_id()],|row|row.get(0))?;
    if !version_still_available || !target_still_active {
        return Err(StoreError::Invalid(
            "Artifact handoff source or target is no longer available.".into(),
        ));
    }
    let mut payload = open_json(store, &row.8, &handoff_aad(scope, handoff_id))?;
    validate_proposed_handoff(
        &payload,
        scope,
        handoff_id,
        &row.1,
        &row.2,
        row.3.as_deref(),
        &row.4,
        &row.7,
        row.6,
    )?;
    payload["status"] = Value::String("accepted".into());
    payload["revision"] = json!(expected_revision + 1);
    payload["updatedAt"] = Value::String(at.into());
    payload["resolvedAt"] = Value::String(at.into());
    payload["resolvedByInternalUserId"] = Value::String(actor_internal_user_id.into());
    let sealed = seal_json(store, &payload, &handoff_aad(scope, handoff_id))?;
    let changed=tx.execute(
        "UPDATE artifact_handoff SET status='accepted',revision=?1,resolved_by_internal_user_id=?2,
          resolved_at=?3,payload=?4,payload_nonce=?5
         WHERE workspace_id=?6 AND owner_subject=?7 AND id=?8 AND status='proposed' AND revision=?9",
        rusqlite::params![expected_revision+1,actor_internal_user_id,at,sealed.ciphertext,sealed.nonce,
            scope.workspace_id(),scope.owner_subject(),handoff_id,expected_revision])?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Artifact handoff changed elsewhere. Reload it and try again.".into(),
        ));
    }
    Ok(payload)
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

    let mut params = Vec::new();
    let mut sql = if let Some(project_id) = filter.project_id {
        params.push(rusqlite::types::Value::Text(project_id.into()));
        String::from(
            "SELECT a.id,COALESCE(h.version_id,a.current_version_id),a.payload,a.payload_nonce,v.payload,v.payload_nonce,h.id IS NOT NULL
             FROM artifact a
             LEFT JOIN artifact_handoff h ON h.workspace_id=a.workspace_id AND h.owner_subject=a.owner_subject
               AND h.artifact_id=a.id AND h.target_project_id=? AND h.status='accepted'
               AND h.id=(SELECT latest.id FROM artifact_handoff latest
                 WHERE latest.workspace_id=a.workspace_id AND latest.owner_subject=a.owner_subject
                   AND latest.artifact_id=a.id AND latest.target_project_id=h.target_project_id
                   AND latest.status='accepted' ORDER BY latest.resolved_at DESC,latest.id DESC LIMIT 1)
             JOIN artifact_version v ON v.workspace_id=a.workspace_id AND v.owner_subject=a.owner_subject
               AND v.artifact_id=a.id AND v.id=COALESCE(h.version_id,a.current_version_id)
             LEFT JOIN thread t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id
             WHERE a.workspace_id=? AND a.owner_subject=? AND a.authority='local'
               AND a.visibility='member-private' AND a.status!='deleted' AND v.status='available'",
        )
    } else {
        String::from(
            "SELECT a.id,a.current_version_id,a.payload,a.payload_nonce,v.payload,v.payload_nonce,0
             FROM artifact a
             JOIN artifact_version v ON v.workspace_id=a.workspace_id AND v.owner_subject=a.owner_subject
               AND v.artifact_id=a.id AND v.id=a.current_version_id
             LEFT JOIN thread t ON t.id=a.thread_id AND t.workspace_id=a.workspace_id
             WHERE a.workspace_id=? AND a.owner_subject=? AND a.authority='local'
               AND a.visibility='member-private' AND a.status!='deleted' AND v.status='available'",
        )
    };
    params.extend([
        rusqlite::types::Value::Text(scope.workspace_id().into()),
        rusqlite::types::Value::Text(scope.owner_subject().into()),
    ]);
    if let Some(thread_id) = filter.thread_id {
        sql.push_str(" AND a.thread_id=?");
        params.push(rusqlite::types::Value::Text(thread_id.into()));
    }
    if let Some(project_id) = filter.project_id {
        sql.push_str(
            " AND ((t.project_id=? AND t.authority='local' AND t.visibility='member-private'
              AND t.deleted_at IS NULL
              AND ((? IS NOT NULL AND t.owner_member_id=?)
                OR (? IS NULL AND t.owner_member_id IS NULL))) OR h.id IS NOT NULL)",
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
    sql.push_str(" ORDER BY a.updated_at DESC,a.id ASC LIMIT ? OFFSET ?");
    let query = filter.query.map(str::to_lowercase);
    let mut results = Vec::new();
    let page_size = if query.is_some() { 100 } else { result_limit };
    let max_scan = if query.is_some() { 2_000 } else { result_limit };
    let mut scanned = 0usize;
    loop {
        let requested = page_size.min(max_scan.saturating_sub(scanned));
        if requested == 0 {
            let mut next_params = params.clone();
            next_params.push(rusqlite::types::Value::Integer(1));
            next_params.push(rusqlite::types::Value::Integer(scanned as i64));
            let mut stmt = tx.prepare(&sql)?;
            if stmt
                .query_map(rusqlite::params_from_iter(next_params), |row| {
                    row.get::<_, String>(0)
                })?
                .next()
                .transpose()?
                .is_some()
            {
                return Err(StoreError::Invalid(
                    "Search is too broad; narrow it and try again.".into(),
                ));
            }
            break;
        }
        let mut page_params = params.clone();
        page_params.push(rusqlite::types::Value::Integer(requested as i64));
        page_params.push(rusqlite::types::Value::Integer(scanned as i64));
        let mut stmt = tx.prepare(&sql)?;
        let candidates = stmt
            .query_map(rusqlite::params_from_iter(page_params), |row| {
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
                    row.get::<_, bool>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let page_len = candidates.len();
        for (artifact_id, version_id, artifact_sealed, version_sealed, handed_off) in candidates {
            let mut artifact_value =
                open_json(store, &artifact_sealed, &artifact_aad(scope, &artifact_id))?;
            if handed_off {
                let object = artifact_value
                    .as_object_mut()
                    .ok_or_else(|| StoreError::Invalid("Artifact payload is invalid.".into()))?;
                object.insert("currentVersionId".into(), Value::String(version_id.clone()));
            }
            let version_value = open_json(
                store,
                &version_sealed,
                &version_aad(scope, &artifact_id, &version_id),
            )?;
            let mut matched_on = Vec::new();
            if let Some(query) = query.as_deref() {
                if includes_case_insensitive(
                    artifact_value.get("title").and_then(Value::as_str),
                    query,
                ) {
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
            results.push(json!({
                "artifact":artifact_value,
                "currentVersion":version_value,
                "matchedOn":matched_on,
            }));
            if results.len() == result_limit {
                return Ok(results);
            }
        }
        scanned += page_len;
        if page_len < requested {
            break;
        }
    }
    Ok(results)
}

fn safe_locator(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && !url.cannot_be_a_base()
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
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

            // Search reads only artifact + current version. Corrupt historical
            // version/review ciphertext must not strand a healthy current result.
            let old_sealed = tx_sealed(&store, &scope, "artifact-1", "version-1");
            store.transaction(|tx| {
                tx.execute("UPDATE artifact_version SET payload=x'00',payload_nonce=x'00' WHERE workspace_id='shared' AND owner_subject=?1 AND id='version-1'",[scope.owner_subject()])?;
                tx.execute("INSERT INTO artifact_review(workspace_id,owner_subject,artifact_id,id,version_id,status,requested_by_internal_user_id,requested_at,resolved_at,payload,payload_nonce) VALUES ('shared',?1,'artifact-1','corrupt-review','version-1','approved','user-member-a','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z',x'00',x'00')",[scope.owner_subject()])?;
                Ok(())
            }).unwrap();
            assert_eq!(find(Some("current needle"), None, None, 50).len(), 1);
            store.transaction(|tx| {
                tx.execute("UPDATE artifact_version SET payload=?1,payload_nonce=?2 WHERE workspace_id='shared' AND owner_subject=?3 AND id='version-1'",rusqlite::params![old_sealed.ciphertext,old_sealed.nonce,scope.owner_subject()])?;
                Ok(())
            }).unwrap();

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

    #[test]
    fn nonempty_search_pages_past_two_hundred_and_reports_scan_ceiling() {
        let store = Store::open_in_memory(vault()).unwrap();
        let scope = owner("paged", "member-a");
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('paged','Paged','t','t')",
                    [],
                )?;
                for index in 0..2_001usize {
                    let artifact_id = format!("artifact-{index:04}");
                    let version_id = format!("{artifact_id}:v1");
                    let title = if index == 250 {
                        "Older Than Two Hundred Needle"
                    } else {
                        "Ordinary artifact"
                    };
                    let updated_at = format!("{:04}", 2_001 - index);
                    let artifact = json!({"id":artifact_id,"title":title,"kind":"document","status":"draft","reviews":[]});
                    let version = json!({"id":version_id,"artifactId":artifact_id,"status":"available","content":{"kind":"inline","text":"ordinary"},"citations":[],"inputs":[],"decisions":[]});
                    let sealed_artifact =
                        seal_json(&store, &artifact, &artifact_aad(&scope, &artifact_id))?;
                    let sealed_version = seal_json(
                        &store,
                        &version,
                        &version_aad(&scope, &artifact_id, &version_id),
                    )?;
                    tx.execute("INSERT INTO artifact(workspace_id,owner_subject,authority,visibility,owner_member_id,id,kind,status,revision,current_version_id,title_fingerprint,content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce) VALUES ('paged',?1,'local','member-private','member-a',?2,'document','draft',1,?3,'title','hash',8,'t',?4,?5,?6)",rusqlite::params![scope.owner_subject(),artifact_id,version_id,updated_at,sealed_artifact.ciphertext,sealed_artifact.nonce])?;
                    tx.execute("INSERT INTO artifact_version(workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce) VALUES ('paged',?1,?2,?3,1,'available','hash',8,'t',?4,?5)",rusqlite::params![scope.owner_subject(),artifact_id,version_id,sealed_version.ciphertext,sealed_version.nonce])?;
                }
                Ok(())
            })
            .unwrap();
        let found = store
            .with_conn(|tx| {
                search(
                    tx,
                    &store,
                    &scope,
                    &ArtifactSearchFilter {
                        query: Some("older than two hundred needle"),
                        thread_id: None,
                        project_id: None,
                        kinds: &[],
                        statuses: &[],
                        limit: 1,
                    },
                )
            })
            .unwrap();
        assert_eq!(found[0]["artifact"]["id"], "artifact-0250");
        let broad = store.with_conn(|tx| {
            search(
                tx,
                &store,
                &scope,
                &ArtifactSearchFilter {
                    query: Some("not present anywhere"),
                    thread_id: None,
                    project_id: None,
                    kinds: &[],
                    statuses: &[],
                    limit: 1,
                },
            )
        });
        assert!(broad
            .unwrap_err()
            .to_string()
            .contains("Search is too broad; narrow it"));
    }

    #[test]
    fn safe_locator_accepts_only_plain_credential_free_http_urls() {
        assert!(safe_locator("https://example.com/path"));
        assert!(safe_locator("http://example.com/path"));
        for unsafe_value in [
            "https://user@example.com/path",
            "https://user:password@example.com/path",
            "https://example.com/path?token=secret",
            "https://example.com/callback?code=oauth-code",
            "https://example.com/file?signature=signed",
            "https://example.com/path#private",
            "//example.com/path",
            "urn:source:one",
            "source-one",
            "C:\\private\\file.txt",
        ] {
            assert!(!safe_locator(unsafe_value), "accepted {unsafe_value}");
        }
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
    fn exact_version_handoff_is_owner_bound_cas_and_searchable_after_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("artifact-handoff.sqlite");
        let vault = vault();
        let accepted_id;
        let corrupt_id;
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            seed(&store, "shared", "member-a");
            let scope = owner("shared", "member-a");
            let foreign = owner("shared", "member-b");
            store.transaction(|tx| {
                tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('other','Other','t','t')",[])?;
                for (id, owner, visibility, lifecycle, deleted_at) in [
                    ("project-2", Some("member-a"), "member-private", "active", None),
                    ("project-3", Some("member-a"), "member-private", "active", None),
                    ("project-archived", Some("member-a"), "member-private", "archived", None),
                    ("project-foreign", Some("member-b"), "member-private", "active", None),
                    ("project-shared", None, "workspace-shared", "active", None),
                    ("project-deleted", Some("member-a"), "member-private", "active", Some("t")),
                ] {
                    let payload=seal_json(&store,&json!({"id":id}),&format!("project:{id}"))?;
                    tx.execute("INSERT INTO project(id,workspace_id,title_fingerprint,authority,visibility,owner_member_id,created_by_internal_user_id,lifecycle,deleted_at,created_at,updated_at,payload,payload_nonce) VALUES (?1,'shared','title','local',?2,?3,'user-member-a',?4,?5,'t','t',?6,?7)",rusqlite::params![id,visibility,owner,lifecycle,deleted_at,payload.ciphertext,payload.nonce])?;
                }
                let cross=seal_json(&store,&json!({"id":"project-cross"}),"project:project-cross")?;
                tx.execute("INSERT INTO project(id,workspace_id,title_fingerprint,authority,visibility,owner_member_id,created_by_internal_user_id,lifecycle,created_at,updated_at,payload,payload_nonce) VALUES ('project-cross','other','title','local','member-private','member-a','user-member-a','active','t','t',?1,?2)",rusqlite::params![cross.ciphertext,cross.nonce])?;
                Ok(())
            }).unwrap();
            let v1 = version("version-1", 1, "One", None);
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
                        "hash-1",
                        3,
                        "t",
                        &artifact_value("shared", "member-a", "version-1", 1),
                        &v1,
                    )
                })
                .unwrap();
            let v2 = version("artifact-1:v2", 2, "Two", Some("version-1"));
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
                        "hash-2",
                        3,
                        "t2",
                        &artifact_value("shared", "member-a", "artifact-1:v2", 2),
                        &v2,
                    )
                })
                .unwrap();
            let before = store
                .with_conn(|tx| get_bundle(tx, &store, &scope, "artifact-1"))
                .unwrap()
                .unwrap();

            for target in [
                "project-1",
                "missing",
                "project-archived",
                "project-foreign",
                "project-shared",
                "project-deleted",
                "project-cross",
            ] {
                assert!(
                    store
                        .transaction(|tx| propose_handoff(
                            tx,
                            &store,
                            &scope,
                            "artifact-1",
                            "version-1",
                            target,
                            "user-member-a",
                            None,
                            "2026-07-11T01:00:00Z"
                        ))
                        .is_err(),
                    "accepted invalid target {target}"
                );
            }
            assert!(store
                .transaction(|tx| propose_handoff(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "missing",
                    "project-2",
                    "user-member-a",
                    None,
                    "2026-07-11T01:00:00Z"
                ))
                .is_err());
            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET status='redacted' WHERE workspace_id='shared' AND owner_subject=?1 AND id='version-1'",[scope.owner_subject()])?;Ok(())}).unwrap();
            assert!(store
                .transaction(|tx| propose_handoff(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "project-2",
                    "user-member-a",
                    None,
                    "2026-07-11T01:00:00Z"
                ))
                .is_err());
            store.transaction(|tx|{tx.execute("UPDATE artifact_version SET status='available' WHERE workspace_id='shared' AND owner_subject=?1 AND id='version-1'",[scope.owner_subject()])?;Ok(())}).unwrap();

            let proposed = store
                .transaction(|tx| {
                    propose_handoff(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "version-1",
                        "project-2",
                        "user-member-a",
                        Some("Share the approved snapshot"),
                        "2026-07-11T01:01:00Z",
                    )
                })
                .unwrap();
            accepted_id = proposed["id"].as_str().unwrap().to_string();
            assert_eq!(proposed["status"], "proposed");
            assert_eq!(proposed["artifactVersionIds"], json!(["version-1"]));
            assert_eq!(proposed["includedContext"], json!([]));
            assert_eq!(proposed["authorityTransfer"], "none");
            assert_eq!(proposed["proposedByInternalUserId"], "user-member-a");
            assert!(proposed.get("resolvedByInternalUserId").is_none());
            let resumed = store
                .transaction(|tx| {
                    propose_handoff(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "version-1",
                        "project-2",
                        "user-member-a",
                        Some("Share the approved snapshot"),
                        "2026-07-11T01:01:01Z",
                    )
                })
                .unwrap();
            assert_eq!(resumed, proposed);
            drop(store);
            let store = Store::open(&path, vault.clone()).unwrap();
            let resumed_after_reopen = store
                .transaction(|tx| {
                    propose_handoff(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "version-1",
                        "project-2",
                        "user-member-a",
                        Some("Share the approved snapshot"),
                        "2026-07-11T01:01:02Z",
                    )
                })
                .unwrap();
            assert_eq!(resumed_after_reopen, proposed);
            assert!(store
                .transaction(|tx| accept_handoff(
                    tx,
                    &store,
                    &scope,
                    &accepted_id,
                    2,
                    "user-member-a",
                    "2026-07-11T01:02:00Z"
                ))
                .is_err());
            assert!(store
                .transaction(|tx| accept_handoff(
                    tx,
                    &store,
                    &foreign,
                    &accepted_id,
                    1,
                    "user-member-b",
                    "2026-07-11T01:02:00Z"
                ))
                .is_err());
            let accepted = store
                .transaction(|tx| {
                    accept_handoff(
                        tx,
                        &store,
                        &scope,
                        &accepted_id,
                        1,
                        "user-member-a",
                        "2026-07-11T01:02:00Z",
                    )
                })
                .unwrap();
            assert_eq!(accepted["status"], "accepted");
            assert_eq!(accepted["revision"], 2);
            assert_eq!(accepted["resolvedByInternalUserId"], "user-member-a");
            assert!(store
                .transaction(|tx| propose_handoff(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "project-2",
                    "user-member-a",
                    None,
                    "2026-07-11T01:02:30Z"
                ))
                .is_err());
            assert!(store
                .transaction(|tx| accept_handoff(
                    tx,
                    &store,
                    &scope,
                    &accepted_id,
                    2,
                    "user-member-a",
                    "2026-07-11T01:03:00Z"
                ))
                .is_err());
            let after = store
                .with_conn(|tx| get_bundle(tx, &store, &scope, "artifact-1"))
                .unwrap()
                .unwrap();
            assert_eq!(
                after, before,
                "handoff mutated source artifact/version/reviews"
            );
            let search_project = |project_id: &str| {
                store
                    .with_conn(|tx| {
                        search(
                            tx,
                            &store,
                            &scope,
                            &ArtifactSearchFilter {
                                query: None,
                                thread_id: None,
                                project_id: Some(project_id),
                                kinds: &[],
                                statuses: &[],
                                limit: 50,
                            },
                        )
                    })
                    .unwrap()
            };
            let target = search_project("project-2");
            assert_eq!(target.len(), 1);
            assert_eq!(target[0]["currentVersion"]["id"], "version-1");
            assert_eq!(target[0]["artifact"]["currentVersionId"], "version-1");
            let serialized_target = serde_json::to_value(&target[0]).unwrap();
            assert_eq!(
                serialized_target["artifact"]["currentVersionId"],
                serialized_target["currentVersion"]["id"]
            );
            assert_eq!(
                search_project("project-1")[0]["currentVersion"]["id"],
                "artifact-1:v2"
            );
            assert!(search_project("project-3").is_empty());
            assert!(serde_json::to_string(&target)
                .unwrap()
                .find("Share the approved snapshot")
                .is_none());

            let corrupt = store
                .transaction(|tx| {
                    propose_handoff(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "artifact-1:v2",
                        "project-3",
                        "user-member-a",
                        None,
                        "2026-07-11T01:04:00Z",
                    )
                })
                .unwrap();
            corrupt_id = corrupt["id"].as_str().unwrap().to_string();
            store.transaction(|tx|{
                let sealed=tx.query_row("SELECT payload,payload_nonce FROM artifact_handoff WHERE workspace_id='shared' AND owner_subject=?1 AND id=?2",rusqlite::params![scope.owner_subject(),corrupt_id],|row|Ok(Sealed{ciphertext:row.get(0)?,nonce:row.get(1)?}))?;
                let mut payload=open_json(&store,&sealed,&handoff_aad(&scope,&corrupt_id))?;
                payload["includedContext"]=json!([{"workspaceId":"shared","projectId":"project-foreign"}]);
                payload["authorityTransfer"]=Value::String("full".into());
                let resealed=seal_json(&store,&payload,&handoff_aad(&scope,&corrupt_id))?;
                tx.execute("UPDATE artifact_handoff SET payload=?1,payload_nonce=?2 WHERE workspace_id='shared' AND owner_subject=?3 AND id=?4",rusqlite::params![resealed.ciphertext,resealed.nonce,scope.owner_subject(),corrupt_id])?;
                Ok(())
            }).unwrap();
            assert!(store
                .transaction(|tx| propose_handoff(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    "project-3",
                    "user-member-a",
                    None,
                    "2026-07-11T01:04:30Z"
                ))
                .is_err());
            assert!(store
                .transaction(|tx| accept_handoff(
                    tx,
                    &store,
                    &scope,
                    &corrupt_id,
                    1,
                    "user-member-a",
                    "2026-07-11T01:05:00Z"
                ))
                .is_err());
        }
        let store = Store::open(&path, vault).unwrap();
        let scope = owner("shared", "member-a");
        let target = store
            .with_conn(|tx| {
                search(
                    tx,
                    &store,
                    &scope,
                    &ArtifactSearchFilter {
                        query: None,
                        thread_id: None,
                        project_id: Some("project-2"),
                        kinds: &[],
                        statuses: &[],
                        limit: 50,
                    },
                )
            })
            .unwrap();
        assert_eq!(target[0]["currentVersion"]["id"], "version-1");
        assert_eq!(target[0]["artifact"]["currentVersionId"], "version-1");
        assert!(store
            .transaction(|tx| propose_handoff(
                tx,
                &store,
                &scope,
                "artifact-1",
                "version-1",
                "project-2",
                "user-member-a",
                None,
                "2026-07-11T01:07:00Z"
            ))
            .is_err());
        assert!(store
            .transaction(|tx| accept_handoff(
                tx,
                &store,
                &scope,
                &corrupt_id,
                1,
                "user-member-a",
                "2026-07-11T01:06:00Z"
            ))
            .is_err());
        let association_count:i64=store.with_conn(|tx|Ok(tx.query_row("SELECT COUNT(*) FROM artifact_handoff WHERE workspace_id='shared' AND owner_subject=?1 AND id=?2 AND status='accepted'",rusqlite::params![scope.owner_subject(),accepted_id],|row|row.get(0))?)).unwrap();
        assert_eq!(association_count, 1);
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
