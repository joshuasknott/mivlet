use super::Status;
#[cfg(windows)]
use tauri::Manager;
use tauri::WebviewWindow;

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Manage background execution from the Mivlet window.".into());
    }
    crate::account_session::ensure_current()
}

#[tauri::command]
pub async fn background_worker_status(window: WebviewWindow) -> Result<Status, String> {
    require_main(&window)?;
    #[cfg(windows)]
    if super::owner_alive() {
        return super::windows::request(super::windows::Action::Status).await;
    }
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    super::recover_if_stopped(store)?;
    super::local_status()
}

#[tauri::command]
pub async fn background_worker_control(
    window: WebviewWindow,
    action: String,
) -> Result<Status, String> {
    require_main(&window)?;
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        return Err("Choose Start, Stop or Restart for background execution.".into());
    }
    #[cfg(not(windows))]
    {
        Err("Background execution requires Windows.".into())
    }
    #[cfg(windows)]
    {
        let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
        if action != "start" {
            // Revoke admission before asking the live process to release its
            // exact provider jobs. A failed IPC request never enables fallback.
            super::persistence::set_enabled(store, false)?;
            if super::owner_alive() {
                super::windows::request(super::windows::Action::Stop).await?;
                for _ in 0..80 {
                    if !super::owner_alive() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                if super::owner_alive() {
                    return Err("Background execution is paused, but its process has not exited. Reconnect before restarting.".into());
                }
            }
            super::recover_if_stopped(store)?;
            if action == "stop" {
                return super::local_status();
            }
        }
        crate::execution_control::ensure_active_execution_allowed()?;
        let _handoff = super::commands::handoff_fence()?;
        if !super::owner_alive() {
            window
                .state::<std::sync::Arc<crate::local_computer::LocalComputerState>>()
                .prepare_background_owner()?;
        }
        super::persistence::set_enabled(store, true)?;
        if !super::owner_alive() {
            use std::os::windows::process::CommandExt;
            let exe = std::env::current_exe()
                .map_err(|_| "The installed Mivlet executable is unavailable.")?;
            let mut child = std::process::Command::new(exe)
                .arg("--mivlet-background-worker")
                .arg(crate::account_session::binding()?)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                // No privilege change, host shell, startup registration or job
                // breakaway. Windows containment policy can refuse detachment.
                .creation_flags(
                    windows_sys::Win32::System::Threading::DETACHED_PROCESS
                        | windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP,
                )
                .spawn()
                .map_err(|_| "Windows could not start Mivlet's background worker.")?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            for _ in 0..100 {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                if let Ok(status) = super::windows::request(super::windows::Action::Status).await {
                    return Ok(status);
                }
                if child
                    .try_wait()
                    .map_err(|_| "Background startup could not be inspected.")?
                    .is_some()
                {
                    return Err("The background worker exited during startup. Repair Mivlet or check the account session; no work was dispatched.".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            return Err("Background startup has not acknowledged ownership. New background work remains blocked until it connects.".into());
        }
        super::windows::request(super::windows::Action::Status).await
    }
}

/// Account changes revoke the worker before a new account enters the UI.
pub(crate) async fn revoke() {
    if let Some(store) = crate::store::try_global() {
        let _ = super::persistence::set_enabled(store, false);
    }
    #[cfg(windows)]
    if !super::is_worker() && super::owner_alive() {
        let _ = super::windows::request(super::windows::Action::Stop).await;
    }
}
