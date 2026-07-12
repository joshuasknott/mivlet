//! Immutable encrypted mission-worker tool-result receipts linked to run events.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::store::repos::scope::{normalize_id, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionWorkerToolRow {
    pub run_id: String,
    pub worker_id: String,
    pub tool_event_id: String,
    pub call_key: String,
    pub output_reference: String,
    pub output_hash: String,
    pub size_bytes: i64,
    pub created_at: String,
    pub receipt: Value,
}

#[allow(clippy::too_many_arguments)]
pub fn put(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    worker_id: &str,
    tool_event_id: &str,
    call_key: &str,
    output_reference: &str,
    output_hash: &str,
    size_bytes: i64,
    receipt: &Value,
    at: &str,
) -> Result<MissionWorkerToolRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let worker_id = normalize_id(worker_id, "Mission worker")?;
    let event_id = normalize_id(tool_event_id, "Mission tool event")?;
    let call_key = normalize_id(call_key, "Mission tool call")?;
    validate_metadata(output_reference, output_hash, size_bytes)?;
    validate_receipt(
        receipt,
        scope.workspace_id(),
        &owner,
        &run_id,
        &worker_id,
        &event_id,
        &call_key,
        output_reference,
        output_hash,
        size_bytes,
        at,
    )?;

    let sealed_event = tx.query_row(
        "SELECT payload,payload_nonce FROM mission_run_event WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3 AND id=?4 AND event_type='tool-call-completed';",
        rusqlite::params![scope.workspace_id(), owner, run_id, event_id],
        |row| Ok(Sealed { ciphertext: row.get(0)?, nonce: row.get(1)? }),
    ).optional()?.ok_or_else(|| StoreError::Invalid("Mission tool event is unavailable.".into()))?;
    let event = open_json(
        store,
        &sealed_event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    if event.get("id").and_then(Value::as_str) != Some(event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        || event
            .pointer("/payload/result/callKey")
            .and_then(Value::as_str)
            != Some(call_key.as_str())
        || event
            .pointer("/payload/result/workerId")
            .and_then(Value::as_str)
            != Some(worker_id.as_str())
        || event
            .pointer("/payload/result/toolName")
            .and_then(Value::as_str)
            != Some("connection-read")
        || event
            .pointer("/payload/result/outputReference")
            .and_then(Value::as_str)
            != Some(output_reference)
        || event
            .pointer("/payload/result/outputHash")
            .and_then(Value::as_str)
            != Some(output_hash)
    {
        return Err(StoreError::Invalid(
            "Mission tool receipt does not match its immutable event.".into(),
        ));
    }

    if let Some(existing) = get_by_reference(tx, store, scope, &owner, output_reference)? {
        return if existing.run_id == run_id
            && existing.worker_id == worker_id
            && existing.tool_event_id == event_id
            && existing.call_key == call_key
            && existing.output_hash == output_hash
            && existing.size_bytes == size_bytes
            && existing.receipt == *receipt
        {
            Ok(existing)
        } else {
            Err(StoreError::Invalid(
                "Mission tool reference represents another receipt.".into(),
            ))
        };
    }

    let sealed = seal_json(
        store,
        receipt,
        &aad(
            scope.workspace_id(),
            &owner,
            &run_id,
            &worker_id,
            &event_id,
            &call_key,
        ),
    )?;
    tx.execute(
        "INSERT INTO mission_worker_tool_receipt(workspace_id,owner_member_id,run_id,worker_id,tool_event_id,call_key,output_reference,output_hash,size_bytes,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12);",
        rusqlite::params![scope.workspace_id(), owner, run_id, worker_id, event_id, call_key, output_reference, output_hash, size_bytes, at, sealed.ciphertext, sealed.nonce],
    )?;
    get_by_reference(tx, store, scope, &owner, output_reference)?
        .ok_or_else(|| StoreError::Invalid("Mission tool receipt was not saved.".into()))
}

pub fn get_by_reference(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    output_reference: &str,
) -> Result<Option<MissionWorkerToolRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let row = tx.query_row(
        "SELECT run_id,worker_id,tool_event_id,call_key,output_hash,size_bytes,created_at,payload,payload_nonce FROM mission_worker_tool_receipt WHERE workspace_id=?1 AND owner_member_id=?2 AND output_reference=?3;",
        rusqlite::params![scope.workspace_id(), owner, output_reference],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?, row.get::<_, String>(6)?, Sealed { ciphertext: row.get(7)?, nonce: row.get(8)? })),
    ).optional()?;
    row.map(
        |(run_id, worker_id, event_id, call_key, hash, size, created_at, sealed)| {
            let receipt = open_json(
                store,
                &sealed,
                &aad(
                    scope.workspace_id(),
                    &owner,
                    &run_id,
                    &worker_id,
                    &event_id,
                    &call_key,
                ),
            )?;
            validate_receipt(
                &receipt,
                scope.workspace_id(),
                &owner,
                &run_id,
                &worker_id,
                &event_id,
                &call_key,
                output_reference,
                &hash,
                size,
                &created_at,
            )?;
            Ok(MissionWorkerToolRow {
                run_id,
                worker_id,
                tool_event_id: event_id,
                call_key,
                output_reference: output_reference.to_string(),
                output_hash: hash,
                size_bytes: size,
                created_at,
                receipt,
            })
        },
    )
    .transpose()
}

fn validate_metadata(reference: &str, hash: &str, size: i64) -> Result<()> {
    if reference.is_empty()
        || reference.len() > 512
        || hash.len() != 64
        || !hash.bytes().all(|value| value.is_ascii_hexdigit())
        || !(1..=131_072).contains(&size)
    {
        return Err(StoreError::Invalid(
            "Mission tool receipt metadata is invalid.".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_receipt(
    receipt: &Value,
    workspace: &str,
    owner: &str,
    run: &str,
    worker: &str,
    event: &str,
    call_key: &str,
    reference: &str,
    hash: &str,
    size: i64,
    created_at: &str,
) -> Result<()> {
    let Some(object) = receipt.as_object() else {
        return Err(StoreError::Invalid(
            "Mission tool receipt is invalid.".into(),
        ));
    };
    const KEYS: [&str; 14] = [
        "version",
        "workspaceId",
        "ownerMemberId",
        "runId",
        "workerId",
        "toolEventId",
        "callKey",
        "outputReference",
        "outputHash",
        "sizeBytes",
        "trust",
        "instructionAuthority",
        "result",
        "createdAt",
    ];
    let encoded = serde_json::to_vec(receipt.get("result").unwrap_or(&Value::Null))
        .map_err(|_| StoreError::Invalid("Mission tool result is invalid.".into()))?;
    if object.len() != KEYS.len()
        || object.keys().any(|key| !KEYS.contains(&key.as_str()))
        || receipt.get("version").and_then(Value::as_i64) != Some(1)
        || receipt.get("workspaceId").and_then(Value::as_str) != Some(workspace)
        || receipt.get("ownerMemberId").and_then(Value::as_str) != Some(owner)
        || receipt.get("runId").and_then(Value::as_str) != Some(run)
        || receipt.get("workerId").and_then(Value::as_str) != Some(worker)
        || receipt.get("toolEventId").and_then(Value::as_str) != Some(event)
        || receipt.get("callKey").and_then(Value::as_str) != Some(call_key)
        || receipt.get("outputReference").and_then(Value::as_str) != Some(reference)
        || receipt.get("outputHash").and_then(Value::as_str) != Some(hash)
        || receipt.get("sizeBytes").and_then(Value::as_i64) != Some(size)
        || receipt.get("trust").and_then(Value::as_str) != Some("external-untrusted")
        || receipt.get("instructionAuthority").and_then(Value::as_str) != Some("none")
        || encoded.len() as i64 != size
        || format!("{:x}", Sha256::digest(&encoded)) != hash
        || binding_reference(workspace, owner, run, worker, event, call_key, hash) != reference
        || receipt.get("createdAt").and_then(Value::as_str) != Some(created_at)
    {
        return Err(StoreError::Invalid(
            "Mission tool receipt is invalid.".into(),
        ));
    }
    Ok(())
}

pub fn binding_reference(
    workspace: &str,
    owner: &str,
    run: &str,
    worker: &str,
    event: &str,
    call_key: &str,
    output_hash: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission-worker-tool.v1\0");
    for value in [workspace, owner, run, worker, event, call_key, output_hash] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!(
        "mission-tool:v1:{event}:{call_key}:sha256:{:x}",
        digest.finalize()
    )
}

fn aad(
    workspace: &str,
    owner: &str,
    run: &str,
    worker: &str,
    event: &str,
    call_key: &str,
) -> String {
    format!("mission-worker-tool:v1:{workspace}:{owner}:{run}:{worker}:{event}:{call_key}")
}

fn event_aad(workspace: &str, owner: &str, event: &str) -> String {
    format!("mission-run-event:{workspace}:{owner}:{event}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use serde_json::json;

    #[test]
    fn tool_receipt_reopens_encrypted_and_owner_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        let result = json!({"contractVersion":"fable.connected-source-search.v1","query":"launch"});
        let encoded = serde_json::to_vec(&result).unwrap();
        let hash = format!("{:x}", Sha256::digest(&encoded));
        let reference = binding_reference(
            "w1",
            "member-1",
            "run-1",
            "worker-1",
            "event-tool",
            "call-1",
            &hash,
        );
        {
            let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store.transaction(|tx| {
                tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');", [])?;
                let event = json!({"id":"event-tool","runId":"run-1","type":"tool-call-completed","payload":{"result":{"callKey":"call-1","workerId":"worker-1","toolName":"connection-read","outputReference":reference,"outputHash":hash}}});
                let sealed = seal_json(&store, &event, &event_aad("w1", "member-1", "event-tool"))?;
                tx.execute("INSERT INTO mission_run_event(workspace_id,owner_member_id,run_id,sequence,id,event_type,idempotency_key,occurred_at,payload,payload_nonce) VALUES ('w1','member-1','run-1',4,'event-tool','tool-call-completed','tool','t',?1,?2);", rusqlite::params![sealed.ciphertext,sealed.nonce])?;
                let receipt = json!({"version":1,"workspaceId":"w1","ownerMemberId":"member-1","runId":"run-1","workerId":"worker-1","toolEventId":"event-tool","callKey":"call-1","outputReference":reference,"outputHash":hash,"sizeBytes":encoded.len(),"trust":"external-untrusted","instructionAuthority":"none","result":result,"createdAt":"t"});
                put(tx, &store, &DataScope::workspace("w1")?, "member-1", "run-1", "worker-1", "event-tool", "call-1", &reference, &hash, encoded.len() as i64, &receipt, "t")?;
                Ok(())
            }).unwrap();
        }
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        assert_eq!(
            store
                .with_conn(|tx| get_by_reference(tx, &store, &scope, "member-1", &reference))
                .unwrap()
                .unwrap()
                .receipt["trust"],
            "external-untrusted"
        );
        assert!(store
            .with_conn(|tx| get_by_reference(tx, &store, &scope, "member-2", &reference))
            .unwrap()
            .is_none());
        let ciphertext: Vec<u8> = store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT payload FROM mission_worker_tool_receipt WHERE output_reference=?1",
                    [&reference],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("fable.connected-source-search.v1"));
    }
}
