//! Scheduler persistence adapters.
//!
//! Production uses the encrypted SQLite repositories exclusively. The JSON
//! codec remains test-only for deterministic isolated fixtures.

#[cfg(test)]
use std::fs;
use std::{collections::BTreeMap, path::Path, sync::Mutex};

use tauri::AppHandle;

use crate::{
    models::{
        SchedulerQueueEntry, SchedulerStore, MAX_SCHEDULED_JOBS, MAX_SCHEDULER_QUEUE_ENTRIES,
        SCHEDULER_STORE_VERSION,
    },
    paths::scheduler_store_path,
    scheduler::{logic, state::SchedulerState},
};

#[cfg(test)]
pub(crate) fn read_store(path: &Path) -> Result<SchedulerStore, String> {
    if !path.exists() {
        return Ok(logic::empty_store("unset"));
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read scheduler store.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(logic::empty_store("unset"));
    }
    let mut store = serde_json::from_str::<SchedulerStore>(&contents)
        .map_err(|_| "Fable could not parse scheduler store.".to_string())?;
    if store.schema_version != SCHEDULER_STORE_VERSION {
        return Err("Scheduler store schema version is not supported.".to_string());
    }
    if store.instance_id.is_empty() {
        store.instance_id = "unset".to_string();
    }
    logic::index_occurrences(&mut store);
    Ok(store)
}

#[cfg(test)]
pub(crate) fn write_store(path: &Path, store: &SchedulerStore) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|_| "Fable could not encode scheduler store.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save scheduler store.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit scheduler store.".to_string())
}

pub(crate) fn decode_store_from_sqlite_rows(
    jobs: Vec<crate::store::repos::scheduled_job::ScheduledJobRow>,
    queue: Vec<crate::store::repos::scheduler_queue::QueueRow>,
    workspace_id: &str,
) -> Result<SchedulerStore, String> {
    let jobs = jobs
        .into_iter()
        .map(|row| {
            serde_json::from_value(row.value)
                .map_err(|_| "Fable could not decode a scheduled job.".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let queue = queue
        .into_iter()
        .map(|row| {
            serde_json::from_value::<SchedulerQueueEntry>(row.value)
                .map_err(|_| "Fable could not decode a queue entry.".to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut store = SchedulerStore {
        schema_version: SCHEDULER_STORE_VERSION,
        jobs,
        queue,
        instance_id: workspace_id.to_string(),
        updated_at: logic::now_iso(),
        occurrence_ledger: Vec::new(),
        occurrence_index: std::collections::HashSet::new(),
    };
    for entry in &store.queue {
        if !store.occurrence_ledger.contains(&entry.deduplication_key) {
            store
                .occurrence_ledger
                .push(entry.deduplication_key.clone());
        }
    }
    logic::index_occurrences(&mut store);
    Ok(store)
}

pub(crate) fn load_store_from_sqlite(workspace_id: &str) -> Result<Option<SchedulerStore>, String> {
    let result = crate::store::with_store(|store| {
        store.with_conn(|conn| {
            let jobs = crate::store::repos::scheduled_job::list(conn, store, workspace_id)?;
            let queue = crate::store::repos::scheduler_queue::list(conn, store, workspace_id)?;
            Ok((jobs, queue))
        })
    })?;
    let Some((jobs, queue)) = result else {
        return Ok(None);
    };
    Ok(Some(decode_store_from_sqlite_rows(
        jobs,
        queue,
        workspace_id,
    )?))
}

fn write_store_to_sqlite(workspace_id: &str, store_value: &SchedulerStore) -> Result<bool, String> {
    let now = logic::now_iso();
    let jobs: Vec<serde_json::Value> = store_value
        .jobs
        .iter()
        .take(MAX_SCHEDULED_JOBS)
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|_| "Fable could not encode a scheduled job.".to_string())?;
    let queue: Vec<serde_json::Value> = store_value
        .queue
        .iter()
        .take(MAX_SCHEDULER_QUEUE_ENTRIES)
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(|_| "Fable could not encode a queue entry.".to_string())?;
    let written = crate::store::with_store(|store| {
        store.transaction(|tx| {
            crate::store::repos::scheduler_queue::delete_all(tx, workspace_id)?;
            crate::store::repos::scheduled_job::delete_all(tx, workspace_id)?;
            for value in &jobs {
                crate::store::repos::scheduled_job::upsert_from_value(
                    tx,
                    store,
                    workspace_id,
                    value.clone(),
                    &now,
                )?;
            }
            for value in &queue {
                crate::store::repos::scheduler_queue::upsert_entry(
                    tx,
                    store,
                    workspace_id,
                    value,
                    &now,
                )?;
            }
            Ok(())
        })
    })?;
    Ok(written.is_some())
}

pub(crate) fn load_store(path: &Path, workspace_id: &str) -> Result<SchedulerStore, String> {
    if let Some(store) = load_store_from_sqlite(workspace_id)? {
        return Ok(store);
    }
    #[cfg(test)]
    {
        read_store(path)
    }
    #[cfg(not(test))]
    {
        let _ = path;
        Err("Fable's encrypted scheduler store is not initialized.".into())
    }
}

pub(crate) fn persist<F: FnOnce(&mut SchedulerStore) -> bool>(
    app: &AppHandle,
    mutex: &Mutex<BTreeMap<String, SchedulerStore>>,
    workspace_id: &str,
    mutate: F,
) -> Result<(), String> {
    let path = scheduler_store_path(app)?;
    let mut guard = mutex
        .lock()
        .map_err(|_| "Scheduler lock poisoned.".to_string())?;
    if !guard.contains_key(workspace_id) {
        guard.insert(workspace_id.to_string(), load_store(&path, workspace_id)?);
    }
    let store = guard.get_mut(workspace_id).expect("store loaded");
    if !mutate(store) {
        return Ok(());
    }
    store.updated_at = logic::now_iso();
    if write_store_to_sqlite(workspace_id, store)? {
        return Ok(());
    }
    #[cfg(test)]
    {
        write_store(&path, store)
    }
    #[cfg(not(test))]
    {
        let _ = path;
        Err("Fable's encrypted scheduler store is not initialized.".into())
    }
}

pub(crate) fn initialize_store(app: &AppHandle, state: &SchedulerState) -> Result<(), String> {
    let selected = crate::store::with_store(|store| {
        store.with_conn(
            crate::store::repos::workspace_directory::selected_active_workspace_for_current_user,
        )
    })?
    .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let Some(selected) = selected else {
        return Ok(());
    };
    let workspace_id = selected.local_workspace_id;
    let path = scheduler_store_path(app)?;
    let mut store = load_store(&path, &workspace_id)?;
    let changed = store
        .queue
        .iter()
        .any(|entry| entry.state == "leased" || entry.state == "running");
    if changed {
        logic::recover_store_at(&mut store);
        store.updated_at = logic::now_iso();
        if !write_store_to_sqlite(&workspace_id, &store)? {
            #[cfg(test)]
            write_store(&path, &store)?;
            #[cfg(not(test))]
            return Err("Fable's encrypted scheduler store is not initialized.".into());
        }
    }
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Scheduler lock poisoned.".to_string())?;
    guard.insert(workspace_id, store);
    Ok(())
}
