use serde::Serialize;

#[derive(Serialize)]
struct RuntimeStatus {
    permission_mode: &'static str,
    offline_ready: bool,
    connector_boundaries: [&'static str; 7],
}

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        permission_mode: "read-only",
        offline_ready: true,
        connector_boundaries: [
            "local-files",
            "github",
            "google-drive",
            "slack",
            "notion",
            "linear",
            "vercel",
        ],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![runtime_status])
        .run(tauri::generate_context!())
        .expect("failed to run Praxis desktop runtime");
}
