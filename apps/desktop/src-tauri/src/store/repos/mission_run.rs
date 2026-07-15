//! Encrypted append-only mission run and event journal persistence.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::repos::scope::{normalize_id, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionRunJournalRow {
    pub run: Value,
    pub events: Vec<Value>,
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    run_id: &str,
    event_id: &str,
    idempotency_key: &str,
    run: &Value,
    event: &Value,
    at: &str,
) -> Result<MissionRunJournalRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let event_id = normalize_id(event_id, "Run event")?;
    validate_initial(run, event, &run_id, &event_id, idempotency_key)?;
    let run_sealed = seal_json(store, run, &run_aad(scope.workspace_id(), &owner, &run_id))?;
    let event_sealed = seal_json(
        store,
        event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    tx.execute(
        "INSERT INTO mission_run_record(workspace_id,owner_member_id,id,status,revision,last_sequence,last_event_id,current_attempt_number,terminal,created_by_internal_user_id,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,1,?6,?7,0,?8,?9,?9,?10,?11);",
        rusqlite::params![scope.workspace_id(),owner,run_id,string(run,"status")?,integer(run,"revision")?,event_id,optional_integer(run,"currentAttemptNumber")?,actor,at,run_sealed.ciphertext,run_sealed.nonce],
    )?;
    insert_event(
        tx,
        scope,
        &owner,
        &run_id,
        1,
        &event_id,
        "run-created",
        idempotency_key,
        None,
        optional_integer(event, "attemptNumber")?,
        at,
        &event_sealed,
    )?;
    get(tx, store, scope, &owner, &run_id)?
        .ok_or_else(|| StoreError::Invalid("Mission run was not saved.".into()))
}

#[allow(clippy::too_many_arguments)]
pub fn append(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    event_id: &str,
    event_type: &str,
    idempotency_key: &str,
    event: &Value,
    projected_run: &Value,
    at: &str,
) -> Result<MissionRunJournalRow> {
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let event_id = normalize_id(event_id, "Run event")?;
    if let Some(existing) = event_by_key(tx, store, scope, &owner, &run_id, idempotency_key)? {
        if existing == *event {
            return get(tx, store, scope, &owner, &run_id)?
                .ok_or_else(|| StoreError::Invalid("Mission run disappeared.".into()));
        }
        return Err(StoreError::Invalid(
            "A run event idempotency key cannot represent different facts.".into(),
        ));
    }
    let (last_event_id, terminal): (String,i64) = tx.query_row(
        "SELECT last_event_id,terminal FROM mission_run_record WHERE workspace_id=?1 AND owner_member_id=?2 AND id=?3 AND revision=?4 AND last_sequence=?5;",
        rusqlite::params![scope.workspace_id(),owner,run_id,expected_run_revision,expected_last_sequence],
        |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional()?.ok_or_else(|| StoreError::Invalid("The mission run changed before this event could be appended.".into()))?;
    if terminal != 0 {
        return Err(StoreError::Invalid(
            "A terminal mission run is immutable.".into(),
        ));
    }
    let sequence = expected_last_sequence + 1;
    validate_append(
        event,
        projected_run,
        &run_id,
        &event_id,
        event_type,
        idempotency_key,
        sequence,
        &last_event_id,
        expected_run_revision + 1,
    )?;
    let event_sealed = seal_json(
        store,
        event,
        &event_aad(scope.workspace_id(), &owner, &event_id),
    )?;
    let run_sealed = seal_json(
        store,
        projected_run,
        &run_aad(scope.workspace_id(), &owner, &run_id),
    )?;
    insert_event(
        tx,
        scope,
        &owner,
        &run_id,
        sequence,
        &event_id,
        event_type,
        idempotency_key,
        Some(&last_event_id),
        optional_integer(event, "attemptNumber")?,
        at,
        &event_sealed,
    )?;
    let status = string(projected_run, "status")?;
    let is_terminal = matches!(
        status.as_str(),
        "completed" | "partially-completed" | "failed" | "cancelled"
    );
    let changed=tx.execute(
        "UPDATE mission_run_record SET status=?1,revision=?2,last_sequence=?3,last_event_id=?4,current_attempt_number=?5,terminal=?6,updated_at=?7,payload=?8,payload_nonce=?9 WHERE workspace_id=?10 AND owner_member_id=?11 AND id=?12 AND revision=?13 AND last_sequence=?14;",
        rusqlite::params![status,expected_run_revision+1,sequence,event_id,optional_integer(projected_run,"currentAttemptNumber")?,is_terminal as i64,at,run_sealed.ciphertext,run_sealed.nonce,scope.workspace_id(),owner,run_id,expected_run_revision,expected_last_sequence],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "The mission run changed before this event could be appended.".into(),
        ));
    }
    get(tx, store, scope, &owner, &run_id)?
        .ok_or_else(|| StoreError::Invalid("Mission run disappeared.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
) -> Result<Option<MissionRunJournalRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let run_id = normalize_id(run_id, "Mission run")?;
    let run=tx.query_row(
        "SELECT payload,payload_nonce FROM mission_run_record WHERE workspace_id=?1 AND owner_member_id=?2 AND id=?3;",
        rusqlite::params![scope.workspace_id(),owner,run_id],
        |row| Ok(Sealed{ciphertext:row.get(0)?,nonce:row.get(1)?}),
    ).optional()?;
    let Some(run) = run else { return Ok(None) };
    let mut stmt=tx.prepare("SELECT id,payload,payload_nonce FROM mission_run_event WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3 ORDER BY sequence;")?;
    let rows = stmt
        .query_map(
            rusqlite::params![scope.workspace_id(), owner, run_id],
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
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let events = rows
        .into_iter()
        .map(|(id, sealed)| {
            open_json(
                store,
                &sealed,
                &event_aad(scope.workspace_id(), &owner, &id),
            )
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(MissionRunJournalRow {
        run: open_json(store, &run, &run_aad(scope.workspace_id(), &owner, &run_id))?,
        events,
    }))
}

pub fn list_nonterminal_ids_before(
    tx: &Connection,
    scope: &DataScope,
    owner_member_id: &str,
    before: &str,
) -> Result<Vec<String>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let mut statement = tx.prepare(
        "SELECT id FROM mission_run_record WHERE workspace_id=?1 AND owner_member_id=?2 AND terminal=0 AND updated_at<?3 ORDER BY updated_at,id;",
    )?;
    let ids = statement
        .query_map(
            rusqlite::params![scope.workspace_id(), owner, before],
            |row| row.get(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

pub fn list_nonterminal_ids(
    tx: &Connection,
    scope: &DataScope,
    owner_member_id: &str,
) -> Result<Vec<String>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let mut statement = tx.prepare(
        "SELECT id FROM mission_run_record WHERE workspace_id=?1 AND owner_member_id=?2 AND terminal=0 ORDER BY updated_at,id;",
    )?;
    let ids = statement
        .query_map(rusqlite::params![scope.workspace_id(), owner], |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)?;
    Ok(ids)
}

#[allow(clippy::too_many_arguments)]
fn insert_event(
    tx: &Connection,
    scope: &DataScope,
    owner: &str,
    run_id: &str,
    sequence: i64,
    event_id: &str,
    event_type: &str,
    key: &str,
    previous: Option<&str>,
    attempt: Option<i64>,
    at: &str,
    sealed: &Sealed,
) -> Result<()> {
    tx.execute("INSERT INTO mission_run_event(workspace_id,owner_member_id,run_id,sequence,id,event_type,idempotency_key,previous_event_id,attempt_number,occurred_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12);",rusqlite::params![scope.workspace_id(),owner,run_id,sequence,event_id,event_type,key,previous,attempt,at,sealed.ciphertext,sealed.nonce])?;
    Ok(())
}
fn event_by_key(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner: &str,
    run_id: &str,
    key: &str,
) -> Result<Option<Value>> {
    let row=tx.query_row("SELECT id,payload,payload_nonce FROM mission_run_event WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3 AND idempotency_key=?4;",rusqlite::params![scope.workspace_id(),owner,run_id,key],|row|Ok((row.get::<_,String>(0)?,Sealed{ciphertext:row.get(1)?,nonce:row.get(2)?}))).optional()?;
    row.map(|(id, sealed)| open_json(store, &sealed, &event_aad(scope.workspace_id(), owner, &id)))
        .transpose()
}
fn validate_initial(
    run: &Value,
    event: &Value,
    run_id: &str,
    event_id: &str,
    key: &str,
) -> Result<()> {
    if string(run, "id")? != run_id
        || integer(
            run.pointer("/eventHead/lastSequence")
                .ok_or_else(|| StoreError::Invalid("Run event head is missing.".into()))?,
            "",
        )? != 1
    {
        return Err(StoreError::Invalid(
            "Initial mission run projection is invalid.".into(),
        ));
    }
    if string(event, "id")? != event_id
        || string(event, "runId")? != run_id
        || string(event, "type")? != "run-created"
        || integer(event, "sequence")? != 1
        || string(event, "idempotencyKey")? != key
    {
        return Err(StoreError::Invalid("Initial run event is invalid.".into()));
    }
    Ok(())
}
fn validate_append(
    event: &Value,
    run: &Value,
    run_id: &str,
    event_id: &str,
    event_type: &str,
    key: &str,
    sequence: i64,
    previous: &str,
    revision: i64,
) -> Result<()> {
    let head = run
        .get("eventHead")
        .ok_or_else(|| StoreError::Invalid("Run event head is missing.".into()))?;
    if string(run, "id")? != run_id
        || integer(run, "revision")? != revision
        || integer(head, "lastSequence")? != sequence
        || string(head, "lastEventId")? != event_id
        || string(event, "id")? != event_id
        || string(event, "runId")? != run_id
        || string(event, "type")? != event_type
        || integer(event, "sequence")? != sequence
        || string(event, "previousEventId")? != previous
        || string(event, "idempotencyKey")? != key
    {
        return Err(StoreError::Invalid(
            "Run event projection is inconsistent.".into(),
        ));
    }
    Ok(())
}
fn string(value: &Value, key: &str) -> Result<String> {
    let target = if key.is_empty() {
        value
    } else {
        value.get(key).unwrap_or(&Value::Null)
    };
    target
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| StoreError::Invalid(format!("Run {key} is invalid.")))
}
fn integer(value: &Value, key: &str) -> Result<i64> {
    let target = if key.is_empty() {
        value
    } else {
        value.get(key).unwrap_or(&Value::Null)
    };
    target
        .as_i64()
        .ok_or_else(|| StoreError::Invalid(format!("Run {key} is invalid.")))
}
fn optional_integer(value: &Value, key: &str) -> Result<Option<i64>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| StoreError::Invalid(format!("Run {key} is invalid."))),
    }
}
fn run_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("mission-run:{workspace}:{owner}:{id}")
}
fn event_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("mission-run-event:{workspace}:{owner}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use serde_json::json;

    fn run(revision: i64, sequence: i64, event_id: &str, status: &str) -> Value {
        json!({"id":"run-1","status":status,"revision":revision,"eventHead":{"lastSequence":sequence,"lastEventId":event_id}})
    }
    fn event(
        id: &str,
        sequence: i64,
        event_type: &str,
        key: &str,
        previous: Option<&str>,
    ) -> Value {
        let mut value = json!({"id":id,"runId":"run-1","type":event_type,"sequence":sequence,"idempotencyKey":key});
        if let Some(previous) = previous {
            value["previousEventId"] = json!(previous)
        }
        value
    }

    #[test]
    fn append_only_run_journal_reopens_isolates_owner_and_replays_exactly() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        {
            let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store.transaction(|tx|{tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?;Ok(())}).unwrap();
            let scope = DataScope::workspace("w1").unwrap();
            let first_event = event("event-1", 1, "run-created", "create", None);
            store
                .transaction(|tx| {
                    create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "run-1",
                        "event-1",
                        "create",
                        &run(2, 1, "event-1", "created"),
                        &first_event,
                        "t1",
                    )
                })
                .unwrap();
            let second_event = event(
                "event-2",
                2,
                "status-transitioned",
                "start",
                Some("event-1"),
            );
            let projected = run(3, 2, "event-2", "running");
            store
                .transaction(|tx| {
                    append(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        2,
                        1,
                        "event-2",
                        "status-transitioned",
                        "start",
                        &second_event,
                        &projected,
                        "t2",
                    )
                })
                .unwrap();
            let replay = store
                .transaction(|tx| {
                    append(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        2,
                        1,
                        "event-2",
                        "status-transitioned",
                        "start",
                        &second_event,
                        &projected,
                        "t2",
                    )
                })
                .unwrap();
            assert_eq!(replay.events.len(), 2);
            let changed = event(
                "event-other",
                2,
                "status-transitioned",
                "start",
                Some("event-1"),
            );
            assert!(store
                .transaction(|tx| append(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "run-1",
                    3,
                    2,
                    "event-other",
                    "status-transitioned",
                    "start",
                    &changed,
                    &projected,
                    "t3"
                ))
                .is_err());
        }
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let reopened = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "run-1"))
            .unwrap()
            .unwrap();
        assert_eq!(reopened.run["status"], "running");
        assert_eq!(reopened.events.len(), 2);
        assert_eq!(
            store
                .with_conn(|tx| list_nonterminal_ids_before(tx, &scope, "member-1", "t3"))
                .unwrap(),
            vec!["run-1"]
        );
        assert!(store
            .with_conn(|tx| list_nonterminal_ids_before(tx, &scope, "member-1", "t2"))
            .unwrap()
            .is_empty());
        assert!(store
            .with_conn(|tx| get(tx, &store, &scope, "member-2", "run-1"))
            .unwrap()
            .is_none());
        let ciphertext: Vec<u8> = store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT payload FROM mission_run_event WHERE id='event-2'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("status-transitioned"));
    }

    #[test]
    fn stale_append_rolls_back_without_extending_the_chain() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store.transaction(|tx|{tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?;Ok(())}).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let first = event("event-1", 1, "run-created", "create", None);
        store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "run-1",
                    "event-1",
                    "create",
                    &run(2, 1, "event-1", "created"),
                    &first,
                    "t1",
                )
            })
            .unwrap();
        let second = event(
            "event-2",
            2,
            "status-transitioned",
            "start",
            Some("event-1"),
        );
        assert!(store
            .transaction(|tx| append(
                tx,
                &store,
                &scope,
                "member-1",
                "run-1",
                99,
                1,
                "event-2",
                "status-transitioned",
                "start",
                &second,
                &run(3, 2, "event-2", "running"),
                "t2"
            ))
            .is_err());
        assert_eq!(
            store
                .with_conn(|tx| get(tx, &store, &scope, "member-1", "run-1"))
                .unwrap()
                .unwrap()
                .events
                .len(),
            1
        );
    }
}
