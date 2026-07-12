//! Owner-qualified encrypted checkpoint state linked to immutable run events.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::repos::scope::{normalize_id, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStateRow {
    pub run_id: String,
    pub checkpoint_event_id: String,
    pub attempt_number: i64,
    pub state_reference: String,
    pub state_hash: String,
    pub created_at: String,
    pub state: Value,
}

#[allow(clippy::too_many_arguments)]
pub fn put(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    checkpoint_event_id: &str,
    attempt_number: i64,
    state_reference: &str,
    state_hash: &str,
    state: &Value,
    at: &str,
) -> Result<CheckpointStateRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let event_id = normalize_id(checkpoint_event_id, "Checkpoint event")?;
    if attempt_number < 1
        || state_reference.is_empty()
        || state_reference.len() > 240
        || state_hash.len() != 64
        || !state_hash.bytes().all(|value| value.is_ascii_hexdigit())
    {
        return Err(StoreError::Invalid(
            "Checkpoint metadata is invalid.".into(),
        ));
    }
    let event = tx
        .query_row(
            "SELECT payload,payload_nonce FROM mission_run_event WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3 AND id=?4 AND event_type='checkpoint-created';",
            rusqlite::params![scope.workspace_id(), owner, run_id, event_id],
            |row| {
                Ok(Sealed {
                    ciphertext: row.get(0)?,
                    nonce: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| {
            StoreError::Invalid("Checkpoint event is unavailable in this run.".into())
        })?;
    let event = open_json(
        store,
        &event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    if event.get("id").and_then(Value::as_str) != Some(event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        || event
            .pointer("/payload/checkpoint/attemptNumber")
            .and_then(Value::as_i64)
            != Some(attempt_number)
        || event
            .pointer("/payload/checkpoint/stateReference")
            .and_then(Value::as_str)
            != Some(state_reference)
        || event
            .pointer("/payload/checkpoint/stateHash")
            .and_then(Value::as_str)
            != Some(state_hash)
    {
        return Err(StoreError::Invalid(
            "Checkpoint state metadata does not match its immutable event.".into(),
        ));
    }
    let sealed = seal_json(store, state, &aad(scope.workspace_id(), &owner, &event_id))?;
    tx.execute("INSERT INTO mission_checkpoint_state(workspace_id,owner_member_id,run_id,checkpoint_event_id,attempt_number,state_reference,state_hash,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10);",rusqlite::params![scope.workspace_id(),owner,run_id,event_id,attempt_number,state_reference,state_hash,at,sealed.ciphertext,sealed.nonce])?;
    get_by_event(tx, store, scope, &owner, &event_id)?
        .ok_or_else(|| StoreError::Invalid("Checkpoint state was not saved.".into()))
}

pub fn latest(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
) -> Result<Option<CheckpointStateRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let event_id=tx.query_row("SELECT state.checkpoint_event_id FROM mission_checkpoint_state AS state JOIN mission_run_event AS event ON event.workspace_id=state.workspace_id AND event.owner_member_id=state.owner_member_id AND event.run_id=state.run_id AND event.id=state.checkpoint_event_id WHERE state.workspace_id=?1 AND state.owner_member_id=?2 AND state.run_id=?3 ORDER BY event.sequence DESC LIMIT 1;",rusqlite::params![scope.workspace_id(),owner,run_id],|row|row.get::<_,String>(0)).optional()?;
    event_id
        .map(|id| get_by_event(tx, store, scope, &owner, &id))
        .transpose()
        .map(Option::flatten)
}

pub fn get_by_event(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner: &str,
    event_id: &str,
) -> Result<Option<CheckpointStateRow>> {
    let row=tx.query_row("SELECT run_id,attempt_number,state_reference,state_hash,created_at,payload,payload_nonce FROM mission_checkpoint_state WHERE workspace_id=?1 AND owner_member_id=?2 AND checkpoint_event_id=?3;",rusqlite::params![scope.workspace_id(),owner,event_id],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,Sealed{ciphertext:row.get(5)?,nonce:row.get(6)?}))).optional()?;
    row.map(
        |(run_id, attempt_number, state_reference, state_hash, created_at, sealed)| {
            Ok(CheckpointStateRow {
                run_id,
                checkpoint_event_id: event_id.to_string(),
                attempt_number,
                state_reference,
                state_hash,
                created_at,
                state: open_json(store, &sealed, &aad(scope.workspace_id(), owner, event_id))?,
            })
        },
    )
    .transpose()
}

fn aad(workspace: &str, owner: &str, event: &str) -> String {
    format!("mission-checkpoint:{workspace}:{owner}:{event}")
}

fn event_aad(workspace: &str, owner: &str, event: &str) -> String {
    format!("mission-run-event:{workspace}:{owner}:{event}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn checkpoint_state_reopens_encrypted_and_owner_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        {
            let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store.transaction(|tx|{
                tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?;
                let scope=DataScope::workspace("w1")?;
                let state=json!({"activeWorkerIds":[],"activePlanStepKeys":[],"pendingWaitKeys":[]});
                let reference="checkpoint:event-2";
                let envelope=json!({"runId":"run-1","checkpointEventId":"event-2","attemptNumber":1,"stateReference":reference,"state":state});
                let hash=format!("{:x}",Sha256::digest(serde_json::to_vec(&envelope).unwrap()));
                let event=json!({"id":"event-2","runId":"run-1","type":"checkpoint-created","sequence":2,"attemptNumber":1,"payload":{"checkpoint":{"attemptNumber":1,"stateReference":reference,"stateHash":hash}}});
                let sealed=seal_json(&store,&event,&event_aad("w1","member-1","event-2"))?;
                tx.execute("INSERT INTO mission_run_event(workspace_id,owner_member_id,run_id,sequence,id,event_type,idempotency_key,occurred_at,payload,payload_nonce) VALUES ('w1','member-1','run-1',2,'event-2','checkpoint-created','checkpoint:1','t2',?1,?2);",rusqlite::params![sealed.ciphertext,sealed.nonce])?;
                put(tx,&store,&scope,"member-1","run-1","event-2",1,reference,&hash,&state,"t2")?;
                Ok(())
            }).unwrap();
        }
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let loaded = store
            .with_conn(|tx| latest(tx, &store, &scope, "member-1", "run-1"))
            .unwrap()
            .unwrap();
        assert_eq!(loaded.state["activeWorkerIds"], json!([]));
        assert_eq!(loaded.state["activePlanStepKeys"], json!([]));
        assert_eq!(loaded.state["pendingWaitKeys"], json!([]));
        assert!(store
            .with_conn(|tx| latest(tx, &store, &scope, "member-2", "run-1"))
            .unwrap()
            .is_none());
        let ciphertext:Vec<u8>=store.with_conn(|tx|Ok(tx.query_row("SELECT payload FROM mission_checkpoint_state WHERE checkpoint_event_id='event-2'",[],|row|row.get(0))?)).unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("state"));
    }
}
