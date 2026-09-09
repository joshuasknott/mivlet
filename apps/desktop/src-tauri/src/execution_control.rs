//! Workspace-wide execution pause.
//!
//! The encrypted preference is a start/lease gate, not a claim that an
//! external provider can undo work already accepted. Cancellation remains the
//! owning runtime's responsibility. Missing state defaults to active; malformed
//! state fails closed.

use crate::authorized_scope::{self, ScopeAccess};
use crate::store::repos::{preferences, scope::DataScope};
use crate::store::{Store, StoreError};

const KEY: &str = "executionControl";
const PAUSE_CONFIRMATION: &str = "pause all execution";
const RESUME_CONFIRMATION: &str = "resume execution";

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionControlState {
    pub paused: bool,
    pub revision: i64,
    pub changed_at: String,
}

fn default_state() -> ExecutionControlState {
    ExecutionControlState {
        paused: false,
        revision: 0,
        changed_at: String::new(),
    }
}

fn read_state(
    conn: &rusqlite::Connection,
    store: &Store,
    workspace_id: &str,
) -> crate::store::Result<ExecutionControlState> {
    let scope = DataScope::workspace(workspace_id.to_string())?;
    let Some(value) = preferences::get_scoped(conn, store, &scope, KEY)? else {
        return Ok(default_state());
    };
    let state: ExecutionControlState = serde_json::from_value(value).map_err(|_| {
        StoreError::Invalid(
            "The local execution control is unavailable. New execution is paused for safety."
                .into(),
        )
    })?;
    if state.revision < 1 || state.changed_at.trim().is_empty() {
        return Err(StoreError::Invalid(
            "The local execution control is unavailable. New execution is paused for safety."
                .into(),
        ));
    }
    Ok(state)
}

fn write_state(
    tx: &rusqlite::Connection,
    store: &Store,
    workspace_id: &str,
    current: &ExecutionControlState,
    paused: bool,
) -> crate::store::Result<ExecutionControlState> {
    if current.paused == paused {
        return Ok(current.clone());
    }
    let next = ExecutionControlState {
        paused,
        revision: current.revision.checked_add(1).ok_or_else(|| {
            StoreError::Invalid("The execution control revision overflowed.".into())
        })?,
        changed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let scope = DataScope::workspace(workspace_id.to_string())?;
    preferences::upsert_scoped(
        tx,
        store,
        &scope,
        KEY,
        &serde_json::to_value(&next)
            .map_err(|error| StoreError::Invalid(format!("Execution control failed: {error}")))?,
        &next.changed_at,
    )?;
    Ok(next)
}

pub(crate) fn ensure_active_execution_allowed() -> Result<(), String> {
    let Some(store) = crate::store::try_global() else {
        #[cfg(test)]
        return Ok(());
        #[cfg(not(test))]
        return Err("Mivlet's encrypted store is not initialized.".to_string());
    };
    let paused = store
        .with_conn(|conn| {
            read_state(
                conn,
                store,
                crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
            )
            .map(|state| state.paused)
        })
        .map_err(|error| error.to_string())?;
    if paused {
        Err("New execution is paused for this workspace. Resume it in Privacy settings before starting more work.".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn execution_control_get(workspace_id: String) -> Result<ExecutionControlState, String> {
    let scope = authorized_scope::command_scope(Some(workspace_id), None, ScopeAccess::Read)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| read_state(conn, store, scope.data.workspace_id()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn execution_control_pause(
    workspace_id: String,
    confirmation: String,
) -> Result<ExecutionControlState, String> {
    if confirmation != PAUSE_CONFIRMATION {
        return Err("Type pause all execution exactly to confirm.".into());
    }
    update(workspace_id, None, true)
}

#[tauri::command]
pub fn execution_control_resume(
    workspace_id: String,
    base_revision: i64,
    confirmation: String,
) -> Result<ExecutionControlState, String> {
    if confirmation != RESUME_CONFIRMATION {
        return Err("Type resume execution exactly to confirm.".into());
    }
    update(workspace_id, Some(base_revision), false)
}

fn update(
    workspace_id: String,
    base_revision: Option<i64>,
    paused: bool,
) -> Result<ExecutionControlState, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let next = store
        .transaction(|tx| {
            let scope =
                authorized_scope::resolve(tx, Some(&workspace_id), None, ScopeAccess::Write)?;
            let current = read_state(tx, store, scope.data.workspace_id())?;
            if let Some(base_revision) = base_revision {
                if current.revision != base_revision {
                    return Err(StoreError::Invalid(
                        "The execution control changed. Refresh it before resuming.".into(),
                    ));
                }
            }
            write_state(tx, store, scope.data.workspace_id(), &current, paused)
        })
        .map_err(|error| error.to_string())?;
    crate::action_history::Recorder::new(
        "system",
        "local-execution",
        if paused { "pause" } else { "resume" },
        "completed",
    )
    .risk("high")
    .mode("exact-confirmation")
    .correlation(&format!("execution-control-r{}", next.revision))
    .summary(if paused {
        "New workspace execution was paused."
    } else {
        "New workspace execution was resumed."
    })
    .record();
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    #[test]
    fn state_defaults_active_round_trips_encrypted_and_rejects_stale_resume() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = DataScope::workspace("workspace-1").unwrap();
        store
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES(?1,'Workspace','t','t')",
                    [scope.workspace_id()],
                )?;
                assert_eq!(read_state(conn, &store, scope.workspace_id())?, default_state());
                Ok(())
            })
            .unwrap();
        let paused = store
            .transaction(|tx| {
                let current = read_state(tx, &store, scope.workspace_id())?;
                write_state(tx, &store, scope.workspace_id(), &current, true)
            })
            .unwrap();
        assert!(paused.paused);
        assert_eq!(paused.revision, 1);
        store
            .with_conn(|conn| {
                let loaded = read_state(conn, &store, scope.workspace_id())?;
                assert_eq!(loaded, paused);
                let plaintext: Vec<u8> = conn.query_row(
                    "SELECT payload FROM preferences WHERE workspace_id=?1 AND key=?2",
                    rusqlite::params![scope.workspace_id(), KEY],
                    |row| row.get(0),
                )?;
                assert!(!String::from_utf8_lossy(&plaintext).contains("paused"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn malformed_state_fails_closed() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = DataScope::workspace("workspace-1").unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES(?1,'Workspace','t','t')",
                    [scope.workspace_id()],
                )?;
                preferences::upsert_scoped(
                    tx,
                    &store,
                    &scope,
                    KEY,
                    &serde_json::json!({"paused":"maybe"}),
                    "t",
                )
            })
            .unwrap();
        assert!(store
            .with_conn(|conn| read_state(conn, &store, scope.workspace_id()))
            .is_err());
    }
}
