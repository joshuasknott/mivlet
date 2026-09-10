//! Official MCP protocol engine in the bundled host. Existing MCP native
//! transports retain connection, credentials, scope and exact tool permits.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
};

const LIMIT: usize = 10 * 1024 * 1024;
const STALE: &str = "The native MCP protocol session is no longer current.";
struct Session {
    owner: String,
    input: mpsc::Sender<Value>,
    stop: watch::Sender<bool>,
}
#[derive(Default)]
struct Registry {
    active: HashMap<String, Arc<Session>>,
    stopped: HashMap<String, Instant>,
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}
fn valid_id(id: &str) -> bool {
    id.starts_with("mcp-sdk-")
        && id.len() <= 80
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[tauri::command]
pub async fn start_embedded_mcp(app: AppHandle, request_id: String) -> Result<(), String> {
    if !valid_id(&request_id) {
        return Err(STALE.into());
    }
    let owner = crate::backends::require_current_internal_user()?;
    let (mut command, image_lease, directory) = super::embedded_agent::host_command(&app)?;
    command.arg("--mcp");
    let (input, mut incoming) = mpsc::channel::<Value>(32);
    let (stop, mut stopped) = watch::channel(false);
    let session = Arc::new(Session { owner, input, stop });
    {
        let mut registry = registry().lock().map_err(|_| STALE)?;
        registry
            .stopped
            .retain(|_, at| at.elapsed() < Duration::from_secs(300));
        if registry.active.len() >= 8
            || registry.stopped.len() >= 1024
            || registry.active.contains_key(&request_id)
            || registry.stopped.contains_key(&request_id)
        {
            return Err(STALE.into());
        }
        registry.active.insert(request_id.clone(), session.clone());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            registry()
                .lock()
                .map_err(|_| STALE)?
                .active
                .remove(&request_id);
            return Err("The bundled MCP protocol host could not start.".into());
        }
    };
    let mut writer = child.stdin.take().ok_or(STALE)?;
    let mut reader = BufReader::new(child.stdout.take().ok_or(STALE)?);
    let writing = tokio::spawn(async move {
        while let Some(frame) = incoming.recv().await {
            if writer
                .write_all(format!("{frame}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let _image_lease = image_lease;
        let _directory = directory;
        let channel = format!("fable://embedded-mcp/{request_id}");
        let mut line = Vec::new();
        loop {
            line.clear();
            let mut bounded = (&mut reader).take((LIMIT + 1) as u64);
            let read = tokio::select! {
                biased;
                _ = stopped.changed() => break,
                result = tokio::time::timeout(Duration::from_secs(300), bounded.read_until(b'\n', &mut line)) => result,
            };
            if !matches!(read, Ok(Ok(n)) if n > 0 && n <= LIMIT) {
                break;
            }
            if *session.stop.borrow()
                || crate::backends::require_current_internal_user()
                    .ok()
                    .as_ref()
                    != Some(&session.owner)
            {
                break;
            }
            let Ok(frame) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            if !matches!(frame["type"].as_str(), Some("send" | "result" | "closed")) {
                break;
            }
            let _ = app.emit(&channel, &frame);
            if frame["type"] == "closed" {
                break;
            }
        }
        let _ = session.stop.send(true);
        let _ = child.kill().await;
        writing.abort();
        let _ = app.emit(&channel, json!({"type":"closed"}));
        if let Ok(mut registry) = registry().lock() {
            registry.active.remove(&request_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn send_embedded_mcp(request_id: String, frame: Value) -> Result<(), String> {
    if frame.to_string().len() > LIMIT
        || !matches!(
            frame["type"].as_str(),
            Some("request" | "frame" | "sent" | "close")
        )
    {
        return Err("Invalid MCP protocol frame.".into());
    }
    let session = registry()
        .lock()
        .map_err(|_| STALE)?
        .active
        .get(&request_id)
        .cloned()
        .ok_or(STALE)?;
    if *session.stop.borrow() || crate::backends::require_current_internal_user()? != session.owner
    {
        return Err(STALE.into());
    }
    session
        .input
        .try_send(frame)
        .map_err(|_| "The MCP protocol queue is unavailable or full.".into())
}

#[tauri::command]
pub fn close_embedded_mcp(request_id: String) -> Result<(), String> {
    if !valid_id(&request_id) {
        return Err(STALE.into());
    }
    let mut registry = registry().lock().map_err(|_| STALE)?;
    registry
        .stopped
        .retain(|_, at| at.elapsed() < Duration::from_secs(300));
    if registry.stopped.len() < 1024 {
        registry.stopped.insert(request_id.clone(), Instant::now());
    }
    if let Some(session) = registry.active.get(&request_id) {
        let _ = session.stop.send(true);
    }
    Ok(())
}

pub(crate) fn shutdown_all() {
    if let Ok(registry) = registry().lock() {
        for session in registry.active.values() {
            let _ = session.stop.send(true);
        }
    }
}
