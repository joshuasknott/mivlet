//! Owner-qualified durable artifacts and immutable version history.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::store::repos::{open_json, payload_of, scope::PrivateDataScope, seal_json};
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
    let artifact = open_json(store, &sealed, &artifact_aad(scope, id))?;
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
        "SELECT revision,current_version_id FROM artifact WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3",
        rusqlite::params![scope.workspace_id(),scope.owner_subject(),artifact_id],
        |row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?)),
    ).optional()?.ok_or_else(||StoreError::Invalid("Artifact is unavailable for this owner.".into()))?;
    if current.0 != expected_revision || current.1 != expected_current_version_id {
        return Err(StoreError::Invalid(
            "Artifact changed elsewhere. Reload it and try again.".into(),
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
        "UPDATE artifact SET revision=?1,current_version_id=?2,title_fingerprint=?3,content_fingerprint=?4,
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
            let thread=seal_json(store,&json!({}),"thread:thread-1")?;
            tx.execute("INSERT INTO thread(id,workspace_id,title,owner_member_id,created_at,updated_at,payload,payload_nonce) VALUES ('thread-1',?1,'T',?2,'t','t',?3,?4)",
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
}
