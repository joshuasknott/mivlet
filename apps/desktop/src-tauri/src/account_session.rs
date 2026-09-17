//! One authenticated account per native process. The process never retargets a
//! store, credential namespace or child profile after dispatch has been admitted.
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::Manager;

static ACCOUNT: OnceLock<String> = OnceLock::new();
static ROOT: OnceLock<PathBuf> = OnceLock::new();
static CLOSING: AtomicBool = AtomicBool::new(false);

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<bool, String> {
    let Ok(identity) = crate::clerk_identity::native_identity_generation_snapshot() else {
        return Ok(false);
    };
    let root = crate::paths::installation_data_dir(app)?
        .join("accounts")
        .join(&identity.account_binding);
    if crate::paths::contains_symlink(&root) {
        return Err("Account storage cannot contain symbolic links or junctions.".into());
    }
    std::fs::create_dir_all(&root).map_err(|_| "Could not prepare account storage.")?;
    let root = crate::paths::strict_canonicalize(&root).map_err(|e| e.to_string())?;
    ACCOUNT
        .set(identity.account_binding)
        .map_err(|_| "Account already initialized.")?;
    ROOT.set(root)
        .map_err(|_| "Account storage already initialized.")?;
    Ok(true)
}

pub(crate) fn binding() -> Result<&'static str, String> {
    ACCOUNT
        .get()
        .map(String::as_str)
        .ok_or_else(|| "Sign in to open your Mivlet account workspace.".into())
}

pub(crate) fn root() -> Result<&'static Path, String> {
    ROOT.get()
        .map(PathBuf::as_path)
        .ok_or_else(|| "Sign in to open your Mivlet account files.".into())
}

fn check(expected: &str, actual: &str, closing: bool) -> Result<(), String> {
    if closing || expected != actual {
        Err("The account session ended. New activity is blocked until Mivlet restarts.".into())
    } else {
        Ok(())
    }
}

pub(crate) fn ensure_current() -> Result<(), String> {
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    check(
        binding()?,
        &identity.account_binding,
        CLOSING.load(Ordering::Acquire),
    )
}

pub(crate) fn credential_key(key: &str) -> Result<String, String> {
    // Deliberately pinned, including a late completion: never resolve a new
    // account's namespace from mutable identity after an await.
    ensure_current()?;
    Ok(format!("{}:{key}", binding()?))
}

pub(crate) fn principals() -> Result<(String, String), String> {
    let account = binding()?;
    Ok((format!("account-{account}"), format!("member-{account}")))
}

pub(crate) fn public_command(command: &str) -> bool {
    matches!(
        command,
        "identity_status"
            | "identity_refresh"
            | "identity_begin_sign_in"
            | "identity_begin_recovery"
            | "identity_sign_out"
            | "control_main_window"
            | "account_workspace_status"
            | "account_workspace_clear_session"
    )
}

pub(crate) fn guard(
    handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool,
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !public_command(invoke.message.command()) {
            if let Err(error) = ensure_current() {
                invoke.resolver.reject(error);
                return true;
            }
        }
        handler(invoke)
    }
}

pub(crate) fn start_watchdog(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let needs_restart = if ACCOUNT.get().is_some() {
                ensure_current().is_err()
            } else {
                // A startup status refresh can renew an expired credential.
                // Admit its workspace only in a fresh process, just like OAuth.
                crate::clerk_identity::native_identity_generation_snapshot().is_ok()
            };
            if needs_restart {
                restart(app).await;
                break;
            }
        }
    });
}

pub(crate) async fn restart(app: tauri::AppHandle) {
    if CLOSING.swap(true, Ordering::AcqRel) {
        return;
    }
    // Hide and destroy the WebView before a different account may be admitted:
    // this drops microphones, audio, JS callbacks, query caches and drafts in RAM.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.destroy();
    }
    crate::native_api::shutdown_account();
    crate::codex_app_server::shutdown_all_runs();
    crate::managed_runtime::shutdown_account();
    crate::antigravity_acp::shutdown_account();
    crate::embedded_agent::shutdown_all();
    crate::embedded_mcp::shutdown_all();
    if let Some(computers) =
        app.try_state::<std::sync::Arc<crate::local_computer::LocalComputerState>>()
    {
        crate::local_computer::shutdown_all(computers.inner().clone()).await;
    }
    if let Some(store) = crate::store::try_global() {
        // Persist suspension even if identity expired. This only accesses the
        // outgoing process's store; no new account can be activated here.
        if let Err(error) = store.suspend_account() {
            // Do not activate another account if durable suspension failed.
            eprintln!("Account schedule suspension failed: {error}");
            app.exit(1);
            return;
        }
    }
    app.restart();
}

#[tauri::command]
pub fn account_theme(value: Option<String>) -> Result<String, String> {
    ensure_current()?;
    let store = crate::store::try_global().ok_or("Account storage unavailable.")?;
    store
        .transaction(|conn| {
            let scope = crate::store::repos::scope::DataScope::legacy_default();
            if let Some(value) = value {
                if !matches!(value.as_str(), "light" | "dark") {
                    return Err(crate::store::StoreError::Invalid("Invalid theme.".into()));
                }
                crate::store::repos::preferences::upsert_scoped(
                    conn,
                    store,
                    &scope,
                    "theme",
                    &serde_json::json!(value),
                    &chrono::Utc::now().to_rfc3339(),
                )?;
            }
            Ok(
                crate::store::repos::preferences::get_scoped(conn, store, &scope, "theme")?
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "light".into()),
            )
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transitions_reject_other_accounts_and_all_late_dispatch() {
        assert!(check("a", "a", false).is_ok());
        assert!(check("a", "b", false).is_err());
        assert!(check("a", "a", true).is_err());
        assert!(check("a", "b", true).is_err());
    }
    #[test]
    fn public_commands_cannot_access_product_or_credentials() {
        for command in [
            "save_runtime_snapshot",
            "backup_local_data",
            "prepare_local_data_restore",
            "connect_backend",
            "start_codex_browser_login",
            "collaboration_command",
            "local_schedule_dispatch_claim",
        ] {
            assert!(!public_command(command));
        }
    }
}
