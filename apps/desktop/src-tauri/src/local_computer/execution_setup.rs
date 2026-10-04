use serde::Serialize;
use tauri::WebviewWindow;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionStatus {
    available: bool,
    message: Option<String>,
}
#[tauri::command]
pub async fn native_execution_status(window: WebviewWindow) -> Result<ExecutionStatus, String> {
    if window.label() != "main" {
        return Err("Native execution setup belongs to the main window.".into());
    }
    #[cfg(windows)]
    let result = tauri::async_runtime::spawn_blocking(|| {
        mivlet_windows_executor::setup::ready()
            .and_then(|_| super::coding::process::execution_resources())
            .and_then(|p| mivlet_windows_executor::verify_runtime(&p))
            .map(|_| ())
    })
    .await
    .map_err(|_| "Native execution inspection was interrupted.".to_owned())?;
    #[cfg(not(windows))]
    let result: Result<(), String> = Err("Native execution requires Windows x64.".into());
    Ok(ExecutionStatus {
        available: result.is_ok(),
        message: result.err(),
    })
}
#[tauri::command]
pub async fn native_execution_setup(window: WebviewWindow, cleanup: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Native execution setup belongs to the main window.".into());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        mivlet_windows_executor::setup::request_elevation(cleanup)
    })
    .await
    .map_err(|_| "Native setup was interrupted.".to_owned())?;
    #[cfg(not(windows))]
    {
        let _ = cleanup;
        Err("Native execution requires Windows x64.".into())
    }
}
