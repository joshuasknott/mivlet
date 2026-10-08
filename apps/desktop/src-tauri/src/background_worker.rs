//! Account-scoped native execution owner. The renderer is a client, never a
//! lifetime owner of background Work. No network listener or host shell exists.
mod control;
pub(crate) mod dispatch;
mod persistence;
#[cfg(windows)]
mod windows;

pub(crate) use control::revoke;
pub use control::{background_worker_control, background_worker_status};
pub(crate) use persistence::enabled_at;
pub(crate) use persistence::{enabled, owns_attempt, owns_work};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

const PROTOCOL: u32 = 1;
static WORKER: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_worker() -> bool {
    WORKER.load(Ordering::Acquire)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    pub running: bool,
    pub protocol: u32,
    pub version: String,
    pub process_id: Option<u32>,
    pub active_work: usize,
}

/// A live OS handle, not a PID file, is the cross-process ownership fence.
pub(crate) fn owner_alive() -> bool {
    if is_worker() {
        return true;
    }
    #[cfg(windows)]
    if let Ok(root) = crate::account_session::root() {
        return windows::owner_alive(root);
    }
    false
}

pub(crate) fn ready() -> bool {
    #[cfg(windows)]
    if let Ok(root) = crate::account_session::root() {
        return windows::ready(root);
    }
    false
}

/// Acquire the same owner fence before recovering a dead process. A new
/// process cannot race this reconciliation and dispatch the same queued Work.
pub(crate) fn recover_if_stopped(store: &crate::store::Store) -> Result<(), String> {
    #[cfg(windows)]
    {
        let root = crate::account_session::root()?;
        match windows::lock(root) {
            Ok(_lock) => {
                crate::collaboration::background::recover(store).map_err(|e| e.to_string())
            }
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32) =>
            {
                Ok(())
            }
            Err(_) => Err("Background ownership could not be checked.".into()),
        }
    }
    #[cfg(not(windows))]
    crate::collaboration::background::recover(store).map_err(|e| e.to_string())
}

/// Hold the owner fence throughout destructive maintenance, including file
/// replacement. A concurrently requested worker cannot acquire this scope.
pub(crate) fn maintenance_guard() -> Result<Option<std::fs::File>, String> {
    #[cfg(windows)]
    return windows::lock(crate::account_session::root()?).map(Some)
        .map_err(|_| "Stop the background worker in General settings before restoring or deleting local data.".into());
    #[cfg(not(windows))]
    Ok(None)
}

/// The same packaged executable starts a headless Tauri event runtime. Clearing
/// the configured windows prevents even a hidden WebView/React execution loop.
pub fn run(account: String) {
    #[cfg(not(windows))]
    {
        let _ = account;
        return;
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        WORKER.store(true, Ordering::Release);
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default()
            .setup(move |app| {
                let handle = app.handle().clone();
                if !crate::account_session::initialize(&handle)?
                    || crate::account_session::binding()? != account
                {
                    return Err("The background account session changed.".into());
                }
                let root = crate::account_session::root()?;
                let owner = windows::Owner::acquire(root)?;
                crate::store::initialize(root)?;
                let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
                if !enabled(store)? {
                    return Err("Background execution is disabled.".into());
                }
                persistence::capture_generation(store)?;
                // Every process incarnation fences its predecessor before any
                // provider starts. Even an abrupt kill never replays an attempt.
                crate::collaboration::background::recover(store)?;
                let computers = std::sync::Arc::new(
                    crate::local_computer::LocalComputerState::initialize(&handle)?,
                );
                app.manage(computers);
                app.manage(crate::local_schedules::LocalScheduleDispatchCoordinator::default());
                tauri::async_runtime::spawn(async move {
                    let _owner = owner;
                    // Named pipes register with Tokio's reactor, so construct
                    // them inside the runtime rather than the Tauri setup thread.
                    let Ok(server) = windows::server(root) else {
                        handle.exit(1);
                        return;
                    };
                    let Ok(_ready) = windows::ready_lock(root) else {
                        handle.exit(1);
                        return;
                    };
                    let serving = windows::serve(handle.clone(), server);
                    let executing = dispatch::run(handle.clone());
                    tokio::join!(serving, executing);
                    crate::native_api::shutdown_account();
                    crate::codex_app_server::shutdown_all_runs();
                    crate::embedded_agent::shutdown_all();
                    crate::managed_runtime::shutdown_account();
                    if let Some(store) = crate::store::try_global() {
                        let _ = crate::collaboration::background::recover(store);
                    }
                    handle.exit(0);
                });
                Ok(())
            })
            .build(context)
            .expect("The native background owner could not start.");
        app.run(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    }
}

pub(crate) fn stopping() -> bool {
    STOP.load(Ordering::Acquire)
}
pub(crate) fn stop() {
    STOP.store(true, Ordering::Release);
}

pub(crate) fn local_status() -> Result<Status, String> {
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    Ok(Status {
        supported: cfg!(windows),
        enabled: enabled(store)?,
        running: is_worker(),
        protocol: PROTOCOL,
        version: env!("CARGO_PKG_VERSION").into(),
        process_id: is_worker().then(std::process::id),
        active_work: dispatch::active_count(),
    })
}
