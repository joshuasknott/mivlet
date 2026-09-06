//! Read-only desktop streaming. The guest gateway credential stays native.
//! A short-lived loopback capability serves only the decoder and its video;
//! keyboard/pointer input continues through Fable's native authority commands.

use super::{container, LocalComputerState};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as UpstreamMessage};

const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;
const VIEW_LIFETIME: Duration = Duration::from_secs(30 * 60);
static VIEWERS: OnceLock<Mutex<HashMap<String, Arc<Viewer>>>> = OnceLock::new();

pub(crate) fn close_all(app: &tauri::AppHandle) {
    let viewers = VIEWERS
        .get_or_init(Default::default)
        .lock()
        .map(|mut views| views.drain().map(|(_, viewer)| viewer).collect::<Vec<_>>())
        .unwrap_or_default();
    for viewer in viewers {
        viewer.disconnect();
        if let Some(window) = app.get_webview_window(&format!("computer-{}", viewer.scope_key)) {
            let _ = window.close();
        }
    }
}

pub(super) fn has_active_viewer(scope_key: &str) -> bool {
    VIEWERS
        .get_or_init(Default::default)
        .lock()
        .map(|views| views.get(scope_key).is_some_and(|viewer| viewer.valid()))
        .unwrap_or(true)
}

struct Viewer {
    id: String,
    scope_key: String,
    workspace_id: String,
    agent_id: String,
    generation: AtomicU64,
    origin: String,
    gateway: container::GatewayEndpoint,
    computers: Arc<LocalComputerState>,
    active: AtomicBool,
    started: Instant,
}

impl Viewer {
    fn valid(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && self.started.elapsed() < VIEW_LIFETIME
            && self
                .computers
                .validate_viewer_generation(
                    &self.workspace_id,
                    &self.agent_id,
                    self.generation.load(Ordering::Acquire),
                )
                .is_ok()
    }
    fn disconnect(&self) {
        if !self.active.swap(false, Ordering::AcqRel) {
            return;
        }
        let _ = self.computers.pause_disconnected_viewer(
            &self.workspace_id,
            &self.agent_id,
            self.generation.load(Ordering::Acquire),
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewerRequest {
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerProjection {
    session_id: String,
    #[serde(skip_serializing)]
    url: String,
    generation: u64,
}

#[tauri::command]
pub async fn local_computer_open_viewer(
    window: tauri::WebviewWindow,
    request: ViewerRequest,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
) -> Result<ViewerProjection, String> {
    if window.label() != "main" {
        return Err("Open the computer from Fable.".into());
    }
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    let label = format!("computer-{}", scope.key);
    let projection = open_viewer(computers.inner().clone(), request).await?;
    let url =
        url::Url::parse(&projection.url).map_err(|_| "Viewer address unavailable.".to_string())?;
    if let Some(existing) = window.app_handle().get_webview_window(&label) {
        existing
            .navigate(url)
            .map_err(|_| "Fable could not reconnect the viewer.".to_string())?;
        existing
            .set_focus()
            .map_err(|_| "Fable could not focus the viewer.".to_string())?;
    } else {
        let navigation_scope = scope.key.clone();
        let viewer_window = tauri::WebviewWindowBuilder::new(
            window.app_handle(),
            label,
            tauri::WebviewUrl::External(url),
        )
        .title("Fable computer")
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 480.0)
        .on_navigation(move |target| {
            VIEWERS
                .get_or_init(Default::default)
                .lock()
                .ok()
                .is_some_and(|views| {
                    views.get(&navigation_scope).is_some_and(|viewer| {
                        target.origin().ascii_serialization() == viewer.origin
                            && target.path() == format!("/{}/index.html", viewer.id)
                    })
                })
        })
        .build()
        .map_err(|_| "Fable could not open its computer viewer.".to_string())?;
        let scope_key = scope.key;
        viewer_window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(views) = VIEWERS.get_or_init(Default::default).lock() {
                    if let Some(viewer) = views.get(&scope_key) {
                        viewer.disconnect();
                    }
                }
            }
        });
    }
    Ok(projection)
}

async fn open_viewer(
    computers: Arc<LocalComputerState>,
    request: ViewerRequest,
) -> Result<ViewerProjection, String> {
    computers
        .authority_for(&request.workspace_id, &request.agent_id)?
        .note_viewer_activity(request.expected_generation)?;
    computers.validate_target(&request.workspace_id, &request.agent_id)?;
    computers.validate_viewer_generation(
        &request.workspace_id,
        &request.agent_id,
        request.expected_generation,
    )?;
    let scope = computers.scope(&request.workspace_id, &request.agent_id)?;
    let scope_key = scope.key.clone();
    let gateway = tauri::async_runtime::spawn_blocking(move || container::gateway_endpoint(&scope))
        .await
        .map_err(|_| "The computer stream could not start.".to_string())??;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Fable could not open its local viewer.".to_string())?;
    let origin = format!(
        "http://127.0.0.1:{}",
        listener
            .local_addr()
            .map_err(|_| "Viewer address unavailable.")?
            .port()
    );
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a private viewer.".to_string())?;
    let id = hex::encode(bytes);
    let viewer = Arc::new(Viewer {
        id: id.clone(),
        scope_key: scope_key.clone(),
        workspace_id: request.workspace_id,
        agent_id: request.agent_id,
        generation: AtomicU64::new(request.expected_generation),
        origin: origin.clone(),
        gateway,
        computers,
        active: AtomicBool::new(true),
        started: Instant::now(),
    });
    {
        let mut views = VIEWERS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Viewer registry unavailable.".to_string())?;
        if let Some(previous) = views.insert(scope_key, viewer.clone()) {
            // Replacing a viewer does not yield control; only the current stream can disconnect it.
            previous.active.store(false, Ordering::Release);
        }
    }
    let router = Router::new()
        .route("/{cap}/index.html", get(index))
        .route("/{cap}/app.js", get(script))
        .route("/{cap}/viewer/{*asset}", get(asset))
        .route("/{cap}/websockify", get(socket))
        .route("/{cap}/state", get(status))
        .route("/{cap}/control", post(control))
        .route("/{cap}/input", post(input))
        .with_state(viewer.clone());
    tauri::async_runtime::spawn(async move {
        let stop = viewer.clone();
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                while stop.active.load(Ordering::Acquire)
                    && stop.started.elapsed() < VIEW_LIFETIME
                    && stop
                        .computers
                        .validate_target(&stop.workspace_id, &stop.agent_id)
                        .is_ok()
                {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                stop.disconnect();
            })
            .await;
        if let Ok(mut views) = VIEWERS.get_or_init(Default::default).lock() {
            if views
                .get(&viewer.scope_key)
                .is_some_and(|active| active.id == viewer.id)
            {
                views.remove(&viewer.scope_key);
            }
        }
    });
    Ok(ViewerProjection {
        session_id: id.clone(),
        url: format!("{origin}/{id}/index.html"),
        generation: request.expected_generation,
    })
}

#[tauri::command]
pub fn local_computer_close_viewer(
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Close the computer from Fable.".into());
    }
    let views = VIEWERS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Viewer registry unavailable.".to_string())?;
    if let Some(viewer) = views.values().find(|viewer| viewer.id == session_id) {
        viewer.disconnect();
    }
    Ok(())
}

fn allowed(viewer: &Viewer, cap: &str, headers: &HeaderMap) -> bool {
    cap == viewer.id
        && viewer.active.load(Ordering::Acquire)
        && viewer.started.elapsed() < VIEW_LIFETIME
        && headers.get(header::HOST).and_then(|v| v.to_str().ok())
            == viewer.origin.strip_prefix("http://")
        && headers
            .get(header::ORIGIN)
            .is_none_or(|value| value.to_str().ok() == Some(viewer.origin.as_str()))
}

fn reply(content: impl Into<Body>, kind: &str) -> Response {
    Response::builder().header(header::CONTENT_TYPE, kind).header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer")
        .header("content-security-policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; worker-src 'self' blob:; frame-ancestors 'none'")
        .body(content.into()).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn index(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !allowed(&viewer, &cap, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    reply(include_str!("viewer.html"), "text/html; charset=utf-8")
}
async fn script(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !allowed(&viewer, &cap, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    reply(include_str!("viewer.js"), "text/javascript; charset=utf-8")
}
fn asset_type(path: &str) -> Option<&'static str> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains("..")
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-.".contains(&b))
    {
        return None;
    }
    match path.rsplit('.').next()? {
        "js" => Some("text/javascript"),
        "wasm" => Some("application/wasm"),
        "css" => Some("text/css"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}
async fn asset(
    State(viewer): State<Arc<Viewer>>,
    Path((cap, path)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(kind) = asset_type(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !allowed(&viewer, &cap, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let url = format!(
        "{}/{}/viewer/{path}",
        viewer.gateway.origin, viewer.gateway.token
    );
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
    else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let Ok(result) = client.get(url).send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if !result.status().is_success() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut stream = result.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return StatusCode::BAD_GATEWAY.into_response();
        };
        if bytes.len() + chunk.len() > MAX_ASSET_BYTES {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        bytes.extend_from_slice(&chunk);
    }
    if !viewer.valid() {
        return StatusCode::FORBIDDEN.into_response();
    }
    reply(bytes, kind)
}
#[derive(Deserialize)]
struct Epoch {
    generation: u64,
}
async fn socket(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    Query(epoch): Query<Epoch>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !allowed(&viewer, &cap, &headers)
        || !viewer.valid()
        || epoch.generation != viewer.generation.load(Ordering::Acquire)
        || headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(viewer.origin.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.protocols(["binary"])
        .max_message_size(MAX_ASSET_BYTES)
        .on_upgrade(move |socket| relay(viewer, socket, epoch.generation))
}
async fn relay(viewer: Arc<Viewer>, mut socket: WebSocket, generation: u64) {
    let url = format!(
        "{}/{}/websockify",
        viewer.gateway.origin.replacen("http://", "ws://", 1),
        viewer.gateway.token
    );
    let Ok(mut request) = url.into_client_request() else {
        viewer.disconnect();
        return;
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        header::HeaderValue::from_static("binary"),
    );
    let upstream = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await;
    let Ok(Ok((mut upstream, _))) = upstream else {
        // A transient stream failure revokes human input but keeps this private
        // viewer's status/reconnect endpoint available for explicit recovery.
        let _ = viewer.computers.pause_disconnected_viewer(
            &viewer.workspace_id,
            &viewer.agent_id,
            generation,
        );
        return;
    };
    let mut timer = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            _ = timer.tick() => { if !viewer.valid() || viewer.generation.load(Ordering::Acquire) != generation { break; } }
            item = socket.recv() => {
                if !viewer.valid() || viewer.generation.load(Ordering::Acquire) != generation { break; }
                let message = match item {
                    Some(Ok(Message::Binary(bytes))) => UpstreamMessage::Binary(bytes),
                    Some(Ok(Message::Text(text))) => UpstreamMessage::Text(text.as_str().into()),
                    Some(Ok(Message::Ping(_)|Message::Pong(_))) => continue,
                    _ => break,
                };
                if !matches!(tokio::time::timeout(Duration::from_secs(1), upstream.send(message)).await, Ok(Ok(()))) { break; }
            }
            item = upstream.next() => {
                if !viewer.valid() || viewer.generation.load(Ordering::Acquire) != generation { break; }
                let message = match item {
                    Some(Ok(UpstreamMessage::Binary(bytes))) if bytes.len() <= MAX_ASSET_BYTES => Message::Binary(bytes),
                    Some(Ok(UpstreamMessage::Text(text))) if text.len() <= MAX_ASSET_BYTES => Message::Text(text.as_str().into()),
                    Some(Ok(UpstreamMessage::Ping(_)|UpstreamMessage::Pong(_))) => continue,
                    _ => break,
                };
                if !matches!(tokio::time::timeout(Duration::from_secs(1), socket.send(message)).await, Ok(Ok(()))) { break; }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close()).await;
    let _ = tokio::time::timeout(Duration::from_secs(1), upstream.close(None)).await;
    if viewer.generation.load(Ordering::Acquire) == generation {
        let _ = viewer.computers.pause_disconnected_viewer(
            &viewer.workspace_id,
            &viewer.agent_id,
            generation,
        );
    }
}

async fn status(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !allowed(&viewer, &cap, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if viewer
        .computers
        .validate_target(&viewer.workspace_id, &viewer.agent_id)
        .is_err()
    {
        viewer.disconnect();
        return StatusCode::FORBIDDEN.into_response();
    }
    match viewer
        .computers
        .authority_for(&viewer.workspace_id, &viewer.agent_id)
        .and_then(|a| a.snapshot())
    {
        Ok(state) => {
            viewer.generation.store(state.generation, Ordering::Release);
            reply(json!({"generation": state.generation,"controller":state.controller,"transitioning":state.transitioning,"leaseExpiresAt":state.lease_expires_at}).to_string(), "application/json")
        }
        Err(_) => StatusCode::CONFLICT.into_response(),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlBody {
    generation: u64,
    controller: super::LocalComputerController,
}
async fn control(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    headers: HeaderMap,
    Json(body): Json<ControlBody>,
) -> Response {
    if !allowed(&viewer, &cap, &headers)
        || headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(viewer.origin.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if body.generation != viewer.generation.load(Ordering::Acquire) {
        return StatusCode::CONFLICT.into_response();
    }
    let request = super::LocalComputerControlRequest {
        workspace_id: viewer.workspace_id.clone(),
        agent_id: viewer.agent_id.clone(),
        controller: body.controller,
        expected_generation: body.generation,
    };
    match super::change_controller(viewer.computers.clone(), request).await {
        Ok(snapshot) => {
            viewer
                .generation
                .store(snapshot.generation, Ordering::Release);
            reply(
                json!({"generation":snapshot.generation,"controller":snapshot.controller})
                    .to_string(),
                "application/json",
            )
        }
        Err(error) => (StatusCode::CONFLICT, Json(json!({"error":error}))).into_response(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputBody {
    generation: u64,
    input: Value,
}
async fn input(
    State(viewer): State<Arc<Viewer>>,
    Path(cap): Path<String>,
    headers: HeaderMap,
    Json(body): Json<InputBody>,
) -> Response {
    if !allowed(&viewer, &cap, &headers)
        || headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(viewer.origin.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if body.generation != viewer.generation.load(Ordering::Acquire) {
        return StatusCode::CONFLICT.into_response();
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        viewer
            .computers
            .validate_target(&viewer.workspace_id, &viewer.agent_id)?;
        let ticket = viewer
            .computers
            .authority_for(&viewer.workspace_id, &viewer.agent_id)?
            .begin_human(body.generation)?;
        let scope = viewer
            .computers
            .scope(&viewer.workspace_id, &viewer.agent_id)?;
        ticket.check()?;
        container::desktop_input(&scope, &body.input)?;
        ticket.renew_human()?;
        ticket.finish(Ok(()))
    })
    .await;
    match result {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        _ => (
            StatusCode::CONFLICT,
            Json(json!({"error":"Input stopped. Refresh the computer and check who has control."})),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_asset_paths_cannot_reach_control_endpoints_or_escape() {
        assert_eq!(asset_type("core/rfb.js"), Some("text/javascript"));
        for path in [
            "../cdp",
            "core/%2e%2e/gateway-token",
            "core\\rfb.js",
            "/etc/passwd",
            "vnc.html",
            "core/rfb.js?token=other",
            "../rfb.js",
        ] {
            assert!(asset_type(path).is_none(), "{path}");
        }
    }
    #[test]
    fn viewer_capability_requires_exact_loopback_host_and_origin() {
        let temporary = tempfile::tempdir().unwrap();
        let viewer = Viewer {
            id: "test-capability".into(),
            scope_key: "test".into(),
            workspace_id: "workspace".into(),
            agent_id: "agent".into(),
            generation: AtomicU64::new(1),
            origin: "http://127.0.0.1:12345".into(),
            gateway: container::GatewayEndpoint {
                origin: "http://127.0.0.1:12346".into(),
                token: "test-credential".into(),
            },
            computers: Arc::new(LocalComputerState::for_test(temporary.path().to_path_buf())),
            active: AtomicBool::new(true),
            started: Instant::now(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:12345".parse().unwrap());
        assert!(allowed(&viewer, "test-capability", &headers));
        assert!(!allowed(&viewer, "wrong-capability", &headers));
        headers.insert(header::ORIGIN, "https://untrusted.example".parse().unwrap());
        assert!(!allowed(&viewer, "test-capability", &headers));
        headers.insert(header::ORIGIN, "null".parse().unwrap());
        assert!(!allowed(&viewer, "test-capability", &headers));
        headers.insert(header::ORIGIN, "http://127.0.0.1:12345".parse().unwrap());
        assert!(allowed(&viewer, "test-capability", &headers));
        headers.insert(header::HOST, "localhost:12345".parse().unwrap());
        assert!(!allowed(&viewer, "test-capability", &headers));
        headers.insert(header::HOST, "127.0.0.1:12345".parse().unwrap());
        viewer.active.store(false, Ordering::Release);
        assert!(!allowed(&viewer, "test-capability", &headers));
    }
}
