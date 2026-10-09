//! Dedicated, ephemeral origin for MCP App HTML resources.
//!
//! MCP Apps are untrusted HTML supplied by a connected server.  They must not
//! be turned into a `srcdoc` document in the renderer because that document
//! inherits the renderer's policy and, on some WebView versions, can observe
//! more of the parent environment than intended.  This module serves one
//! opaque, short lived resource through an ephemeral loopback HTTP listener.
//! Keeping this origin outside Tauri's registered custom protocols is a
//! security boundary: Tauri classifies those protocols as local on Windows.
//!
//! The protocol is deliberately read-only.  App-to-host messages still use
//! the official AppBridge channel and are validated in the TypeScript host;
//! this listener only supplies the initial HTML document.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[cfg(windows)]
use tauri::webview::PlatformWebview;

#[cfg(windows)]
use webview2_com::{
    take_pwstr, FrameCreatedEventHandler, FrameDestroyedEventHandler,
    FrameNavigationStartingEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Frame, ICoreWebView2Frame2, ICoreWebView2_4,
    },
};

#[cfg(windows)]
use windows::core::{Interface, PWSTR};

use serde::Deserialize;
use serde_json::Value;
use tauri::http::{header, Request, Response, StatusCode};

const MAX_HTML_BYTES: usize = 5 * 1024 * 1024;
const MAX_CSP_BYTES: usize = 16 * 1024;
const RESOURCE_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_LIVE_RESOURCES: usize = 32;
const MAX_HTTP_REQUEST_BYTES: usize = 8 * 1024;
const MAX_HTTP_CONNECTIONS: usize = 8;

#[derive(Debug)]
struct ResourceEntry {
    owner_subject: String,
    workspace_id: String,
    session_id: String,
    result_id: String,
    html: Vec<u8>,
    csp: String,
    expires_at: Instant,
}

static RESOURCES: OnceLock<Mutex<HashMap<String, ResourceEntry>>> = OnceLock::new();
static HTTP_ORIGIN: OnceLock<String> = OnceLock::new();
static HTTP_SERVER_READY: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
static NAVIGATION_FENCE: OnceLock<Arc<Mutex<NavigationFence>>> = OnceLock::new();

#[cfg(windows)]
static NAVIGATION_GUARD_READY: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
static NAVIGATION_GUARD_FAILED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
#[derive(Debug, Default)]
struct NavigationFence {
    expected: HashMap<usize, String>,
}

#[cfg(windows)]
fn navigation_fence() -> Arc<Mutex<NavigationFence>> {
    NAVIGATION_FENCE
        .get_or_init(|| Arc::new(Mutex::new(NavigationFence::default())))
        .clone()
}

#[cfg(windows)]
fn mark_navigation_guard_failed() {
    NAVIGATION_GUARD_FAILED.store(true, Ordering::Release);
    NAVIGATION_GUARD_READY.store(false, Ordering::Release);
}

#[cfg(windows)]
fn allow_navigation(state: &mut NavigationFence, frame_id: usize, uri: &str) -> bool {
    match state.expected.get(&frame_id) {
        Some(expected) => expected == uri,
        None if is_registered_mcp_url(uri) => {
            state.expected.insert(frame_id, uri.to_owned());
            true
        }
        None => true,
    }
}

/// Start the resource server on an ephemeral loopback port. This intentionally
/// is not a Tauri custom protocol: registered Windows protocols are classified
/// as local by Tauri and would let a child frame reach the normal IPC bridge.
pub fn start_http_server() -> Result<(), String> {
    if HTTP_ORIGIN.get().is_some() {
        return Ok(());
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "MCP App loopback server is unavailable.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "MCP App loopback server could not be configured.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "MCP App loopback server address is unavailable.")?
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    HTTP_ORIGIN
        .set(origin.clone())
        .map_err(|_| "MCP App loopback server was initialized twice.")?;
    let connections = Arc::new(tokio::sync::Semaphore::new(MAX_HTTP_CONNECTIONS));
    tauri::async_runtime::spawn(async move {
        // Tokio's `from_std` requires an entered runtime with IO enabled;
        // perform it inside this task rather than during synchronous Tauri
        // setup, where it would panic on some runtimes.
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        HTTP_SERVER_READY.store(true, Ordering::Release);
        loop {
            let Ok((stream, _peer)) = listener.accept().await else {
                break;
            };
            let Ok(permit) = connections.clone().try_acquire_owned() else {
                continue;
            };
            let origin = origin.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let _ = serve_http_connection(stream, &origin).await;
            });
        }
    });
    Ok(())
}

fn http_origin() -> Result<&'static str, String> {
    if !HTTP_SERVER_READY.load(Ordering::Acquire) {
        return Err("MCP App loopback server is unavailable.".to_string());
    }
    HTTP_ORIGIN
        .get()
        .map(String::as_str)
        .ok_or_else(|| "MCP App loopback server is unavailable.".to_string())
}

#[cfg(windows)]
fn is_registered_mcp_url(uri: &str) -> bool {
    let Ok(origin) = http_origin() else {
        return false;
    };
    let Some(path) = uri.strip_prefix(&format!("{origin}/")) else {
        return false;
    };
    let mut segments = path.split('/');
    let Some(token) = segments.next() else {
        return false;
    };
    if segments.next() != Some("index.html") || segments.next().is_some() {
        return false;
    }
    token.len() == 64
        && token.bytes().all(|byte| byte.is_ascii_hexdigit())
        && resources()
            .lock()
            .map(|entries| entries.contains_key(token))
            .unwrap_or(false)
}

#[cfg(windows)]
fn install_frame_navigation_handlers(frame: ICoreWebView2Frame) -> windows::core::Result<()> {
    let frame_id = frame.as_raw() as usize;
    let fence = navigation_fence();
    let frame2: ICoreWebView2Frame2 = frame.cast()?;
    let navigation_handler =
        FrameNavigationStartingEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri = PWSTR::null();
            if let Err(error) = unsafe { args.Uri(&mut uri) } {
                mark_navigation_guard_failed();
                return Err(error);
            }
            let uri = take_pwstr(uri);
            let allow = match fence.lock() {
                Ok(mut state) => allow_navigation(&mut state, frame_id, &uri),
                Err(_) => {
                    mark_navigation_guard_failed();
                    false
                }
            };
            if let Err(error) = unsafe { args.SetCancel(!allow) } {
                mark_navigation_guard_failed();
                return Err(error);
            }
            Ok(())
        }));
    let mut navigation_token = 0;
    unsafe {
        frame2.add_NavigationStarting(&navigation_handler, &mut navigation_token)?;
    }

    let fence = navigation_fence();
    let destroyed_handler = FrameDestroyedEventHandler::create(Box::new(move |_sender, _args| {
        if let Ok(mut state) = fence.lock() {
            state.expected.remove(&frame_id);
        }
        Ok(())
    }));
    let mut destroyed_token = 0;
    unsafe {
        frame.add_Destroyed(&destroyed_handler, &mut destroyed_token)?;
    }
    Ok(())
}

#[cfg(windows)]
fn install_navigation_guard_on_webview(webview: &PlatformWebview) -> windows::core::Result<()> {
    let controller = webview.controller();
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2()? };
    let core4: ICoreWebView2_4 = core.cast()?;
    let frame_handler = FrameCreatedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            mark_navigation_guard_failed();
            return Ok(());
        };
        let frame = match unsafe { args.Frame() } {
            Ok(frame) => frame,
            Err(error) => {
                mark_navigation_guard_failed();
                return Err(error);
            }
        };
        if let Err(error) = install_frame_navigation_handlers(frame) {
            mark_navigation_guard_failed();
            return Err(error);
        }
        Ok(())
    }));
    let mut frame_token = 0;
    unsafe {
        core4.add_FrameCreated(&frame_handler, &mut frame_token)?;
    }
    NAVIGATION_GUARD_READY.store(true, Ordering::Release);
    Ok(())
}

#[cfg(windows)]
pub fn install_navigation_guard(window: &tauri::WebviewWindow) {
    if NAVIGATION_GUARD_READY.load(Ordering::Acquire)
        || NAVIGATION_GUARD_FAILED.load(Ordering::Acquire)
    {
        return;
    }
    let _ = window.with_webview(|webview| {
        if install_navigation_guard_on_webview(&webview).is_err() {
            mark_navigation_guard_failed();
        }
    });
}

#[cfg(windows)]
fn require_navigation_guard() -> Result<(), String> {
    if NAVIGATION_GUARD_READY.load(Ordering::Acquire)
        && !NAVIGATION_GUARD_FAILED.load(Ordering::Acquire)
    {
        Ok(())
    } else {
        Err("MCP App navigation guard is unavailable in this desktop runtime.".into())
    }
}

#[cfg(not(windows))]
fn require_navigation_guard() -> Result<(), String> {
    Err("MCP Apps are unavailable in this desktop runtime because its native child-frame navigation fence is unsupported.".into())
}

async fn serve_http_connection(
    mut stream: tokio::net::TcpStream,
    origin: &str,
) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let read = tokio::time::timeout_at(deadline, stream.read(&mut chunk))
            .await
            .map_err(|_| "MCP App request timed out.")?
            .map_err(|_| "MCP App request could not be read.")?;
        if read == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_HTTP_REQUEST_BYTES {
            let response = invalid_response("MCP App request is too large.");
            write_http_response(&mut stream, response).await?;
            return Ok(());
        }
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let request = parse_http_request(&bytes, origin);
    let response = match request {
        Ok(request) => {
            // Resource entries are keyed by the same private owner subject as
            // the account-authorized store. Never compare the raw account
            // binding with a `member:<id>` entry: doing so makes every live
            // resource look like it belongs to another account.
            let owner = current_owner_subject();
            serve_for_owner(&request, &owner)
        }
        Err(message) => invalid_response(message),
    };
    write_http_response(&mut stream, response).await
}

fn current_owner_subject() -> String {
    crate::authorized_scope::command_scope(
        Some(crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )
    .map(|scope| scope.private.owner_subject().to_owned())
    .unwrap_or_default()
}

fn parse_http_request(
    bytes: &[u8],
    origin: &str,
) -> Result<tauri::http::Request<Vec<u8>>, &'static str> {
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|offset| offset + 4)
        .ok_or("MCP App request is incomplete.")?;
    if !bytes[header_end..].is_empty() {
        return Err("MCP App request body rejected.");
    }
    let text =
        std::str::from_utf8(&bytes[..header_end]).map_err(|_| "MCP App request is invalid.")?;
    let mut lines = text.split("\r\n");
    let first = lines.next().ok_or("MCP App request is invalid.")?;
    let parts: Vec<_> = first.split_ascii_whitespace().collect();
    if parts.len() != 3 || parts[0] != "GET" || parts[2] != "HTTP/1.1" {
        return Err("MCP App request method rejected.");
    }
    let mut host = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err("MCP App request header is invalid.");
        };
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value.trim()).is_some() {
                return Err("MCP App request has duplicate hosts.");
            }
        } else if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err("MCP App request body headers rejected.");
        }
    }
    let host = host.ok_or("MCP App request host is missing.")?;
    if host != origin.strip_prefix("http://").unwrap_or_default() {
        return Err("MCP App request host rejected.");
    }
    let uri = format!("{origin}{}", parts[1]);
    tauri::http::Request::builder()
        .method(parts[0])
        .uri(uri)
        .body(Vec::new())
        .map_err(|_| "MCP App request URI rejected.")
}

async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    response: Response<Vec<u8>>,
) -> Result<(), String> {
    let status = response.status();
    let reason = match status {
        StatusCode::OK => "OK",
        StatusCode::NOT_FOUND => "Not Found",
        StatusCode::METHOD_NOT_ALLOWED => "Method Not Allowed",
        _ => "Bad Request",
    };
    let body = response.body();
    let mut output = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
        status.as_u16(),
        body.len()
    )
    .into_bytes();
    for (name, value) in response.headers() {
        output.extend_from_slice(name.as_str().as_bytes());
        output.extend_from_slice(b": ");
        output.extend_from_slice(value.as_bytes());
        output.extend_from_slice(b"\r\n");
    }
    output.extend_from_slice(b"\r\n");
    output.extend_from_slice(body);
    tokio::time::timeout(Duration::from_secs(5), stream.write_all(&output))
        .await
        .map_err(|_| "MCP App response timed out.".to_string())?
        .map_err(|_| "MCP App response could not be written.".to_string())
}

fn resources() -> &'static Mutex<HashMap<String, ResourceEntry>> {
    RESOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn conversation_belongs_to_owner(
    conn: &rusqlite::Connection,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    conversation_id: &str,
) -> crate::store::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND owner_member_id IS ?3 AND deleted_at IS NULL)",
        rusqlite::params![
            scope.data.workspace_id(),
            conversation_id,
            scope.private.owner_member_id()
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterMcpAppResourceRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub result_id: String,
    pub uri: String,
    pub html: String,
    pub csp: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseMcpAppResourceRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub result_id: String,
}

fn bounded_identity(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(|c| c.is_control()) {
        return Err(format!("MCP App {label} is invalid."));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct PersistedMcpAppDescriptor {
    connector_id: String,
    tool_name: String,
    resource_uri: String,
}

#[derive(Debug, PartialEq, Eq)]
enum PersistedMcpConnectorRoute {
    Custom(String),
    Remote(String),
}

fn is_official_remote_reference(reference: &str) -> bool {
    matches!(
        reference,
        "notion"
            | "linear"
            | "vercel"
            | "canva"
            | "figma"
            | "sentry"
            | "stripe"
            | "cloudflare"
            | "granola"
            | "atlassian-rovo"
    )
}

fn valid_custom_mcp_reference(reference: &str) -> bool {
    let mut chars = reference.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    reference.len() <= 128
        && first.is_ascii_alphanumeric()
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        && !reference.starts_with("marketplace-")
}

/// Conversation results persist the renderer connector ID. Decode that ID at
/// the native boundary into the same launch/configuration reference used by
/// the existing MCP connection repositories. This keeps resource reads bound
/// to the saved connection rather than trusting a renderer-supplied server ID.
fn persisted_mcp_connector_route(connector_id: &str) -> Result<PersistedMcpConnectorRoute, String> {
    if let Some(encoded) = connector_id.strip_prefix("mcp-") {
        if encoded.is_empty() || encoded.len() % 2 != 0 || encoded.len() > 256 {
            return Err("The MCP App connector reference is invalid.".into());
        }
        let mut bytes = Vec::with_capacity(encoded.len() / 2);
        for pair in encoded.as_bytes().as_chunks::<2>().0 {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| "The MCP App connector reference is invalid.".to_string())?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| "The MCP App connector reference is invalid.".to_string())?;
            bytes.push(((high << 4) | low) as u8);
        }
        let reference = String::from_utf8(bytes)
            .map_err(|_| "The MCP App connector reference is invalid.".to_string())?;
        if !valid_custom_mcp_reference(&reference) {
            return Err("The MCP App connector reference is invalid.".into());
        }
        return Ok(PersistedMcpConnectorRoute::Custom(reference));
    }
    if let Some(remote_reference) = connector_id.strip_prefix("marketplace-") {
        if is_official_remote_reference(remote_reference) {
            return Ok(PersistedMcpConnectorRoute::Remote(connector_id.to_string()));
        }
    } else if is_official_remote_reference(connector_id) {
        return Ok(PersistedMcpConnectorRoute::Remote(format!(
            "marketplace-{connector_id}"
        )));
    }
    Err("The MCP App connector reference is unavailable.".into())
}

/// Extract only the descriptor persisted with the selected tool result. The
/// renderer still supplies the resource HTML, but it cannot choose a
/// conversation, connector, tool, or resource URI that is absent from the
/// sealed result content.
fn persisted_mcp_app_descriptor(content: &Value) -> Result<PersistedMcpAppDescriptor, String> {
    let document = match content {
        Value::String(raw) if raw.len() <= 256 * 1024 => serde_json::from_str(raw)
            .map_err(|_| "The saved MCP App result descriptor is invalid.".to_string())?,
        Value::Object(_) => content.clone(),
        _ => return Err("The selected result has no MCP App descriptor.".into()),
    };
    let app = document
        .get("mcpApp")
        .and_then(Value::as_object)
        .ok_or_else(|| "The selected result has no MCP App descriptor.".to_string())?;
    let connector_id = app
        .get("connectorId")
        .and_then(Value::as_str)
        .ok_or_else(|| "The MCP App connector descriptor is invalid.".to_string())?;
    let tool_name = app
        .get("toolName")
        .and_then(Value::as_str)
        .ok_or_else(|| "The MCP App tool descriptor is invalid.".to_string())?;
    let resource_uri = app
        .get("resourceUri")
        .and_then(Value::as_str)
        .ok_or_else(|| "The MCP App resource descriptor is invalid.".to_string())?;
    bounded_identity(connector_id, "connector")?;
    bounded_identity(tool_name, "tool")?;
    bounded_identity(resource_uri, "resource")?;
    if connector_id.len() > 256
        || tool_name.len() > 256
        || !resource_uri.starts_with("ui://")
        || resource_uri.len() > 2_048
        || resource_uri.chars().any(|c| c.is_control())
    {
        return Err("The persisted MCP App descriptor is invalid.".into());
    }
    Ok(PersistedMcpAppDescriptor {
        connector_id: connector_id.to_string(),
        tool_name: tool_name.to_string(),
        resource_uri: resource_uri.to_string(),
    })
}

fn current_mcp_app_tool(
    conn: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
    connector_id: &str,
    tool_name: &str,
    resource_uri: &str,
) -> Result<(), crate::store::StoreError> {
    let route =
        persisted_mcp_connector_route(connector_id).map_err(crate::store::StoreError::Invalid)?;
    let details = match route {
        PersistedMcpConnectorRoute::Remote(reference) => {
            crate::store::repos::connection_record::mcp_details_for_remote(
                conn, store, scope, &reference,
            )?
        }
        PersistedMcpConnectorRoute::Custom(reference) => {
            let configuration =
                crate::store::repos::mcp_local_server::get_launch(conn, store, scope, &reference)?
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "The MCP App custom tool server is unavailable.".into(),
                        )
                    })?;
            if configuration.metadata.disabled {
                return Err(crate::store::StoreError::Invalid(
                    "The MCP App custom tool server is disabled.".into(),
                ));
            }
            if configuration.metadata.transport == "stdio" {
                crate::store::repos::connection_record::mcp_details_for_launch(
                    conn, store, scope, &reference,
                )?
            } else if configuration.metadata.transport == "streamable-http" {
                crate::store::repos::connection_record::mcp_details_for_remote(
                    conn, store, scope, &reference,
                )?
            } else {
                return Err(crate::store::StoreError::Invalid(
                    "The MCP App custom tool server transport is unavailable.".into(),
                ));
            }
        }
    };
    if details.discovery_state != "discovered"
        || !details.enabled_tools.iter().any(|name| name == tool_name)
        || !details
            .enabled_resources
            .iter()
            .any(|uri| uri == resource_uri)
    {
        return Err(crate::store::StoreError::Invalid(
            "The MCP App tool or resource is not enabled on the current Connection revision."
                .into(),
        ));
    }
    Ok(())
}

fn selected_mcp_app_result<'a>(
    rows: &'a [crate::store::repos::message::MessageRow],
    result_revision_id: &str,
) -> Option<&'a crate::store::repos::message::MessageRow> {
    rows.iter().find(|row| {
        row.kind == "tool"
            && row.current_revision_id == result_revision_id
            && row.current_revision_state == "terminal"
            && row.detail.get("phase").and_then(Value::as_str) == Some("result")
            && row.detail.get("outcome").and_then(Value::as_str) == Some("succeeded")
    })
}

fn validate_csp(csp: &str) -> Result<(), String> {
    if csp.is_empty() || csp.len() > MAX_CSP_BYTES || csp.contains(['\r', '\n']) {
        return Err("MCP App policy is invalid.".into());
    }
    // The renderer supplies a policy built from the negotiated Apps metadata.
    // Keep this native parser too: a compromised or stale renderer must not
    // register a broad policy that turns the dedicated origin into a network
    // bridge. In particular, `ipc:`, `tauri:` and `chrome.webview` are never
    // valid sources for an app document.
    let mut directives = HashMap::<String, Vec<String>>::new();
    let mut is_first_directive = true;
    for raw_directive in csp.split(';') {
        if raw_directive.trim().is_empty() {
            return Err("MCP App policy contains an empty directive.".into());
        }
        let mut tokens = raw_directive.split_whitespace();
        let Some(name) = tokens.next() else {
            return Err("MCP App policy contains an empty directive.".into());
        };
        let name = name.to_ascii_lowercase();
        if is_first_directive && name != "default-src" {
            return Err("MCP App policy must start with default-src 'none'.".into());
        }
        is_first_directive = false;
        if !matches!(
            name.as_str(),
            "default-src"
                | "script-src"
                | "style-src"
                | "img-src"
                | "font-src"
                | "media-src"
                | "connect-src"
                | "frame-src"
                | "base-uri"
                | "form-action"
                | "object-src"
                | "navigate-to"
        ) || directives.contains_key(&name)
        {
            return Err("MCP App policy contains an unsupported or duplicate directive.".into());
        }
        let values: Vec<String> = tokens.map(|token| token.to_ascii_lowercase()).collect();
        if values.is_empty() {
            return Err("MCP App policy contains an empty directive.".into());
        }
        directives.insert(name, values);
    }
    if !directives
        .get("default-src")
        .is_some_and(|values| values.len() == 1 && values[0] == "'none'")
    {
        return Err("MCP App policy must start with default-src 'none'.".into());
    }
    let allowed_keywords = ["'none'", "'self'", "'unsafe-inline'"];
    for (directive, values) in &directives {
        for value in values {
            if value == "*"
                || value.contains("chrome.webview")
                || value.starts_with("ipc:")
                || value.starts_with("tauri:")
                || value.starts_with("asset:")
                || value.starts_with("file:")
                || value.starts_with("http:")
                || value.starts_with("javascript:")
                || value.starts_with("data:text/html")
                || value == "'unsafe-eval'"
            {
                return Err("MCP App policy contains a forbidden native or broad source.".into());
            }
            if allowed_keywords.contains(&value.as_str()) {
                if value == "'unsafe-inline'"
                    && directive != "script-src"
                    && directive != "style-src"
                {
                    return Err(
                        "MCP App policy uses unsafe-inline in an unsupported directive.".into(),
                    );
                }
                continue;
            }
            if value == "data:" || value == "blob:" {
                if !matches!(directive.as_str(), "img-src" | "font-src" | "media-src") {
                    return Err(
                        "MCP App policy permits data or blob content in an unsafe directive."
                            .into(),
                    );
                }
                continue;
            }
            let origin = value
                .strip_prefix("https://")
                .or_else(|| value.strip_prefix("wss://"));
            let Some(origin) = origin else {
                return Err("MCP App policy network sources must use HTTPS or WSS origins.".into());
            };
            let origin_host = origin
                .strip_prefix("*.")
                .map(|rest| format!("wildcard.{rest}"))
                .unwrap_or_else(|| origin.to_string());
            let origin = format!("https://{origin_host}");
            let parsed = url::Url::parse(&origin)
                .map_err(|_| "MCP App policy contains an invalid network origin.")?;
            if !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err("MCP App policy origins cannot contain credentials or paths.".into());
            }
            let host = parsed.host_str().unwrap_or_default();
            if host == "localhost"
                || host.ends_with(".localhost")
                || host == "127.0.0.1"
                || host == "[::1]"
            {
                return Err("MCP App policy cannot access local or native service origins.".into());
            }
        }
    }
    if !directives.contains_key("script-src") || !directives.contains_key("connect-src") {
        return Err("MCP App policy must declare scripts and connections explicitly.".into());
    }
    if !directives
        .get("navigate-to")
        .is_some_and(|values| values.len() == 1 && values[0] == "'none'")
    {
        return Err("MCP App policy must disable guest navigation.".into());
    }
    if directives
        .get("frame-src")
        .is_some_and(|values| values.len() != 1 || values[0] != "'none'")
    {
        return Err(
            "MCP App nested frames are unavailable in this desktop host; frame-src must be 'none'."
                .into(),
        );
    }
    Ok(())
}

fn token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "MCP App randomness is unavailable.".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn invalid_response(message: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(message.as_bytes().to_vec())
        .expect("static MCP App error response is valid")
}

/// Serve only the exact opaque token path issued by `register_mcp_app_resource`.
/// This function is kept separate from the Tauri closure so it can be tested
/// without starting a WebView.
fn serve_for_owner(request: &Request<Vec<u8>>, owner_subject: &str) -> Response<Vec<u8>> {
    #[cfg(windows)]
    if NAVIGATION_GUARD_FAILED.load(Ordering::Acquire) {
        return invalid_response("MCP App navigation guard is unavailable.");
    }
    if request.method() != tauri::http::Method::GET || request.uri().query().is_some() {
        return invalid_response("MCP App resource method rejected.");
    }
    let mut parts = request.uri().path().split('/');
    let _empty = parts.next();
    let Some(resource_token) = parts.next() else {
        return invalid_response("MCP App resource not found.");
    };
    if parts.next() != Some("index.html") || parts.next().is_some() {
        return invalid_response("MCP App resource path rejected.");
    }
    if resource_token.len() != 64 || !resource_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return invalid_response("MCP App resource token rejected.");
    }

    let mut guard = resources().lock().expect("MCP App resource lock poisoned");
    let Some(entry) = guard.get(resource_token) else {
        return invalid_response("MCP App resource expired.");
    };
    if entry.owner_subject != owner_subject {
        return invalid_response("MCP App account changed.");
    }
    if Instant::now() >= entry.expires_at {
        guard.remove(resource_token);
        return invalid_response("MCP App resource expired.");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            "text/html;profile=mcp-app; charset=utf-8",
        )
        .header(header::CONTENT_SECURITY_POLICY, entry.csp.as_str())
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(entry.html.clone())
        .expect("MCP App response headers are valid")
}

#[tauri::command]
pub fn register_mcp_app_resource(
    window: tauri::WebviewWindow,
    request: RegisterMcpAppResourceRequest,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("MCP App resources may only be registered by the main window.".into());
    }
    require_navigation_guard()?;
    http_origin()?;
    for (value, label) in [
        (&request.workspace_id, "workspace"),
        (&request.session_id, "session"),
        (&request.conversation_id, "conversation"),
        (&request.result_id, "result"),
        (&request.uri, "URI"),
    ] {
        bounded_identity(value, label)?;
    }
    if !request.uri.starts_with("ui://")
        || request.uri.len() > 2_048
        || request.uri.chars().any(|c| c.is_control())
    {
        return Err("MCP App resource URI is invalid.".into());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is unavailable.")?;
    store
        .with_conn(|conn| {
            if !conversation_belongs_to_owner(conn, &scope, &request.conversation_id)? {
                return Err(crate::store::StoreError::Invalid(
                    "This MCP App conversation is no longer available to this account.".into(),
                ));
            }
            let rows = crate::store::repos::message::list_selected(
                conn,
                store,
                &scope.data,
                &request.conversation_id,
            )?;
            let row = selected_mcp_app_result(&rows, &request.result_id).ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Open an interactive result from the selected conversation branch.".into(),
                )
            })?;
            let descriptor = persisted_mcp_app_descriptor(&row.content)
                .map_err(crate::store::StoreError::Invalid)?;
            if descriptor.resource_uri != request.uri {
                return Err(crate::store::StoreError::Invalid(
                    "The MCP App resource does not belong to this saved result.".into(),
                ));
            }
            current_mcp_app_tool(
                conn,
                store,
                &scope,
                &descriptor.connector_id,
                &descriptor.tool_name,
                &descriptor.resource_uri,
            )
        })
        .map_err(|error| error.to_string())?;
    if request.html.is_empty() || request.html.len() > MAX_HTML_BYTES {
        return Err("MCP App resource exceeds the supported size.".into());
    }
    validate_csp(&request.csp)?;

    let resource_token = token()?;
    let mut guard = resources()
        .lock()
        .map_err(|_| "MCP App resources are unavailable.".to_string())?;
    let now = Instant::now();
    guard.retain(|_, entry| entry.expires_at > now);
    if guard.len() >= MAX_LIVE_RESOURCES {
        return Err("Too many interactive MCP App results are open. Close one and retry.".into());
    }
    // The renderer-created session id is only a transient teardown correlation
    // value. Authority came from the account scope, selected result descriptor
    // and current enabled MCP connection checks above; this value never grants
    // access to a different result or connector.
    guard.insert(
        resource_token.clone(),
        ResourceEntry {
            owner_subject: scope.private.owner_subject().into(),
            workspace_id: request.workspace_id,
            session_id: request.session_id,
            result_id: request.result_id,
            html: request.html.into_bytes(),
            csp: request.csp,
            expires_at: now + RESOURCE_TTL,
        },
    );
    // Keep a stable path so the host can use a single GET and AppBridge can
    // perform its initialize handshake once the document has loaded. The
    // ephemeral loopback origin remains remote to Tauri's ACL classifier.
    Ok(format!("{}/{resource_token}/index.html", http_origin()?))
}

#[tauri::command]
pub fn release_mcp_app_resource(
    window: tauri::WebviewWindow,
    request: ReleaseMcpAppResourceRequest,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("MCP App resources may only be released by the main window.".into());
    }
    crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    bounded_identity(&request.workspace_id, "workspace")?;
    bounded_identity(&request.session_id, "session")?;
    bounded_identity(&request.result_id, "result")?;
    let mut guard = resources()
        .lock()
        .map_err(|_| "MCP App resources are unavailable.".to_string())?;
    guard.retain(|_, entry| {
        !(entry.workspace_id == request.workspace_id
            && entry.session_id == request.session_id
            && entry.result_id == request.result_id)
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_http_parser_accepts_only_the_bound_origin_and_get() {
        let origin = "http://127.0.0.1:43127";
        let request = parse_http_request(
            b"GET /abc/index.html HTTP/1.1\r\nHost: 127.0.0.1:43127\r\nConnection: close\r\n\r\n",
            origin,
        )
        .unwrap();
        assert_eq!(request.uri().path(), "/abc/index.html");
        assert!(parse_http_request(
            b"POST /abc/index.html HTTP/1.1\r\nHost: 127.0.0.1:43127\r\n\r\n",
            origin,
        )
        .is_err());
        assert!(parse_http_request(
            b"GET /abc/index.html HTTP/1.1\r\nHost: 127.0.0.1:43128\r\n\r\n",
            origin,
        )
        .is_err());
        assert!(parse_http_request(
            b"GET /abc/index.html HTTP/1.1\r\nHost: 127.0.0.1:43127\r\nhOsT: 127.0.0.1:43127\r\n\r\n",
            origin,
        )
        .is_err());
        assert!(parse_http_request(
            b"GET /abc/index.html HTTP/1.1\r\nHost: 127.0.0.1:43127\r\n\r\nbody",
            origin,
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn navigation_fence_keeps_a_guest_on_its_issued_loopback_resource() {
        let origin = "http://127.0.0.1:43127";
        let token = "c".repeat(64);
        let _ = HTTP_ORIGIN.set(origin.into());
        HTTP_SERVER_READY.store(true, Ordering::Release);
        resources().lock().unwrap().insert(
            token.clone(),
            ResourceEntry {
                owner_subject: "account-owner".into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                result_id: "result".into(),
                html: b"guest".to_vec(),
                csp: "default-src 'none'".into(),
                expires_at: Instant::now() + RESOURCE_TTL,
            },
        );
        let issued = format!("{origin}/{token}/index.html");
        let mut fence = NavigationFence::default();
        assert!(allow_navigation(&mut fence, 7, &issued));
        assert!(allow_navigation(&mut fence, 7, &issued));
        assert!(!allow_navigation(
            &mut fence,
            7,
            "tauri://localhost/index.html"
        ));
        assert!(!allow_navigation(
            &mut fence,
            7,
            "http://127.0.0.1:1422/index.html"
        ));
        resources().lock().unwrap().remove(&token);
    }

    #[test]
    fn persisted_descriptor_binds_connector_tool_and_resource_uri() {
        // Message revisions persist tool output as a JSON string. Keep this
        // fixture in the same envelope used by runtime/domain/conversations,
        // rather than exercising only the native object fallback.
        let content = Value::String(
            serde_json::to_string(&serde_json::json!({
            "trust": "untrusted",
            "mcpApp": {
                "connectorId": "marketplace-example",
                "toolName": "get-time",
                "resourceUri": "ui://get-time/mcp-app.html"
            }
            }))
            .unwrap(),
        );
        assert_eq!(
            persisted_mcp_app_descriptor(&content).unwrap(),
            PersistedMcpAppDescriptor {
                connector_id: "marketplace-example".into(),
                tool_name: "get-time".into(),
                resource_uri: "ui://get-time/mcp-app.html".into(),
            }
        );
        let forged_uri = Value::String(
            serde_json::to_string(&serde_json::json!({
                "mcpApp": {
                    "connectorId": "marketplace-example",
                    "toolName": "get-time",
                    "resourceUri": "https://attacker.example/app"
                }
            }))
            .unwrap(),
        );
        assert!(persisted_mcp_app_descriptor(&forged_uri).is_err());
        let other_tool = Value::String(
            serde_json::to_string(&serde_json::json!({
                "mcpApp": {
                    "connectorId": "marketplace-example",
                    "toolName": "other-tool",
                    "resourceUri": "ui://get-time/mcp-app.html"
                }
            }))
            .unwrap(),
        );
        assert!(persisted_mcp_app_descriptor(&other_tool).is_ok());
    }

    #[test]
    fn persisted_connector_ids_resolve_to_the_saved_native_routes() {
        let custom_stdio = "mcp-6c6f63616c2d6272696566"; // local-brief
        assert_eq!(
            persisted_mcp_connector_route(custom_stdio).unwrap(),
            PersistedMcpConnectorRoute::Custom("local-brief".into())
        );
        let custom_http = "mcp-72656d6f74652d617070"; // remote-app
        assert_eq!(
            persisted_mcp_connector_route(custom_http).unwrap(),
            PersistedMcpConnectorRoute::Custom("remote-app".into())
        );
        assert_eq!(
            persisted_mcp_connector_route("vercel").unwrap(),
            PersistedMcpConnectorRoute::Remote("marketplace-vercel".into())
        );
        assert_eq!(
            persisted_mcp_connector_route("marketplace-vercel").unwrap(),
            PersistedMcpConnectorRoute::Remote("marketplace-vercel".into())
        );
        assert!(persisted_mcp_connector_route("mcp-6d61726b6574706c6163652d76657263656c").is_err());
        assert!(persisted_mcp_connector_route("marketplace-example").is_err());
        assert!(persisted_mcp_connector_route("not-a-saved-route").is_err());
    }

    fn seed_enabled_mcp_connection(
        store: &crate::store::Store,
        scope: &crate::authorized_scope::AuthorizedCommandScope,
        reference: &str,
        transport: &str,
    ) {
        let args: Vec<String> = Vec::new();
        let saved = store
            .transaction(|tx| {
                crate::store::repos::mcp_local_server::upsert(
                    tx,
                    store,
                    scope,
                    crate::store::repos::mcp_local_server::McpLocalServerWrite {
                        id: reference,
                        display_name: reference,
                        transport,
                        command: if transport == "stdio" { "node" } else { "" },
                        args: &args,
                        endpoint: if transport == "streamable-http" {
                            Some("https://mcp.example.test/mcp")
                        } else {
                            None
                        },
                        expected_revision: None,
                        updated_at: "2026-10-08T22:00:00Z",
                    },
                )
            })
            .unwrap();
        let connection = store
            .transaction(|tx| {
                if transport == "stdio" {
                    crate::store::repos::connection_record::upsert_mcp_stdio(
                        tx,
                        store,
                        scope,
                        &saved.id,
                        &saved.display_name,
                        "2026-10-08T22:00:00Z",
                    )
                } else {
                    crate::store::repos::connection_record::upsert_mcp_streamable_http(
                        tx,
                        store,
                        scope,
                        &saved.id,
                        &saved.display_name,
                        "2026-10-08T22:00:00Z",
                    )
                }
            })
            .unwrap();
        let discovered = store
            .transaction(|tx| {
                crate::store::repos::connection_record::record_mcp_discovery(
                    tx,
                    store,
                    scope,
                    &connection.id,
                    connection.revision,
                    vec!["get-time".into()],
                    vec!["ui://get-time/mcp-app.html".into()],
                    "2026-10-08T22:00:01Z",
                )
            })
            .unwrap();
        store
            .transaction(|tx| {
                crate::store::repos::connection_record::set_mcp_enablement(
                    tx,
                    store,
                    scope,
                    &discovered.connection_id,
                    discovered.connection_revision,
                    vec!["get-time".into()],
                    vec!["ui://get-time/mcp-app.html".into()],
                    Vec::new(),
                    "2026-10-08T22:00:02Z",
                )
            })
            .unwrap();
    }

    #[test]
    fn current_mcp_app_tool_uses_persisted_transport_and_canonical_remote_reference() {
        let store = crate::store::Store::open_in_memory(
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap(),
        )
        .unwrap();
        let scope = store
            .transaction(|tx| {
                crate::authorized_scope::resolve(
                    tx,
                    None,
                    None,
                    crate::authorized_scope::ScopeAccess::Write,
                )
            })
            .unwrap();
        seed_enabled_mcp_connection(&store, &scope, "local-brief", "stdio");
        seed_enabled_mcp_connection(&store, &scope, "remote-app", "streamable-http");
        seed_enabled_mcp_connection(&store, &scope, "marketplace-vercel", "streamable-http");

        store
            .with_conn(|conn| {
                current_mcp_app_tool(
                    conn,
                    &store,
                    &scope,
                    "mcp-6c6f63616c2d6272696566",
                    "get-time",
                    "ui://get-time/mcp-app.html",
                )
            })
            .unwrap();
        store
            .with_conn(|conn| {
                current_mcp_app_tool(
                    conn,
                    &store,
                    &scope,
                    "mcp-72656d6f74652d617070",
                    "get-time",
                    "ui://get-time/mcp-app.html",
                )
            })
            .unwrap();
        store
            .with_conn(|conn| {
                current_mcp_app_tool(
                    conn,
                    &store,
                    &scope,
                    "vercel",
                    "get-time",
                    "ui://get-time/mcp-app.html",
                )
            })
            .unwrap();
    }

    #[test]
    fn mcp_resource_authority_requires_current_enabled_uri_and_revision() {
        let store = crate::store::Store::open_in_memory(
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap(),
        )
        .unwrap();
        let scope = store
            .transaction(|tx| {
                crate::authorized_scope::resolve(
                    tx,
                    None,
                    None,
                    crate::authorized_scope::ScopeAccess::Write,
                )
            })
            .unwrap();
        seed_enabled_mcp_connection(&store, &scope, "local-brief", "stdio");
        let connector_id = "mcp-6c6f63616c2d6272696566";
        store
            .with_conn(|conn| {
                current_mcp_app_tool(
                    conn,
                    &store,
                    &scope,
                    connector_id,
                    "get-time",
                    "ui://get-time/other.html",
                )
            })
            .unwrap_err();
        store
            .transaction(|tx| {
                crate::store::repos::mcp_local_server::set_disabled(
                    tx,
                    &scope,
                    "local-brief",
                    1,
                    true,
                    "2026-10-08T22:00:03Z",
                )
            })
            .unwrap();
        store
            .with_conn(|conn| {
                current_mcp_app_tool(
                    conn,
                    &store,
                    &scope,
                    connector_id,
                    "get-time",
                    "ui://get-time/mcp-app.html",
                )
            })
            .unwrap_err();

        let descriptor =
            |revision_id: &str, state: &str| crate::store::repos::message::MessageRow {
                id: format!("message-{revision_id}"),
                thread_id: "thread".into(),
                sequence: 1,
                parent_message_id: None,
                kind: "tool".into(),
                run_id: Some("run".into()),
                detail: serde_json::json!({
                    "phase": "result",
                    "outcome": "succeeded",
                    "toolCallId": "reused-call-id"
                }),
                current_revision_id: revision_id.into(),
                current_revision_number: 1,
                current_revision_state: state.into(),
                content: Value::String("{}".into()),
                created_at: "2026-10-08T22:00:04Z".into(),
            };
        let rows = vec![
            descriptor("revision-old", "terminal"),
            descriptor("revision-new", "terminal"),
        ];
        assert_eq!(
            selected_mcp_app_result(&rows, "revision-new")
                .map(|row| row.current_revision_id.as_str()),
            Some("revision-new")
        );
        assert!(selected_mcp_app_result(&rows, "stale-revision").is_none());
        let revised_message = vec![descriptor("revision-new", "terminal")];
        assert!(selected_mcp_app_result(&revised_message, "revision-old").is_none());
        assert!(
            selected_mcp_app_result(&[descriptor("streaming", "streaming")], "streaming").is_none()
        );
    }

    #[test]
    fn mcp_result_lookup_requires_the_authenticated_member_owner() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE thread (workspace_id TEXT NOT NULL, id TEXT NOT NULL, owner_member_id TEXT, deleted_at TEXT)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO thread(workspace_id,id,owner_member_id,deleted_at) VALUES('default','private-thread','member-a',NULL),('default','other-thread','member-b',NULL)",
            [],
        )
        .unwrap();
        let data = crate::store::repos::scope::DataScope::legacy_default();
        let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            data.clone(),
            "account-a",
            Some("member-a"),
        )
        .unwrap();
        let scope = crate::authorized_scope::AuthorizedCommandScope {
            data,
            private,
            internal_user_id: "account-a".into(),
            member_id: Some("member-a".into()),
        };
        assert!(conversation_belongs_to_owner(&conn, &scope, "private-thread").unwrap());
        assert!(!conversation_belongs_to_owner(&conn, &scope, "other-thread").unwrap());
    }

    fn serve(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        serve_for_owner(request, "account-owner")
    }

    fn request(path: &str) -> Request<Vec<u8>> {
        Request::builder()
            .method("GET")
            .uri(path)
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn serves_only_an_exact_live_token_path() {
        let key = "a".repeat(64);
        resources().lock().unwrap().insert(
            key.clone(),
            ResourceEntry {
                owner_subject: "account-owner".into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                result_id: "result".into(),
                html: b"<script>globalThis.exampleReady=true</script>".to_vec(),
                csp: "default-src 'none'; script-src 'unsafe-inline'".into(),
                expires_at: Instant::now() + RESOURCE_TTL,
            },
        );
        let response = serve(&request(&format!(
            "http://127.0.0.1:43127/{key}/index.html"
        )));
        assert_eq!(
            serve_for_owner(
                &request(&format!("http://127.0.0.1:43127/{key}/index.html")),
                "other-account"
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.body(),
            b"<script>globalThis.exampleReady=true</script>"
        );
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; script-src 'unsafe-inline'"
        );
        assert_eq!(
            serve(&request(&format!("http://127.0.0.1:43127/{key}/other.js"))).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve(&request("http://127.0.0.1:43127/nope/index.html")).status(),
            StatusCode::NOT_FOUND
        );
        resources().lock().unwrap().remove(&key);
    }

    #[test]
    fn serves_a_resource_using_the_private_scope_owner_subject() {
        let key = "d".repeat(64);
        let data = crate::store::repos::scope::DataScope::legacy_default();
        let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            data,
            "account-a",
            Some("member-a"),
        )
        .unwrap();
        resources().lock().unwrap().insert(
            key.clone(),
            ResourceEntry {
                owner_subject: private.owner_subject().into(),
                workspace_id: "default".into(),
                session_id: "session".into(),
                result_id: "result".into(),
                html: b"<p>guest</p>".to_vec(),
                csp: "default-src 'none'; script-src 'unsafe-inline'".into(),
                expires_at: Instant::now() + RESOURCE_TTL,
            },
        );
        let response = serve_for_owner(
            &request(&format!("http://127.0.0.1:43127/{key}/index.html")),
            private.owner_subject(),
        );
        assert_eq!(response.status(), StatusCode::OK);
        resources().lock().unwrap().remove(&key);
    }

    #[test]
    fn rejects_expired_resources_and_non_get_requests() {
        let key = "b".repeat(64);
        resources().lock().unwrap().insert(
            key.clone(),
            ResourceEntry {
                owner_subject: "account-owner".into(),
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                result_id: "result".into(),
                html: b"expired".to_vec(),
                csp: "default-src 'none'; script-src 'unsafe-inline'".into(),
                expires_at: Instant::now() - Duration::from_secs(1),
            },
        );
        assert_eq!(
            serve(&request(&format!(
                "http://127.0.0.1:43127/{key}/index.html"
            )))
            .status(),
            StatusCode::NOT_FOUND
        );
        let post = Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:43127/{key}/index.html"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(&post).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn csp_rejects_a_broad_script_or_network_policy() {
        assert!(validate_csp(
            "script-src 'unsafe-inline'; default-src 'none'; connect-src https://safe.example"
        )
        .is_err());
        assert!(validate_csp(
            "default-src 'none';; script-src 'unsafe-inline'; connect-src https://safe.example"
        )
        .is_err());
        assert!(validate_csp("default-src 'none'; script-src 'unsafe-inline'; script-src https://safe.example; connect-src https://safe.example").is_err());
        assert!(validate_csp("default-src 'none'; script-src https://evil.example").is_err());
        assert!(
            validate_csp("default-src 'none'; connect-src *; script-src 'unsafe-inline'").is_err()
        );
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src ipc://localhost"
        )
        .is_err());
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src chrome.webview"
        )
        .is_err());
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src https://safe.example; frame-src https://safe.example; navigate-to 'none'"
        )
        .is_err());
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src https://safe.example; frame-src 'none'; navigate-to 'none'"
        )
        .is_ok());
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src https://safe.example; navigate-to 'none'"
        )
        .is_ok());
        assert!(validate_csp(
            "default-src 'none'; script-src 'unsafe-inline'; connect-src https://safe.example; navigate-to https://safe.example"
        )
        .is_err());
    }
}
