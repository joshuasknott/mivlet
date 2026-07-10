//! Managed scheduler state and scope resolution.

use std::{collections::BTreeMap, sync::Mutex};

use tauri::{AppHandle, Manager};

use crate::{
    models::SchedulerStore,
    store::repos::scope::{DataScope, DEFAULT_WORKSPACE_ID},
};

pub(crate) fn command_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<DataScope, String> {
    let scope = DataScope::new(
        workspace_id.unwrap_or_else(|| DEFAULT_WORKSPACE_ID.to_string()),
        project_id,
    )
    .map_err(|error| error.to_string())?;
    let _ = crate::store::with_store(|store| store.with_conn(|conn| scope.ensure_exists(conn)))?;
    Ok(scope)
}

/// Process-global scheduler state held behind Tauri's managed state.
/// Loaded once at setup; the tick mutates + persists it under the mutex.
pub struct SchedulerState(pub Mutex<BTreeMap<String, SchedulerStore>>);

impl SchedulerState {
    /// An empty store used before a real file is loaded.
    pub fn empty() -> SchedulerStore {
        super::logic::empty_store("unset")
    }
}

/// Resolve the managed scheduler state. Managed state is registered at app
/// setup, so this is always present in the running app. Unit tests that call
/// the pure helpers directly (`read_store`, `normalize_*`) do not need it.
pub(crate) fn with_state<R>(
    app: &AppHandle,
    f: impl FnOnce(&Mutex<BTreeMap<String, SchedulerStore>>) -> R,
) -> R {
    f(&app.state::<SchedulerState>().inner().0)
}
