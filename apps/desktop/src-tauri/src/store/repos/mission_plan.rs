//! Encrypted member-private mission and immutable generated-plan persistence.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::store::repos::scope::{normalize_id, DataScope};
use crate::store::repos::{open_json, seal_json};
use crate::store::vault::Sealed;
use crate::store::{Result, Store, StoreError};

const REVISION_REASONS: [&str; 7] = [
    "scope-changed",
    "constraint-changed",
    "new-evidence",
    "worker-feedback",
    "approval-result",
    "recovery",
    "manual-revision",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionPlanLifecycleRow {
    pub mission: Value,
    pub plan: Value,
    pub current_revision: Value,
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    mission_id: &str,
    plan_id: &str,
    plan_revision_id: &str,
    execution_depth: &str,
    mission: &Value,
    plan: &Value,
    plan_revision: &Value,
    at: &str,
) -> Result<MissionPlanLifecycleRow> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let actor = normalize_id(internal_user_id, "Internal user")?;
    let mission_id = normalize_id(mission_id, "Mission")?;
    let plan_id = normalize_id(plan_id, "Mission plan")?;
    let revision_id = normalize_id(plan_revision_id, "Plan revision")?;
    if !matches!(execution_depth, "delegated" | "multi-worker") {
        return Err(StoreError::Invalid(
            "Mission execution depth is invalid.".into(),
        ));
    }
    ensure_links(
        mission,
        plan,
        plan_revision,
        &mission_id,
        &plan_id,
        &revision_id,
        1,
    )?;
    let mission_sealed = seal_json(
        store,
        mission,
        &mission_aad(scope.workspace_id(), &owner, &mission_id),
    )?;
    let plan_sealed = seal_json(
        store,
        plan,
        &plan_aad(scope.workspace_id(), &owner, &plan_id),
    )?;
    let revision_sealed = seal_json(
        store,
        plan_revision,
        &revision_aad(scope.workspace_id(), &owner, &revision_id),
    )?;
    tx.execute(
        "INSERT INTO mission_record(workspace_id,owner_member_id,id,status,execution_depth,revision,current_plan_id,current_plan_revision_id,created_by_internal_user_id,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,'ready',?4,1,?5,?6,?7,?8,?8,?9,?10);",
        rusqlite::params![scope.workspace_id(),owner,mission_id,execution_depth,plan_id,revision_id,actor,at,mission_sealed.ciphertext,mission_sealed.nonce],
    )?;
    tx.execute(
        "INSERT INTO mission_plan_record(workspace_id,owner_member_id,id,mission_id,revision,current_revision_id,current_revision_number,created_at,updated_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,1,?5,1,?6,?6,?7,?8);",
        rusqlite::params![scope.workspace_id(),owner,plan_id,mission_id,revision_id,at,plan_sealed.ciphertext,plan_sealed.nonce],
    )?;
    tx.execute(
        "INSERT INTO mission_plan_revision(workspace_id,owner_member_id,id,plan_id,mission_id,revision_number,reason,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,1,'initial',?6,?7,?8);",
        rusqlite::params![scope.workspace_id(),owner,revision_id,plan_id,mission_id,at,revision_sealed.ciphertext,revision_sealed.nonce],
    )?;
    get(tx, store, scope, &owner, &mission_id)?
        .ok_or_else(|| StoreError::Invalid("Mission plan was not saved.".into()))
}

#[allow(clippy::too_many_arguments)]
pub fn revise(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    mission_id: &str,
    plan_id: &str,
    expected_mission_revision: i64,
    expected_plan_revision: i64,
    expected_current_revision_id: &str,
    new_revision_id: &str,
    reason: &str,
    mission: &Value,
    plan: &Value,
    plan_revision: &Value,
    at: &str,
) -> Result<MissionPlanLifecycleRow> {
    if !REVISION_REASONS.contains(&reason) {
        return Err(StoreError::Invalid(
            "Plan revision reason is invalid.".into(),
        ));
    }
    let owner = normalize_id(owner_member_id, "Member")?;
    let mission_id = normalize_id(mission_id, "Mission")?;
    let plan_id = normalize_id(plan_id, "Mission plan")?;
    let old_revision_id = normalize_id(expected_current_revision_id, "Current plan revision")?;
    let new_revision_id = normalize_id(new_revision_id, "Plan revision")?;
    let current_number: i64 = tx.query_row(
        "SELECT current_revision_number FROM mission_plan_record WHERE workspace_id=?1 AND owner_member_id=?2 AND id=?3 AND mission_id=?4 AND revision=?5 AND current_revision_id=?6;",
        rusqlite::params![scope.workspace_id(),owner,plan_id,mission_id,expected_plan_revision,old_revision_id],
        |row| row.get(0),
    ).optional()?.ok_or_else(|| StoreError::Invalid("The mission plan changed before this revision could be saved.".into()))?;
    let next_number = current_number + 1;
    ensure_links(
        mission,
        plan,
        plan_revision,
        &mission_id,
        &plan_id,
        &new_revision_id,
        next_number,
    )?;
    if plan_revision
        .get("supersedesRevisionId")
        .and_then(Value::as_str)
        != Some(old_revision_id.as_str())
    {
        return Err(StoreError::Invalid(
            "Plan revision does not supersede the selected revision.".into(),
        ));
    }
    let mission_sealed = seal_json(
        store,
        mission,
        &mission_aad(scope.workspace_id(), &owner, &mission_id),
    )?;
    let plan_sealed = seal_json(
        store,
        plan,
        &plan_aad(scope.workspace_id(), &owner, &plan_id),
    )?;
    let revision_sealed = seal_json(
        store,
        plan_revision,
        &revision_aad(scope.workspace_id(), &owner, &new_revision_id),
    )?;
    let mission_changed = tx.execute(
        "UPDATE mission_record SET revision=revision+1,current_plan_revision_id=?1,updated_at=?2,payload=?3,payload_nonce=?4 WHERE workspace_id=?5 AND owner_member_id=?6 AND id=?7 AND revision=?8 AND current_plan_id=?9 AND current_plan_revision_id=?10;",
        rusqlite::params![new_revision_id,at,mission_sealed.ciphertext,mission_sealed.nonce,scope.workspace_id(),owner,mission_id,expected_mission_revision,plan_id,old_revision_id],
    )?;
    if mission_changed != 1 {
        return Err(StoreError::Invalid(
            "The mission changed before this revision could be saved.".into(),
        ));
    }
    tx.execute(
        "INSERT INTO mission_plan_revision(workspace_id,owner_member_id,id,plan_id,mission_id,revision_number,reason,created_at,payload,payload_nonce) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10);",
        rusqlite::params![scope.workspace_id(),owner,new_revision_id,plan_id,mission_id,next_number,reason,at,revision_sealed.ciphertext,revision_sealed.nonce],
    )?;
    let plan_changed = tx.execute(
        "UPDATE mission_plan_record SET revision=revision+1,current_revision_id=?1,current_revision_number=?2,updated_at=?3,payload=?4,payload_nonce=?5 WHERE workspace_id=?6 AND owner_member_id=?7 AND id=?8 AND mission_id=?9 AND revision=?10 AND current_revision_id=?11;",
        rusqlite::params![new_revision_id,next_number,at,plan_sealed.ciphertext,plan_sealed.nonce,scope.workspace_id(),owner,plan_id,mission_id,expected_plan_revision,old_revision_id],
    )?;
    if plan_changed != 1 {
        return Err(StoreError::Invalid(
            "The mission plan changed before this revision could be saved.".into(),
        ));
    }
    get(tx, store, scope, &owner, &mission_id)?
        .ok_or_else(|| StoreError::Invalid("Mission plan disappeared.".into()))
}

pub fn get(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    mission_id: &str,
) -> Result<Option<MissionPlanLifecycleRow>> {
    scope.ensure_exists(tx)?;
    let owner = normalize_id(owner_member_id, "Member")?;
    let mission_id = normalize_id(mission_id, "Mission")?;
    let row = tx.query_row(
        "SELECT m.id,m.current_plan_id,m.current_plan_revision_id,m.payload,m.payload_nonce,p.payload,p.payload_nonce,r.payload,r.payload_nonce FROM mission_record m JOIN mission_plan_record p ON p.workspace_id=m.workspace_id AND p.owner_member_id=m.owner_member_id AND p.id=m.current_plan_id AND p.mission_id=m.id JOIN mission_plan_revision r ON r.workspace_id=m.workspace_id AND r.owner_member_id=m.owner_member_id AND r.id=m.current_plan_revision_id AND r.plan_id=p.id WHERE m.workspace_id=?1 AND m.owner_member_id=?2 AND m.id=?3;",
        rusqlite::params![scope.workspace_id(),owner,mission_id],
        |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,Sealed{ciphertext:row.get(3)?,nonce:row.get(4)?},Sealed{ciphertext:row.get(5)?,nonce:row.get(6)?},Sealed{ciphertext:row.get(7)?,nonce:row.get(8)?})),
    ).optional()?;
    row.map(
        |(mission_id, plan_id, revision_id, mission, plan, revision)| {
            Ok(MissionPlanLifecycleRow {
                mission: open_json(
                    store,
                    &mission,
                    &mission_aad(scope.workspace_id(), &owner, &mission_id),
                )?,
                plan: open_json(
                    store,
                    &plan,
                    &plan_aad(scope.workspace_id(), &owner, &plan_id),
                )?,
                current_revision: open_json(
                    store,
                    &revision,
                    &revision_aad(scope.workspace_id(), &owner, &revision_id),
                )?,
            })
        },
    )
    .transpose()
}

pub fn mark_running(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    at: &str,
) -> Result<()> {
    transition_status(
        tx,
        store,
        scope,
        owner_member_id,
        lifecycle,
        "ready",
        "running",
        None,
        at,
    )
}

pub fn mark_completed(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    terminal_result: &Value,
    at: &str,
) -> Result<()> {
    if terminal_result.get("outcome").and_then(Value::as_str) != Some("succeeded")
        || terminal_result
            .get("producingRunIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| ids.len() != 1)
    {
        return Err(StoreError::Invalid(
            "Mission terminal result is invalid.".into(),
        ));
    }
    transition_status(
        tx,
        store,
        scope,
        owner_member_id,
        lifecycle,
        "running",
        "completed",
        Some(terminal_result),
        at,
    )
}

pub fn mark_partially_completed(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    terminal_result: &Value,
    at: &str,
) -> Result<()> {
    if terminal_result.get("outcome").and_then(Value::as_str) != Some("partial")
        || terminal_result.get("partial").is_none()
        || terminal_result
            .get("producingRunIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| ids.len() != 1)
    {
        return Err(StoreError::Invalid(
            "Mission partial result is invalid.".into(),
        ));
    }
    transition_status(
        tx,
        store,
        scope,
        owner_member_id,
        lifecycle,
        "running",
        "partially-completed",
        Some(terminal_result),
        at,
    )
}

pub fn mark_failed(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    terminal_result: &Value,
    at: &str,
) -> Result<()> {
    if terminal_result.get("outcome").and_then(Value::as_str) != Some("failed")
        || terminal_result
            .get("producingRunIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| ids.len() != 1)
    {
        return Err(StoreError::Invalid(
            "Mission failure result is invalid.".into(),
        ));
    }
    transition_status(
        tx,
        store,
        scope,
        owner_member_id,
        lifecycle,
        "running",
        "failed",
        Some(terminal_result),
        at,
    )
}

pub fn mark_cancelled(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    terminal_result: &Value,
    at: &str,
) -> Result<()> {
    if terminal_result.get("outcome").and_then(Value::as_str) != Some("cancelled")
        || terminal_result
            .get("producingRunIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| ids.len() != 1)
    {
        return Err(StoreError::Invalid(
            "Mission cancellation result is invalid.".into(),
        ));
    }
    transition_status(
        tx,
        store,
        scope,
        owner_member_id,
        lifecycle,
        "running",
        "cancelled",
        Some(terminal_result),
        at,
    )
}

#[allow(clippy::too_many_arguments)]
fn transition_status(
    tx: &Connection,
    store: &Store,
    scope: &DataScope,
    owner_member_id: &str,
    lifecycle: &MissionPlanLifecycleRow,
    expected_status: &str,
    next_status: &str,
    terminal_result: Option<&Value>,
    at: &str,
) -> Result<()> {
    let owner = normalize_id(owner_member_id, "Member")?;
    let mut mission = lifecycle
        .mission
        .as_object()
        .cloned()
        .ok_or_else(|| StoreError::Invalid("Mission is invalid.".into()))?;
    let mission_id = normalize_id(
        mission.get("id").and_then(Value::as_str).unwrap_or(""),
        "Mission",
    )?;
    let revision = mission
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| StoreError::Invalid("Mission revision is invalid.".into()))?;
    let plan_id = normalize_id(
        mission
            .get("currentPlanId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "Mission plan",
    )?;
    let plan_revision_id = normalize_id(
        mission
            .get("currentPlanRevisionId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "Plan revision",
    )?;
    if mission.get("status").and_then(Value::as_str) != Some(expected_status) {
        return Err(StoreError::Invalid(
            "Mission lifecycle status changed.".into(),
        ));
    }
    mission.insert("status".into(), Value::String(next_status.into()));
    mission.insert("revision".into(), Value::from(revision + 1));
    mission.insert("updatedAt".into(), Value::String(at.into()));
    if let Some(result) = terminal_result {
        mission.insert("terminalResult".into(), result.clone());
    }
    let sealed = seal_json(
        store,
        &Value::Object(mission),
        &mission_aad(scope.workspace_id(), &owner, &mission_id),
    )?;
    let changed = tx.execute(
        "UPDATE mission_record SET status=?1,revision=revision+1,updated_at=?2,payload=?3,payload_nonce=?4 WHERE workspace_id=?5 AND owner_member_id=?6 AND id=?7 AND status=?8 AND revision=?9 AND current_plan_id=?10 AND current_plan_revision_id=?11;",
        rusqlite::params![next_status,at,sealed.ciphertext,sealed.nonce,scope.workspace_id(),owner,mission_id,expected_status,revision,plan_id,plan_revision_id],
    )?;
    if changed != 1 {
        return Err(StoreError::Invalid(
            "Mission lifecycle changed before its run could be projected.".into(),
        ));
    }
    Ok(())
}

fn ensure_links(
    mission: &Value,
    plan: &Value,
    revision: &Value,
    mission_id: &str,
    plan_id: &str,
    revision_id: &str,
    number: i64,
) -> Result<()> {
    let valid = mission.get("id").and_then(Value::as_str) == Some(mission_id)
        && mission.get("currentPlanId").and_then(Value::as_str) == Some(plan_id)
        && mission.get("currentPlanRevisionId").and_then(Value::as_str) == Some(revision_id)
        && plan.get("id").and_then(Value::as_str) == Some(plan_id)
        && plan.get("missionId").and_then(Value::as_str) == Some(mission_id)
        && plan.get("currentRevisionId").and_then(Value::as_str) == Some(revision_id)
        && plan.get("currentRevisionNumber").and_then(Value::as_i64) == Some(number)
        && revision.get("id").and_then(Value::as_str) == Some(revision_id)
        && revision.get("planId").and_then(Value::as_str) == Some(plan_id)
        && revision.get("missionId").and_then(Value::as_str) == Some(mission_id)
        && revision.get("planRevisionNumber").and_then(Value::as_i64) == Some(number);
    if !valid {
        return Err(StoreError::Invalid(
            "Mission plan lifecycle links are inconsistent.".into(),
        ));
    }
    Ok(())
}

fn mission_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("mission:{workspace}:{owner}:{id}")
}
fn plan_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("mission-plan:{workspace}:{owner}:{id}")
}
fn revision_aad(workspace: &str, owner: &str, id: &str) -> String {
    format!("mission-plan-revision:{workspace}:{owner}:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }
    fn values(revision: i64, revision_id: &str, supersedes: Option<&str>) -> (Value, Value, Value) {
        let mission = json!({"id":"mission-1","currentPlanId":"plan-1","currentPlanRevisionId":revision_id,"revision":revision});
        let plan = json!({"id":"plan-1","missionId":"mission-1","currentRevisionId":revision_id,"currentRevisionNumber":revision,"revision":revision});
        let mut plan_revision = json!({"id":revision_id,"planId":"plan-1","missionId":"mission-1","planRevisionNumber":revision,"summary":"secret objective"});
        if let Some(id) = supersedes {
            plan_revision["supersedesRevisionId"] = json!(id);
        }
        (mission, plan, plan_revision)
    }

    #[test]
    fn lifecycle_round_trips_revisions_across_reopen_and_isolates_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        {
            let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store.transaction(|tx| { tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?; Ok(()) }).unwrap();
            let scope = DataScope::workspace("w1").unwrap();
            let (m, p, r) = values(1, "revision-1", None);
            store
                .transaction(|tx| {
                    create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "mission-1",
                        "plan-1",
                        "revision-1",
                        "delegated",
                        &m,
                        &p,
                        &r,
                        "t1",
                    )
                })
                .unwrap();
            let (m2, p2, r2) = values(2, "revision-2", Some("revision-1"));
            store
                .transaction(|tx| {
                    revise(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-1",
                        "plan-1",
                        1,
                        1,
                        "revision-1",
                        "revision-2",
                        "new-evidence",
                        &m2,
                        &p2,
                        &r2,
                        "t2",
                    )
                })
                .unwrap();
        }
        let store = Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let reopened = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(reopened.current_revision["id"], "revision-2");
        assert!(store
            .with_conn(|tx| get(tx, &store, &scope, "member-2", "mission-1"))
            .unwrap()
            .is_none());
        let encrypted: Vec<u8> = store
            .with_conn(|tx| {
                Ok(tx.query_row(
                    "SELECT payload FROM mission_plan_revision WHERE id='revision-2'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("secret objective"));
    }

    #[test]
    fn stale_or_mismatched_revision_is_rejected_atomically() {
        let store = store();
        store.transaction(|tx| { tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?; Ok(()) }).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let (m, p, r) = values(1, "revision-1", None);
        store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "mission-1",
                    "plan-1",
                    "revision-1",
                    "delegated",
                    &m,
                    &p,
                    &r,
                    "t1",
                )
            })
            .unwrap();
        let (m2, p2, r2) = values(2, "revision-2", Some("wrong"));
        assert!(store
            .transaction(|tx| revise(
                tx,
                &store,
                &scope,
                "member-1",
                "mission-1",
                "plan-1",
                1,
                1,
                "revision-1",
                "revision-2",
                "recovery",
                &m2,
                &p2,
                &r2,
                "t2"
            ))
            .is_err());
        assert_eq!(
            store
                .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
                .unwrap()
                .unwrap()
                .current_revision["id"],
            "revision-1"
        );
    }

    #[test]
    fn mission_status_projects_run_start_and_exact_terminal_result() {
        let store = store();
        store.transaction(|tx| { tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?; Ok(()) }).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let (mut mission, plan, revision) = values(1, "revision-1", None);
        mission["status"] = json!("ready");
        mission["updatedAt"] = json!("t1");
        let lifecycle = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "mission-1",
                    "plan-1",
                    "revision-1",
                    "delegated",
                    &mission,
                    &plan,
                    &revision,
                    "t1",
                )
            })
            .unwrap();
        store
            .transaction(|tx| mark_running(tx, &store, &scope, "member-1", &lifecycle, "t2"))
            .unwrap();
        let running = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(running.mission["status"], "running");
        assert_eq!(running.mission["revision"], 2);
        let result = json!({"outcome":"succeeded","summary":"Done","producingRunIds":["run-1"],"outputs":[],"acceptance":[],"completedAt":"t3"});
        store
            .transaction(|tx| {
                mark_completed(tx, &store, &scope, "member-1", &running, &result, "t3")
            })
            .unwrap();
        let completed = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(completed.mission["status"], "completed");
        assert_eq!(completed.mission["revision"], 3);
        assert_eq!(completed.mission["terminalResult"], result);
        assert!(store
            .transaction(|tx| mark_completed(
                tx, &store, &scope, "member-1", &running, &result, "t4"
            ))
            .is_err());
    }

    #[test]
    fn mission_status_projects_exact_partial_result() {
        let store = store();
        store.transaction(|tx| { tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?; Ok(()) }).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let (mut mission, plan, revision) = values(1, "revision-1", None);
        mission["status"] = json!("ready");
        mission["updatedAt"] = json!("t1");
        let lifecycle = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "mission-1",
                    "plan-1",
                    "revision-1",
                    "delegated",
                    &mission,
                    &plan,
                    &revision,
                    "t1",
                )
            })
            .unwrap();
        store
            .transaction(|tx| mark_running(tx, &store, &scope, "member-1", &lifecycle, "t2"))
            .unwrap();
        let running = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        let partial = json!({"summary":"Draft preserved","completedOutputs":[],"remainingWork":["Meet policy"],"acceptance":[],"recoverable":true,"recommendedNextAction":"stop"});
        let result = json!({"outcome":"partial","summary":"Draft not accepted","producingRunIds":["run-1"],"outputs":[],"acceptance":[],"partial":partial,"completedAt":"t3"});
        store
            .transaction(|tx| {
                mark_partially_completed(tx, &store, &scope, "member-1", &running, &result, "t3")
            })
            .unwrap();
        let projected = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(projected.mission["status"], "partially-completed");
        assert_eq!(projected.mission["terminalResult"], result);
    }

    #[test]
    fn mission_status_projects_exact_failure_result() {
        let store = store();
        store.transaction(|tx| { tx.execute("INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",[])?; Ok(()) }).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let (mut mission, plan, revision) = values(1, "revision-1", None);
        mission["status"] = json!("ready");
        mission["updatedAt"] = json!("t1");
        let lifecycle = store
            .transaction(|tx| {
                create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "mission-1",
                    "plan-1",
                    "revision-1",
                    "delegated",
                    &mission,
                    &plan,
                    &revision,
                    "t1",
                )
            })
            .unwrap();
        store
            .transaction(|tx| mark_running(tx, &store, &scope, "member-1", &lifecycle, "t2"))
            .unwrap();
        let running = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        let result = json!({"outcome":"failed","summary":"Worker failed","producingRunIds":["run-1"],"outputs":[],"acceptance":[],"completedAt":"t3"});
        store
            .transaction(|tx| mark_failed(tx, &store, &scope, "member-1", &running, &result, "t3"))
            .unwrap();
        let projected = store
            .with_conn(|tx| get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(projected.mission["status"], "failed");
        assert_eq!(projected.mission["terminalResult"], result);
    }
}
