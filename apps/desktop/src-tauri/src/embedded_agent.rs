//! Embedded OpenCode process custody. Canonical state remains in the vault;
//! the child has an in-memory SDK database and no provider credentials.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, watch},
};

const MAX_FRAME: usize = 3 * 1024 * 1024;
const STALE: &str = "This embedded agent attempt is no longer current.";
const CHANNEL: &str = "fable://embedded-agent/";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    request_id: String,
    provider_id: String,
    request: Value,
    context_prefix: Option<String>,
    computer: Option<Value>,
    max_turns: u32,
    max_tool_calls: u32,
    context_window: u32,
}

struct Run {
    owner: String,
    provider: String,
    model: String,
    route: crate::models::ProviderRouteExecutionBinding,
    stop: watch::Sender<bool>,
    stdin: mpsc::Sender<Value>,
    pending: Mutex<HashSet<String>>,
    computer_session: Option<String>,
    computer_approvals: Mutex<HashMap<String, String>>,
}

impl Run {
    fn current(&self) -> Result<(), String> {
        if *self.stop.borrow() || crate::backends::require_current_internal_user()? != self.owner {
            return Err(STALE.into());
        }
        crate::execution_control::ensure_active_execution_allowed()?;
        crate::backends::validate_current_native_provider_route(
            &self.provider,
            &self.model,
            &self.route,
        )
        .map(|_| ())
    }
}

fn runs() -> &'static Mutex<HashMap<String, Arc<Run>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<Run>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled_ids() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static IDS: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
    IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Flatten text-only SDK blocks before the existing native screenshot validator.
// Image/thinking/unknown blocks remain unchanged and are rejected there.
fn normalize_computer_text(provider: &str, body: &mut Value) {
    fn text(value: &mut Value) {
        if let Some(blocks) = value.as_array() {
            if blocks
                .iter()
                .all(|b| b["type"] == "text" && b["text"].is_string())
            {
                *value = json!(blocks
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""));
            }
        }
    }
    if let Some(messages) = body["messages"].as_array_mut() {
        for message in messages {
            if provider == "anthropic" {
                if let Some(blocks) = message["content"].as_array_mut() {
                    for block in blocks {
                        if block["type"] == "tool_result" {
                            text(&mut block["content"]);
                        }
                    }
                }
            } else {
                text(&mut message["content"]);
            }
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn executable(app: &AppHandle) -> Result<(std::path::PathBuf, File), String> {
    let resource = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-host")
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "Mivlet resources are unavailable.")?
            .join("resources/agent-host")
    };
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(resource.join("runtime.json"))
            .map_err(|_| "The bundled agent host is missing. Rebuild or repair Mivlet.")?,
    )
    .map_err(|_| "The bundled agent host manifest is invalid.")?;
    if manifest["protocol"] != 1 || manifest["sdk"] != "0.0.0-dev-19449" {
        return Err("The bundled agent host version is unsupported.".into());
    }
    let path = resource.join("mivlet-agent-host.exe");
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // Deny replacement or writes while this host runs.
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "The bundled agent host is unavailable.")?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "The bundled agent host could not be verified.")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if manifest["sha256"].as_str() != Some(hex::encode(hash.finalize()).as_str()) {
        return Err("The bundled agent host failed integrity verification. Repair Mivlet.".into());
    }
    Ok((path, file))
}

pub(crate) fn host_command(app: &AppHandle) -> Result<(Command, File, tempfile::TempDir), String> {
    let (path, image_lease) = executable(app)?;
    let directory = tempfile::Builder::new()
        .prefix("mivlet-agent-")
        .tempdir()
        .map_err(|_| "Mivlet could not prepare the private agent host.")?;
    let mut command = Command::new(path);
    command
        .current_dir(directory.path())
        .env_clear()
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    for name in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("TEMP", directory.path())
        .env("TMP", directory.path());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok((command, image_lease, directory))
}

#[tauri::command]
pub async fn start_embedded_agent(app: AppHandle, input: StartRequest) -> Result<(), String> {
    crate::execution_control::ensure_active_execution_allowed()?;
    if !valid_id(&input.request_id)
        || !["openai", "anthropic", "xai", "custom"].contains(&input.provider_id.as_str())
        || !(1..=32).contains(&input.max_turns)
        || !(1..=80).contains(&input.max_tool_calls)
        || !(1_024..=2_000_000).contains(&input.context_window)
        || input.request.to_string().len() > 2 * 1024 * 1024
        || input
            .context_prefix
            .as_ref()
            .is_some_and(|s| s.len() > 512 * 1024)
    {
        return Err("The embedded agent request is invalid.".into());
    }
    let model = input.request["model"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("The embedded model is invalid.")?
        .to_string();
    let route: crate::models::ProviderRouteExecutionBinding =
        serde_json::from_value(input.request["providerRoute"].clone())
            .map_err(|_| "The embedded agent requires an exact provider route.")?;
    crate::backends::validate_current_native_provider_route(&input.provider_id, &model, &route)?;
    let owner = crate::backends::require_current_internal_user()?;
    let (mut command, image_lease, directory) = host_command(&app)?;
    let (stop, mut stopped) = watch::channel(false);
    let (stdin, mut input_frames) = mpsc::channel::<Value>(128);
    let computer_session = if input.request["tools"].as_array().is_some_and(|tools| {
        tools.iter().any(|tool| {
            tool["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("local-desktop-"))
        })
    }) {
        let visual = serde_json::from_value(json!({"providerId":input.provider_id,"model":model,"computer":input.computer,"providerRoute":route})).map_err(|_| "Invalid native computer scope.")?;
        Some(crate::native_api::computer::begin_native_computer_session(
            visual,
            app.state(),
        )?)
    } else {
        None
    };
    let run = Arc::new(Run {
        owner,
        provider: input.provider_id.clone(),
        model,
        route,
        stop,
        stdin,
        pending: Mutex::new(HashSet::new()),
        computer_session,
        computer_approvals: Mutex::new(HashMap::new()),
    });
    {
        let mut cancelled = cancelled_ids().lock().map_err(|_| STALE)?;
        cancelled.retain(|_, time| time.elapsed() < std::time::Duration::from_secs(300));
        if cancelled.len() >= 1024 || cancelled.contains_key(&input.request_id) {
            if let Some(id) = &run.computer_session {
                let _ = crate::native_api::computer::end_native_computer_session(id.clone());
            }
            return Err(STALE.into());
        }
        let mut active = runs().lock().map_err(|_| STALE)?;
        if active.len() >= 8 || active.contains_key(&input.request_id) {
            if let Some(id) = &run.computer_session {
                let _ = crate::native_api::computer::end_native_computer_session(id.clone());
            }
            return Err(
                "This embedded agent attempt already exists or the concurrency limit was reached."
                    .into(),
            );
        }
        active.insert(input.request_id.clone(), run.clone());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            runs().lock().map_err(|_| STALE)?.remove(&input.request_id);
            if let Some(id) = &run.computer_session {
                let _ = crate::native_api::computer::end_native_computer_session(id.clone());
            }
            return Err("Mivlet could not launch the bundled agent host.".into());
        }
    };
    let mut writer = child.stdin.take().ok_or(STALE)?;
    let mut reader = BufReader::new(child.stdout.take().ok_or(STALE)?);
    let initial = json!({ "type": "start", "input": {
        "request": input.request, "providerId": input.provider_id,
        "contextPrefix": input.context_prefix, "maxTurns": input.max_turns, "maxToolCalls": input.max_tool_calls,
        "contextWindow": input.context_window,
    }});
    run.stdin.try_send(initial).map_err(|_| STALE)?;
    let writing = tokio::spawn(async move {
        while let Some(frame) = input_frames.recv().await {
            let encoded = format!("{}\n", frame);
            if writer.write_all(encoded.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let computers = app
        .state::<Arc<crate::local_computer::LocalComputerState>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        let _image_lease = image_lease;
        let _directory = directory;
        let channel = format!("{CHANNEL}{}", input.request_id);
        let mut terminal = false;
        let mut model_job: Option<tokio::task::JoinHandle<()>> = None;
        let mut next_model = 1u64;
        let mut tool_count = 0u32;
        let mut seen = HashSet::new();
        let mut line = Vec::new();
        loop {
            line.clear();
            let mut bounded = (&mut reader).take((MAX_FRAME + 1) as u64);
            let read = tokio::select! {
                biased;
                _ = stopped.changed() => break,
                result = bounded.read_until(b'\n', &mut line) => result,
            };
            if !matches!(read, Ok(n) if n > 0 && n <= MAX_FRAME) {
                break;
            }
            let Ok(event) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            if run.current().is_err() {
                break;
            }
            match event["type"].as_str() {
                Some("model-request") => {
                    if event["id"].as_u64() != Some(next_model)
                        || next_model > u64::from(input.max_turns)
                    {
                        break;
                    }
                    // The child may consume DONE before the previous task returns.
                    if let Some(mut job) = model_job.take() {
                        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut job)
                            .await
                            .is_err()
                        {
                            job.abort();
                            break;
                        }
                    }
                    let id = next_model;
                    next_model += 1;
                    let bound = run.clone();
                    let native = computers.clone();
                    let request_id = format!("{}-model-{id}", input.request_id);
                    let mut body = event["body"].clone();
                    if run.computer_session.is_some() {
                        normalize_computer_text(&run.provider, &mut body);
                    }
                    model_job = Some(tokio::spawn(async move {
                        let mut sequence = 0u64;
                        let (send, mut receive) = mpsc::channel(128);
                        let mut stop = bound.stop.subscribe();
                        if *stop.borrow() {
                            return;
                        }
                        let request = crate::native_api::BackendStreamRequest {
                            provider_id: bound.provider.clone(),
                            request_id: request_id.clone(),
                            model: bound.model.clone(),
                            body,
                            provider_route: Some(bound.route.clone()),
                            computer_session_id: bound.computer_session.clone(),
                        };
                        let emit = |line: String| {
                            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                                if let Some(binding) = value.get("__fableComputerTool") {
                                    if let (Some(id), Some(approval)) =
                                        (binding["callId"].as_str(), binding["approvalId"].as_str())
                                    {
                                        if let Ok(mut approvals) = bound.computer_approvals.lock() {
                                            approvals.insert(id.into(), approval.into());
                                        }
                                    }
                                    return;
                                }
                            }
                            if send.try_send(line).is_err() {
                                let _ = bound.stop.send(true);
                            }
                        };
                        let egress = crate::native_api::stream_completion(request, &native, &emit);
                        tokio::pin!(egress);
                        loop {
                            tokio::select! {
                                biased;
                                _ = stop.changed() => { let _ = crate::native_api::cancel_backend_completion(request_id.clone()); break; },
                                result = &mut egress => {
                                    while let Ok(line) = receive.try_recv() {
                                        if bound.stdin.send(json!({"type":"model-chunk", "id":id, "sequence":sequence, "line":line})).await.is_err() { break; }
                                        sequence += 1;
                                    }
                                    if result.is_err() { let _ = bound.stop.send(true); }
                                    break;
                                },
                                Some(line) = receive.recv() => {
                                    if *bound.stop.borrow() || bound.stdin.send(json!({"type":"model-chunk", "id":id, "sequence":sequence, "line":line})).await.is_err() { break; }
                                    sequence += 1;
                                }
                            }
                        }
                    }));
                }
                Some("tool-request") => {
                    let Some(id) = event["callId"].as_str().filter(|s| valid_id(s)) else {
                        break;
                    };
                    tool_count += 1;
                    if tool_count > input.max_tool_calls
                        || !seen.insert(id.to_string())
                        || event["arguments"].as_str().is_none_or(|s| s.len() > 64_000)
                        || event["tool"].as_str().is_none_or(|s| s.len() > 200)
                    {
                        break;
                    }
                    if let Ok(mut pending) = run.pending.lock() {
                        pending.insert(id.to_string());
                    } else {
                        break;
                    }
                    let mut event = event.clone();
                    if event["tool"]
                        .as_str()
                        .is_some_and(|name| name.starts_with("local-desktop-"))
                    {
                        let approval = run
                            .computer_approvals
                            .lock()
                            .ok()
                            .and_then(|mut bindings| bindings.remove(id));
                        let Some(approval) = approval else {
                            break;
                        };
                        event["approvalId"] = json!(approval);
                    }
                    let _ = app.emit(&channel, &event);
                }
                Some("text-delta" | "usage" | "retrying") => {
                    let _ = app.emit(&channel, &event);
                }
                Some("error" | "done" | "cancelled") => {
                    terminal = true;
                    let _ = app.emit(&channel, &event);
                    break;
                }
                _ => break,
            }
        }
        let cancelled = *run.stop.borrow();
        let _ = run.stop.send(true);
        if next_model > 1 {
            let _ = crate::native_api::cancel_backend_completion(format!(
                "{}-model-{}",
                input.request_id,
                next_model - 1
            ));
        }
        if let Some(id) = &run.computer_session {
            let _ = crate::native_api::computer::end_native_computer_session(id.clone());
        }
        // Close the child pipe before joining egress: a blocked writer must not
        // make Stop wait for the model queue to drain.
        let _ = child.kill().await;
        writing.abort();
        if let Some(mut job) = model_job {
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut job)
                .await
                .is_err()
            {
                job.abort();
            }
        }
        if !terminal {
            let _ = app.emit(&channel, if cancelled { json!({"type":"cancelled"}) } else { json!({"type":"error","message":"The embedded agent stopped before completing this turn."}) });
        }
        if let Ok(mut active) = runs().lock() {
            active.remove(&input.request_id);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn reply_embedded_agent(
    request_id: String,
    call_id: String,
    ok: bool,
    output: String,
) -> Result<(), String> {
    if output.chars().count() > 64_000 {
        return Err("The tool result is too large.".into());
    }
    let run = runs()
        .lock()
        .map_err(|_| STALE)?
        .get(&request_id)
        .cloned()
        .ok_or(STALE)?;
    run.current()?;
    if !run.pending.lock().map_err(|_| STALE)?.remove(&call_id) {
        return Err("The tool reply is stale, mismatched or already consumed.".into());
    }
    run.stdin
        .send(json!({"type":"tool-result","callId":call_id,"ok":ok,"output":output}))
        .await
        .map_err(|_| STALE.to_string())
}

#[tauri::command]
pub fn cancel_embedded_agent(request_id: String) -> Result<(), String> {
    if !valid_id(&request_id) {
        return Err(STALE.into());
    }
    let mut cancelled = cancelled_ids().lock().map_err(|_| STALE)?;
    cancelled.retain(|_, time| time.elapsed() < std::time::Duration::from_secs(300));
    if cancelled.len() < 1024 {
        cancelled.insert(request_id.clone(), std::time::Instant::now());
    }
    let run = runs().lock().map_err(|_| STALE)?.get(&request_id).cloned();
    if let Some(run) = run {
        // Cancellation is permitted after account/route invalidation as well.
        let _ = run.stop.send(true);
        if let Ok(mut pending) = run.pending.lock() {
            pending.clear();
        }
    }
    Ok(())
}

pub(crate) fn shutdown_all() {
    if let Ok(active) = runs().lock() {
        for run in active.values() {
            let _ = run.stop.send(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_text_normalization_never_admits_pixels() {
        let mut body = json!({"messages":[{"role":"tool","content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:forbidden"}}]}]});
        normalize_computer_text("openai", &mut body);
        assert_eq!(body["messages"][0]["content"], "onetwo");
        assert!(body["messages"][1]["content"].is_array());
        let mut body = json!({"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":[{"type":"text","text":"exact receipt"}]}]}]});
        normalize_computer_text("anthropic", &mut body);
        assert_eq!(
            body["messages"][0]["content"][0]["content"],
            "exact receipt"
        );
    }

    #[test]
    fn cancellation_before_start_is_remembered() {
        let id = "sdk-cancel-before-start-test";
        cancel_embedded_agent(id.into()).unwrap();
        assert!(cancelled_ids().lock().unwrap().contains_key(id));
        assert!(!valid_id("path/escape"));
    }
}
