//! Managed scheduler state and scope resolution.

use std::{collections::BTreeMap, sync::Mutex};

use tauri::{AppHandle, Manager};

use crate::{
    authorized_scope::ScopeAccess, models::SchedulerStore, store::repos::scope::DataScope,
};

pub(crate) fn command_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
    access: ScopeAccess,
) -> Result<DataScope, String> {
    crate::authorized_scope::command_scope(workspace_id, project_id, access).map(|auth| auth.data)
}

/// Process-global scheduler state held behind Tauri's managed state.
/// Loaded once at setup; the tick mutates + persists it under the mutex.
pub struct SchedulerState(pub Mutex<BTreeMap<String, SchedulerStore>>);

/// Resolve the managed scheduler state. Managed state is registered at app
/// setup, so this is always present in the running app. Unit tests that call
/// the pure helpers directly (`read_store`, `normalize_*`) do not need it.
pub(crate) fn with_state<R>(
    app: &AppHandle,
    f: impl FnOnce(&Mutex<BTreeMap<String, SchedulerStore>>) -> R,
) -> R {
    f(&app.state::<SchedulerState>().inner().0)
}
