//! OS notification dispatch + deep-link emission. Bodies arrive already-shaped
//! from the TS layer (generic, no private content — the notification-privacy
//! boundary); Rust only delivers them via the platform notification center and
//! emits the click deep-link so the shell can navigate to the relevant run.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// A delivery request. `deep_link_page`/`run_id` drive click navigation.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverNotificationRequest {
    pub id: String,
    pub title: String,
    pub body: String,
    pub deep_link_page: Option<String>,
    pub run_id: Option<String>,
}

/// Show an OS notification. Delivery is not a click: navigation is intentionally
/// left to a genuine platform activation callback when that callback is
/// available. The previous implementation incorrectly emitted a click here.
#[tauri::command]
pub fn deliver_notification(
    app: AppHandle,
    request: DeliverNotificationRequest,
) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&request.title)
        .body(&request.body)
        .show()
        .map_err(|e| format!("Could not show notification: {e}"))?;

    Ok(())
}
