//! Immutable encrypted mission-worker output receipts linked to completion events.

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
pub struct MissionWorkerOutputRow {
    pub run_id: String,
    pub worker_id: String,
    pub completion_event_id: String,
    pub output_key: String,
    pub value_reference: String,
    pub content_hash: String,
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
    completion_event_id: &str,
    output_key: &str,
    value_reference: &str,
    content_hash: &str,
    size_bytes: i64,
    receipt: &Value,
    at: &str,
) -> Result<MissionWorkerOutputRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let worker_id = normalize_id(worker_id, "Mission worker")?;
    let event_id = normalize_id(completion_event_id, "Worker completion event")?;
    let output_key = normalize_id(output_key, "Worker output")?;
    validate_metadata(value_reference, content_hash, size_bytes)?;
    validate_receipt(
        receipt,
        scope.workspace_id(),
        &owner,
        &run_id,
        &worker_id,
        &event_id,
        &output_key,
        value_reference,
        content_hash,
        size_bytes,
        at,
    )?;

    let event = tx
        .query_row(
            "SELECT payload,payload_nonce FROM mission_run_event WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3 AND id=?4 AND event_type='worker-completed';",
            rusqlite::params![scope.workspace_id(), owner, run_id, event_id],
            |row| Ok(Sealed { ciphertext: row.get(0)?, nonce: row.get(1)? }),
        )
        .optional()?
        .ok_or_else(|| StoreError::Invalid("Worker completion event is unavailable.".into()))?;
    let event = open_json(
        store,
        &event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    let output_matches = event
        .pointer("/payload/outputs")
        .and_then(Value::as_array)
        .is_some_and(|outputs| {
            outputs.len() == 1
                && outputs[0].get("key").and_then(Value::as_str) == Some(output_key.as_str())
                && outputs[0].get("valueReference").and_then(Value::as_str) == Some(value_reference)
        });
    if event.get("id").and_then(Value::as_str) != Some(event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        || event.pointer("/payload/workerId").and_then(Value::as_str) != Some(worker_id.as_str())
        || !output_matches
    {
        return Err(StoreError::Invalid(
            "Worker output receipt does not match its immutable completion event.".into(),
        ));
    }

    if let Some(existing) = get_by_reference(tx, store, scope, &owner, value_reference)? {
        return if existing.run_id == run_id
            && existing.worker_id == worker_id
            && existing.completion_event_id == event_id
            && existing.output_key == output_key
            && existing.content_hash == content_hash
            && existing.size_bytes == size_bytes
            && existing.receipt == *receipt
        {
            Ok(existing)
        } else {
            Err(StoreError::Invalid(
                "Worker output reference represents another receipt.".into(),
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
            &output_key,
        ),
    )?;
    tx.execute(
        "INSERT INTO mission_worker_output_receipt(workspace_id,owner_member_id,run_id,worker_id,completion_event_id,output_key,value_reference,content_hash,size_bytes,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12);",
        rusqlite::params![scope.workspace_id(),owner,run_id,worker_id,event_id,output_key,value_reference,content_hash,size_bytes,at,sealed.ciphertext,sealed.nonce],
    )?;
    get_by_reference(tx, store, scope, &owner, value_reference)?
        .ok_or_else(|| StoreError::Invalid("Worker output receipt was not saved.".into()))
}

pub fn get_by_reference(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    value_reference: &str,
) -> Result<Option<MissionWorkerOutputRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let row = tx
        .query_row(
            "SELECT run_id,worker_id,completion_event_id,output_key,content_hash,size_bytes,created_at,payload,payload_nonce FROM mission_worker_output_receipt WHERE workspace_id=?1 AND owner_member_id=?2 AND value_reference=?3;",
            rusqlite::params![scope.workspace_id(), owner, value_reference],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    Sealed { ciphertext: row.get(7)?, nonce: row.get(8)? },
                ))
            },
        )
        .optional()?;
    row.map(
        |(run_id, worker_id, event_id, output_key, hash, size, created_at, sealed)| {
            let receipt = open_json(
                store,
                &sealed,
                &aad(
                    scope.workspace_id(),
                    &owner,
                    &run_id,
                    &worker_id,
                    &event_id,
                    &output_key,
                ),
            )?;
            validate_receipt(
                &receipt,
                scope.workspace_id(),
                &owner,
                &run_id,
                &worker_id,
                &event_id,
                &output_key,
                value_reference,
                &hash,
                size,
                &created_at,
            )?;
            Ok(MissionWorkerOutputRow {
                run_id,
                worker_id,
                completion_event_id: event_id,
                output_key,
                value_reference: value_reference.to_string(),
                content_hash: hash,
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
        || !(1..=65_536).contains(&size)
    {
        return Err(StoreError::Invalid(
            "Worker output receipt metadata is invalid.".into(),
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
    output_key: &str,
    reference: &str,
    hash: &str,
    size: i64,
    created_at: &str,
) -> Result<()> {
    let Some(object) = receipt.as_object() else {
        return Err(StoreError::Invalid(
            "Worker output receipt is invalid.".into(),
        ));
    };
    const KEYS: [&str; 19] = [
        "version",
        "workspaceId",
        "ownerMemberId",
        "runId",
        "workerId",
        "completionEventId",
        "outputKey",
        "valueReference",
        "contentHash",
        "sizeBytes",
        "text",
        "mediaType",
        "encoding",
        "observedProvider",
        "providerRouteId",
        "requestedModel",
        "trust",
        "citations",
        "createdAt",
    ];
    let text = receipt
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let model = receipt
        .get("requestedModel")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let provider = receipt
        .get("observedProvider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let computed_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let version = receipt
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let citations = receipt.get("citations").and_then(Value::as_array);
    let provenance_valid = match (
        version,
        receipt.get("trust").and_then(Value::as_str),
        citations,
    ) {
        (1, Some("provider-generated"), Some(citations)) => citations.is_empty(),
        (2, Some("provider-generated-with-external-evidence"), Some(citations)) => {
            citations.len() <= 50 && citations.iter().all(valid_external_citation)
        }
        _ => false,
    };
    let route = receipt.get("providerRouteId").and_then(Value::as_str);
    if !(object.len() == KEYS.len() || (object.len() == KEYS.len() - 1 && route.is_none()))
        || object.keys().any(|key| !KEYS.contains(&key.as_str()))
        || !provenance_valid
        || receipt.get("workspaceId").and_then(Value::as_str) != Some(workspace)
        || receipt.get("ownerMemberId").and_then(Value::as_str) != Some(owner)
        || receipt.get("runId").and_then(Value::as_str) != Some(run)
        || receipt.get("workerId").and_then(Value::as_str) != Some(worker)
        || receipt.get("completionEventId").and_then(Value::as_str) != Some(event)
        || receipt.get("outputKey").and_then(Value::as_str) != Some(output_key)
        || receipt.get("valueReference").and_then(Value::as_str) != Some(reference)
        || receipt.get("contentHash").and_then(Value::as_str) != Some(hash)
        || receipt.get("sizeBytes").and_then(Value::as_i64) != Some(size)
        || receipt.get("mediaType").and_then(Value::as_str) != Some("text/markdown")
        || receipt.get("encoding").and_then(Value::as_str) != Some("utf-8")
        || crate::store::repos::scope::normalize_id(provider, "Observed provider").is_err()
        || route.is_some_and(|value| value.is_empty() || value.len() > 200)
        || model.is_empty()
        || model.len() > 200
        || text.trim().is_empty()
        || text.len() as i64 != size
        || computed_hash != hash
        || binding_reference(workspace, owner, run, worker, event, output_key, hash) != reference
        || receipt.get("createdAt").and_then(Value::as_str) != Some(created_at)
    {
        return Err(StoreError::Invalid(
            "Worker output receipt is invalid.".into(),
        ));
    }
    Ok(())
}

fn valid_external_citation(citation: &Value) -> bool {
    let Some(object) = citation.as_object() else {
        return false;
    };
    const KEYS: [&str; 8] = [
        "citationId",
        "sourceId",
        "title",
        "snippet",
        "uri",
        "provenance",
        "freshness",
        "trust",
    ];
    !object.keys().any(|key| !KEYS.contains(&key.as_str()))
        && citation
            .get("citationId")
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("source-") && v.len() <= 120)
        && citation
            .get("sourceId")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.len() <= 512)
        && citation
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.len() <= 512)
        && citation
            .get("snippet")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.len() <= 4_096)
        && citation
            .get("provenance")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.len() <= 512)
        && citation
            .get("freshness")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v.len() <= 200)
        && citation.get("trust").and_then(Value::as_str) == Some("external-untrusted")
        && citation.get("uri").is_none_or(|value| {
            value.as_str().is_some_and(|uri| {
                uri.len() <= 2_048
                    && url::Url::parse(uri).ok().is_some_and(|parsed| {
                        matches!(parsed.scheme(), "http" | "https")
                            && parsed.host_str().is_some()
                            && parsed.username().is_empty()
                            && parsed.password().is_none()
                    })
            })
        })
}

pub fn binding_reference(
    workspace: &str,
    owner: &str,
    run: &str,
    worker: &str,
    event: &str,
    output_key: &str,
    content_hash: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission-worker-output.v1\0");
    for value in [
        workspace,
        owner,
        run,
        worker,
        event,
        output_key,
        content_hash,
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!(
        "mission-output:v1:{event}:{output_key}:sha256:{:x}",
        digest.finalize()
    )
}

fn aad(workspace: &str, owner: &str, run: &str, worker: &str, event: &str, key: &str) -> String {
    format!("mission-worker-output:v1:{workspace}:{owner}:{run}:{worker}:{event}:{key}")
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
    fn output_receipt_reopens_encrypted_and_owner_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        let text = "A durable native result.";
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let reference = binding_reference(
            "w1", "member-1", "run-1", "worker-1", "event-4", "brief", &hash,
        );
        {
            let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store.transaction(|tx| {
                tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');", [])?;
                let event = json!({
                    "id":"event-4","runId":"run-1","type":"worker-completed",
                    "payload":{"workerId":"worker-1","outputs":[{
                        "key":"brief","summary":"Native worker output","valueReference":reference
                    }]}
                });
                let sealed = seal_json(&store, &event, &event_aad("w1", "member-1", "event-4"))?;
                tx.execute("INSERT INTO mission_run_event(workspace_id,owner_member_id,run_id,sequence,id,event_type,idempotency_key,occurred_at,payload,payload_nonce) VALUES ('w1','member-1','run-1',4,'event-4','worker-completed','complete','t',?1,?2);", rusqlite::params![sealed.ciphertext,sealed.nonce])?;
                let receipt = json!({
                    "version":1,"workspaceId":"w1","ownerMemberId":"member-1",
                    "runId":"run-1","workerId":"worker-1","completionEventId":"event-4",
                    "outputKey":"brief","valueReference":reference,"contentHash":hash,
                    "sizeBytes":text.len(),"text":text,"mediaType":"text/markdown","encoding":"utf-8",
                    "observedProvider":"openai","requestedModel":"gpt-5","trust":"provider-generated",
                    "citations":[],"createdAt":"t"
                });
                put(tx, &store, &DataScope::workspace("w1")?, "member-1", "run-1", "worker-1", "event-4", "brief", &reference, &hash, text.len() as i64, &receipt, "t")?;
                Ok(())
            }).unwrap();
        }
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let loaded = store
            .with_conn(|tx| get_by_reference(tx, &store, &scope, "member-1", &reference))
            .unwrap()
            .unwrap();
        assert_eq!(loaded.receipt["text"], text);
        assert!(store
            .with_conn(|tx| get_by_reference(tx, &store, &scope, "member-2", &reference))
            .unwrap()
            .is_none());
        let ciphertext: Vec<u8> = store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT payload FROM mission_worker_output_receipt WHERE value_reference=?1",
                    [&reference],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains(text));
    }

    #[test]
    fn cited_output_receipt_retains_external_evidence_without_instruction_authority() {
        let text = "Launch in Q3 [source-1].\n\n## Sources\n- [source-1] Launch plan";
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let reference = binding_reference(
            "w1", "member-1", "run-1", "worker-1", "event-5", "brief", &hash,
        );
        let receipt = json!({
            "version":2,"workspaceId":"w1","ownerMemberId":"member-1","runId":"run-1","workerId":"worker-1",
            "completionEventId":"event-5","outputKey":"brief","valueReference":reference,"contentHash":hash,
            "sizeBytes":text.len(),"text":text,"mediaType":"text/markdown","encoding":"utf-8",
            "observedProvider":"xai","requestedModel":"grok-4","trust":"provider-generated-with-external-evidence",
            "citations":[{"citationId":"source-1","sourceId":"doc-1","title":"Launch plan","snippet":"Q3",
                "uri":"https://example.com/launch","provenance":"Notion","freshness":"2026-07-11T20:00:00Z","trust":"external-untrusted"}],
            "createdAt":"t"
        });
        validate_receipt(
            &receipt,
            "w1",
            "member-1",
            "run-1",
            "worker-1",
            "event-5",
            "brief",
            &reference,
            &hash,
            text.len() as i64,
            "t",
        )
        .unwrap();
        let mut invented = receipt.clone();
        invented["observedProvider"] = json!("unknown/provider");
        assert!(validate_receipt(
            &invented,
            "w1",
            "member-1",
            "run-1",
            "worker-1",
            "event-5",
            "brief",
            &reference,
            &hash,
            text.len() as i64,
            "t"
        )
        .is_err());
        let mut forged = receipt;
        forged["citations"][0]["trust"] = json!("trusted");
        assert!(validate_receipt(
            &forged,
            "w1",
            "member-1",
            "run-1",
            "worker-1",
            "event-5",
            "brief",
            &reference,
            &hash,
            text.len() as i64,
            "t"
        )
        .is_err());
    }
}
