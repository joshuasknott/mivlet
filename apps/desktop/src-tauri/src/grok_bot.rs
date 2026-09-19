//! Dedicated remote-agent bridge. No general MCP tool dispatch, API or CLI route.
//! Pairing stays in the provider's POSIX-protected, account/workspace-specific
//! WSL directory. The renderer receives only metadata and bounded remote history.
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::watch,
};

const VERSION: &str = "0.2.0-beta.8";
const LIMIT: usize = 256 * 1024;
const STALE: &str =
    "The Grok Bot connection is no longer current. Reconnect. Remote execution may continue.";
const SETUP: &str = "Install WSL with a Linux distribution and Node 22 at /usr/bin/node, install the pinned bridge, then pair this Mivlet scope and start the VM companion. See Grok Bot setup.";
const UNAVAILABLE: &str = "The bridge did not respond. Check WSL, pairing, relay and the VM companion, then reconnect. A pending send may have arrived; do not resend without inspecting Grok Bot.";

struct Wire {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    namespace: String,
    selection: Option<String>,
}
struct Session {
    scope: Scope,
    stop: watch::Sender<bool>,
    wire: tokio::sync::Mutex<Wire>,
    bots: HashSet<String>,
    sent: Mutex<HashSet<String>>,
}
fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scope() -> Result<Scope, String> {
    crate::account_session::ensure_current()?;
    let local =
        crate::authorized_scope::active_command_scope(crate::authorized_scope::ScopeAccess::Write)?;
    let store = crate::store::try_global().ok_or(STALE)?;
    let (selected, selection) = store.with_conn(|conn| {
        let selected = crate::store::repos::workspace_directory::selected_active_workspace_for_current_user(conn)?;
        let selection = conn.query_row("SELECT s.selected_at FROM active_workspace_selection s JOIN current_internal_user u ON u.internal_user_id=s.internal_user_id WHERE u.singleton=1", [], |row| row.get::<_, String>(0)).optional()?;
        Ok((selected, selection))
    }).map_err(|_| STALE)?;
    let workspace = selected
        .and_then(|s| s.fable_workspace_id)
        .unwrap_or_else(|| local.data.workspace_id().to_string());
    let namespace = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{workspace}", local.internal_user_id).as_bytes())
    );
    // A -> B -> A is still a new selection. Keep the pairing namespace stable,
    // but invalidate in-flight work on every persisted workspace selection.
    Ok(Scope {
        namespace,
        selection,
    })
}

#[tauri::command]
pub fn grok_bot_setup_scope() -> Result<String, String> {
    scope().map(|scope| scope.namespace)
}

// The shell script is fixed except for a native SHA-256 namespace. No renderer
// command/path/env input; no host-shell tool is exposed to the Bot.
fn launch_script(namespace: &str) -> String {
    format!("exec /usr/bin/env -i HOME=\"$HOME\" PATH=/usr/bin:/bin XDG_CONFIG_HOME=\"$HOME/.config/mivlet-grok-bot/{namespace}\" /usr/bin/node \"$HOME/.local/share/mivlet-grok-bot/{VERSION}/node_modules/codex-grok-mcp/dist/index.js\"")
}

impl Wire {
    async fn start(namespace: &str) -> Result<Self, String> {
        if !cfg!(windows) {
            return Err("This experimental bridge launcher requires Windows and WSL.".into());
        }
        let system = std::env::var_os("SystemRoot").ok_or(SETUP)?;
        let mut command = Command::new(std::path::PathBuf::from(system).join("System32/wsl.exe"));
        command
            .args(["--exec", "/bin/sh", "-c", &launch_script(namespace)])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| SETUP)?;
        let input = child.stdin.take().ok_or(SETUP)?;
        let output = BufReader::new(child.stdout.take().ok_or(SETUP)?);
        Ok(Self {
            child,
            input,
            output,
            sequence: 0,
        })
    }

    async fn write(&mut self, value: Value) -> Result<(), String> {
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .map_err(|_| UNAVAILABLE.to_string())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.sequence += 1;
        let id = self.sequence;
        self.write(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .await?;
        // Bounded stdio framing, matching existing native MCP transport. Server
        // instructions, notifications and unstructured errors never reach React.
        for _ in 0..32 {
            let mut bytes = Vec::new();
            let n = (&mut self.output)
                .take((LIMIT + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await
                .map_err(|_| UNAVAILABLE)?;
            if n == 0 || n > LIMIT {
                return Err(UNAVAILABLE.into());
            }
            let frame: Value = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
            if frame["id"] != id {
                continue;
            }
            if frame.get("error").is_some() {
                return Err(UNAVAILABLE.into());
            }
            return frame
                .get("result")
                .cloned()
                .ok_or_else(|| UNAVAILABLE.into());
        }
        Err(UNAVAILABLE.into())
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let result = self
            .request("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if result["isError"] == true {
            return Err(UNAVAILABLE.into());
        }
        result
            .get("structuredContent")
            .cloned()
            .ok_or_else(|| UNAVAILABLE.into())
    }
}

fn validate_status(status: &Value) -> Result<(), String> {
    if status["state"] != "connected"
        || status["mode"] != "paired_relay"
        || status["gateway_healthy"] != true
    {
        return Err("Bridge not paired or companion unavailable. Pair this scope and start the companion in Grok Bot's Computer terminal.".into());
    }
    if status["server_version"] != VERSION || status["companion_version"] != VERSION {
        return Err("Install codex-grok-mcp 0.2.0-beta.8 at both ends, then reconnect.".into());
    }
    if !["status", "list_bots", "read_bot", "send_message"]
        .iter()
        .all(|name| {
            status["capabilities"]
                .as_array()
                .is_some_and(|values| values.contains(&json!(name)))
        })
    {
        return Err(
            "The companion lacks required Bot operations. Install the pinned version at both ends."
                .into(),
        );
    }
    Ok(())
}

fn validate_roster(value: &Value) -> Result<HashSet<String>, String> {
    let bots = value["bots"]
        .as_array()
        .filter(|v| v.len() <= 500)
        .ok_or(UNAVAILABLE)?;
    let mut ids = HashSet::new();
    for bot in bots {
        let id = bot["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
            .ok_or(UNAVAILABLE)?;
        let name = bot["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
            .ok_or(UNAVAILABLE)?;
        if id.chars().chain(name.chars()).any(char::is_control) || !ids.insert(id.to_string()) {
            return Err(UNAVAILABLE.into());
        }
    }
    Ok(ids)
}

#[tauri::command]
pub async fn grok_bot_connect() -> Result<Value, String> {
    static CONNECTING: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _connecting = CONNECTING.get_or_init(|| tokio::sync::Mutex::new(())).try_lock()
        .map_err(|_| "A bridge connection check is already running. Wait for it to finish before reconnecting.")?;
    let namespace = scope()?;
    let mut wire = Wire::start(&namespace.namespace).await?;
    let handshake = async {
        wire.request("initialize", json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mivlet-grok-bot","version":"0.1.0"}})).await?;
        wire.write(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?;
        validate_status(&wire.tool("grok_bridge_status", json!({})).await?)?;
        wire.tool("grok_list_bots", json!({})).await
    };
    let roster = tokio::time::timeout(Duration::from_secs(40), handshake)
        .await
        .map_err(|_| UNAVAILABLE)??;
    let bots = validate_roster(&roster)?;
    if scope()? != namespace {
        return Err(STALE.into());
    }
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| STALE)?;
    let id = hex::encode(random);
    let (stop, _) = watch::channel(false);
    let session = Arc::new(Session {
        scope: namespace,
        stop,
        wire: tokio::sync::Mutex::new(wire),
        bots,
        sent: Mutex::new(HashSet::new()),
    });
    {
        let mut registry = sessions().lock().map_err(|_| STALE)?;
        // One remote connection per renderer; replacing it revokes old results.
        for old in registry.values() {
            old.stop.send_replace(true);
        }
        registry.clear();
        registry.insert(id.clone(), session.clone());
    }
    let mut stopped = session.stop.subscribe();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    if scope().ok().as_ref() != Some(&session.scope) { session.stop.send_replace(true); break; }
                }
            }
            if *stopped.borrow() {
                break;
            }
        }
        let _ = session.wire.lock().await.child.kill().await;
    });
    Ok(
        json!({"sessionId":id,"bots":roster["bots"].as_array().unwrap().iter().map(|b| json!({"id":b["id"],"name":b["name"]})).collect::<Vec<_>>()}),
    )
}

fn current(session: &Session, namespace: &Scope) -> Result<(), String> {
    if *session.stop.borrow() || &session.scope != namespace {
        Err(STALE.into())
    } else {
        Ok(())
    }
}

fn reserve_send(sent: &Mutex<HashSet<String>>, nonce: String) -> Result<(), String> {
    let mut sent = sent.lock().map_err(|_| STALE)?;
    if sent.len() >= 1024 || !sent.insert(nonce) {
        return Err("This send was already attempted. Inspect Grok Bot; do not retry it.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn grok_bot_call(
    session_id: String,
    bot_id: String,
    operation: String,
    message: Option<String>,
    request_id: Option<String>,
    cursor: Option<String>,
) -> Result<Value, String> {
    let session = sessions()
        .lock()
        .map_err(|_| STALE)?
        .get(&session_id)
        .cloned()
        .ok_or(STALE)?;
    current(&session, &scope()?)?;
    if !session.bots.contains(&bot_id) {
        return Err("Select a Bot discovered in this connection.".into());
    }
    let (tool, args) = match operation.as_str() {
        "read"
            if message.is_none()
                && request_id.is_none()
                && cursor
                    .as_ref()
                    .is_none_or(|c| !c.is_empty() && c.len() <= 2048) =>
        {
            let mut args = json!({"bot_id":bot_id,"limit":50});
            if let Some(cursor) = cursor {
                args["cursor"] = json!(cursor);
            }
            ("grok_read_bot", args)
        }
        "send" if cursor.is_none() => {
            let text = message
                .filter(|s| !s.trim().is_empty() && s.len() <= 65536 && !s.contains('\0'))
                .ok_or("Enter a message of at most 64 KiB.")?;
            let nonce = request_id
                .filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
                .ok_or(STALE)?;
            reserve_send(&session.sent, nonce)?;
            (
                "grok_send_bot_message",
                json!({"bot_id":bot_id,"message":text}),
            )
        }
        _ => return Err("Unsupported Grok Bot operation.".into()),
    };
    let mut stopped = session.stop.subscribe();
    let mut wire = session.wire.lock().await;
    current(&session, &scope()?)?;
    let result = tokio::select! {
        biased;
        _ = stopped.changed() => Err(STALE.to_string()),
        value = tokio::time::timeout(Duration::from_secs(30), wire.tool(tool, args)) => value.map_err(|_| UNAVAILABLE.to_string()).and_then(|v| v),
    };
    if result.is_err() {
        session.stop.send_replace(true);
    }
    let value = result?;
    current(&session, &scope()?)?;
    if value["bot_id"] != bot_id {
        session.stop.send_replace(true);
        return Err(UNAVAILABLE.into());
    }
    // Only documented fields leave native custody, never arbitrary MCP content.
    let fields: &[&str] = if operation == "send" {
        &["bot_id", "accepted", "completion_boundary"]
    } else {
        &[
            "bot_id",
            "activity_state",
            "messages",
            "next_cursor",
            "truncated",
            "correlation",
            "completion_boundary",
        ]
    };
    let mut output = Value::Object(
        fields
            .iter()
            .filter_map(|key| value.get(*key).map(|v| (key.to_string(), v.clone())))
            .collect(),
    );
    if operation == "read" {
        let messages = value["messages"]
            .as_array()
            .filter(|m| m.len() <= 50)
            .ok_or(UNAVAILABLE)?;
        let mut sanitized = Vec::new();
        for message in messages {
            let speaker = message["speaker"]
                .as_str()
                .filter(|s| matches!(*s, "user" | "bot" | "peer"))
                .ok_or(UNAVAILABLE)?;
            let text = message["text"]
                .as_str()
                .filter(|s| s.len() <= 16384)
                .ok_or(UNAVAILABLE)?;
            let timestamp = &message["timestamp_ms"];
            if !timestamp.is_null() && timestamp.as_u64().is_none() {
                return Err(UNAVAILABLE.into());
            }
            sanitized.push(json!({"speaker":speaker,"text":text,"timestamp_ms":timestamp}));
        }
        output["messages"] = json!(sanitized);
    }
    Ok(output)
}

#[tauri::command]
pub fn grok_bot_disconnect(session_id: String) -> Result<(), String> {
    let mut registry = sessions().lock().map_err(|_| STALE)?;
    if let Some(session) = registry.get(&session_id) {
        // Account guard still applies; stopping old observation is always safe.
        session.stop.send_replace(true);
    }
    registry.remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests;
