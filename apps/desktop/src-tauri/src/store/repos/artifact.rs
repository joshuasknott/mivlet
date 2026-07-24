//! Owner-qualified durable artifacts and immutable version history.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::store::repos::{open_json, payload_of, scope::PrivateDataScope, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

const ACCEPTED_MISSION_ARTIFACT_TITLE: &str = "Connected work brief";
const GENERAL_DECLARED_GRAPH_MARKER: &str = "native:general-declared-graph:v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedMissionArtifactBinding {
    pub artifact_id: String,
    pub artifact_version_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectMissionArtifactBinding {
    pub artifact_id: String,
    pub artifact_version_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttestedArtifactVersionReference {
    pub artifact_id: String,
    pub artifact_version_id: String,
    pub title: String,
    pub content_hash: String,
}

#[derive(Clone, Copy, Debug)]
pub struct DirectMissionArtifactReference<'a> {
    pub field_key: &'a str,
    pub reference: &'a AttestedArtifactVersionReference,
}

#[derive(Clone, Copy, Debug)]
pub struct DirectMissionWorkerOutputReference<'a> {
    pub worker_id: &'a str,
    pub completion_event_id: &'a str,
    pub output_key: &'a str,
    pub value_reference: &'a str,
    pub content_hash: &'a str,
}

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

pub fn attest_available_artifact_version(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    project_id: Option<&str>,
    artifact_id: &str,
    artifact_version_id: &str,
) -> Result<AttestedArtifactVersionReference> {
    let reference =
        attest_existing_artifact_version(tx, store, scope, artifact_id, artifact_version_id)?;
    let bundle = get_bundle(tx, store, scope, artifact_id)?
        .ok_or_else(|| StoreError::Invalid("The selected artifact is unavailable.".into()))?;
    if bundle.pointer("/artifact/status").and_then(Value::as_str) == Some("deleted") {
        return Err(StoreError::Invalid(
            "The selected artifact is no longer available.".into(),
        ));
    }
    if let Some(project_id) = project_id {
        if !exact_owner_project(tx, scope, project_id)? {
            return Err(StoreError::Invalid(
                "The selected artifact project is unavailable for this owner.".into(),
            ));
        }
        let direct_payload = bundle
            .pointer("/artifact/context/projectId")
            .and_then(Value::as_str)
            == Some(project_id);
        let direct_thread: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact a JOIN thread t
               ON t.id=a.thread_id AND t.workspace_id=a.workspace_id
             WHERE a.workspace_id=?1 AND a.owner_subject=?2 AND a.id=?3
               AND t.project_id=?4 AND t.authority='local' AND t.visibility='member-private'
               AND t.deleted_at IS NULL AND t.owner_member_id=?5)",
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                artifact_id,
                project_id,
                scope.owner_member_id()
            ],
            |row| row.get(0),
        )?;
        let handed_off = latest_accepted_handoff_matches(
            tx,
            scope,
            artifact_id,
            artifact_version_id,
            project_id,
        )?;
        let current_matches = bundle
            .pointer("/artifact/currentVersionId")
            .and_then(Value::as_str)
            == Some(artifact_version_id);
        if !handed_off && (!(direct_payload || direct_thread) || !current_matches) {
            return Err(StoreError::Invalid(
                "The selected artifact version is outside this project.".into(),
            ));
        }
    } else if bundle
        .pointer("/artifact/currentVersionId")
        .and_then(Value::as_str)
        != Some(artifact_version_id)
    {
        return Err(StoreError::Invalid(
            "Select the artifact's current version for this mission.".into(),
        ));
    }
    Ok(reference)
}

fn latest_accepted_handoff_matches(
    tx: &Connection,
    scope: &PrivateDataScope,
    artifact_id: &str,
    artifact_version_id: &str,
    project_id: &str,
) -> Result<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM artifact_handoff h
         WHERE h.workspace_id=?1 AND h.owner_subject=?2 AND h.artifact_id=?3
           AND h.version_id=?4 AND h.target_project_id=?5 AND h.status='accepted'
           AND h.id=(SELECT latest.id FROM artifact_handoff latest
             WHERE latest.workspace_id=h.workspace_id AND latest.owner_subject=h.owner_subject
               AND latest.artifact_id=h.artifact_id AND latest.target_project_id=h.target_project_id
               AND latest.status='accepted'
             ORDER BY latest.resolved_at DESC,latest.id DESC LIMIT 1))",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            artifact_id,
            artifact_version_id,
            project_id
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn attest_existing_artifact_version(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    artifact_id: &str,
    artifact_version_id: &str,
) -> Result<AttestedArtifactVersionReference> {
    scope.ensure_exists(tx)?;
    if artifact_id.trim().is_empty()
        || artifact_id.len() > 200
        || artifact_version_id.trim().is_empty()
        || artifact_version_id.len() > 200
    {
        return Err(StoreError::Invalid(
            "Artifact input reference is invalid.".into(),
        ));
    }
    let bundle = get_bundle(tx, store, scope, artifact_id)?
        .ok_or_else(|| StoreError::Invalid("The selected artifact is unavailable.".into()))?;
    let artifact = bundle
        .get("artifact")
        .ok_or_else(|| StoreError::Invalid("The selected artifact is invalid.".into()))?;
    let version = bundle
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|versions| {
            versions.iter().find(|version| {
                version.get("id").and_then(Value::as_str) == Some(artifact_version_id)
            })
        })
        .ok_or_else(|| {
            StoreError::Invalid("The selected artifact version is unavailable.".into())
        })?;
    let title = artifact
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty() && title.chars().count() <= 400)
        .ok_or_else(|| StoreError::Invalid("The selected artifact title is invalid.".into()))?;
    let content_hash = version
        .pointer("/contentHash/value")
        .and_then(Value::as_str)
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| StoreError::Invalid("The selected artifact hash is invalid.".into()))?;
    let inline_text = version
        .pointer("/content/text")
        .and_then(Value::as_str)
        .filter(|_| version.pointer("/content/kind").and_then(Value::as_str) == Some("inline"))
        .ok_or_else(|| {
            StoreError::Invalid(
                "Only an inline immutable artifact version can be used as mission input.".into(),
            )
        })?;
    let computed_hash = format!("{:x}", Sha256::digest(inline_text.as_bytes()));
    let stored_record: Option<(String, i64)> = tx
        .query_row(
            "SELECT content_fingerprint,size_bytes FROM artifact_version
             WHERE workspace_id=?1 AND owner_subject=?2 AND artifact_id=?3 AND id=?4
               AND status='available'",
            rusqlite::params![
                scope.workspace_id(),
                scope.owner_subject(),
                artifact_id,
                artifact_version_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if artifact.get("id").and_then(Value::as_str) != Some(artifact_id)
        || artifact.get("workspaceId").and_then(Value::as_str) != Some(scope.workspace_id())
        || artifact.get("visibility").and_then(Value::as_str) != Some("member-private")
        || artifact.get("authority").and_then(Value::as_str) != Some("local")
        || version.get("artifactId").and_then(Value::as_str) != Some(artifact_id)
        || version.get("status").and_then(Value::as_str) != Some("available")
        || version
            .pointer("/contentHash/algorithm")
            .and_then(Value::as_str)
            != Some("sha-256")
        || version.pointer("/content/contentHash") != version.get("contentHash")
        || version.pointer("/content/media") != version.get("media")
        || version.pointer("/media/byteLength").and_then(Value::as_i64)
            != Some(inline_text.len() as i64)
        || computed_hash != content_hash
        || stored_record.as_ref().map(|record| record.0.as_str()) != Some(content_hash)
        || stored_record.as_ref().map(|record| record.1) != Some(inline_text.len() as i64)
    {
        return Err(StoreError::Invalid(
            "The selected artifact version no longer matches its immutable record.".into(),
        ));
    }
    Ok(AttestedArtifactVersionReference {
        artifact_id: artifact_id.into(),
        artifact_version_id: artifact_version_id.into(),
        title: title.trim().into(),
        content_hash: content_hash.into(),
    })
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

/// Remove project-only handoff authority when a private project is deleted.
/// Source lineage becomes workspace lineage; a handoff into a deleted target
/// is removed rather than silently transferred to another scope.
pub fn detach_project_handoffs(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    project_id: &str,
    updated_at: &str,
) -> Result<(usize, usize)> {
    let removed = tx.execute(
        "DELETE FROM artifact_handoff
         WHERE workspace_id=?1 AND owner_subject=?2 AND target_project_id=?3;",
        rusqlite::params![scope.workspace_id(), scope.owner_subject(), project_id],
    )?;
    let mut stmt = tx.prepare(
        "SELECT id,payload,payload_nonce FROM artifact_handoff
         WHERE workspace_id=?1 AND owner_subject=?2 AND source_project_id=?3;",
    )?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), scope.owner_subject(), project_id],
            |row| Ok((row.get::<_, String>(0)?, payload_of(row)?)),
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut detached = 0;
    for (handoff_id, sealed) in rows {
        let mut payload = open_json(store, &sealed, &handoff_aad(scope, &handoff_id))?;
        let source = payload
            .get_mut("source")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| StoreError::Invalid("Artifact handoff source is invalid.".into()))?;
        if source.get("projectId").and_then(Value::as_str) != Some(project_id) {
            return Err(StoreError::Invalid(
                "Artifact handoff source does not match its encrypted content.".into(),
            ));
        }
        source.remove("projectId");
        payload["updatedAt"] = Value::String(updated_at.into());
        let sealed = seal_json(store, &payload, &handoff_aad(scope, &handoff_id))?;
        let changed = tx.execute(
            "UPDATE artifact_handoff SET source_project_id=NULL,payload=?1,payload_nonce=?2
             WHERE workspace_id=?3 AND owner_subject=?4 AND id=?5 AND source_project_id=?6;",
            rusqlite::params![
                sealed.ciphertext,
                sealed.nonce,
                scope.workspace_id(),
                scope.owner_subject(),
                handoff_id,
                project_id
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::Invalid(
                "Artifact handoff changed during project deletion.".into(),
            ));
        }
        detached += 1;
    }
    Ok((detached, removed))
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

pub fn accepted_mission_output_binding(
    workspace_id: &str,
    owner_member_id: &str,
    run_id: &str,
    worker_id: &str,
    completion_event_id: &str,
    output_key: &str,
    content_hash: &str,
) -> AcceptedMissionArtifactBinding {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "accepted-mission-artifact:v1|{workspace_id}|{owner_member_id}|{run_id}|{worker_id}|{completion_event_id}|{output_key}|{content_hash}"
            )
            .as_bytes()
        )
    );
    AcceptedMissionArtifactBinding {
        artifact_id: format!("mission-artifact-{}", &digest[..40]),
        artifact_version_id: format!("mission-artifact-version-{}", &digest[..40]),
    }
}

fn reviewed_general_mission_output_binding(
    workspace_id: &str,
    owner_member_id: &str,
    run_id: &str,
    worker_id: &str,
    completion_event_id: &str,
    output_key: &str,
    content_hash: &str,
) -> AcceptedMissionArtifactBinding {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "reviewed-general-mission-artifact:v1|{workspace_id}|{owner_member_id}|{run_id}|{worker_id}|{completion_event_id}|{output_key}|{content_hash}"
            )
            .as_bytes()
        )
    );
    AcceptedMissionArtifactBinding {
        artifact_id: format!("mission-reviewed-artifact-{}", &digest[..40]),
        artifact_version_id: format!("mission-reviewed-artifact-version-{}", &digest[..40]),
    }
}

pub fn reviewed_general_mission_binding_for_reference(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    output_key: &str,
    value_reference: &str,
) -> Result<AcceptedMissionArtifactBinding> {
    scope.ensure_exists(tx)?;
    if scope.owner_member_id() != Some(owner_member_id) {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact owner does not match its authenticated member.".into(),
        ));
    }
    let receipt = super::mission_worker_output::get_by_reference(
        tx,
        store,
        scope.data(),
        owner_member_id,
        value_reference,
    )?
    .ok_or_else(|| StoreError::Invalid("Reviewed Mission output receipt is unavailable.".into()))?;
    if receipt.run_id != run_id || receipt.output_key != output_key {
        return Err(StoreError::Invalid(
            "Reviewed Mission output receipt represents another result.".into(),
        ));
    }
    Ok(reviewed_general_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        &receipt.worker_id,
        &receipt.completion_event_id,
        output_key,
        &receipt.content_hash,
    ))
}

pub fn direct_mission_output_binding(
    workspace_id: &str,
    owner_member_id: &str,
    run_id: &str,
    source_event_id: &str,
    output_key: &str,
    content_hash: &str,
) -> DirectMissionArtifactBinding {
    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "direct-mission-artifact:v1|{workspace_id}|{owner_member_id}|{run_id}|{source_event_id}|{output_key}|{content_hash}"
            )
            .as_bytes()
        )
    );
    DirectMissionArtifactBinding {
        artifact_id: format!("mission-direct-artifact-{}", &digest[..40]),
        artifact_version_id: format!("mission-direct-artifact-version-{}", &digest[..40]),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_direct_mission_output(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    source_event_id: &str,
    result_event_id: &str,
    output_key: &str,
    title: &str,
    text: &str,
    expected: &DirectMissionArtifactBinding,
) -> Result<DirectMissionArtifactBinding> {
    create_direct_mission_output_inner(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        source_event_id,
        result_event_id,
        output_key,
        title,
        text,
        expected,
        "source",
        "Authenticated structured intake response",
        None,
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn create_direct_mission_output_with_artifact_reference(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    source_event_id: &str,
    result_event_id: &str,
    output_key: &str,
    title: &str,
    text: &str,
    expected: &DirectMissionArtifactBinding,
    input_label: &str,
    source_reference: DirectMissionArtifactReference<'_>,
) -> Result<DirectMissionArtifactBinding> {
    create_direct_mission_output_inner(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        source_event_id,
        result_event_id,
        output_key,
        title,
        text,
        expected,
        "user-input",
        input_label,
        Some(source_reference),
        &[],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn create_direct_mission_aggregate_output(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    join_event_id: &str,
    result_event_id: &str,
    output_key: &str,
    title: &str,
    text: &str,
    expected: &DirectMissionArtifactBinding,
    worker_outputs: &[DirectMissionWorkerOutputReference<'_>],
) -> Result<DirectMissionArtifactBinding> {
    if worker_outputs.len() < 2 || worker_outputs.len() > 8 {
        return Err(StoreError::Invalid(
            "A mission aggregate requires between two and eight exact worker outputs.".into(),
        ));
    }
    create_direct_mission_output_inner(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        join_event_id,
        result_event_id,
        output_key,
        title,
        text,
        expected,
        "source",
        "Deterministic worker join",
        None,
        worker_outputs,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_direct_mission_output_inner(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    source_event_id: &str,
    result_event_id: &str,
    output_key: &str,
    title: &str,
    text: &str,
    expected: &DirectMissionArtifactBinding,
    input_kind: &str,
    input_label: &str,
    source_reference: Option<DirectMissionArtifactReference<'_>>,
    worker_outputs: &[DirectMissionWorkerOutputReference<'_>],
) -> Result<DirectMissionArtifactBinding> {
    scope.ensure_exists(tx)?;
    if scope.owner_member_id() != Some(owner_member_id)
        || !matches!(input_kind, "source" | "user-input")
        || input_label.trim().is_empty()
        || input_label.chars().count() > 200
        || title.trim().is_empty()
        || title.chars().count() > 400
        || text.trim().is_empty()
        || text.len() > 131_072
    {
        return Err(StoreError::Invalid(
            "Direct mission artifact input is invalid.".into(),
        ));
    }
    let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let derived = direct_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        source_event_id,
        output_key,
        &content_hash,
    );
    if &derived != expected {
        return Err(StoreError::Invalid(
            "Direct mission artifact identity does not match its content.".into(),
        ));
    }
    let journal = super::mission_run::get(tx, store, scope.data(), owner_member_id, run_id)?
        .ok_or_else(|| StoreError::Invalid("Direct mission artifact run is unavailable.".into()))?;
    let source = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(source_event_id));
    let result = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id));
    validate_direct_worker_outputs(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        source,
        worker_outputs,
    )?;
    if let Some(reference) = source_reference {
        validate_direct_source_reference(tx, store, scope, source, reference)?;
    }
    let output_matches = |value: &Value| {
        value.get("key").and_then(Value::as_str) == Some(output_key)
            && value.get("artifactId").and_then(Value::as_str)
                == Some(expected.artifact_id.as_str())
            && value.get("artifactVersionId").and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str())
            && value.get("valueReference").and_then(Value::as_str)
                == Some(format!("sha256:{content_hash}").as_str())
    };
    if journal.run.get("status").and_then(Value::as_str) != Some("completed")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id)
        || !source.is_some_and(|event| {
            let expected_type = if worker_outputs.is_empty() {
                "human-input-received"
            } else {
                "join-resolved"
            };
            event.get("type").and_then(Value::as_str) == Some(expected_type)
                && event.get("runId").and_then(Value::as_str) == Some(run_id)
        })
        || !result.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("run-completed")
                && event.get("previousEventId").and_then(Value::as_str) == Some(source_event_id)
                && event
                    .pointer("/payload/result/outcome")
                    .and_then(Value::as_str)
                    == Some("succeeded")
                && event
                    .pointer("/payload/result/outputs/0")
                    .is_some_and(output_matches)
        })
    {
        return Err(StoreError::Invalid(
            "Direct mission artifact is not linked to an exact completed local input result."
                .into(),
        ));
    }
    if let Some(existing) = get_direct_mission_source_binding(
        tx,
        scope,
        owner_member_id,
        run_id,
        output_key,
        source_event_id,
        result_event_id,
        &content_hash,
    )? {
        validate_direct_mission_artifact_bundle(tx, store, scope, &existing, &content_hash)?;
        if let Some(reference) = source_reference {
            validate_direct_artifact_reference_bundle(
                tx,
                store,
                scope,
                &existing,
                source_event_id,
                input_kind,
                input_label,
                reference,
            )?;
        }
        return if existing == *expected {
            Ok(existing)
        } else {
            Err(StoreError::Invalid(
                "Direct mission source represents another artifact.".into(),
            ))
        };
    }
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Direct mission source conversation is missing.".into())
        })?;
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Direct mission identity is missing.".into()))?;
    let actor = journal
        .run
        .get("createdByInternalUserId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Direct mission creator is missing.".into()))?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2 AND authority='local'
          AND visibility='member-private' AND deleted_at IS NULL AND owner_member_id=?3)",
        rusqlite::params![source_thread_id, scope.workspace_id(), owner_member_id],
        |row| row.get(0),
    )?;
    if !owns_thread {
        return Err(StoreError::Invalid(
            "Direct mission source conversation is unavailable for this owner.".into(),
        ));
    }
    let at = source
        .and_then(|event| {
            if worker_outputs.is_empty() {
                event.pointer("/payload/resolution/receivedAt")
            } else {
                event.get("occurredAt")
            }
        })
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Direct mission source time is missing.".into()))?;
    let provenance = json!({
        "kind":"run","runId":run_id,"externalReference":source_event_id,"observedAt":at
    });
    let media = json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
    let hash = json!({"algorithm":"sha-256","value":content_hash});
    let mut inputs = vec![json!({"kind":input_kind,"referenceId":source_event_id,
        "label":input_label.trim(),"recordedAt":at})];
    for output in worker_outputs {
        inputs.push(json!({
            "kind":"source","referenceId":output.value_reference,
            "label":format!("Worker {} output {}", output.worker_id, output.output_key),
            "recordedAt":at,
            "contentHash":{"algorithm":"sha-256","value":output.content_hash}
        }));
    }
    let mut lineage = Vec::new();
    if let Some(source) = source_reference {
        inputs.push(json!({
            "kind":"artifact-version","referenceId":source.reference.artifact_version_id,
            "label":source.reference.title,"recordedAt":at,
            "contentHash":{"algorithm":"sha-256","value":source.reference.content_hash}
        }));
        lineage.push(json!({
            "relation":"references","artifactId":source.reference.artifact_id,
            "artifactVersionId":source.reference.artifact_version_id,"recordedAt":at
        }));
    }
    let artifact_value = json!({
        "id":expected.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local",
        "visibility":"member-private","ownerMemberId":owner_member_id,"schemaVersion":1,"revision":1,
        "createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,"kind":"document","status":"draft",
        "title":title.trim(),"currentVersionId":expected.artifact_version_id,"producingRunId":run_id,
        "sourceProvenance":[provenance.clone()],"context":{"threadId":source_thread_id,"missionId":mission_id,
            "projectId":journal.run.get("projectId")},"reviews":[],"retention":{"status":"active"}
    });
    let version_value = json!({
        "id":expected.artifact_version_id,"artifactId":expected.artifact_id,"version":1,"status":"available",
        "createdAt":at,"createdByInternalUserId":actor,
        "content":{"kind":"inline","text":text,"media":media,"contentHash":hash},
        "media":media,"contentHash":hash,"provenance":provenance,"citations":[],
        "inputs":inputs,"decisions":[],"lineage":lineage
    });
    let sealed_artifact = seal_json(
        store,
        &artifact_value,
        &artifact_aad(scope, &expected.artifact_id),
    )?;
    let sealed_version = seal_json(
        store,
        &version_value,
        &version_aad(scope, &expected.artifact_id, &expected.artifact_version_id),
    )?;
    let title_fingerprint = format!("{:x}", Sha256::digest(title.trim().as_bytes()));
    tx.execute(
        "INSERT INTO artifact
         (workspace_id,owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,
          id,run_id,thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,
          content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,'local','member-private',?3,?4,?5,NULL,?6,NULL,'document','draft',1,?7,?8,?9,?10,?11,?11,?12,?13)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),owner_member_id,scope.owner_internal_user_id(),
            expected.artifact_id,source_thread_id,expected.artifact_version_id,title_fingerprint,
            content_hash,text.len() as i64,at,sealed_artifact.ciphertext,sealed_artifact.nonce],
    )?;
    tx.execute(
        "INSERT INTO artifact_version
         (workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,1,'available',?5,?6,?7,?8,?9)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),expected.artifact_id,
            expected.artifact_version_id,content_hash,text.len() as i64,at,
            sealed_version.ciphertext,sealed_version.nonce],
    )?;
    tx.execute(
        "INSERT INTO mission_direct_artifact_source
         (workspace_id,owner_member_id,mission_run_id,output_key,owner_subject,artifact_id,
          artifact_version_id,source_event_id,result_event_id,content_hash,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            scope.workspace_id(),
            owner_member_id,
            run_id,
            output_key,
            scope.owner_subject(),
            expected.artifact_id,
            expected.artifact_version_id,
            source_event_id,
            result_event_id,
            content_hash,
            at
        ],
    )?;
    validate_direct_mission_artifact_bundle(tx, store, scope, expected, &content_hash)?;
    if let Some(reference) = source_reference {
        validate_direct_artifact_reference_bundle(
            tx,
            store,
            scope,
            expected,
            source_event_id,
            input_kind,
            input_label,
            reference,
        )?;
    }
    Ok(expected.clone())
}

#[allow(clippy::too_many_arguments)]
fn validate_direct_worker_outputs(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    join_event: Option<&Value>,
    worker_outputs: &[DirectMissionWorkerOutputReference<'_>],
) -> Result<()> {
    if worker_outputs.is_empty() {
        return Ok(());
    }
    let join = join_event.ok_or_else(|| {
        StoreError::Invalid("Mission aggregate join event is unavailable.".into())
    })?;
    let satisfied = join
        .pointer("/payload/join/satisfiedWorkerIds")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Mission aggregate join is invalid.".into()))?;
    if join.get("type").and_then(Value::as_str) != Some("join-resolved")
        || join.pointer("/payload/join/status").and_then(Value::as_str) != Some("satisfied")
        || satisfied.len() != worker_outputs.len()
    {
        return Err(StoreError::Invalid(
            "Mission aggregate requires one satisfied durable join.".into(),
        ));
    }
    let journal = super::mission_run::get(tx, store, scope.data(), owner_member_id, run_id)?
        .ok_or_else(|| StoreError::Invalid("Mission aggregate run is unavailable.".into()))?;
    let mut unique_workers = std::collections::BTreeSet::new();
    let mut unique_references = std::collections::BTreeSet::new();
    for output in worker_outputs {
        if !unique_workers.insert(output.worker_id)
            || !unique_references.insert(output.value_reference)
            || !satisfied
                .iter()
                .any(|worker| worker.as_str() == Some(output.worker_id))
        {
            return Err(StoreError::Invalid(
                "Mission aggregate worker outputs must be unique join members.".into(),
            ));
        }
        let event = journal.events.iter().find(|event| {
            event.get("id").and_then(Value::as_str) == Some(output.completion_event_id)
        });
        if !event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("worker-completed")
                && event.pointer("/payload/workerId").and_then(Value::as_str)
                    == Some(output.worker_id)
                && event
                    .pointer("/payload/outputs/0/key")
                    .and_then(Value::as_str)
                    == Some(output.output_key)
                && event
                    .pointer("/payload/outputs/0/valueReference")
                    .and_then(Value::as_str)
                    == Some(output.value_reference)
        }) {
            return Err(StoreError::Invalid(
                "Mission aggregate worker completion is invalid.".into(),
            ));
        }
        let receipt = super::mission_worker_output::get_by_reference(
            tx,
            store,
            scope.data(),
            owner_member_id,
            output.value_reference,
        )?
        .ok_or_else(|| {
            StoreError::Invalid("Mission aggregate output receipt is unavailable.".into())
        })?;
        if receipt.run_id != run_id
            || receipt.worker_id != output.worker_id
            || receipt.completion_event_id != output.completion_event_id
            || receipt.output_key != output.output_key
            || receipt.value_reference != output.value_reference
            || receipt.content_hash != output.content_hash
            || receipt
                .receipt
                .pointer("/contentHash")
                .and_then(Value::as_str)
                != Some(output.content_hash)
        {
            return Err(StoreError::Invalid(
                "Mission aggregate output receipt crosses its immutable worker boundary.".into(),
            ));
        }
    }
    Ok(())
}

fn validate_direct_source_reference(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    source_event: Option<&Value>,
    source: DirectMissionArtifactReference<'_>,
) -> Result<()> {
    let event = source_event.ok_or_else(|| {
        StoreError::Invalid("Direct mission artifact input event is unavailable.".into())
    })?;
    let matching = event
        .pointer("/payload/resolution/values")
        .and_then(Value::as_array)
        .and_then(|values| {
            values.iter().find(|value| {
                value.get("fieldKey").and_then(Value::as_str) == Some(source.field_key)
            })
        })
        .and_then(|value| value.get("value"));
    let expected_hash = json!({
        "algorithm":"sha-256","value":source.reference.content_hash
    });
    if event.get("type").and_then(Value::as_str) != Some("human-input-received")
        || matching
            .and_then(|value| value.get("artifactId"))
            .and_then(Value::as_str)
            != Some(source.reference.artifact_id.as_str())
        || matching
            .and_then(|value| value.get("artifactVersionId"))
            .and_then(Value::as_str)
            != Some(source.reference.artifact_version_id.as_str())
        || matching.and_then(|value| value.get("contentHash")) != Some(&expected_hash)
        || matching
            .and_then(Value::as_object)
            .is_none_or(|value| value.len() != 3)
    {
        return Err(StoreError::Invalid(
            "Direct mission artifact input is not bound to its attested source version.".into(),
        ));
    }
    let existing = attest_existing_artifact_version(
        tx,
        store,
        scope,
        &source.reference.artifact_id,
        &source.reference.artifact_version_id,
    )?;
    if existing.artifact_id != source.reference.artifact_id
        || existing.artifact_version_id != source.reference.artifact_version_id
        || existing.content_hash != source.reference.content_hash
    {
        return Err(StoreError::Invalid(
            "Direct mission artifact source version changed after attestation.".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_direct_artifact_reference_bundle(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    binding: &DirectMissionArtifactBinding,
    source_event_id: &str,
    input_kind: &str,
    input_label: &str,
    source: DirectMissionArtifactReference<'_>,
) -> Result<()> {
    let bundle = get_bundle(tx, store, scope, &binding.artifact_id)?
        .ok_or_else(|| StoreError::Invalid("Direct mission artifact is unavailable.".into()))?;
    let version = bundle
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|versions| {
            versions.iter().find(|version| {
                version.get("id").and_then(Value::as_str)
                    == Some(binding.artifact_version_id.as_str())
            })
        })
        .ok_or_else(|| {
            StoreError::Invalid("Direct mission artifact version is unavailable.".into())
        })?;
    let at = version
        .get("createdAt")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Direct mission artifact time is invalid.".into()))?;
    let expected_inputs = json!([
        {"kind":input_kind,"referenceId":source_event_id,"label":input_label.trim(),"recordedAt":at},
        {"kind":"artifact-version","referenceId":source.reference.artifact_version_id,
         "label":source.reference.title,"recordedAt":at,
         "contentHash":{"algorithm":"sha-256","value":source.reference.content_hash}}
    ]);
    let expected_lineage = json!([{
        "relation":"references","artifactId":source.reference.artifact_id,
        "artifactVersionId":source.reference.artifact_version_id,"recordedAt":at
    }]);
    if version.get("inputs") != Some(&expected_inputs)
        || version.get("lineage") != Some(&expected_lineage)
    {
        return Err(StoreError::Invalid(
            "Direct mission artifact no longer retains its exact source version.".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn get_direct_mission_source_binding(
    tx: &Connection,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    output_key: &str,
    source_event_id: &str,
    result_event_id: &str,
    content_hash: &str,
) -> Result<Option<DirectMissionArtifactBinding>> {
    scope.ensure_exists(tx)?;
    tx.query_row(
        "SELECT artifact_id,artifact_version_id FROM mission_direct_artifact_source
         WHERE workspace_id=?1 AND owner_member_id=?2 AND mission_run_id=?3 AND output_key=?4
           AND owner_subject=?5 AND source_event_id=?6 AND result_event_id=?7 AND content_hash=?8",
        rusqlite::params![
            scope.workspace_id(),
            owner_member_id,
            run_id,
            output_key,
            scope.owner_subject(),
            source_event_id,
            result_event_id,
            content_hash
        ],
        |row| {
            Ok(DirectMissionArtifactBinding {
                artifact_id: row.get(0)?,
                artifact_version_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn validate_direct_mission_artifact_bundle(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    binding: &DirectMissionArtifactBinding,
    content_hash: &str,
) -> Result<()> {
    let bundle = get_bundle(tx, store, scope, &binding.artifact_id)?
        .ok_or_else(|| StoreError::Invalid("Direct mission artifact is missing.".into()))?;
    let source_version = bundle
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|versions| {
            versions.iter().find(|version| {
                version.get("id").and_then(Value::as_str)
                    == Some(binding.artifact_version_id.as_str())
            })
        });
    if bundle.pointer("/artifact/id").and_then(Value::as_str) == Some(binding.artifact_id.as_str())
        && source_version.is_some_and(|version| {
            version.get("artifactId").and_then(Value::as_str) == Some(binding.artifact_id.as_str())
                && version.get("version").and_then(Value::as_i64) == Some(1)
                && version
                    .pointer("/contentHash/value")
                    .and_then(Value::as_str)
                    == Some(content_hash)
        })
    {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "Direct mission artifact no longer matches its source output.".into(),
        ))
    }
}

fn exact_human_approval_chain(
    journal: &super::mission_run::MissionRunJournalRow,
    lifecycle: &super::mission_plan::MissionPlanLifecycleRow,
    result_event: &Value,
    evaluation_event_id: &str,
    actor: &str,
) -> bool {
    let Some(resolution_id) = result_event.get("previousEventId").and_then(Value::as_str) else {
        return false;
    };
    let Some(resolution) = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(resolution_id)
            && event.get("type").and_then(Value::as_str) == Some("approval-resolved")
    }) else {
        return false;
    };
    let wait_key = resolution
        .pointer("/payload/resolution/waitKey")
        .and_then(Value::as_str);
    let proposal_hash = resolution
        .pointer("/payload/resolution/acceptedProposalHash")
        .and_then(Value::as_str);
    let Some(request) = journal.events.iter().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("approval-requested")
            && event
                .pointer("/payload/wait/waitKey")
                .and_then(Value::as_str)
                == wait_key
    }) else {
        return false;
    };
    let checkpoint_id = request.get("previousEventId").and_then(Value::as_str);
    let checkpoint = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == checkpoint_id
            && event.get("type").and_then(Value::as_str) == Some("checkpoint-created")
    });
    lifecycle
        .mission
        .pointer("/acceptance/requiresHumanAcceptance")
        .and_then(Value::as_bool)
        == Some(true)
        && lifecycle.current_revision.get("id") == journal.run.get("planRevisionId")
        && resolution
            .pointer("/payload/resolution/decision")
            .and_then(Value::as_str)
            == Some("approved")
        && resolution.get("previousEventId") == request.get("id")
        && resolution
            .pointer("/payload/resolution/decidedByInternalUserId")
            .and_then(Value::as_str)
            == Some(actor)
        && proposal_hash.is_some()
        && request
            .pointer("/payload/wait/proposalHash")
            .and_then(Value::as_str)
            == proposal_hash
        && request
            .pointer("/payload/wait/status")
            .and_then(Value::as_str)
            == Some("pending")
        && checkpoint.is_some_and(|event| {
            event
                .pointer("/payload/checkpoint/kind")
                .and_then(Value::as_str)
                == Some("wait-boundary")
                && event
                    .pointer("/payload/checkpoint/pendingWaitKey")
                    .and_then(Value::as_str)
                    == wait_key
                && event.get("previousEventId").and_then(Value::as_str) == Some(evaluation_event_id)
        })
}

fn result_chain_matches_acceptance(
    requires_human: bool,
    ordinary_result_chain: bool,
    human_approval_chain: bool,
) -> bool {
    if requires_human {
        human_approval_chain
    } else {
        ordinary_result_chain
    }
}

fn linked_human_resolution<'a>(
    journal: &'a super::mission_run::MissionRunJournalRow,
    result: &Value,
) -> Option<&'a Value> {
    let resolution_id = result.get("previousEventId").and_then(Value::as_str)?;
    journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(resolution_id)
            && event.get("type").and_then(Value::as_str) == Some("approval-resolved")
            && event
                .pointer("/payload/resolution/decision")
                .and_then(Value::as_str)
                == Some("approved")
    })
}

#[allow(clippy::too_many_arguments)]
pub fn create_reviewed_general_mission_output(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    result_event_id: &str,
    output_key: &str,
    value_reference: &str,
    title: &str,
    expected: &AcceptedMissionArtifactBinding,
) -> Result<AcceptedMissionArtifactBinding> {
    scope.ensure_exists(tx)?;
    if scope.owner_member_id() != Some(owner_member_id)
        || title.trim().is_empty()
        || title.chars().count() > 400
    {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact input is invalid.".into(),
        ));
    }
    let receipt = super::mission_worker_output::get_by_reference(
        tx,
        store,
        scope.data(),
        owner_member_id,
        value_reference,
    )?
    .ok_or_else(|| StoreError::Invalid("Reviewed Mission output receipt is unavailable.".into()))?;
    if receipt.run_id != run_id || receipt.output_key != output_key {
        return Err(StoreError::Invalid(
            "Reviewed Mission output receipt represents another result.".into(),
        ));
    }
    let derived = reviewed_general_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        &receipt.worker_id,
        &receipt.completion_event_id,
        output_key,
        &receipt.content_hash,
    );
    if &derived != expected {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact identity does not match its immutable output.".into(),
        ));
    }
    let journal = super::mission_run::get(tx, store, scope.data(), owner_member_id, run_id)?
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission artifact run is unavailable.".into())
        })?;
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission artifact Mission is unavailable.".into())
        })?;
    let lifecycle = super::mission_plan::get(tx, store, scope.data(), owner_member_id, mission_id)?
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission artifact plan is unavailable.".into())
        })?;
    let declared_general = lifecycle
        .mission
        .get("constraints")
        .and_then(Value::as_array)
        .is_some_and(|constraints| {
            constraints.iter().any(|constraint| {
                constraint.get("key").and_then(Value::as_str) == Some(GENERAL_DECLARED_GRAPH_MARKER)
                    && constraint.get("severity").and_then(Value::as_str) == Some("required")
            })
        });
    if !declared_general
        || lifecycle.current_revision.get("id") != journal.run.get("planRevisionId")
        || journal.run.get("status").and_then(Value::as_str) != Some("completed")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id)
    {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact is outside the selected completed general plan.".into(),
        ));
    }
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| StoreError::Invalid("Reviewed Mission plan steps are invalid.".into()))?;
    let producers = steps
        .iter()
        .filter(|step| {
            step.get("expectedOutputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| {
                    outputs
                        .iter()
                        .any(|output| output.get("key").and_then(Value::as_str) == Some(output_key))
                })
        })
        .collect::<Vec<_>>();
    if producers.len() != 1 {
        return Err(StoreError::Invalid(
            "Reviewed Mission output has no exact producing step.".into(),
        ));
    }
    let producer = producers[0];
    let step_key = producer
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Reviewed Mission producing step is invalid.".into()))?;
    let workers = journal
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("worker-created")
                && event
                    .pointer("/payload/worker/planStepKey")
                    .and_then(Value::as_str)
                    == Some(step_key)
        })
        .collect::<Vec<_>>();
    if workers.len() != 1
        || workers[0]
            .pointer("/payload/worker/id")
            .and_then(Value::as_str)
            != Some(receipt.worker_id.as_str())
    {
        return Err(StoreError::Invalid(
            "Reviewed Mission output crosses its selected worker boundary.".into(),
        ));
    }
    let completion = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(receipt.completion_event_id.as_str())
    });
    let completion_matches = completion.is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("worker-completed")
            && event.pointer("/payload/workerId").and_then(Value::as_str)
                == Some(receipt.worker_id.as_str())
            && event
                .pointer("/payload/outputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| {
                    outputs.len() == 1
                        && outputs[0].get("key").and_then(Value::as_str) == Some(output_key)
                        && outputs[0].get("valueReference").and_then(Value::as_str)
                            == Some(value_reference)
                })
    });
    if !completion_matches
        || receipt.receipt.get("version").and_then(Value::as_i64) != Some(1)
        || receipt.receipt.get("trust").and_then(Value::as_str) != Some("provider-generated")
    {
        return Err(StoreError::Invalid(
            "Reviewed Mission output is not an exact untrusted provider receipt.".into(),
        ));
    }
    let text = receipt
        .receipt
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission artifact content is missing.".into())
        })?;
    if text.trim().is_empty()
        || text.len() as i64 != receipt.size_bytes
        || format!("{:x}", Sha256::digest(text.as_bytes())) != receipt.content_hash
    {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact content does not match its immutable receipt.".into(),
        ));
    }
    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission acceptance criteria are invalid.".into())
        })?;
    let criterion_keys = producer
        .get("acceptanceCriterionKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission producing step acceptance is invalid.".into())
        })?
        .iter()
        .map(|value| {
            value.as_str().ok_or_else(|| {
                StoreError::Invalid("Reviewed Mission producing step acceptance is invalid.".into())
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let human_keys = criterion_keys
        .iter()
        .filter(|key| {
            criteria.iter().any(|criterion| {
                criterion.get("key").and_then(Value::as_str) == Some(**key)
                    && criterion.get("evaluator").and_then(Value::as_str) == Some("human")
                    && criterion.get("required").and_then(Value::as_bool) == Some(true)
            })
        })
        .copied()
        .collect::<Vec<_>>();
    if human_keys.is_empty() {
        return Err(StoreError::Invalid(
            "Reviewed Mission output has no required identified-human acceptance.".into(),
        ));
    }
    let actor = journal
        .run
        .get("createdByInternalUserId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Reviewed Mission creator is invalid.".into()))?;
    let terminal_acceptance = journal
        .run
        .pointer("/terminalResult/acceptance")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission terminal acceptance is invalid.".into())
        })?;
    let mut evaluation_events = Vec::with_capacity(human_keys.len());
    for key in human_keys {
        let matching = journal
            .events
            .iter()
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("evaluation-recorded")
                    && event.pointer("/actor/kind").and_then(Value::as_str) == Some("internal-user")
                    && event
                        .pointer("/actor/internalUserId")
                        .and_then(Value::as_str)
                        == Some(actor)
                    && event
                        .pointer("/payload/evaluation/reviewerInternalUserId")
                        .and_then(Value::as_str)
                        == Some(actor)
                    && event
                        .pointer("/payload/evaluation/target/runId")
                        .and_then(Value::as_str)
                        == Some(run_id)
                    && event
                        .pointer("/payload/evaluation/verdict")
                        .and_then(Value::as_str)
                        == Some("pass")
                    && event
                        .pointer("/payload/evaluation/criteria")
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values.len() == 1
                                && values[0].get("criterionKey").and_then(Value::as_str)
                                    == Some(key)
                                && values[0].get("passed").and_then(Value::as_bool) == Some(true)
                                && values[0]
                                    .get("evidenceRefs")
                                    .and_then(Value::as_array)
                                    .is_some_and(|refs| {
                                        refs.iter().any(|reference| {
                                            reference.as_str() == Some(value_reference)
                                        })
                                    })
                        })
            })
            .collect::<Vec<_>>();
        let terminal_met = terminal_acceptance.iter().any(|result| {
            result.get("criterionKey").and_then(Value::as_str) == Some(key)
                && result.get("status").and_then(Value::as_str) == Some("met")
                && result
                    .get("evidenceRefs")
                    .and_then(Value::as_array)
                    .is_some_and(|refs| {
                        refs.iter()
                            .any(|reference| reference.as_str() == Some(value_reference))
                    })
        });
        if matching.len() != 1 || !terminal_met {
            return Err(StoreError::Invalid(
                "Reviewed Mission output lacks exact identified-human acceptance.".into(),
            ));
        }
        evaluation_events.push(matching[0]);
    }
    evaluation_events.sort_by_key(|event| event.get("sequence").and_then(Value::as_i64));
    let representative_evaluation_id = evaluation_events
        .last()
        .and_then(|event| event.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission acceptance event is invalid.".into())
        })?;
    let result = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id));
    let output_matches = |value: &Value| {
        value.get("key").and_then(Value::as_str) == Some(output_key)
            && value.get("valueReference").and_then(Value::as_str) == Some(value_reference)
            && value.get("artifactId").and_then(Value::as_str)
                == Some(expected.artifact_id.as_str())
            && value.get("artifactVersionId").and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str())
    };
    if !result.is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("run-completed")
            && event
                .pointer("/payload/result/outcome")
                .and_then(Value::as_str)
                == Some("succeeded")
            && event
                .pointer("/payload/result/outputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| outputs.iter().any(output_matches))
    }) {
        return Err(StoreError::Invalid(
            "Reviewed Mission artifact is not linked to its exact successful result.".into(),
        ));
    }
    if let Some(existing) = get_mission_source_binding(
        tx,
        scope,
        owner_member_id,
        run_id,
        output_key,
        &receipt.completion_event_id,
        representative_evaluation_id,
        result_event_id,
        value_reference,
        &receipt.content_hash,
    )? {
        validate_mission_artifact_bundle(tx, store, scope, &existing, &receipt.content_hash)?;
        return if existing == *expected {
            Ok(existing)
        } else {
            Err(StoreError::Invalid(
                "Reviewed Mission source represents another artifact.".into(),
            ))
        };
    }
    if mission_source_exists(tx, scope, owner_member_id, run_id, output_key)? {
        return Err(StoreError::Invalid(
            "Reviewed Mission source changed after artifact materialization.".into(),
        ));
    }
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission source conversation is missing.".into())
        })?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2 AND authority='local'
          AND visibility='member-private' AND deleted_at IS NULL AND owner_member_id=?3)",
        rusqlite::params![source_thread_id, scope.workspace_id(), owner_member_id],
        |row| row.get(0),
    )?;
    if !owns_thread {
        return Err(StoreError::Invalid(
            "Reviewed Mission source conversation is unavailable for this owner.".into(),
        ));
    }
    let at = evaluation_events
        .last()
        .and_then(|event| event.get("occurredAt"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Reviewed Mission acceptance time is invalid.".into())
        })?;
    let provenance = json!({
        "kind":"run","runId":run_id,"externalReference":value_reference,"observedAt":at
    });
    let media =
        json!({"mediaType":"text/markdown","byteLength":receipt.size_bytes,"encoding":"utf-8"});
    let content_hash = json!({"algorithm":"sha-256","value":receipt.content_hash});
    let decisions = evaluation_events
        .iter()
        .map(|event| {
            json!({
                "id":event.get("id"),"kind":"user",
                "summary":"The authenticated owner accepted this exact Mission output against its declared criterion.",
                "decidedAt":event.get("occurredAt"),
                "decidedByInternalUserId":actor
            })
        })
        .collect::<Vec<_>>();
    let artifact_value = json!({
        "id":expected.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local",
        "visibility":"member-private","ownerMemberId":owner_member_id,"schemaVersion":1,"revision":1,
        "createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,"kind":"document",
        "status":"accepted","title":title.trim(),"currentVersionId":expected.artifact_version_id,
        "producingRunId":run_id,"sourceProvenance":[provenance.clone()],
        "context":{"threadId":source_thread_id,"missionId":mission_id,
            "projectId":journal.run.get("projectId")},
        "reviews":[],"retention":{"status":"active"}
    });
    let version_value = json!({
        "id":expected.artifact_version_id,"artifactId":expected.artifact_id,"version":1,
        "status":"available","createdAt":at,"createdByInternalUserId":actor,
        "content":{"kind":"inline","text":text,"media":media,"contentHash":content_hash},
        "media":media,"contentHash":content_hash,"provenance":provenance,"citations":[],
        "inputs":[{
            "kind":"source","referenceId":value_reference,
            "label":"Reviewed untrusted Mission output","recordedAt":receipt.created_at,
            "contentHash":content_hash
        }],
        "decisions":decisions,"lineage":[]
    });
    let sealed_artifact = seal_json(
        store,
        &artifact_value,
        &artifact_aad(scope, &expected.artifact_id),
    )?;
    let sealed_version = seal_json(
        store,
        &version_value,
        &version_aad(scope, &expected.artifact_id, &expected.artifact_version_id),
    )?;
    let title_fingerprint = format!("{:x}", Sha256::digest(title.trim().as_bytes()));
    tx.execute(
        "INSERT INTO artifact
         (workspace_id,owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,
          id,run_id,thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,
          content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,'local','member-private',?3,NULL,?4,NULL,?5,NULL,'document','accepted',1,
          ?6,?7,?8,?9,?10,?10,?11,?12)",
        rusqlite::params![
            scope.workspace_id(),scope.owner_subject(),owner_member_id,expected.artifact_id,
            source_thread_id,expected.artifact_version_id,title_fingerprint,receipt.content_hash,
            receipt.size_bytes,at,sealed_artifact.ciphertext,sealed_artifact.nonce
        ],
    )?;
    tx.execute(
        "INSERT INTO artifact_version
         (workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,
          created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,1,'available',?5,?6,?7,?8,?9)",
        rusqlite::params![
            scope.workspace_id(),
            scope.owner_subject(),
            expected.artifact_id,
            expected.artifact_version_id,
            receipt.content_hash,
            receipt.size_bytes,
            at,
            sealed_version.ciphertext,
            sealed_version.nonce
        ],
    )?;
    tx.execute(
        "INSERT INTO mission_artifact_source
         (workspace_id,owner_member_id,mission_run_id,output_key,owner_subject,artifact_id,
          artifact_version_id,completion_event_id,evaluation_event_id,result_event_id,
          value_reference,content_hash,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            scope.workspace_id(),
            owner_member_id,
            run_id,
            output_key,
            scope.owner_subject(),
            expected.artifact_id,
            expected.artifact_version_id,
            receipt.completion_event_id,
            representative_evaluation_id,
            result_event_id,
            value_reference,
            receipt.content_hash,
            at
        ],
    )?;
    validate_mission_artifact_bundle(tx, store, scope, expected, &receipt.content_hash)?;
    Ok(expected.clone())
}

#[allow(clippy::too_many_arguments)]
pub fn create_accepted_mission_output(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    worker_id: &str,
    completion_event_id: &str,
    evaluation_event_id: &str,
    result_event_id: &str,
    output_key: &str,
    value_reference: &str,
    expected: &AcceptedMissionArtifactBinding,
) -> Result<AcceptedMissionArtifactBinding> {
    scope.ensure_exists(tx)?;
    if scope.owner_member_id() != Some(owner_member_id) {
        return Err(StoreError::Invalid(
            "Mission artifact owner does not match its authenticated member.".into(),
        ));
    }
    let data_scope = scope.data();
    let receipt = super::mission_worker_output::get_by_reference(
        tx,
        store,
        data_scope,
        owner_member_id,
        value_reference,
    )?
    .ok_or_else(|| StoreError::Invalid("Mission artifact output receipt is missing.".into()))?;
    if receipt.run_id != run_id
        || receipt.worker_id != worker_id
        || receipt.completion_event_id != completion_event_id
        || receipt.output_key != output_key
    {
        return Err(StoreError::Invalid(
            "Mission artifact output receipt represents another result.".into(),
        ));
    }
    let derived = accepted_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        worker_id,
        completion_event_id,
        output_key,
        &receipt.content_hash,
    );
    if &derived != expected {
        return Err(StoreError::Invalid(
            "Mission artifact identity does not match its immutable output.".into(),
        ));
    }
    let journal = super::mission_run::get(tx, store, data_scope, owner_member_id, run_id)?
        .ok_or_else(|| StoreError::Invalid("Mission artifact run is unavailable.".into()))?;
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            StoreError::Invalid("Mission artifact source conversation is missing.".into())
        })?;
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Mission artifact mission is missing.".into()))?;
    let actor = journal
        .run
        .get("createdByInternalUserId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Mission artifact creator is missing.".into()))?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2 AND authority='local'
          AND visibility='member-private' AND deleted_at IS NULL AND owner_member_id=?3)",
        rusqlite::params![source_thread_id, scope.workspace_id(), owner_member_id],
        |row| row.get(0),
    )?;
    if !owns_thread {
        return Err(StoreError::Invalid(
            "Mission artifact conversation is unavailable for this owner.".into(),
        ));
    }
    let completion = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(completion_event_id));
    let evaluation = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(evaluation_event_id));
    let result = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id));
    let ordinary_result_chain = result.is_some_and(|event| {
        event.get("previousEventId").and_then(Value::as_str) == Some(evaluation_event_id)
    });
    let lifecycle =
        super::mission_plan::get(tx, store, data_scope, owner_member_id, mission_id)?
            .ok_or_else(|| StoreError::Invalid("Mission artifact plan is unavailable.".into()))?;
    let requires_human = lifecycle
        .mission
        .pointer("/acceptance/requiresHumanAcceptance")
        .and_then(Value::as_bool)
        == Some(true);
    if lifecycle.current_revision.get("id") != journal.run.get("planRevisionId") {
        return Err(StoreError::Invalid(
            "Mission artifact plan does not match the selected run revision.".into(),
        ));
    }
    let human_approval_chain = result.is_some_and(|result_event| {
        exact_human_approval_chain(
            &journal,
            &lifecycle,
            result_event,
            evaluation_event_id,
            actor,
        )
    });
    let output_matches = |value: &Value| {
        value.pointer("/key").and_then(Value::as_str) == Some(output_key)
            && value.pointer("/valueReference").and_then(Value::as_str) == Some(value_reference)
            && value.pointer("/artifactId").and_then(Value::as_str)
                == Some(expected.artifact_id.as_str())
            && value.pointer("/artifactVersionId").and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str())
    };
    let exact_acceptance = completion.is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("worker-completed")
            && event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id)
            && event
                .pointer("/payload/outputs/0/valueReference")
                .and_then(Value::as_str)
                == Some(value_reference)
    }) && evaluation.is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("evaluation-recorded")
            && event.get("previousEventId").and_then(Value::as_str) == Some(completion_event_id)
            && event
                .pointer("/payload/evaluation/verdict")
                .and_then(Value::as_str)
                == Some("pass")
            && event
                .pointer("/payload/evaluation/target/workerId")
                .and_then(Value::as_str)
                == Some(worker_id)
    }) && result.is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("run-completed")
            && result_chain_matches_acceptance(
                requires_human,
                ordinary_result_chain,
                human_approval_chain,
            )
            && event
                .pointer("/payload/result/outcome")
                .and_then(Value::as_str)
                == Some("succeeded")
            && event
                .pointer("/payload/result/outputs/0")
                .is_some_and(output_matches)
    }) && journal.run.get("status").and_then(Value::as_str)
        == Some("completed")
        && journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            == Some(result_event_id);
    if !exact_acceptance
        || receipt.receipt.get("version").and_then(Value::as_i64) != Some(2)
        || receipt.receipt.get("trust").and_then(Value::as_str)
            != Some("provider-generated-with-external-evidence")
        || receipt
            .receipt
            .get("citations")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        return Err(StoreError::Invalid(
            "Only an exact policy-accepted cited mission output can become an artifact.".into(),
        ));
    }
    if let Some(existing) = get_mission_source_binding(
        tx,
        scope,
        owner_member_id,
        run_id,
        output_key,
        completion_event_id,
        evaluation_event_id,
        result_event_id,
        value_reference,
        &receipt.content_hash,
    )? {
        validate_mission_artifact_bundle(tx, store, scope, &existing, &receipt.content_hash)?;
        return if existing == *expected {
            Ok(existing)
        } else {
            Err(StoreError::Invalid(
                "Mission artifact source represents another output.".into(),
            ))
        };
    }

    let text = receipt
        .receipt
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::Invalid("Mission artifact content is missing.".into()))?;
    if text.len() as i64 != receipt.size_bytes
        || format!("{:x}", Sha256::digest(text.as_bytes())) != receipt.content_hash
    {
        return Err(StoreError::Invalid(
            "Mission artifact content does not match its immutable receipt.".into(),
        ));
    }
    let human_resolution = requires_human
        .then(|| result.and_then(|event| linked_human_resolution(&journal, event)))
        .flatten();
    let at = human_resolution
        .and_then(|event| event.pointer("/payload/resolution/decidedAt"))
        .and_then(Value::as_str)
        .unwrap_or(receipt.created_at.as_str());
    let provenance = json!({
        "kind":"run","runId":run_id,"externalReference":value_reference,"observedAt":at
    });
    let citations = receipt
        .receipt
        .get("citations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|citation| {
            let citation_id = citation.get("citationId").and_then(Value::as_str).unwrap_or("source");
            json!({
                "id":format!("{}:{citation_id}", expected.artifact_id),
                "label":citation.get("title"),
                "source":{"kind":"connection","externalReference":citation.get("sourceId"),"observedAt":at},
                "locator":citation.get("uri").or_else(|| citation.get("provenance")),
                "quotedText":citation.get("snippet")
            })
        })
        .collect::<Vec<_>>();
    let media =
        json!({"mediaType":"text/markdown","byteLength":receipt.size_bytes,"encoding":"utf-8"});
    let content_hash = json!({"algorithm":"sha-256","value":receipt.content_hash});
    let context = json!({
        "threadId":source_thread_id,
        "missionId":mission_id,
        "projectId":journal.run.get("projectId")
    });
    let artifact_value = json!({
        "id":expected.artifact_id,"workspaceId":scope.workspace_id(),"authority":"local",
        "visibility":"member-private","ownerMemberId":owner_member_id,"schemaVersion":1,"revision":1,
        "createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,"kind":"document","status":"accepted",
        "title":ACCEPTED_MISSION_ARTIFACT_TITLE,"currentVersionId":expected.artifact_version_id,
        "producingRunId":run_id,"sourceProvenance":[provenance.clone()],"context":context,
        "reviews":[],"retention":{"status":"active"}
    });
    let mut decisions = vec![json!({
        "id":evaluation_event_id,"kind":"policy",
        "summary":"Native cited-output policy accepted this exact version.","decidedAt":receipt.created_at
    })];
    if let Some(resolution) = human_resolution {
        decisions.push(json!({
            "id":resolution.get("id"),"kind":"user",
            "summary":"The authenticated owner approved this exact cited draft for artifact creation.",
            "decidedAt":resolution.pointer("/payload/resolution/decidedAt"),
            "decidedByInternalUserId":resolution.pointer("/payload/resolution/decidedByInternalUserId"),
            "approvalId":resolution.pointer("/payload/resolution/waitKey")
        }));
    }
    let version_value = json!({
        "id":expected.artifact_version_id,"artifactId":expected.artifact_id,"version":1,"status":"available",
        "createdAt":at,"createdByInternalUserId":actor,
        "content":{"kind":"inline","text":text,"media":media,"contentHash":content_hash},
        "media":media,"contentHash":content_hash,"provenance":provenance,"citations":citations,
        "inputs":[{"kind":"source","referenceId":value_reference,"label":"Attested cited mission output","recordedAt":at,"contentHash":content_hash}],
        "decisions":decisions,
        "lineage":[]
    });
    let sealed_artifact = seal_json(
        store,
        &artifact_value,
        &artifact_aad(scope, &expected.artifact_id),
    )?;
    let sealed_version = seal_json(
        store,
        &version_value,
        &version_aad(scope, &expected.artifact_id, &expected.artifact_version_id),
    )?;
    let title_fingerprint = format!(
        "{:x}",
        Sha256::digest(ACCEPTED_MISSION_ARTIFACT_TITLE.as_bytes())
    );
    tx.execute(
        "INSERT INTO artifact
         (workspace_id,owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,
          id,run_id,thread_id,source_message_id,kind,status,revision,current_version_id,title_fingerprint,
          content_fingerprint,size_bytes,created_at,updated_at,payload,payload_nonce)
         VALUES (?1,?2,'local','member-private',?3,NULL,?4,NULL,?5,NULL,'document','accepted',1,?6,?7,?8,?9,?10,?10,?11,?12)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),owner_member_id,
            expected.artifact_id,source_thread_id,expected.artifact_version_id,title_fingerprint,
            receipt.content_hash,receipt.size_bytes,at,sealed_artifact.ciphertext,sealed_artifact.nonce],
    )?;
    tx.execute(
        "INSERT INTO artifact_version
         (workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,created_at,payload,payload_nonce)
         VALUES (?1,?2,?3,?4,1,'available',?5,?6,?7,?8,?9)",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),expected.artifact_id,
            expected.artifact_version_id,receipt.content_hash,receipt.size_bytes,at,
            sealed_version.ciphertext,sealed_version.nonce],
    )?;
    tx.execute(
        "INSERT INTO mission_artifact_source
         (workspace_id,owner_member_id,mission_run_id,output_key,owner_subject,artifact_id,
          artifact_version_id,completion_event_id,evaluation_event_id,result_event_id,value_reference,content_hash,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![scope.workspace_id(),owner_member_id,run_id,output_key,scope.owner_subject(),
            expected.artifact_id,expected.artifact_version_id,completion_event_id,evaluation_event_id,
            result_event_id,value_reference,receipt.content_hash,at],
    )?;
    validate_mission_artifact_bundle(tx, store, scope, expected, &receipt.content_hash)?;
    Ok(expected.clone())
}

#[allow(clippy::too_many_arguments)]
pub fn get_mission_source_binding(
    tx: &Connection,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    output_key: &str,
    completion_event_id: &str,
    evaluation_event_id: &str,
    result_event_id: &str,
    value_reference: &str,
    content_hash: &str,
) -> Result<Option<AcceptedMissionArtifactBinding>> {
    scope.ensure_exists(tx)?;
    tx.query_row(
        "SELECT artifact_id,artifact_version_id FROM mission_artifact_source
         WHERE workspace_id=?1 AND owner_member_id=?2 AND mission_run_id=?3 AND output_key=?4
           AND owner_subject=?5 AND completion_event_id=?6 AND evaluation_event_id=?7
           AND result_event_id=?8 AND value_reference=?9 AND content_hash=?10",
        rusqlite::params![
            scope.workspace_id(),
            owner_member_id,
            run_id,
            output_key,
            scope.owner_subject(),
            completion_event_id,
            evaluation_event_id,
            result_event_id,
            value_reference,
            content_hash
        ],
        |row| {
            Ok(AcceptedMissionArtifactBinding {
                artifact_id: row.get(0)?,
                artifact_version_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn mission_source_exists(
    tx: &Connection,
    scope: &PrivateDataScope,
    owner_member_id: &str,
    run_id: &str,
    output_key: &str,
) -> Result<bool> {
    scope.ensure_exists(tx)?;
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM mission_artifact_source
         WHERE workspace_id=?1 AND owner_member_id=?2 AND mission_run_id=?3
           AND output_key=?4 AND owner_subject=?5)",
        rusqlite::params![
            scope.workspace_id(),
            owner_member_id,
            run_id,
            output_key,
            scope.owner_subject()
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn validate_mission_artifact_bundle(
    tx: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    binding: &AcceptedMissionArtifactBinding,
    content_hash: &str,
) -> Result<()> {
    let bundle = get_bundle(tx, store, scope, &binding.artifact_id)?
        .ok_or_else(|| StoreError::Invalid("Accepted mission artifact is missing.".into()))?;
    if bundle.pointer("/artifact/status").and_then(Value::as_str) == Some("accepted")
        && bundle
            .pointer("/artifact/currentVersionId")
            .and_then(Value::as_str)
            == Some(binding.artifact_version_id.as_str())
        && bundle.pointer("/currentVersion/id").and_then(Value::as_str)
            == Some(binding.artifact_version_id.as_str())
        && bundle
            .pointer("/currentVersion/contentHash/value")
            .and_then(Value::as_str)
            == Some(content_hash)
    {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "Accepted mission artifact no longer matches its source output.".into(),
        ))
    }
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

#[allow(clippy::too_many_arguments)]
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
    fn accepted_mission_output_materializes_one_exact_replayable_artifact() {
        let store = Store::open_in_memory(vault()).unwrap();
        seed(&store, "shared", "member-a");
        let private = owner("shared", "member-a");
        let scope = private.data().clone();
        let at = "2026-07-13T10:00:00Z";
        let text = "Accepted brief [source-1].";
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let reference = super::super::mission_worker_output::binding_reference(
            "shared",
            "member-a",
            "mission-run-1",
            "worker-1",
            "completed-1",
            "brief",
            &hash,
        );
        let binding = accepted_mission_output_binding(
            "shared",
            "member-a",
            "mission-run-1",
            "worker-1",
            "completed-1",
            "brief",
            &hash,
        );
        store
            .transaction(|tx| {
                let mission = json!({
                    "id":"mission-1","currentPlanId":"plan-1","currentPlanRevisionId":"plan-revision-1",
                    "acceptance":{"requiresHumanAcceptance":false}
                });
                let plan = json!({
                    "id":"plan-1","missionId":"mission-1","currentRevisionId":"plan-revision-1",
                    "currentRevisionNumber":1
                });
                let plan_revision = json!({
                    "id":"plan-revision-1","planId":"plan-1","missionId":"mission-1",
                    "planRevisionNumber":1
                });
                super::super::mission_plan::create(
                    tx, &store, &scope, "member-a", "user-member-a", "mission-1", "plan-1",
                    "plan-revision-1", "delegated", &mission, &plan, &plan_revision, at,
                )?;
                let run = json!({
                    "id":"mission-run-1","workspaceId":"shared","status":"running","revision":1,
                    "sourceThreadId":"thread-1","initiator":{"kind":"mission","missionId":"mission-1"},
                    "planRevisionId":"plan-revision-1",
                    "createdByInternalUserId":"user-member-a","eventHead":{"lastSequence":1,"lastEventId":"created-1"}
                });
                let created = json!({"id":"created-1","runId":"mission-run-1","type":"run-created","sequence":1,"idempotencyKey":"create-1"});
                super::super::mission_run::create(
                    tx,
                    &store,
                    &scope,
                    "member-a",
                    "user-member-a",
                    "mission-run-1",
                    "created-1",
                    "create-1",
                    &run,
                    &created,
                    at,
                )?;
                let completion = json!({
                    "id":"completed-1","runId":"mission-run-1","type":"worker-completed","sequence":2,
                    "previousEventId":"created-1","idempotencyKey":"complete-1",
                    "payload":{"workerId":"worker-1","outputs":[{"key":"brief","valueReference":reference}]}
                });
                let mut projected = run.clone();
                projected["revision"] = json!(2);
                projected["eventHead"] = json!({"lastSequence":2,"lastEventId":"completed-1"});
                super::super::mission_run::append(
                    tx,&store,&scope,"member-a","mission-run-1",1,1,"completed-1",
                    "worker-completed","complete-1",&completion,&projected,at,
                )?;
                let receipt = json!({
                    "version":2,"workspaceId":"shared","ownerMemberId":"member-a","runId":"mission-run-1",
                    "workerId":"worker-1","completionEventId":"completed-1","outputKey":"brief",
                    "valueReference":reference,"contentHash":hash,"sizeBytes":text.len(),"text":text,
                    "mediaType":"text/markdown","encoding":"utf-8","observedProvider":"openai",
                    "providerRouteId":"route-1","requestedModel":"gpt-5","trust":"provider-generated-with-external-evidence",
                    "citations":[{"citationId":"source-1","sourceId":"doc-1","title":"Plan","snippet":"Evidence",
                        "uri":"https://example.com/plan","provenance":"connection:doc-1","freshness":"current","trust":"external-untrusted"}],
                    "createdAt":at
                });
                super::super::mission_worker_output::put(
                    tx,&store,&scope,"member-a","mission-run-1","worker-1","completed-1","brief",
                    &reference,&hash,text.len() as i64,&receipt,at,
                )?;
                assert!(create_accepted_mission_output(
                    tx,&store,&private,"member-a","mission-run-1","worker-1","completed-1",
                    "evaluation-1","result-1","brief",&reference,&binding,
                ).is_err());
                let premature_count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM artifact WHERE workspace_id='shared' AND owner_subject=?1",
                    [private.owner_subject()],
                    |row| row.get(0),
                )?;
                assert_eq!(premature_count, 0);
                let evaluation = json!({
                    "id":"evaluation-1","runId":"mission-run-1","type":"evaluation-recorded","sequence":3,
                    "previousEventId":"completed-1","idempotencyKey":"evaluation-1",
                    "payload":{"evaluation":{"verdict":"pass","target":{"kind":"worker","workerId":"worker-1"}}}
                });
                projected["revision"] = json!(3);
                projected["eventHead"] = json!({"lastSequence":3,"lastEventId":"evaluation-1"});
                super::super::mission_run::append(
                    tx,&store,&scope,"member-a","mission-run-1",2,2,"evaluation-1",
                    "evaluation-recorded","evaluation-1",&evaluation,&projected,at,
                )?;
                let result = json!({
                    "id":"result-1","runId":"mission-run-1","type":"run-completed","sequence":4,
                    "previousEventId":"evaluation-1","idempotencyKey":"result-1",
                    "payload":{"result":{"outcome":"succeeded","outputs":[{"key":"brief","valueReference":reference,
                        "artifactId":binding.artifact_id,"artifactVersionId":binding.artifact_version_id}]}}
                });
                projected["status"] = json!("completed");
                projected["revision"] = json!(4);
                projected["eventHead"] = json!({"lastSequence":4,"lastEventId":"result-1"});
                super::super::mission_run::append(
                    tx,&store,&scope,"member-a","mission-run-1",3,3,"result-1",
                    "run-completed","result-1",&result,&projected,at,
                )?;
                let created = create_accepted_mission_output(
                    tx,&store,&private,"member-a","mission-run-1","worker-1","completed-1",
                    "evaluation-1","result-1","brief",&reference,&binding,
                )?;
                assert_eq!(created, binding);
                let replay = create_accepted_mission_output(
                    tx,&store,&private,"member-a","mission-run-1","worker-1","completed-1",
                    "evaluation-1","result-1","brief",&reference,&binding,
                )?;
                assert_eq!(replay, binding);
                let count: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM artifact WHERE workspace_id='shared' AND owner_subject=?1",
                    [private.owner_subject()],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 1);
                let statuses = vec!["accepted".to_string()];
                let found = search(
                    tx,
                    &store,
                    &private,
                    &ArtifactSearchFilter {
                        query: Some("Accepted brief"),
                        thread_id: Some("thread-1"),
                        project_id: None,
                        kinds: &[],
                        statuses: &statuses,
                        limit: 10,
                    },
                )?;
                assert_eq!(found.len(), 1);
                assert_eq!(
                    found[0]
                        .pointer("/artifact/id")
                        .and_then(Value::as_str),
                    Some(binding.artifact_id.as_str())
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn human_acceptance_requires_the_exact_checkpoint_bound_owner_decision() {
        let lifecycle = super::super::mission_plan::MissionPlanLifecycleRow {
            mission: json!({"acceptance":{"requiresHumanAcceptance":true}}),
            plan: json!({}),
            current_revision: json!({"id":"revision-1"}),
        };
        let mut journal = super::super::mission_run::MissionRunJournalRow {
            run: json!({"planRevisionId":"revision-1"}),
            events: vec![
                json!({"id":"checkpoint-1","type":"checkpoint-created","previousEventId":"evaluation-1","payload":{"checkpoint":{"kind":"wait-boundary","pendingWaitKey":"wait-1"}}}),
                json!({"id":"request-1","type":"approval-requested","previousEventId":"checkpoint-1","payload":{"wait":{"waitKey":"wait-1","status":"pending","proposalHash":"sha256:proposal"}}}),
                json!({"id":"resolution-1","type":"approval-resolved","previousEventId":"request-1","payload":{"resolution":{"waitKey":"wait-1","decision":"approved","acceptedProposalHash":"sha256:proposal","decidedByInternalUserId":"user-1"}}}),
            ],
        };
        let result = json!({"previousEventId":"resolution-1"});
        assert!(exact_human_approval_chain(
            &journal,
            &lifecycle,
            &result,
            "evaluation-1",
            "user-1"
        ));
        journal.events[2]["payload"]["resolution"]["acceptedProposalHash"] =
            json!("sha256:changed");
        assert!(!exact_human_approval_chain(
            &journal,
            &lifecycle,
            &result,
            "evaluation-1",
            "user-1"
        ));
        journal.events[2]["payload"]["resolution"]["acceptedProposalHash"] =
            json!("sha256:proposal");
        journal.events[2]["payload"]["resolution"]["decision"] = json!("denied");
        assert!(!exact_human_approval_chain(
            &journal,
            &lifecycle,
            &result,
            "evaluation-1",
            "user-1"
        ));
    }

    #[test]
    fn human_required_artifacts_cannot_use_the_ordinary_result_chain() {
        assert!(result_chain_matches_acceptance(false, true, false));
        assert!(!result_chain_matches_acceptance(true, true, false));
        assert!(result_chain_matches_acceptance(true, true, true));
        assert!(!result_chain_matches_acceptance(false, false, true));
    }

    #[test]
    fn human_artifact_metadata_uses_only_the_resolution_linked_by_the_result() {
        let journal = super::super::mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"resolution-old","type":"approval-resolved","payload":{"resolution":{"decision":"approved","decidedAt":"old"}}}),
                json!({"id":"resolution-linked","type":"approval-resolved","payload":{"resolution":{"decision":"approved","decidedAt":"linked"}}}),
            ],
        };
        let result = json!({"previousEventId":"resolution-linked"});
        let linked = linked_human_resolution(&journal, &result).unwrap();
        assert_eq!(
            linked
                .pointer("/payload/resolution/decidedAt")
                .and_then(Value::as_str),
            Some("linked")
        );
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
    fn project_handoff_detachment_never_transfers_target_authority() {
        let store = Store::open_in_memory(vault()).unwrap();
        seed(&store, "shared", "member-a");
        let scope = owner("shared", "member-a");
        store
            .transaction(|tx| {
                let payload = seal_json(&store, &json!({"id":"project-2"}), "project:project-2")?;
                tx.execute(
                    "INSERT INTO project(id,workspace_id,title_fingerprint,authority,visibility,
                     owner_member_id,created_by_internal_user_id,lifecycle,created_at,updated_at,
                     payload,payload_nonce)
                     VALUES ('project-2','shared','title','local','member-private','member-a',
                     'user-member-a','active','t','t',?1,?2)",
                    rusqlite::params![payload.ciphertext, payload.nonce],
                )?;
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
                    &version("version-1", 1, "One", None),
                )?;
                Ok(())
            })
            .unwrap();
        let handoff = store
            .transaction(|tx| {
                propose_handoff(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "project-2",
                    "user-member-a",
                    None,
                    "t2",
                )
            })
            .unwrap();
        let handoff_id = handoff["id"].as_str().unwrap().to_string();
        assert_eq!(
            store
                .transaction(|tx| {
                    detach_project_handoffs(tx, &store, &scope, "project-1", "t3")
                })
                .unwrap(),
            (1, 0)
        );
        let source = store
            .with_conn(|tx| {
                let sealed = tx.query_row(
                    "SELECT payload,payload_nonce FROM artifact_handoff
                     WHERE workspace_id='shared' AND owner_subject=?1 AND id=?2",
                    rusqlite::params![scope.owner_subject(), handoff_id],
                    payload_of,
                )?;
                open_json(&store, &sealed, &handoff_aad(&scope, &handoff_id))
            })
            .unwrap();
        assert_eq!(source.pointer("/source/projectId"), None);
        assert_eq!(source["updatedAt"], "t3");
        assert_eq!(
            store
                .transaction(|tx| {
                    detach_project_handoffs(tx, &store, &scope, "project-2", "t4")
                })
                .unwrap(),
            (0, 1)
        );
        let count: i64 = store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT COUNT(*) FROM artifact_handoff WHERE workspace_id='shared'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 0);
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
            assert!(store
                .with_conn(|tx| latest_accepted_handoff_matches(
                    tx,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "project-2"
                ))
                .unwrap());
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

            // A later accepted handoff replaces the project's canonical visible
            // version. Native attestation must reject the older hidden version
            // even though its accepted audit row remains immutable.
            let latest = store
                .transaction(|tx| {
                    propose_handoff(
                        tx,
                        &store,
                        &scope,
                        "artifact-1",
                        "artifact-1:v2",
                        "project-2",
                        "user-member-a",
                        None,
                        "2026-07-11T01:03:30Z",
                    )
                })
                .unwrap();
            let latest_id = latest["id"].as_str().unwrap();
            store
                .transaction(|tx| {
                    accept_handoff(
                        tx,
                        &store,
                        &scope,
                        latest_id,
                        1,
                        "user-member-a",
                        "2026-07-11T01:03:45Z",
                    )
                })
                .unwrap();
            assert!(!store
                .with_conn(|tx| latest_accepted_handoff_matches(
                    tx,
                    &scope,
                    "artifact-1",
                    "version-1",
                    "project-2"
                ))
                .unwrap());
            assert!(store
                .with_conn(|tx| latest_accepted_handoff_matches(
                    tx,
                    &scope,
                    "artifact-1",
                    "artifact-1:v2",
                    "project-2"
                ))
                .unwrap());
            let latest_target = search_project("project-2");
            assert_eq!(latest_target[0]["currentVersion"]["id"], "artifact-1:v2");

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
        assert_eq!(target[0]["currentVersion"]["id"], "artifact-1:v2");
        assert_eq!(target[0]["artifact"]["currentVersionId"], "artifact-1:v2");
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
