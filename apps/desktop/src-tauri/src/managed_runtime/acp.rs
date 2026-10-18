//! ACP transport, discovery, prompt framing, and approval handling.
use super::*;

pub(super) fn write_json(
    stdin: &Arc<Mutex<ChildStdin>>,
    provider_id: &str,
    value: &Value,
) -> Result<(), String> {
    let mut input = stdin
        .lock()
        .map_err(|_| format!("{} stdin is unavailable.", provider_label(provider_id)))?;
    serde_json::to_writer(&mut *input, value)
        .map_err(|_| "Mivlet could not encode an ACP request.".to_string())?;
    input
        .write_all(b"\n")
        .and_then(|_| input.flush())
        .map_err(|_| {
            format!(
                "Mivlet could not write to {} ACP.",
                provider_label(provider_id)
            )
        })
}

fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc":"2.0",
        "id":id,
        "method":"initialize",
        "params":{
            "protocolVersion":1,
            "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
            "clientInfo":{"name":"Mivlet","title":"Mivlet","version":env!("CARGO_PKG_VERSION")}
        }
    })
}

fn auth_method(provider_id: &str) -> &'static str {
    match provider_id {
        "cursor" => "cursor_login",
        "grok" => "cached_token",
        _ => "",
    }
}

fn validate_initialize(provider_id: &str, value: &Value) -> Result<(), String> {
    if value.get("error").is_some() {
        return Err(format!(
            "{} ACP initialization failed.",
            provider_label(provider_id)
        ));
    }
    let protocol = value
        .pointer("/result/protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let methods = value
        .pointer("/result/authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let expected = auth_method(provider_id);
    let supports_auth = methods.is_empty()
        || methods.iter().any(|method| {
            method.as_str() == Some(expected)
                || method.get("id").and_then(Value::as_str) == Some(expected)
        });
    if protocol == 1 && supports_auth {
        Ok(())
    } else {
        Err(format!(
            "The installed {} runtime did not expose the expected ACP contract.",
            provider_label(provider_id)
        ))
    }
}

pub(super) fn extract_acp_models(value: &Value) -> Vec<BackendModel> {
    let result = value.get("result").unwrap_or(value);
    let model_state = result
        .get("models")
        .or_else(|| result.pointer("/_meta/modelState"));
    let direct = model_state
        .and_then(|state| state.get("availableModels"))
        .and_then(Value::as_array);
    let configured = result
        .get("configOptions")
        .and_then(Value::as_array)
        .and_then(|options| {
            options
                .iter()
                .find(|option| option.get("id").and_then(Value::as_str) == Some("model"))
        })
        .and_then(|option| option.get("options"))
        .and_then(Value::as_array);
    let mut seen = HashSet::new();
    direct
        .or(configured)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model
                .get("modelId")
                .or_else(|| model.get("value"))
                .and_then(Value::as_str)?
                .trim();
            if id.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            let label = model
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id)
                .trim();
            Some(BackendModel {
                id: id.to_string(),
                label: label.to_string(),
                available: true,
                capabilities: None,
                reasoning: None,
                fast_mode: None,
            })
        })
        .take(32)
        .collect()
}

fn acp_command(
    app: &AppHandle,
    user_id: &str,
    provider_id: &str,
    workspace: &Path,
) -> Result<Command, String> {
    let path = find_executable(provider_id).ok_or_else(|| {
        format!(
            "Install the official {} runtime first.",
            provider_label(provider_id)
        )
    })?;
    let mut command = command_for_provider(app, user_id, provider_id, &path)?;
    match provider_id {
        "cursor" => {
            command.arg("acp");
        }
        "grok" => {
            command.args(["agent", "stdio"]);
        }
        _ => return Err("This provider does not expose an ACP runtime.".into()),
    }
    command
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    Ok(command)
}

pub(super) fn prompt_text(request: &ManagedAgentRequest, options: &ManagedTurnOptions) -> String {
    let mut parts = Vec::new();
    if let Some(prefix) = options
        .context_prefix
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(prefix.to_string());
    }
    let history = request
        .messages
        .iter()
        .map(|message| format!("{}: {}", message.role, message.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    if !history.is_empty() {
        parts.push(history);
    }
    parts.join("\n\n")
}

fn normalized_permission_mode(mode: &str) -> &'static str {
    match mode {
        "read-only" => "read-only",
        "full-access" => "full-access",
        _ => "trusted-scope",
    }
}

pub(super) fn managed_approval_payload(
    provider_id: &str,
    run_id: &str,
    request_id: &str,
    call_id: &str,
    tool_kind: &str,
    title: &str,
    arguments: &Value,
    mode: &str,
) -> Value {
    let title = crate::paths::truncate_characters(&crate::paths::normalize_spaces(title), 120);
    let arguments = crate::store::repos::action_history::redact_safe_detail(arguments);
    let arguments_text = crate::paths::truncate_characters(&arguments.to_string(), 2_000);
    let permission_mode = normalized_permission_mode(mode);
    let label = provider_label(provider_id);
    json!({
        "type":"approval-request",
        "requestId":request_id,
        "callId":call_id,
        "tool":format!("{provider_id}:{tool_kind}"),
        "arguments":arguments_text.clone(),
        "approval":{
            "id":crate::paths::truncate_characters(&format!("{provider_id}-{run_id}-{request_id}"),120),
            "service":provider_id,
            "action":title.clone(),
            "mode":permission_mode,
            "riskLevel":if permission_mode == "full-access" { "high" } else { "medium" },
            "dataUsed":[arguments_text],
            "consequence":format!("Allow {label} to {title}."),
            "requestedAt":chrono::Utc::now().to_rfc3339(),
            "decisions":["once","deny"],
            "confirmationPhrase":if permission_mode == "full-access" { Value::String(format!("approve {} action", provider_id)) } else { Value::Null }
        }
    })
}

pub(super) fn acp_approval_payload(
    provider_id: &str,
    run_id: &str,
    request_id: &str,
    value: &Value,
    mode: &str,
) -> (Value, Option<PendingPermission>) {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let tool = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let call_id = tool
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or(request_id)
        .to_string();
    let title = tool
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("perform this provider action");
    let kind = tool.get("kind").and_then(Value::as_str).unwrap_or("other");
    let args = tool.get("rawInput").cloned().unwrap_or_else(|| json!({}));
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let allow = options
        .iter()
        .find(|option| {
            matches!(
                option.get("kind").and_then(Value::as_str),
                Some("allow_once")
                    | Some("allow-once")
                    | Some("allow_always")
                    | Some("allow-always")
            )
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let reject = options
        .iter()
        .find(|option| {
            matches!(
                option.get("kind").and_then(Value::as_str),
                Some("reject_once") | Some("reject-once")
            )
        })
        .and_then(|option| option.get("optionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let payload = managed_approval_payload(
        provider_id,
        run_id,
        request_id,
        &call_id,
        kind,
        title,
        &args,
        mode,
    );
    let pending = allow
        .zip(reject)
        .map(|(allow_option, reject_option)| PendingPermission::Acp {
            allow_option,
            reject_option,
        });
    (payload, pending)
}

fn respond_to_unsupported_extension(
    stdin: &Arc<Mutex<ChildStdin>>,
    provider_id: &str,
    value: &Value,
) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let Some(id) = value.get("id") else {
        return;
    };
    if method.starts_with("cursor/") || method.starts_with("x.ai/") {
        let _ = write_json(
            stdin,
            provider_id,
            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Mivlet does not expose that provider extension."}}),
        );
    }
}

fn handle_acp_line(
    app: &AppHandle,
    channel: &str,
    provider_id: &str,
    run_id: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    permissions: &Arc<Mutex<HashMap<String, PendingPermission>>>,
    value: Value,
    prompt_id: u64,
    permission_mode: &str,
) -> bool {
    if value.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        let request_id = value
            .get("id")
            .map(|id| id.to_string().trim_matches('"').to_string())
            .unwrap_or_else(|| "permission".into());
        let (payload, pending) =
            acp_approval_payload(provider_id, run_id, &request_id, &value, permission_mode);
        if let Some(pending) = pending {
            if let Ok(mut map) = permissions.lock() {
                map.insert(request_id, pending);
            }
            let _ = app.emit(channel, payload);
        } else {
            let _ = write_json(
                stdin,
                provider_id,
                &json!({"jsonrpc":"2.0","id":value.get("id").cloned().unwrap_or(Value::Null),"result":{"outcome":{"outcome":"cancelled"}}}),
            );
        }
        return false;
    }
    if value.get("method").and_then(Value::as_str) == Some("session/update") {
        let update = value.pointer("/params/update").unwrap_or(&Value::Null);
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("agent_message_chunk") {
            if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({"type":"text-delta","text":text}));
            }
        }
        return false;
    }
    respond_to_unsupported_extension(stdin, provider_id, &value);
    if value.get("id").and_then(Value::as_u64) == Some(prompt_id) {
        if let Some(error) = value.pointer("/error/message").and_then(Value::as_str) {
            let message = safe_error_message(error, "Managed ACP execution failed.");
            let _ = app.emit(channel, json!({"type":"error","message":message}));
            let _ = app.emit(channel, json!({"type":"done","finishReason":"error"}));
        } else {
            let _ = app.emit(channel, json!({"type":"done","finishReason":"stop"}));
        }
        return true;
    }
    false
}

pub(super) fn start_acp_turn(
    app: AppHandle,
    user_id: String,
    request: ManagedTurnRequest,
) -> Result<(), String> {
    let provider_id = request.provider_id.clone();
    if !ACP_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return Err("This provider does not use the managed ACP adapter.".into());
    }
    let workspace = workspace_dir(&app, &user_id, &provider_id)?;
    let mut child = crate::provider_process::SupervisedChild::spawn(acp_command(
        &app,
        &user_id,
        &provider_id,
        &workspace,
    )?)
    .map_err(|_| {
        format!(
            "Mivlet could not start {} ACP.",
            provider_label(&provider_id)
        )
    })?;
    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
        format!("{} stdin was unavailable.", provider_label(&provider_id))
    })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{} stdout was unavailable.", provider_label(&provider_id)))?;
    let child = Arc::new(Mutex::new(child));
    let session_id = Arc::new(Mutex::new(None));
    let permissions = Arc::new(Mutex::new(HashMap::new()));
    active_runs()
        .lock()
        .map_err(|_| "Mivlet could not register the managed ACP turn.".to_string())?
        .insert(
            request.request_id.clone(),
            ActiveRun {
                owner: user_id.clone(),
                provider_id: provider_id.clone(),
                stdin: Some(stdin.clone()),
                child: child.clone(),
                session_id: session_id.clone(),
                permissions: permissions.clone(),
                opencode: None,
                tool_bridge: Arc::new(Mutex::new(ToolBridge::default())),
            },
        );
    let request_id = request.request_id.clone();
    let channel = format!("mivlet://managed-runtime/{provider_id}/{request_id}");
    thread::spawn(move || {
        let outcome = (|| -> Result<(), String> {
            write_json(&stdin, &provider_id, &initialize_request(1))?;
            let reader = BufReader::new(stdout);
            let prompt_id = 5_u64;
            for line in reader.lines() {
                let line = line.map_err(|_| {
                    format!("{} ACP stopped unexpectedly.", provider_label(&provider_id))
                })?;
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match value.get("id").and_then(Value::as_u64) {
                    Some(1) => {
                        validate_initialize(&provider_id, &value)?;
                        let models = extract_acp_models(&value);
                        let _ = cache_models(&app, &user_id, &provider_id, &models);
                        write_json(
                            &stdin,
                            &provider_id,
                            &json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":auth_method(&provider_id)}}),
                        )?;
                    }
                    Some(2) if value.get("error").is_none() => write_json(
                        &stdin,
                        &provider_id,
                        &json!({"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":workspace,"mcpServers":[]}}),
                    )?,
                    Some(3) if value.get("error").is_none() => {
                        let sid = value
                            .pointer("/result/sessionId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                format!(
                                    "{} did not return an ACP session id.",
                                    provider_label(&provider_id)
                                )
                            })?
                            .to_string();
                        *session_id.lock().map_err(|_| {
                            format!(
                                "{} session state is unavailable.",
                                provider_label(&provider_id)
                            )
                        })? = Some(sid.clone());
                        let models = extract_acp_models(&value);
                        let _ = cache_models(&app, &user_id, &provider_id, &models);
                        let model = request.request.model.trim();
                        if !model.is_empty() && model != "default" && model != "grok-build" {
                            write_json(
                                &stdin,
                                &provider_id,
                                &json!({"jsonrpc":"2.0","id":4,"method":"session/set_model","params":{"sessionId":sid,"modelId":model}}),
                            )?;
                        } else {
                            let text = prompt_text(&request.request, &request.options);
                            write_json(
                                &stdin,
                                &provider_id,
                                &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":text}]}}),
                            )?;
                        }
                    }
                    Some(4) if value.get("error").is_none() => {
                        let sid = session_id
                            .lock()
                            .ok()
                            .and_then(|guard| guard.clone())
                            .ok_or_else(|| {
                                format!(
                                    "{} session state is unavailable.",
                                    provider_label(&provider_id)
                                )
                            })?;
                        let text = prompt_text(&request.request, &request.options);
                        write_json(
                            &stdin,
                            &provider_id,
                            &json!({"jsonrpc":"2.0","id":prompt_id,"method":"session/prompt","params":{"sessionId":sid,"prompt":[{"type":"text","text":text}]}}),
                        )?;
                    }
                    Some(2..=4) => {
                        return Err(value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("Managed ACP setup failed.")
                            .to_string())
                    }
                    _ => {}
                }
                if handle_acp_line(
                    &app,
                    &channel,
                    &provider_id,
                    &request_id,
                    &stdin,
                    &permissions,
                    value,
                    prompt_id,
                    request
                        .options
                        .permission_mode
                        .as_deref()
                        .unwrap_or("trusted-scope"),
                ) {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(message) = outcome {
            let _ = app.emit(&channel, json!({"type":"error","message":message}));
            let _ = app.emit(&channel, json!({"type":"done","finishReason":"error"}));
        }
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
        }
        if let Ok(mut runs) = active_runs().lock() {
            runs.remove(&request_id);
        }
        let _ = app.emit(&channel, json!({"type":"process-exited"}));
    });
    Ok(())
}
