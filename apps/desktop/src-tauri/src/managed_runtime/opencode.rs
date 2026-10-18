//! OpenCode local HTTP/SSE transport and event handling.
use super::*;

pub(super) fn open_code_endpoint(base_url: &str, segments: &[&str]) -> Result<String, String> {
    let mut url = url::Url::parse(base_url)
        .map_err(|_| "Mivlet could not construct the OpenCode server URL.".to_string())?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "Mivlet could not construct the OpenCode server URL.".to_string())?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    Ok(url.into())
}

fn open_code_password() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Mivlet could not secure the local OpenCode server.".to_string())?;
    Ok(hex::encode(bytes))
}

fn open_code_rules() -> Value {
    json!([
        {"permission":"*","pattern":"*","action":"ask"},
        {"permission":"bash","pattern":"*","action":"ask"},
        {"permission":"edit","pattern":"*","action":"ask"},
        {"permission":"external_directory","pattern":"*","action":"ask"},
        {"permission":"question","pattern":"*","action":"deny"}
    ])
}

pub(super) async fn open_code_error(mut response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok().flatten() {
        let remaining = MAX_COMMAND_OUTPUT.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() == MAX_COMMAND_OUTPUT {
            break;
        }
    }
    let body = String::from_utf8_lossy(&body);
    let detail = safe_error_message(&body, fallback);
    format!("{detail} (OpenCode HTTP {status})")
}

async fn wait_for_open_code(
    client: &reqwest::Client,
    control: &OpenCodeControl,
) -> Result<(), String> {
    let health = open_code_endpoint(&control.base_url, &["global", "health"])?;
    for _ in 0..50 {
        if client
            .get(&health)
            .header("Authorization", &control.authorization)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("OpenCode's local server did not become ready.".to_string())
}

pub(super) fn sse_frames(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut values = Vec::new();
    loop {
        let lf = buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|position| (position, 2));
        let crlf = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| (position, 4));
        let Some((end, delimiter_length)) = (match (lf, crlf) {
            (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
            (Some(found), None) | (None, Some(found)) => Some(found),
            (None, None) => None,
        }) else {
            break;
        };
        let frame = buffer.drain(..end + delimiter_length).collect::<Vec<_>>();
        let Ok(frame) = std::str::from_utf8(&frame) else {
            continue;
        };
        let data = frame
            .lines()
            .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if !data.is_empty() && data != "[DONE]" {
            if let Ok(value) = serde_json::from_str(&data) {
                values.push(value);
            }
        }
    }
    values
}

#[derive(Default)]
struct OpenCodeStreamState {
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    cost_usd: f64,
    cost_unknown: bool,
    assistant_messages: HashSet<String>,
    emitted_usage: HashSet<String>,
    text_by_part: HashMap<String, String>,
    observed_activity: bool,
    awaiting_busy_after_permission: bool,
    pending_permission_count: usize,
}

fn open_code_event_session_id(value: &Value) -> Option<&str> {
    value
        .pointer("/properties/sessionID")
        .or_else(|| value.pointer("/properties/info/sessionID"))
        .or_else(|| value.pointer("/properties/part/sessionID"))
        .and_then(Value::as_str)
}

fn open_code_event_error(value: &Value) -> String {
    let candidate = value
        .pointer("/properties/error/data/message")
        .or_else(|| value.pointer("/properties/error/message"))
        .or_else(|| value.pointer("/properties/error/name"))
        .and_then(Value::as_str)
        .unwrap_or("OpenCode execution failed.");
    safe_error_message(candidate, "OpenCode execution failed.")
}

fn handle_open_code_event(
    app: &AppHandle,
    channel: &str,
    run_id: &str,
    session_id: &str,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    permission_mode: &str,
    value: &Value,
    state: &mut OpenCodeStreamState,
) -> bool {
    if open_code_event_session_id(value).is_some_and(|candidate| candidate != session_id) {
        return false;
    }
    match value.get("type").and_then(Value::as_str) {
        Some("message.updated") => {
            let info = value.pointer("/properties/info").unwrap_or(&Value::Null);
            let message_id = info.get("id").and_then(Value::as_str).unwrap_or_default();
            if info.get("role").and_then(Value::as_str) == Some("assistant") {
                state.observed_activity = true;
                state.awaiting_busy_after_permission = false;
                state.assistant_messages.insert(message_id.to_string());
                if info.get("error").is_some_and(|error| !error.is_null()) {
                    let message =
                        open_code_event_error(&json!({"properties":{"error":info.get("error")}}));
                    let _ = app.emit(channel, json!({"type":"error","message":message}));
                    let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
                    return true;
                }
                if info.pointer("/time/completed").is_some()
                    && state.emitted_usage.insert(message_id.to_string())
                {
                    let input = info
                        .pointer("/tokens/input")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    let output = info
                        .pointer("/tokens/output")
                        .and_then(Value::as_u64)
                        .unwrap_or_default();
                    let cost = info.get("cost").and_then(Value::as_f64);
                    let read = info.pointer("/tokens/cache/read").and_then(Value::as_u64);
                    let write = info.pointer("/tokens/cache/write").and_then(Value::as_u64);
                    if input > 0
                        || output > 0
                        || read.unwrap_or(0) > 0
                        || write.unwrap_or(0) > 0
                        || cost.is_some()
                    {
                        state.input_tokens = state
                            .input_tokens
                            .saturating_add(input)
                            .saturating_add(read.unwrap_or(0));
                        state.output_tokens = state.output_tokens.saturating_add(output);
                        for (total, value) in [
                            (&mut state.cached_input_tokens, read),
                            (&mut state.cache_write_tokens, write),
                            (
                                &mut state.reasoning_tokens,
                                info.pointer("/tokens/reasoning").and_then(Value::as_u64),
                            ),
                        ] {
                            if let Some(value) = value {
                                *total = Some(total.unwrap_or(0).saturating_add(value));
                            }
                        }
                        if let Some(cost) = cost.filter(|v| v.is_finite() && *v >= 0.0) {
                            state.cost_usd += cost;
                        } else {
                            state.cost_unknown = true;
                        }
                        let _ = app.emit(channel, json!({"type":"usage","inputTokens":state.input_tokens,"outputTokens":state.output_tokens,
                            "cachedInputTokens":state.cached_input_tokens,"cacheWriteTokens":state.cache_write_tokens,"reasoningTokens":state.reasoning_tokens,
                            "costUsd":state.cost_usd,"costUnknown":state.cost_unknown,"costEstimated":true}));
                    }
                }
            }
        }
        Some("message.part.delta") => {
            let message_id = value
                .pointer("/properties/messageID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.assistant_messages.contains(message_id)
                && value.pointer("/properties/field").and_then(Value::as_str) == Some("text")
            {
                let part_id = value
                    .pointer("/properties/partID")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let delta = value
                    .pointer("/properties/delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !delta.is_empty() {
                    state.observed_activity = true;
                    state.awaiting_busy_after_permission = false;
                    state
                        .text_by_part
                        .entry(part_id.to_string())
                        .or_default()
                        .push_str(delta);
                    let _ = app.emit(channel, json!({"type":"text-delta","text":delta}));
                }
            }
        }
        Some("message.part.updated") => {
            let part = value.pointer("/properties/part").unwrap_or(&Value::Null);
            let message_id = part
                .get("messageID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if state.assistant_messages.contains(message_id)
                && part.get("type").and_then(Value::as_str) == Some("text")
                && part.get("synthetic").and_then(Value::as_bool) != Some(true)
            {
                let part_id = part.get("id").and_then(Value::as_str).unwrap_or_default();
                let text = part.get("text").and_then(Value::as_str).unwrap_or_default();
                let previous = state
                    .text_by_part
                    .get(part_id)
                    .map(String::as_str)
                    .unwrap_or_default();
                let delta = text.strip_prefix(previous).unwrap_or_default();
                if !delta.is_empty() {
                    state.observed_activity = true;
                    state.awaiting_busy_after_permission = false;
                    let _ = app.emit(channel, json!({"type":"text-delta","text":delta}));
                }
                state
                    .text_by_part
                    .insert(part_id.to_string(), text.to_string());
            }
        }
        Some("permission.asked") => {
            state.observed_activity = true;
            let properties = value.get("properties").unwrap_or(&Value::Null);
            let permission_id = properties
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if permission_id.is_empty() {
                return false;
            }
            let permission = properties
                .get("permission")
                .and_then(Value::as_str)
                .unwrap_or("other");
            let call_id = properties
                .pointer("/tool/callID")
                .and_then(Value::as_str)
                .unwrap_or(permission_id);
            let detail = json!({
                "patterns":properties.get("patterns").cloned().unwrap_or_else(|| json!([])),
                "metadata":properties.get("metadata").cloned().unwrap_or_else(|| json!({}))
            });
            let title = format!("use {permission}");
            let payload = managed_approval_payload(
                "opencode",
                run_id,
                permission_id,
                call_id,
                provider_tool_kind(permission),
                &title,
                &detail,
                permission_mode,
            );
            if let Ok(mut map) = permissions.lock() {
                if map
                    .insert(permission_id.to_string(), PendingPermission::OpenCode)
                    .is_none()
                {
                    state.pending_permission_count += 1;
                }
            }
            let _ = app.emit(channel, payload);
        }
        Some("permission.replied") => {
            if let Some(permission_id) = value
                .pointer("/properties/requestID")
                .and_then(Value::as_str)
            {
                if let Ok(mut map) = permissions.lock() {
                    map.remove(permission_id);
                }
            }
            state.pending_permission_count = state.pending_permission_count.saturating_sub(1);
            state.awaiting_busy_after_permission =
                value.pointer("/properties/reply").and_then(Value::as_str) != Some("reject");
        }
        Some("session.error") => {
            let message = open_code_event_error(value);
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
            return true;
        }
        Some("session.status") => {
            let status = value
                .pointer("/properties/status/type")
                .and_then(Value::as_str);
            if status == Some("busy") {
                state.observed_activity = true;
                state.awaiting_busy_after_permission = false;
            } else if status == Some("idle")
                && state.observed_activity
                && !state.awaiting_busy_after_permission
                && state.pending_permission_count == 0
            {
                let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
                return true;
            }
        }
        Some("session.idle")
            if state.observed_activity
                && !state.awaiting_busy_after_permission
                && state.pending_permission_count == 0 =>
        {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
            return true;
        }
        _ => {}
    }
    false
}

pub(super) fn start_opencode_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    if request.provider_id != "opencode" {
        return Err("This provider does not use the OpenCode server adapter.".into());
    }
    let path = find_executable("opencode")
        .ok_or_else(|| "Install the official OpenCode runtime first.".to_string())?;
    let workspace = workspace_dir(&app, &user_id, "opencode")?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Mivlet could not reserve a local OpenCode port.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Mivlet could not reserve a local OpenCode port.".to_string())?
        .port();
    drop(listener);
    let password = open_code_password()?;
    let authorization = format!(
        "Basic {}",
        BASE64_STANDARD.encode(format!("opencode:{password}"))
    );
    let control = OpenCodeControl {
        base_url: format!("http://127.0.0.1:{port}"),
        authorization,
        directory: workspace.to_string_lossy().into_owned(),
    };
    let mut command = command_for_provider(&app, &user_id, "opencode", &path)?;
    command
        .env("OPENCODE_SERVER_PASSWORD", password)
        .arg("serve")
        .arg("--pure")
        .arg("--hostname=127.0.0.1")
        .arg(format!("--port={port}"))
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start OpenCode's local server.".to_string())?;
    let stdout = process.stdout.take();
    let stderr = process.stderr.take();
    let child = Arc::new(Mutex::new(process));
    let session_id = Arc::new(Mutex::new(None));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the OpenCode turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                owner: user_id.clone(),
                provider_id: "opencode".to_string(),
                stdin: None,
                child: child.clone(),
                session_id: session_id.clone(),
                permissions: permissions.clone(),
                opencode: Some(control.clone()),
                tool_bridge: Arc::new(Mutex::new(ToolBridge::default())),
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/opencode/{request_id}");
    tauri::async_runtime::spawn(async move {
        let stdout_thread =
            stdout.map(|stdout| thread::spawn(move || read_limited(stdout, MAX_COMMAND_OUTPUT)));
        let stderr_thread =
            stderr.map(|stderr| thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT)));
        let outcome = async {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .build()
                .map_err(|_| "Mivlet could not prepare the OpenCode client.".to_string())?;
            wait_for_open_code(&client, &control).await?;
            let event_url = open_code_endpoint(&control.base_url, &["event"])?;
            let events = client
                .get(event_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .send()
                .await
                .map_err(|_| "Mivlet could not subscribe to OpenCode events.".to_string())?;
            if !events.status().is_success() {
                return Err(
                    open_code_error(events, "OpenCode rejected its event subscription.").await,
                );
            }
            let session_url = open_code_endpoint(&control.base_url, &["session"])?;
            let created = client
                .post(session_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .json(&json!({"title":"Mivlet conversation","permission":open_code_rules()}))
                .send()
                .await
                .map_err(|_| "Mivlet could not create an OpenCode session.".to_string())?;
            if !created.status().is_success() {
                return Err(open_code_error(created, "OpenCode rejected session creation.").await);
            }
            let created: Value = created
                .json()
                .await
                .map_err(|_| "OpenCode returned an invalid session.".to_string())?;
            let sid = created
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "OpenCode returned no session id.".to_string())?
                .to_string();
            if let Ok(mut current) = session_id.lock() {
                *current = Some(sid.clone());
            }
            let prompt_url =
                open_code_endpoint(&control.base_url, &["session", &sid, "prompt_async"])?;
            let prompt = prompt_text(&request.request, &request.options);
            let mut body = json!({"parts":[{"type":"text","text":prompt}]});
            if let Some((provider_id, model_id)) = request.request.model.split_once('/') {
                if !provider_id.trim().is_empty() && !model_id.trim().is_empty() {
                    body["model"] = json!({"providerID":provider_id,"modelID":model_id});
                }
            }
            let accepted = client
                .post(prompt_url)
                .header("Authorization", &control.authorization)
                .query(&[("directory", control.directory.as_str())])
                .json(&body)
                .send()
                .await
                .map_err(|_| "Mivlet could not submit the OpenCode prompt.".to_string())?;
            if !accepted.status().is_success() {
                return Err(open_code_error(accepted, "OpenCode rejected the prompt.").await);
            }
            let mut bytes = events.bytes_stream();
            let mut buffer = Vec::new();
            let mut state = OpenCodeStreamState::default();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk
                    .map_err(|_| "OpenCode's event stream stopped unexpectedly.".to_string())?;
                buffer.extend_from_slice(&chunk);
                for event in sse_frames(&mut buffer) {
                    if handle_open_code_event(
                        &app,
                        &channel,
                        &request_id,
                        &sid,
                        &permissions,
                        request
                            .options
                            .permission_mode
                            .as_deref()
                            .unwrap_or("trusted-scope"),
                        &event,
                        &mut state,
                    ) {
                        return Ok(());
                    }
                }
                if buffer.len() > MAX_COMMAND_OUTPUT {
                    return Err("OpenCode sent an oversized event frame.".to_string());
                }
            }
            Err("OpenCode's event stream ended before the turn completed.".to_string())
        }
        .await;
        if let Err(message) = outcome {
            let message = safe_error_message(&message, "OpenCode execution failed.");
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut server) = child.lock() {
            let _ = server.kill();
        }
        let _ = child.lock().ok().and_then(|mut server| server.wait().ok());
        let _ = stdout_thread.map(|reader| reader.join());
        let _ = stderr_thread.map(|reader| reader.join());
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}
