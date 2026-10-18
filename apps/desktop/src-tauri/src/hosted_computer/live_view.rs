//! Native-only live-view secret retention and expiry.

use super::*;
use chrono::Utc;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

struct LiveViewHandle {
    url: String,
    expires_at: chrono::DateTime<Utc>,
}

pub(super) fn live_view_handles() -> &'static Mutex<HashMap<String, LiveViewHandle>> {
    static HANDLES: OnceLock<Mutex<HashMap<String, LiveViewHandle>>> = OnceLock::new();
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn live_view_key(workspace_id: &str, agent_id: &str, device_id: &str) -> String {
    format!("{workspace_id}\0{agent_id}\0{device_id}")
}

pub(super) fn store_live_view(
    workspace_id: &str,
    agent_id: &str,
    device_id: &str,
    url: String,
) -> Result<(), String> {
    validate_live_view_url(&url)?;
    let mut handles = live_view_handles()
        .lock()
        .map_err(|_| "The cloud browser Live View session is unavailable.".to_string())?;
    // One native secret at a time. A later snapshot for another hosted
    // workspace must not leave the previous takeover URL reachable.
    handles.clear();
    handles.insert(
        live_view_key(workspace_id, agent_id, device_id),
        LiveViewHandle {
            url,
            expires_at: Utc::now()
                + chrono::Duration::from_std(LIVE_VIEW_TTL).unwrap_or(chrono::Duration::minutes(5)),
        },
    );
    Ok(())
}

pub(super) fn live_view_handle(
    workspace_id: &str,
    agent_id: &str,
    device_id: &str,
) -> Option<String> {
    let Ok(mut handles) = live_view_handles().lock() else {
        return None;
    };
    let key = live_view_key(workspace_id, agent_id, device_id);
    let now = Utc::now();
    match handles.get(&key) {
        Some(handle) if handle.expires_at > now => Some(handle.url.clone()),
        Some(_) => {
            handles.remove(&key);
            None
        }
        None => None,
    }
}

pub(super) fn retain_live_view_for_frontend(
    mut snapshot: HostedBrowserSnapshot,
    workspace_id: &str,
    agent_id: &str,
    device_id: &str,
) -> HostedBrowserSnapshot {
    if let Some(url) = snapshot.live_view_url.take() {
        let _ = store_live_view(workspace_id, agent_id, device_id, url);
    }
    snapshot.takeover_available = live_view_handle(workspace_id, agent_id, device_id).is_some();
    snapshot.live_view_url = None;
    snapshot
}

pub(super) fn live_view_url_for_open(target: HostedBrowserTarget) -> Result<String, String> {
    let target = normalize_browser_target(target)?;
    require_matching_hosted_scope(&target.workspace_id, Some(&target.device_id))?;
    let url = live_view_handle(&target.workspace_id, &target.agent_id, &target.device_id)
        .ok_or_else(|| "The cloud browser Live View session is no longer available.".to_string())?;
    validate_live_view_url(&url)?;
    Ok(url)
}
