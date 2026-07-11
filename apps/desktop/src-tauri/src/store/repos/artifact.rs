//! Durable sourced artifacts backed by the existing encrypted artifact table.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::store::repos::{open_json, payload_of, scope::DataScope, seal_json};
use crate::store::{Result, Store, StoreError};

fn aad(id: &str) -> String {
    format!("artifact:{id}")
}

pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
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
    scope.ensure_exists(tx)?;
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
    let revision = tx.query_row(
        "SELECT m.current_revision_id,r.payload,r.payload_nonce FROM message m JOIN message_revision r ON r.id=m.current_revision_id WHERE m.id=?1 AND m.thread_id=?2 AND m.workspace_id=?3 AND m.run_id=?4 AND m.kind='assistant' AND m.current_revision_state='terminal' AND m.deleted_at IS NULL",
        rusqlite::params![message_id, thread_id, scope.workspace_id(), run_id],
        |row| Ok((row.get::<_, String>(0)?, payload_of(row)?)),
    ).optional()?;
    let Some((revision_id, sealed_revision)) = revision else {
        return Err(StoreError::Invalid(
            "Only a completed assistant response can become an artifact.".into(),
        ));
    };
    let durable_content = open_json(
        store,
        &sealed_revision,
        &format!("message-revision:{}:{revision_id}", scope.workspace_id()),
    )?;
    let submitted_content = payload
        .pointer("/version/content/text")
        .and_then(Value::as_str);
    if durable_content.as_str() != submitted_content {
        return Err(StoreError::Invalid(
            "Artifact content no longer matches the completed response.".into(),
        ));
    }
    if let Some(existing) = get(tx, store, scope, id)? {
        let same = existing
            .get("artifact")
            .and_then(|v| v.get("producingRunId"))
            .and_then(Value::as_str)
            == Some(run_id)
            && existing.get("sourceMessageId").and_then(Value::as_str) == Some(message_id)
            && existing
                .get("version")
                .and_then(|v| v.get("contentHash"))
                .and_then(|v| v.get("value"))
                .and_then(Value::as_str)
                == Some(fingerprint);
        return if same {
            Ok(existing)
        } else {
            Err(StoreError::Invalid("Artifact id is already in use.".into()))
        };
    }
    let sealed = seal_json(store, payload, &aad(id))?;
    tx.execute(
        "INSERT INTO artifact (id,run_id,kind,content_fingerprint,size_bytes,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![id, run_id, kind, fingerprint, size_bytes as i64, created_at, sealed.ciphertext, sealed.nonce],
    )?;
    Ok(payload.clone())
}

pub fn get(tx: &Connection, store: &Store, scope: &DataScope, id: &str) -> Result<Option<Value>> {
    scope.ensure_exists(tx)?;
    let row = tx.query_row(
        "SELECT a.payload,a.payload_nonce FROM artifact a JOIN run r ON r.id=a.run_id WHERE a.id=?1 AND r.workspace_id=?2",
        rusqlite::params![id, scope.workspace_id()],
        payload_of,
    ).optional()?;
    row.map(|sealed| open_json(store, &sealed, &aad(id)))
        .transpose()
}

pub fn list_for_thread(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    thread_id: &str,
) -> Result<Vec<Value>> {
    scope.ensure_exists(tx)?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE id=?1 AND workspace_id=?2 AND deleted_at IS NULL)",
        rusqlite::params![thread_id, scope.workspace_id()], |row| row.get(0))?;
    if !owns_thread {
        return Err(StoreError::Invalid(
            "Thread does not belong to this workspace.".into(),
        ));
    }
    let mut stmt = tx.prepare("SELECT a.id,a.payload,a.payload_nonce FROM artifact a JOIN run r ON r.id=a.run_id WHERE r.workspace_id=?1 AND r.thread_id=?2 ORDER BY a.created_at,a.id")?;
    let rows = stmt.query_map(rusqlite::params![scope.workspace_id(), thread_id], |row| {
        Ok((row.get::<_, String>(0)?, payload_of(row)?))
    })?;
    rows.map(|row| {
        let (id, sealed) = row?;
        open_json(store, &sealed, &aad(&id))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use tempfile::TempDir;

    fn vault() -> Vault {
        Vault::new(&MasterKey::generate().unwrap()).unwrap()
    }
    fn seed(store: &Store, workspace: &str, thread: &str, run: &str, message: &str) {
        store.transaction(|tx| {
            tx.execute("INSERT OR IGNORE INTO workspace(id,name,created_at,updated_at) VALUES (?1,'Workspace','t','t')", [workspace])?;
            let sealed = seal_json(store, &serde_json::json!({}), &format!("thread:{thread}"))?;
            tx.execute("INSERT INTO thread(id,workspace_id,title,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,'Thread','t','t',?3,?4)", rusqlite::params![thread,workspace,sealed.ciphertext,sealed.nonce])?;
            let run_payload = seal_json(store, &serde_json::json!({}), &format!("run:{run}"))?;
            tx.execute("INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,'provider','model','completed','t','t',?4,?5)", rusqlite::params![run,workspace,thread,run_payload.ciphertext,run_payload.nonce])?;
            let message_payload = seal_json(store, &serde_json::json!({}), &format!("message:{message}"))?;
            let revision = format!("revision-{message}");
            let revision_payload = seal_json(store, &serde_json::json!("Answer"), &format!("message-revision:{workspace}:{revision}"))?;
            tx.execute("INSERT INTO message(id,workspace_id,thread_id,kind,run_id,seq,idempotency_key,current_revision_id,current_revision_state,created_at,payload,payload_nonce) VALUES (?1,?2,?3,'assistant',?4,1,?1,?5,'terminal','t',?6,?7)", rusqlite::params![message,workspace,thread,run,revision,message_payload.ciphertext,message_payload.nonce])?;
            tx.execute("INSERT INTO message_revision(id,workspace_id,thread_id,message_id,revision_number,base_revision_number,state,reason,idempotency_key,checkpointed_at,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,1,0,'terminal','initial',?1,'t','t',?5,?6)", rusqlite::params![revision,workspace,thread,message,revision_payload.ciphertext,revision_payload.nonce])?;
            Ok(())
        }).unwrap();
    }
    fn payload() -> Value {
        serde_json::json!({"artifact":{"producingRunId":"run-1"},"version":{"content":{"kind":"inline","text":"Answer"},"contentHash":{"value":"hash"},"citations":[{"label":"Source"}]},"sourceMessageId":"message-1"})
    }

    #[test]
    fn creates_reads_and_preserves_sources() {
        let store = Store::open_in_memory(vault()).unwrap();
        seed(&store, "default", "thread-1", "run-1", "message-1");
        let scope = DataScope::legacy_default();
        store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "artifact-1",
                    "run-1",
                    "thread-1",
                    "message-1",
                    "document",
                    "hash",
                    4,
                    "t",
                    &payload(),
                )
            })
            .unwrap();
        let read = store
            .with_conn(|tx| get(tx, &store, &scope, "artifact-1"))
            .unwrap()
            .unwrap();
        assert_eq!(read["version"]["citations"][0]["label"], "Source");
        assert_eq!(
            store
                .with_conn(|tx| list_for_thread(tx, &store, &scope, "thread-1"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn rejects_cross_workspace_source_links() {
        let store = Store::open_in_memory(vault()).unwrap();
        seed(&store, "default", "thread-1", "run-1", "message-1");
        seed(&store, "other", "thread-2", "run-2", "message-2");
        let result = store.transaction(|tx| {
            create(
                tx,
                &store,
                &DataScope::legacy_default(),
                "artifact-1",
                "run-2",
                "thread-2",
                "message-2",
                "document",
                "hash",
                4,
                "t",
                &payload(),
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn rejects_message_from_a_different_run() {
        let store = Store::open_in_memory(vault()).unwrap();
        seed(&store, "default", "thread-1", "run-1", "message-1");
        let result = store.transaction(|tx| {
            let other_payload =
                seal_json(&store, &serde_json::json!({}), "run:run-2")?;
            tx.execute(
                "INSERT INTO run(id,workspace_id,thread_id,provider_id,model,status,created_at,updated_at,payload,payload_nonce) VALUES ('run-2','default','thread-1','provider','model','completed','t','t',?1,?2)",
                rusqlite::params![other_payload.ciphertext, other_payload.nonce],
            )?;
            create(
                tx,
                &store,
                &DataScope::legacy_default(),
                "artifact-1",
                "run-2",
                "thread-1",
                "message-1",
                "document",
                "hash",
                4,
                "t",
                &payload(),
            )
        });
        assert!(result.is_err());
    }

    #[test]
    fn artifact_survives_store_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("artifact.sqlite3");
        let vault = vault();
        {
            let store = Store::open(&path, vault.clone()).unwrap();
            seed(&store, "default", "thread-1", "run-1", "message-1");
            store
                .transaction(|tx| {
                    create(
                        tx,
                        &store,
                        &DataScope::legacy_default(),
                        "artifact-1",
                        "run-1",
                        "thread-1",
                        "message-1",
                        "document",
                        "hash",
                        4,
                        "t",
                        &payload(),
                    )
                })
                .unwrap();
        }
        let store = Store::open(&path, vault).unwrap();
        let read = store
            .with_conn(|tx| get(tx, &store, &DataScope::legacy_default(), "artifact-1"))
            .unwrap();
        assert!(read.is_some());
    }

    #[test]
    fn message_run_link_is_preserved_for_artifact_provenance() {
        let store = Store::open_in_memory(vault()).unwrap();
        store.transaction(|tx| {
            let sealed = seal_json(&store, &serde_json::json!({}), "thread:thread-1")?;
            tx.execute("INSERT INTO thread(id,workspace_id,title,created_at,updated_at,payload,payload_nonce) VALUES ('thread-1','default','Thread','t','t',?1,?2)", rusqlite::params![sealed.ciphertext,sealed.nonce])?;
            crate::store::repos::message::append(tx, &store, &DataScope::legacy_default(), "thread-1", "message-1", "assistant", &Value::Null, Some("run-1"), 1, 0, None, "run-1:assistant", "revision-1", "terminal", "initial", &serde_json::json!("Answer"), "t")?;
            Ok(())
        }).unwrap();
        let messages = store
            .with_conn(|tx| {
                crate::store::repos::message::list(
                    tx,
                    &store,
                    &DataScope::legacy_default(),
                    "thread-1",
                )
            })
            .unwrap();
        assert_eq!(messages[0].run_id.as_deref(), Some("run-1"));
    }
}
