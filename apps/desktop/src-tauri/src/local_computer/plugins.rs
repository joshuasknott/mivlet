//! Built-in plugin enablement is native authority, shared by the installation workspace.
use super::{LocalComputerController, LocalComputerState};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, State};

pub(super) const BROWSER: u8 = 1;
pub(super) const COMPUTER: u8 = 2;

#[tauri::command]
pub async fn builtin_plugin_prepare_computer(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    plugin: String,
    expected_generation: u64,
) -> Result<super::LocalComputerSnapshot, String> {
    if window.label() != "main" {
        return Err("Plugin startup belongs to the main Mivlet window.".into());
    }
    state.validate_target(&workspace_id, &agent_id)?;
    let browser = match plugin.as_str() {
        "browser" => true,
        "computer" => false,
        _ => return Err("Unknown built-in Plugin.".into()),
    };
    let authority = state.authority_for(&workspace_id, &agent_id)?;
    let ticket = if browser {
        authority.begin_browser(expected_generation)?
    } else {
        authority.begin_agent(expected_generation)?
    };
    let snapshot = super::computer_snapshot(&state, workspace_id.clone(), agent_id.clone())?;
    if snapshot.lifecycle == "ready" {
        return ticket.finish(Ok(snapshot));
    }
    if snapshot.lifecycle != "unprovisioned" || !snapshot.browser_available {
        return Err(snapshot.message.unwrap_or_else(|| {
            "Start the computer and explicitly return control before continuing.".into()
        }));
    }
    let scope = state.scope(&workspace_id, &agent_id)?;
    super::ensure_browser_session(
        state.inner().clone(),
        scope,
        Some((expected_generation, browser)),
    )
    .await?;
    ticket.finish(super::computer_snapshot(&state, workspace_id, agent_id))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuiltinPlugins {
    pub browser: bool,
    pub computer: bool,
}

impl BuiltinPlugins {
    fn bits(&self) -> u8 {
        u8::from(self.browser) | (u8::from(self.computer) << 1)
    }
    pub(super) fn from_bits(bits: u8) -> Self {
        Self {
            browser: bits & BROWSER != 0,
            computer: bits & COMPUTER != 0,
        }
    }
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
            bits: Arc::new(AtomicU8::new(saved.bits())),
            update: Mutex::new(()),
        })
    }
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self {
            bits: Arc::new(AtomicU8::new(3)),
            update: Mutex::new(()),
        }
    }
    pub fn snapshot(&self) -> BuiltinPlugins {
        BuiltinPlugins::from_bits(self.bits.load(Ordering::Acquire))
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
    let flag = match plugin.as_str() {
        "browser" => BROWSER,
        "computer" => COMPUTER,
        _ => return Err("Unknown built-in Plugin.".into()),
    };
    let state = state.inner().clone();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _update = state
            .plugins
            .update
            .lock()
            .map_err(|_| "Plugin settings are unavailable.")?;
        state.ensure_open()?;
        let old = state.plugins.bits.load(Ordering::Acquire);
        let next = if enabled { old | flag } else { old & !flag };
        if next == old {
            return Ok(state.plugins.snapshot());
        }
        // Persist before enabling. Disable admission before revoking every admitted ticket.
        if !enabled {
            state.plugins.bits.store(next, Ordering::Release);
        }
        let saved = crate::store::write_private_workspace_document(
            &state.root.join("plugins.json"),
            &scope.private,
            &BuiltinPlugins::from_bits(next),
        );
        let mut failure = None;
        if !enabled {
            let authorities = state
                .authorities
                .lock()
                .map_err(|_| "Computer authority is unavailable.")?
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for authority in authorities {
                let result = authority.pause_for_shutdown().and_then(|generation| {
                    authority.drain(generation, std::time::Duration::from_secs(15))?;
                    authority
                        .complete_transition(generation, LocalComputerController::Paused)
                        .map(|_| ())
                });
                if let Err(error) = result {
                    failure = Some(error);
                }
            }
            super::viewer::close_all(&app);
        }
        if !saved? {
            return Err("Encrypted Plugin settings are unavailable.".into());
        }
        if enabled {
            state.plugins.bits.store(next, Ordering::Release);
        }
        if let Some(error) = failure {
            return Err(format!(
                "Plugin disabled. Computer cleanup needs attention: {error}"
            ));
        }
        Ok(state.plugins.snapshot())
    })
    .await
    .map_err(|_| "Plugin settings could not be updated.".to_string())?
}
