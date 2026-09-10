//! Enabling tools is separate from granting foreground window control.
use super::LocalComputerState;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use tauri::State;
pub(super) const COMPUTER: u8 = 2;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinPlugins {
    pub computer: bool,
    /// Accept saved legacy settings without enabling the retired browser tool.
    #[serde(default, rename = "browser", skip_serializing)]
    _retired_browser: bool,
}
pub(super) struct PluginAuthority {
    pub bits: Arc<AtomicU8>,
    update: Mutex<()>,
}
impl PluginAuthority {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let scope = crate::authorized_scope::command_scope(
            None,
            None,
            crate::authorized_scope::ScopeAccess::Read,
        )?;
        let saved: BuiltinPlugins =
            crate::store::read_private_workspace_document(path, &scope.private)?
                .unwrap_or_default();
        Ok(Self {
            bits: Arc::new(AtomicU8::new(if saved.computer { COMPUTER } else { 0 })),
            update: Mutex::new(()),
        })
    }
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            bits: Arc::new(AtomicU8::new(COMPUTER)),
            update: Mutex::new(()),
        }
    }
    pub fn snapshot(&self) -> BuiltinPlugins {
        BuiltinPlugins {
            computer: self.bits.load(Ordering::Acquire) & COMPUTER != 0,
            ..Default::default()
        }
    }
}
#[tauri::command]
pub fn builtin_plugins_status(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
) -> Result<BuiltinPlugins, String> {
    if window.label() != "main" {
        return Err("Plugin settings belong to the main Mivlet window.".into());
    }
    crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    state.ensure_open()?;
    Ok(state.plugins.snapshot())
}
#[tauri::command]
pub async fn builtin_plugin_set(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    plugin: String,
    enabled: bool,
) -> Result<BuiltinPlugins, String> {
    if window.label() != "main" {
        return Err("Plugin settings belong to the main Mivlet window.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    if plugin != "computer" {
        return Err("This built-in plugin is no longer available.".into());
    }
    let state = state.inner().clone();
    // Disable input immediately, before storage IO or any drain operation.
    if !enabled {
        state.plugins.bits.store(0, Ordering::Release);
        state
            .native
            .stop("Computer Use disabled. Fresh permission is required.");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _update = state
            .plugins
            .update
            .lock()
            .map_err(|_| "Plugin settings are unavailable.")?;
        state.ensure_open()?;
        let saved = BuiltinPlugins {
            computer: enabled,
            ..Default::default()
        };
        if !crate::store::write_private_workspace_document(
            &state.root.join("plugins.json"),
            &scope.private,
            &saved,
        )? {
            return Err("Encrypted plugin settings are unavailable.".into());
        }
        if !enabled {
            for authority in state
                .authorities
                .lock()
                .map_err(|_| "Computer authority is unavailable.")?
                .values()
            {
                authority.revoke_and_drain_later();
            }
        }
        state
            .plugins
            .bits
            .store(if enabled { COMPUTER } else { 0 }, Ordering::Release);
        Ok(saved)
    })
    .await
    .map_err(|_| "Plugin settings could not be updated.")?
}
#[tauri::command]
pub async fn builtin_plugin_prepare_computer(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    plugin: String,
    expected_generation: u64,
) -> Result<super::LocalComputerSnapshot, String> {
    if window.label() != "main" || plugin != "computer" {
        return Err("Choose Computer Use in Mivlet's Plugins page.".into());
    }
    state.validate_target(&workspace_id, &agent_id)?;
    let ticket = state
        .authority_for(&workspace_id, &agent_id)?
        .begin_agent(expected_generation)?;
    ticket.finish(super::computer_snapshot(&state, workspace_id, agent_id))
}
