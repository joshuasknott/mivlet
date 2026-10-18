//! Claude Agent SDK transport and provider tool handling.
use super::*;

fn provider_tool_kind(tool_name: &str) -> &'static str {
    match tool_name.to_ascii_lowercase().as_str() {
        "read" => "read",
        "glob" | "grep" | "websearch" | "codesearch" => "search",
        "webfetch" => "fetch",
        "write" | "edit" | "multiedit" | "notebookedit" => "edit",
        "bash" | "shell" | "execute" => "execute",
        _ => "other",
    }
}

fn respond_to_unsupported_claude_control(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) {
    let Some(request_id) = value.get("request_id").and_then(Value::as_str) else {
        return;
    };
    let _ = write_json(
        stdin,
        "claude",
        &json!({
            "type":"control_response",
            "response":{
                "subtype":"error",
                "request_id":request_id,
                "error":"Mivlet does not expose this Claude control surface."
            }
        }),
    );
}

fn handle_claude_line(
    app: &AppHandle,
    channel: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    value: &Value,
    tool_bridge: &Arc<Mutex<ToolBridge>>,
    emitted_text: &mut bool,
) -> bool {
    if value.get("type").and_then(Value::as_str) == Some("control_request") {
        let request_id = value
            .get("request_id")
            .and_then(Value::as_str)
            .unwrap_or("permission")
            .to_string();
        let subtype = value.pointer("/request/subtype").and_then(Value::as_str);
        if subtype == Some("mcp_message")
            && value
                .pointer("/request/server_name")
                .and_then(Value::as_str)
                == Some("mivlet")
        {
            let dispatched = tool_bridge
                .lock()
                .map_err(|_| "Mivlet tools are unavailable.".to_string())
                .and_then(|mut bridge| bridge.dispatch(&request_id, &value["request"]["message"]));
            match dispatched {
                Ok(Dispatch::Reply(response)) => {
                    let _ = write_json(
                        stdin,
                        "claude",
                        &shared_tool_response(&request_id, response),
                    );
                }
                Ok(Dispatch::Call(event)) => {
                    let _ = app.emit(channel, event);
                }
                Err(_) => respond_to_unsupported_claude_control(stdin, value),
            }
        } else if subtype == Some("can_use_tool")
            && tool_bridge.lock().ok().is_some_and(|bridge| {
                bridge.owns(value["request"]["tool_name"].as_str().unwrap_or(""))
            })
        {
            // This admits only SDK dispatch. The actual MCP call still goes
            // through Mivlet's exact approval and scoped native executor.
            let _ = write_json(
                stdin,
                "claude",
                &json!({"type":"control_response",
                "response":{"subtype":"success","request_id":request_id,"response":{
                    "behavior":"allow","updatedInput":value["request"]["input"]}}}),
            );
        } else {
            respond_to_unsupported_claude_control(stdin, value);
        }
        return false;
    }
    if value.get("type").and_then(Value::as_str) == Some("control_cancel_request") {
        if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
            if let Ok(mut bridge) = tool_bridge.lock() {
                bridge.cancel(request_id);
            }
        }
        return false;
    }
    if value.get("type").and_then(Value::as_str) == Some("stream_event")
        && value.pointer("/event/delta/type").and_then(Value::as_str) == Some("text_delta")
    {
        if let Some(text) = value.pointer("/event/delta/text").and_then(Value::as_str) {
            *emitted_text = true;
            let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
        }
    }
    if value.get("type").and_then(Value::as_str) == Some("result") {
        if !*emitted_text {
            if let Some(text) = value.get("result").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
            }
        }
        let input = value
            .pointer("/usage/input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let output = value
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let cost = value.get("total_cost_usd").and_then(Value::as_f64);
        let read = value
            .pointer("/usage/cache_read_input_tokens")
            .and_then(Value::as_u64);
        let write = value
            .pointer("/usage/cache_creation_input_tokens")
            .and_then(Value::as_u64);
        if input > 0
            || output > 0
            || read.unwrap_or(0) > 0
            || write.unwrap_or(0) > 0
            || cost.is_some()
        {
            let _ = app.emit(
                channel,
                json!({"type":"usage","inputTokens":input.saturating_add(read.unwrap_or(0)),
                    "outputTokens":output,"costUsd":cost,"costEstimated":true,
                    "cachedInputTokens":read,"cacheWriteTokens":write}),
            );
        }
        if value.get("is_error").and_then(Value::as_bool) == Some(true) {
            let provider_message = value
                .get("result")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/errors/0").and_then(Value::as_str))
                .unwrap_or("Claude execution failed.");
            let message = safe_error_message(provider_message, "Claude execution failed.");
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
        } else {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
        }
        return true;
    }
    false
}

pub(super) fn start_claude_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    let provider_id = request.provider_id.clone();
    if provider_id != "claude" {
        return Err("This provider does not use the Claude agent adapter.".into());
    }
    let path =
        find_executable(&provider_id).ok_or_else(|| missing_runtime_message(&provider_id))?;
    let workspace = workspace_dir(&app, &user_id, &provider_id)?;
    let prompt = image_input::user_message(&request.request, &request.options)?;
    let tool_bridge = Arc::new(Mutex::new(ToolBridge::new(&request.request.tools)?));
    let mut command = command_for_provider(&app, &user_id, &provider_id, &path)?;
    sdk_launch::configure(&mut command, &request.request.model);
    command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start Claude.".to_string())?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or_else(|| "Claude stdin was unavailable.".to_string())?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Claude stderr was unavailable.".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the Claude turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                owner: user_id.clone(),
                provider_id: provider_id.clone(),
                stdin: Some(stdin.clone()),
                child: child.clone(),
                session_id: Arc::new(Mutex::new(None)),
                permissions: permissions.clone(),
                opencode: None,
                tool_bridge: tool_bridge.clone(),
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/{provider_id}/{request_id}");
    thread::spawn(move || {
        let stderr_thread = thread::spawn(move || read_limited(stderr, MAX_COMMAND_OUTPUT));
        let initialize_id = format!("mivlet-init-{request_id}");
        let usage_run_id = request.options._run_id.clone();
        let mut prompt_sent = false;
        let mut completed = false;
        let mut emitted_text = false;
        let initialize = json!({
            "type":"control_request",
            "request_id":initialize_id,
            "request":{"subtype":"initialize"}
        });
        if let Err(message) = write_json(&stdin, "claude", &initialize) {
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
        }
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if crate::backends::require_current_internal_user()
                .ok()
                .as_ref()
                != Some(&user_id)
            {
                break;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if crate::provider_usage::claude_event_is_limit(&value) {
                crate::provider_usage::record_limit_failure("claude", usage_run_id.as_deref());
            }
            if !prompt_sent
                && value.get("type").and_then(Value::as_str) == Some("control_response")
                && value
                    .pointer("/response/request_id")
                    .and_then(Value::as_str)
                    == Some(initialize_id.as_str())
            {
                if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
                    let _ = app.emit(
                        &channel,
                        json!({"type":"error","message":"Claude rejected Mivlet's SDK initialization."}),
                    );
                    break;
                }
                if write_json(&stdin, "claude", &prompt).is_err() {
                    break;
                }
                prompt_sent = true;
                continue;
            }
            if handle_claude_line(
                &app,
                &channel,
                &stdin,
                &value,
                &tool_bridge,
                &mut emitted_text,
            ) {
                completed = true;
                break;
            }
        }
        if let Ok(mut bridge) = tool_bridge.lock() {
            bridge.stop();
        }
        if let Ok(mut provider_child) = child.lock() {
            let _ = provider_child.kill();
        }
        let _ = child.lock().ok().and_then(|mut child| child.wait().ok());
        let stderr_text = stderr_thread.join().unwrap_or_default();
        if !completed {
            let message = safe_error_message(&stderr_text, "Claude execution failed.");
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}
