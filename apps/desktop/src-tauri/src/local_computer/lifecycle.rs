//! User-controlled stop/restart/update and conservative idle suspension.
//! The Linux system container is replaceable; both home volumes and Workspace
//! are retained. Idle sleep freezes application memory rather than discarding it.

use super::{
    container, ComputerScope, LocalComputerController, LocalComputerSnapshot, LocalComputerState,
};
use serde::Deserialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const IDLE_AFTER: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleAction {
    Stop,
    Restart,
    Update,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    action: LifecycleAction,
}

fn gate(state: &LocalComputerState, scope: &ComputerScope) -> Result<Arc<Mutex<()>>, String> {
    Ok(state
        .launch_gates
        .lock()
        .map_err(|_| "The computer lifecycle is unavailable.")?
        .entry(scope.key.clone())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn forget_session(state: &LocalComputerState, scope: &ComputerScope) -> Result<(), String> {
    let old = state
        .sessions
        .lock()
        .map_err(|_| "The computer session is unavailable.")?
        .remove(&scope.key);
    drop(old);
    Ok(())
}

#[tauri::command]
pub async fn local_computer_lifecycle(
    window: tauri::WebviewWindow,
    request: LifecycleRequest,
    state: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<LocalComputerSnapshot, String> {
    if window.label() != "main" {
        return Err("Use Computer options in Fable to manage this computer.".into());
    }
    state.validate_target(&request.workspace_id, &request.agent_id)?;
    let state = state.inner().clone();
    let scope = state.scope(&request.workspace_id, &request.agent_id)?;
    let authority = state.authority_for(&request.workspace_id, &request.agent_id)?;
    // Revoke before waiting on a long launch or browser operation.
    let generation = authority.revoke(request.expected_generation)?;
    let execution_state = state.clone();
    let execution_scope = scope.clone();
    let action = request.action;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let gate = gate(&execution_state, &execution_scope)?;
            let _guard = gate
                .lock()
                .map_err(|_| "The computer lifecycle is unavailable.")?;
            // A sleeping desktop must wake briefly for its root supervisor to
            // drain jobs. Authority remains revoked throughout this operation.
            container::wake_owned(&execution_scope)?;
            if container::status(&execution_scope).running {
                super::cancel_external_operations(&execution_scope)?;
            }
            authority.drain(generation, Duration::from_secs(20))?;
            // An admitted GUI launcher can finish starting while the first
            // cancellation drains. After drain no admitted launcher remains.
            if container::status(&execution_scope).running {
                super::cancel_external_operations(&execution_scope)?;
            }
            forget_session(&execution_state, &execution_scope)?;
            container::stop_owned(&execution_scope, action == LifecycleAction::Update)?;
            if action != LifecycleAction::Stop {
                super::ensure_scope_directories(&execution_scope)?;
                container::ensure_running(&execution_scope, &execution_state.image_context)?;
            }
            authority.complete_transition(generation, LocalComputerController::Paused)?;
            Ok::<_, String>(())
        })();
        if result.is_err() {
            authority.abandon_transition(generation);
        }
        result
    })
    .await
    .map_err(|_| "The computer lifecycle task stopped. Control remains paused.".to_string())??;
    if request.action != LifecycleAction::Stop {
        super::ensure_browser_session(state.clone(), scope, None).await?;
    }
    super::computer_snapshot(&state, request.workspace_id, request.agent_id)
}

fn suspend_idle(state: &LocalComputerState) {
    let authorities = match state.authorities.lock() {
        Ok(authorities) => authorities
            .iter()
            .map(|(key, authority)| (key.clone(), authority.clone()))
            .collect::<Vec<_>>(),
        Err(_) => return,
    };
    for (key, authority) in authorities {
        // Snapshot expires abandoned human leases even when their conversation
        // is no longer mounted and no renderer status poll is running.
        let Ok(current) = authority.snapshot() else {
            continue;
        };
        if !authority.is_idle_for(IDLE_AFTER) {
            continue;
        }
        if super::viewer::has_active_viewer(&key) {
            continue;
        }
        if current.transitioning || current.controller == LocalComputerController::Human {
            continue;
        }
        let scope = ComputerScope {
            computer_id: format!("local-{}", &key[..24]),
            directory: state.root.join(&key),
            key,
        };
        let Ok(gate) = gate(state, &scope) else {
            continue;
        };
        let Ok(_guard) = gate.try_lock() else {
            continue;
        };
        let status = container::status(&scope);
        if !status.running || status.suspended {
            continue;
        }
        // Last activity is checked atomically with revocation. A viewer opening
        // after the earlier check refreshes activity under the same authority.
        let Ok(Some(generation)) = authority.revoke_if_idle(current.generation, IDLE_AFTER) else {
            continue;
        };
        let result = (|| {
            super::cancel_external_operations(&scope)?;
            authority.drain(generation, Duration::from_secs(20))?;
            super::cancel_external_operations(&scope)?;
            forget_session(state, &scope)?;
            container::suspend_owned(&scope)?;
            authority.complete_transition(generation, LocalComputerController::Paused)?;
            Ok::<_, String>(())
        })();
        if result.is_err() {
            authority.abandon_transition(generation);
        }
    }
}

/// Runs only while this native process is alive. No background-continuation
/// promise survives app exit, Windows sleep, or Docker engine shutdown.
pub(crate) fn start_idle_monitor(state: Arc<LocalComputerState>) {
    let weak = Arc::downgrade(&state);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(state) = weak.upgrade() else {
                break;
            };
            let _ = tauri::async_runtime::spawn_blocking(move || suspend_idle(&state)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Docker/WSL; creates and removes only labelled test resources"]
    fn real_stop_sleep_restart_and_update_preserve_workspace_and_home() {
        let root = tempfile::tempdir().unwrap();
        let state = LocalComputerState::for_test(root.path().join("computers"));
        let scope = state
            .scope("lifecycle-test", &format!("agent-{}", std::process::id()))
            .unwrap();
        super::super::ensure_scope_directories(&scope).unwrap();
        struct Cleanup(ComputerScope);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = container::cleanup_test_computer(&self.0);
            }
        }
        let _cleanup = Cleanup(scope.clone());
        container::ensure_running(&scope, &state.image_context).unwrap();
        std::fs::write(
            scope.directory.join("workspace/kept.txt"),
            "persistent workspace",
        )
        .unwrap();
        let cancellation = Arc::new(std::sync::atomic::AtomicBool::new(false));
        container::run_shell_cancellable(
            &scope,
            "printf 'persistent home' > /home/agent/kept.txt",
            cancellation.clone(),
        )
        .unwrap();
        container::suspend_owned(&scope).unwrap();
        assert!(container::status(&scope).suspended);
        container::ensure_running(&scope, &state.image_context).unwrap();
        assert!(!container::status(&scope).suspended);
        container::stop_owned(&scope, false).unwrap();
        assert!(!container::status(&scope).running);
        container::ensure_running(&scope, &state.image_context).unwrap();
        container::stop_owned(&scope, true).unwrap();
        assert!(!container::status(&scope).container_exists);
        container::ensure_running(&scope, &state.image_context).unwrap();
        assert_eq!(
            std::fs::read_to_string(scope.directory.join("workspace/kept.txt")).unwrap(),
            "persistent workspace"
        );
        let result =
            container::run_shell_cancellable(&scope, "cat /home/agent/kept.txt", cancellation)
                .unwrap();
        assert_eq!(result.stdout, "persistent home");
    }
}
