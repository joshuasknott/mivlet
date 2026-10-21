//! Native-only policy for an Instabox desktop viewer.
//!
//! The bearer stream URL never belongs in a React snapshot, command result, or
//! transcript. This module mints a view-only stream, validates it before opening
//! a child WebView, fences navigation, and revokes the stream on close.
//!
//! Instabox's own desktop control has a 30-second timeout handback.  That is a
//! provider safety feature, not Mivlet ownership.  The local fence below does
//! not infer ownership from that provider event, and an observed handback must
//! not resume agent input.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use url::Url;

#[cfg(test)]
mod viewer_tests;
mod viewer_validation;

/// The smallest stream window Mivlet requests.  Short links reduce the impact
/// of a URL accidentally copied from a native diagnostic surface.
pub(crate) const STREAM_TTL_SECONDS: u32 = 60;

const MAX_STREAM_URL_BYTES: usize = 4096;
const MAX_FRAGMENT_BYTES: usize = 2048;
const MACHINE_ID_BYTES: usize = 28; // `m_` + 26 lowercase base32 characters
const STREAM_ORIGIN: &str = "https://api.instabox.sh";
const VIEWER_LABEL: &str = "instabox-desktop-viewer";
const MAX_VIEWER_WIDTH: u32 = 4096;
const MAX_VIEWER_HEIGHT: u32 = 2160;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RevokeState {
    NotRequested,
    Pending,
    Acknowledged,
    Unconfirmed,
}

/// A native-only stream descriptor.  It deliberately has no `Serialize` or
/// `Debug` implementation, so a bearer URL cannot enter snapshots or logs by
/// accidental structural serialization.
pub(crate) struct ValidatedStream {
    url: String,
    expires_at: DateTime<Utc>,
    navigation: NavigationPolicy,
}

impl ValidatedStream {
    /// The only accessor intended for the native child WebView opener.
    pub(crate) fn open_url(&self) -> &str {
        &self.url
    }

    pub(crate) fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }

    pub(crate) fn navigation_policy(&self) -> &NavigationPolicy {
        &self.navigation
    }
}

/// A strict allowlist for the stream's own viewer document.  External origins,
/// `javascript:`/`data:`/`file:` URLs and child-window navigations are refused.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NavigationPolicy {
    origin: String,
    path: String,
    fragment_raw: String,
}

impl NavigationPolicy {
    pub(crate) fn allows(&self, uri: &str) -> bool {
        let Ok(candidate) = Url::parse(uri) else {
            return false;
        };
        if candidate.origin().ascii_serialization() != self.origin
            || candidate.path() != self.path
            || candidate.username() != ""
            || candidate.password().is_some()
            || candidate.query().is_some()
        {
            return false;
        }
        // The stream token lives in the fragment.  Keep it opaque and never
        // let a child navigation replace it with another fragment.
        candidate
            .as_str()
            .split_once('#')
            .is_some_and(|(_, fragment)| fragment == self.fragment_raw)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ViewerSnapshot {
    pub generation: u64,
    pub closed: bool,
    pub revoke: RevokeState,
}

/// Local ownership and revocation fence.  It is intentionally independent of
/// the provider's 30-second timeout handback.
pub(crate) struct ViewerFence {
    generation: u64,
    closed: bool,
    revoke: RevokeState,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewerOpenRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub expected_revision: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewerMachineRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewerResizeRequest {
    pub workspace_id: String,
    pub machine_id: String,
    pub generation: u64,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ViewerStatusRequest {
    pub workspace_id: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewerPublicState {
    pub open: bool,
    pub machine_id: Option<String>,
    pub generation: Option<u64>,
    pub revoke: Option<&'static str>,
    pub expires_at: Option<String>,
}

struct ActiveViewer {
    workspace_id: String,
    connection_revision: u64,
    credential_name: String,
    account_user_id: Option<i64>,
    machine_id: String,
    key: Arc<crate::protected_secrets::Secret>,
    expires_at: DateTime<Utc>,
    fence: ViewerFence,
}

static ACTIVE_VIEWER: OnceLock<Mutex<Option<ActiveViewer>>> = OnceLock::new();
static OPEN_SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn active_viewer() -> &'static Mutex<Option<ActiveViewer>> {
    ACTIVE_VIEWER.get_or_init(|| Mutex::new(None))
}

fn open_serial() -> &'static tokio::sync::Mutex<()> {
    OPEN_SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn next_viewer_generation() -> Result<u64, String> {
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    (generation > 0).then_some(generation).ok_or_else(|| {
        "Computer viewer generation exhausted; restart Mivlet before opening another viewer.".into()
    })
}

fn require_workspace(workspace_id: &str) -> Result<(), String> {
    if workspace_id.trim().is_empty() {
        return Err("Instabox workspace context is required.".into());
    }
    let scope = super::scope()?;
    if scope.workspace_id() != workspace_id {
        return Err("The active workspace changed. Reopen the Instabox computer viewer.".into());
    }
    Ok(())
}

fn public_state(active: Option<&ActiveViewer>) -> ViewerPublicState {
    let Some(active) = active else {
        return ViewerPublicState::default();
    };
    let snapshot = active.fence.snapshot();
    ViewerPublicState {
        open: !snapshot.closed,
        machine_id: Some(active.machine_id.clone()),
        generation: Some(snapshot.generation),
        revoke: Some(match snapshot.revoke {
            RevokeState::NotRequested => "notRequested",
            RevokeState::Pending => "pending",
            RevokeState::Acknowledged => "acknowledged",
            RevokeState::Unconfirmed => "unconfirmed",
        }),
        expires_at: Some(active.expires_at.to_rfc3339()),
    }
}

fn validate_bounds(
    window: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if x < 0
        || y < 0
        || !(240..=MAX_VIEWER_WIDTH).contains(&width)
        || !(240..=MAX_VIEWER_HEIGHT).contains(&height)
    {
        return Err("Instabox desktop viewer bounds are outside the native panel limits.".into());
    }
    let scale = window
        .scale_factor()
        .map_err(|_| "The native window scale is unavailable.".to_string())?;
    let inner = window
        .inner_size()
        .map_err(|_| "The native window size is unavailable.".to_string())?;
    let inner_width = (f64::from(inner.width) / scale).floor() as u32;
    let inner_height = (f64::from(inner.height) / scale).floor() as u32;
    let right = u32::try_from(x)
        .ok()
        .and_then(|left| left.checked_add(width));
    let bottom = u32::try_from(y)
        .ok()
        .and_then(|top| top.checked_add(height));
    if right.map_or(true, |right| right > inner_width)
        || bottom.map_or(true, |bottom| bottom > inner_height)
    {
        return Err("Instabox desktop viewer must remain inside the main window.".into());
    }
    Ok(())
}

fn selected_machine(saved: &super::SavedConnection, machine_id: &str) -> Result<(), String> {
    if saved.selected_machine_id.as_deref() != Some(machine_id) {
        return Err("Select this exact Instabox computer before opening its desktop.".into());
    }
    Ok(())
}

fn revalidate_open_binding(
    request: &ViewerOpenRequest,
    fence: &super::AccountDispatchFence,
    credential_name: &str,
    account_user_id: Option<i64>,
) -> Result<(), String> {
    fence.with_current(|| {
        require_workspace(&request.workspace_id)?;
        let scope = super::scope()?;
        let saved = super::check_revision(&scope, request.expected_revision)?;
        selected_machine(&saved, &request.machine_id)?;
        if saved.account_user_id != account_user_id {
            return Err("The Instabox account changed while opening the desktop viewer.".into());
        }
        if super::key_name()? != credential_name {
            return Err("The Instabox credential changed while opening the desktop viewer.".into());
        }
        if super::native_key(credential_name)?.is_none() {
            return Err("The Instabox credential is no longer available.".into());
        }
        Ok(())
    })
}

async fn mint_stream(machine_id: &str, key: &str) -> Result<ValidatedStream, String> {
    let path = format!("/v1/machines/{machine_id}/desktop/stream");
    let response = super::api_request(
        reqwest::Method::POST,
        &path,
        key,
        Some(json!({"viewOnly": true, "ttlSeconds": STREAM_TTL_SECONDS})),
        None,
    )
    .await?;
    let url = response
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Instabox did not return a desktop stream URL.")?;
    let expires_at = response
        .get("expiresAt")
        .and_then(Value::as_str)
        .ok_or("Instabox did not return a desktop stream expiry.")?
        .parse::<DateTime<Utc>>()
        .map_err(|_| "Instabox returned an invalid desktop stream expiry.")?;
    viewer_validation::validate_stream(machine_id, STREAM_ORIGIN, url, expires_at, Utc::now())
}

async fn revoke_stream(machine_id: &str, key: &str) -> Result<(), String> {
    // DELETE returns no JSON in the documented HTTP contract, while the
    // shared lifecycle helper expects JSON. Keep this path native and bounded.
    let path = format!("/v1/machines/{machine_id}/desktop/stream");
    let url = super::endpoint(&path)?;
    let response = super::client()?
        .delete(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-API-Key", key)
        .send()
        .await
        .map_err(|_| "Instabox could not be reached to revoke the desktop stream.".to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(super::map_status(response.status()))
}

/// Close the native child and revoke its short-lived bearer link before a
/// lifecycle operation or credential disconnect removes the API key.
/// Hold the returned guard until the lifecycle or selection change is committed
/// so another viewer cannot open with the old binding in between.
pub(crate) async fn close_for_lifecycle(
    window: &tauri::WebviewWindow,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let serial = open_serial().lock().await;
    let (machine_id, generation, key) = {
        let active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        let Some(active) = active.as_ref() else {
            return Ok(serial);
        };
        (
            active.machine_id.clone(),
            active.fence.snapshot().generation,
            active.key.clone(),
        )
    };
    {
        let mut active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        let current = active
            .as_mut()
            .ok_or("The native Instabox viewer state disappeared.")?;
        current.fence.begin_close(generation)?;
    }
    let child_result = close_child(window);
    let revoke_result = revoke_stream(&machine_id, key.as_str()).await;
    let mut active = active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
    let current = active
        .as_mut()
        .ok_or("The native Instabox viewer state disappeared.")?;
    if child_result.is_err() {
        current.fence.mark_revoke_unconfirmed();
    }
    if revoke_result.is_ok() {
        current.fence.acknowledge_revoke();
    } else {
        current.fence.mark_revoke_unconfirmed();
    }
    if revoke_result.is_ok() && child_result.is_ok() {
        *active = None;
        Ok(serial)
    } else {
        Err("The viewer is fenced locally, but Instabox did not acknowledge complete stream closure.".into())
    }
}

fn close_child(window: &tauri::WebviewWindow) -> Result<(), String> {
    if let Some(webview) = window.get_webview(VIEWER_LABEL) {
        webview
            .close()
            .map_err(|_| "The native Instabox viewer could not be closed.".to_string())?;
    }
    Ok(())
}

fn retain_unconfirmed_stream(
    request: &ViewerOpenRequest,
    credential_name: String,
    account_user_id: Option<i64>,
    key: Arc<crate::protected_secrets::Secret>,
    machine_id: String,
    expires_at: DateTime<Utc>,
) -> Result<(), String> {
    let generation = next_viewer_generation()?;
    let mut fence = ViewerFence::new(generation)?;
    fence.begin_close(generation)?;
    fence.mark_revoke_unconfirmed();
    let viewer = ActiveViewer {
        workspace_id: request.workspace_id.clone(),
        connection_revision: request.expected_revision,
        credential_name,
        account_user_id,
        machine_id,
        key,
        expires_at,
        fence,
    };
    *active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())? = Some(viewer);
    Ok(())
}

fn check_machine_request(request: &ViewerMachineRequest) -> Result<super::SavedConnection, String> {
    require_workspace(&request.workspace_id)?;
    viewer_validation::validate_machine_id(&request.machine_id)?;
    let scope = super::scope()?;
    let saved = super::read_saved(&scope)?;
    selected_machine(&saved, &request.machine_id)?;
    Ok(saved)
}

#[tauri::command]
pub(crate) async fn cloud_computer_viewer_open(
    window: tauri::WebviewWindow,
    request: ViewerOpenRequest,
) -> Result<ViewerPublicState, String> {
    super::require_main(&window)?;
    let _serial = open_serial().lock().await;
    require_workspace(&request.workspace_id)?;
    viewer_validation::validate_machine_id(&request.machine_id)?;
    validate_bounds(&window, request.x, request.y, request.width, request.height)?;
    {
        let active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        if active.is_some() {
            return Err("Close the current Instabox desktop viewer before opening another.".into());
        }
    }
    let fence = super::AccountDispatchFence::capture()?;
    let scope = super::scope()?;
    let saved = super::check_revision(&scope, request.expected_revision)?;
    selected_machine(&saved, &request.machine_id)?;
    let credential_name = super::key_name()?;
    let Some(key) = super::native_key(&credential_name)? else {
        return Err("Connect Instabox before opening its desktop.".into());
    };
    let key = Arc::new(key);
    let account_user_id = saved.account_user_id;
    let machines = super::fetch_machines(key.as_str()).await?;
    fence.with_current(|| Ok(()))?;
    let machine = machines
        .iter()
        .find(|machine| machine.id == request.machine_id)
        .ok_or("That Instabox computer is not available to this account.")?;
    if machine.status != "running" {
        return Err(
            "Start or resume the selected Instabox computer before opening its desktop.".into(),
        );
    }
    let generation = next_viewer_generation()?;
    let stream = mint_stream(&request.machine_id, key.as_str()).await?;
    if let Err(error) = revalidate_open_binding(&request, &fence, &credential_name, account_user_id)
    {
        if revoke_stream(&request.machine_id, key.as_str())
            .await
            .is_err()
        {
            retain_unconfirmed_stream(
                &request,
                credential_name,
                account_user_id,
                key,
                request.machine_id.clone(),
                stream.expires_at(),
            )?;
            return Err(
                "The viewer was not opened and Instabox did not acknowledge stream revocation; retry stop viewing."
                    .into(),
            );
        }
        return Err(error);
    }
    let expected_url = Url::parse(stream.open_url())
        .map_err(|_| "Instabox returned an invalid desktop stream URL.");
    let expected_url = match expected_url {
        Ok(url) => url,
        Err(error) => {
            if revoke_stream(&request.machine_id, key.as_str())
                .await
                .is_err()
            {
                retain_unconfirmed_stream(
                    &request,
                    credential_name,
                    account_user_id,
                    key,
                    request.machine_id.clone(),
                    stream.expires_at(),
                )?;
                return Err(
                    "The viewer was not opened and Instabox did not acknowledge stream revocation; retry stop viewing."
                        .into(),
                );
            }
            return Err(error.to_string());
        }
    };
    let policy = stream.navigation_policy().clone();
    let builder = WebviewBuilder::new(VIEWER_LABEL, WebviewUrl::External(expected_url))
        .on_navigation(move |url| policy.allows(url.as_str()))
        .on_new_window(|_url, _features| NewWindowResponse::Deny);
    let child = window
        .as_ref()
        .window()
        .add_child(
            builder,
            LogicalPosition::new(request.x, request.y),
            LogicalSize::new(request.width, request.height),
        )
        .map_err(|_| "The native Instabox viewer could not be created.".to_string());
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            // A child that failed after minting must not leave a live bearer
            // link behind. Retain native metadata when remote revocation is
            // uncertain so the caller can retry with the original key.
            if revoke_stream(&request.machine_id, key.as_str())
                .await
                .is_err()
            {
                retain_unconfirmed_stream(
                    &request,
                    credential_name,
                    account_user_id,
                    key,
                    request.machine_id.clone(),
                    stream.expires_at(),
                )?;
                return Err(
                    "The viewer was not opened and Instabox did not acknowledge stream revocation; retry stop viewing."
                        .into(),
                );
            }
            return Err(error);
        }
    };
    let _ = child;
    let viewer = ActiveViewer {
        workspace_id: request.workspace_id,
        connection_revision: request.expected_revision,
        credential_name,
        account_user_id,
        machine_id: request.machine_id,
        key,
        expires_at: stream.expires_at(),
        fence: ViewerFence::new(generation)?,
    };
    let state = public_state(Some(&viewer));
    *active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())? = Some(viewer);
    Ok(state)
}

#[tauri::command]
pub(crate) async fn cloud_computer_viewer_close(
    window: tauri::WebviewWindow,
    request: ViewerMachineRequest,
) -> Result<ViewerPublicState, String> {
    super::require_main(&window)?;
    let _serial = open_serial().lock().await;
    require_workspace(&request.workspace_id)?;
    viewer_validation::validate_machine_id(&request.machine_id)?;
    let (machine_id, key) = {
        let mut active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        let Some(active) = active.as_mut() else {
            close_child(&window)?;
            return Ok(ViewerPublicState::default());
        };
        if active.machine_id != request.machine_id {
            return Err("The requested viewer does not own this Instabox computer.".into());
        }
        active.fence.begin_close(request.generation)?;
        (active.machine_id.clone(), active.key.clone())
    };
    // Local input is fenced before the remote revoke is attempted. Closing a
    // WebView does not itself revoke a bearer stream, so report the remote
    // result explicitly and never imply immediate server-side closure.
    let child_result = close_child(&window);
    let revoke_result = revoke_stream(&machine_id, key.as_str()).await;
    let mut active = active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
    let Some(current) = active.as_mut() else {
        return Err("The native Instabox viewer state disappeared.".into());
    };
    if child_result.is_err() {
        current.fence.mark_revoke_unconfirmed();
    }
    match revoke_result {
        Ok(()) => current.fence.acknowledge_revoke(),
        Err(_) => current.fence.mark_revoke_unconfirmed(),
    }
    let state = public_state(Some(current));
    if revoke_result.is_err() {
        return Err(
            "The viewer closed locally, but Instabox did not acknowledge stream revocation.".into(),
        );
    }
    if child_result.is_err() {
        return Err(
            "Instabox stream revocation succeeded, but the native viewer could not be closed."
                .into(),
        );
    }
    *active = None;
    Ok(state)
}

#[tauri::command]
pub(crate) fn cloud_computer_viewer_resize(
    window: tauri::WebviewWindow,
    request: ViewerResizeRequest,
) -> Result<ViewerPublicState, String> {
    super::require_main(&window)?;
    check_machine_request(&ViewerMachineRequest {
        workspace_id: request.workspace_id.clone(),
        machine_id: request.machine_id.clone(),
        generation: request.generation,
    })?;
    validate_bounds(&window, request.x, request.y, request.width, request.height)?;
    let mut active = active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
    let current = active
        .as_mut()
        .ok_or("Open the selected Instabox desktop before resizing it.")?;
    if current.machine_id != request.machine_id {
        return Err("The requested viewer does not own this Instabox computer.".into());
    }
    let snapshot = current.fence.snapshot();
    if snapshot.generation != request.generation {
        return Err("Computer viewer generation is stale.".into());
    }
    if snapshot.closed {
        return Err("Computer viewer is closed.".into());
    }
    let webview = window
        .get_webview(VIEWER_LABEL)
        .ok_or("The native Instabox viewer is no longer open.")?;
    webview
        .set_position(LogicalPosition::new(request.x, request.y))
        .and_then(|_| webview.set_size(LogicalSize::new(request.width, request.height)))
        .map_err(|_| "The native Instabox viewer could not be resized.".to_string())?;
    Ok(public_state(Some(current)))
}

#[tauri::command]
pub(crate) async fn cloud_computer_viewer_status(
    window: tauri::WebviewWindow,
    request: ViewerStatusRequest,
) -> Result<ViewerPublicState, String> {
    super::require_main(&window)?;
    let active_workspace_changed = {
        let scope = super::scope()?;
        let active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        active
            .as_ref()
            .is_some_and(|active| active.workspace_id != scope.workspace_id())
    };
    if active_workspace_changed {
        drop(close_for_lifecycle(&window).await?);
    }
    require_workspace(&request.workspace_id)?;
    let stale_binding = {
        let scope = super::scope()?;
        let saved = super::read_saved(&scope)?;
        let credential_name = super::key_name()?;
        let active = active_viewer()
            .lock()
            .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
        active.as_ref().is_some_and(|active| {
            active.workspace_id != request.workspace_id
                || active.connection_revision != saved.connection_revision
                || active.credential_name != credential_name
                || active.account_user_id != saved.account_user_id
        })
    };
    if stale_binding {
        // Use the credential captured when the bearer stream was minted. A
        // newly selected account must never be used to revoke an old stream.
        drop(close_for_lifecycle(&window).await?);
    }
    let active = active_viewer()
        .lock()
        .map_err(|_| "The native Instabox viewer is unavailable.".to_string())?;
    Ok(public_state(active.as_ref()))
}

impl ViewerFence {
    pub(crate) fn new(generation: u64) -> Result<Self, String> {
        if generation == 0 {
            return Err("Computer viewer generation is invalid.".into());
        }
        Ok(Self {
            generation,
            closed: false,
            revoke: RevokeState::NotRequested,
        })
    }

    pub(crate) fn snapshot(&self) -> ViewerSnapshot {
        ViewerSnapshot {
            generation: self.generation,
            closed: self.closed,
            revoke: self.revoke,
        }
    }

    /// Fence locally before asking the provider to revoke the bearer link.
    /// `Pending` is visible to the caller until `acknowledge_revoke` arrives.
    pub(crate) fn begin_close(&mut self, generation: u64) -> Result<ViewerSnapshot, String> {
        if generation != self.generation {
            return Err("Computer viewer generation is stale.".into());
        }
        if self.closed {
            if matches!(
                self.revoke,
                RevokeState::Unconfirmed | RevokeState::Acknowledged
            ) {
                self.revoke = RevokeState::Pending;
                return Ok(self.snapshot());
            }
            return Err("Computer viewer is already closed.".into());
        }
        self.generation = next_viewer_generation()?;
        self.closed = true;
        self.revoke = RevokeState::Pending;
        Ok(self.snapshot())
    }

    pub(crate) fn acknowledge_revoke(&mut self) {
        if self.revoke == RevokeState::Pending {
            self.revoke = RevokeState::Acknowledged;
        }
    }

    pub(crate) fn mark_revoke_unconfirmed(&mut self) {
        if self.revoke == RevokeState::Pending {
            self.revoke = RevokeState::Unconfirmed;
        }
    }
}
