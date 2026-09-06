//! Opt-in native smoke check using the signed-in workspace and normal executor.
//! The report contains no account identifiers, credentials, or returned source data.

use serde_json::{json, Value};
use tauri::{Listener, Manager};

pub fn run() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            crate::store::initialize(&crate::paths::app_data_dir(&handle)?)?;
            crate::connector_auth::provision_connector_configuration()?;
            app.manage(std::sync::Arc::new(
                crate::local_computer::LocalComputerState::initialize(&handle)?,
            ));
            tauri::async_runtime::spawn(async move {
                let args: Vec<_> = std::env::args().collect();
                let report = if let Some(index) = args.iter().position(|arg| arg == "--connect") {
                    reconnect(
                        &handle,
                        args.get(index + 1).map(String::as_str).unwrap_or(""),
                    )
                    .await
                } else if args.iter().any(|arg| arg == "--chat") {
                    check_chat(&handle).await
                } else {
                    check(&handle).await
                };
                let failed = report.get("error").is_some()
                    || report.get("completed") == Some(&json!(false))
                    || report
                        .get("connectors")
                        .and_then(Value::as_array)
                        .is_some_and(|rows| {
                            rows.iter()
                                .any(|row| row.get("read") == Some(&json!("failed")))
                        });
                println!("{}", report);
                handle.exit(if failed { 1 } else { 0 });
            });
            Ok(())
        })
        .run(context)
        .expect("Could not start native connector check");
}

async fn reconnect(app: &tauri::AppHandle, connector_id: &str) -> Value {
    let manifests =
        crate::connectors::list_connector_statuses(app.clone(), None).unwrap_or_default();
    let Some(manifest) = manifests
        .into_iter()
        .find(|manifest| manifest.id == connector_id)
    else {
        return json!({"error":"Unknown connector"});
    };
    let request = crate::models::ConnectorAuthRequest {
        connector_id: connector_id.into(),
        redirect_uri: None,
        callback_url: None,
        requested_scopes: Some(manifest.scopes.into_iter().map(|scope| scope.id).collect()),
    };
    match crate::connectors::begin_connector_oauth(app.clone(), request, None).await {
        Ok(result) => json!({"connector":connector_id,"status":result.status}),
        Err(error) => json!({"connector":connector_id,"error":error.message}),
    }
}

async fn check_chat(app: &tauri::AppHandle) -> Value {
    let input: Value = match serde_json::from_reader(std::io::stdin()) {
        Ok(input) => input,
        Err(_) => return json!({"error": "Provide connector tool schemas on stdin."}),
    };
    let scope = match crate::authorized_scope::active_command_scope(
        crate::authorized_scope::ScopeAccess::Read,
    ) {
        Ok(scope) => scope,
        Err(error) => return json!({"error": error}),
    };
    let statuses = crate::connectors::list_connector_statuses(
        app.clone(),
        Some(scope.data.workspace_id().into()),
    )
    .unwrap_or_default();
    let connected: Vec<_> = statuses
        .iter()
        .filter(|status| status.status == "connected")
        .map(|status| status.id.as_str())
        .collect();
    let allowed: Vec<Value> = input["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|tool| {
            tool["name"].as_str().is_some_and(|name| {
                name.strip_suffix("-read")
                    .is_some_and(|id| connected.contains(&id))
            })
        })
        .cloned()
        .collect();
    if allowed.is_empty() {
        return json!({"error": "No connected read adapters are available."});
    }
    let request_id = format!("connector-check-{}", std::process::id());
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let listener = app.listen(format!("fable://codex/{request_id}"), move |event| {
        if let Ok(value) = serde_json::from_str(event.payload()) {
            let _ = sender.send(value);
        }
    });
    let request = serde_json::from_value(json!({
        "requestId": request_id, "providerId": "codex", "request": {
            "model": input["model"], "reasoningEffort": "low", "maxTokens": 1024, "tools": allowed,
            "messages": [{"role":"user", "content":"Check each supplied connected app with one read call. Use limit 1 for search/list operations. Choose search with empty query for Gmail and Drive, calendars for Calendar, repositories.list for GitHub. Do not read message bodies or file contents. Then report completion. Tool results intentionally contain only diagnostic counts, not source content."}]
        }, "options": {"permissionMode": "read-only"}
    })).expect("native chat check request");
    if let Err(error) = crate::codex_app_server::start_codex_app_server_turn(app.clone(), request) {
        app.unlisten(listener);
        return json!({"error": error});
    }
    let started = std::time::Instant::now();
    let mut first_event_ms = None;
    let mut calls = Vec::new();
    let mut completed = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, receiver.recv()).await {
        if first_event_ms.is_none()
            && matches!(
                event["type"].as_str(),
                Some("text-delta" | "approval-request")
            )
        {
            first_event_ms = Some(started.elapsed().as_millis());
        }
        match event["type"].as_str().unwrap_or("") {
            "approval-request" => {
                let tool = event["tool"].as_str().unwrap_or("");
                let arguments: Value =
                    serde_json::from_str(event["arguments"].as_str().unwrap_or("{}"))
                        .unwrap_or(json!({}));
                let mut output = json!({"error":"Unexpected tool"});
                let mut ok = false;
                if allowed.iter().any(|spec| spec["name"] == tool)
                    && crate::tools::tool_policy(tool).is_some()
                {
                    let data: Vec<_> = arguments
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(key, value)| {
                            format!(
                                "{key}: {}",
                                value
                                    .as_str()
                                    .map(str::to_string)
                                    .unwrap_or_else(|| value.to_string())
                            )
                        })
                        .collect();
                    let now = chrono::Utc::now().to_rfc3339();
                    let request = serde_json::from_value(json!({"tool":tool,"arguments":arguments,"workspaceId":scope.data.workspace_id(),
                        "approval":{"decision":"once","decidedAt":now,"request":{"id":event["callId"],"service":"Codex","action":tool,"mode":"read-only","riskLevel":crate::tools::tool_policy(tool).unwrap().1,"dataUsed":data,"consequence":"Read connected source","requestedAt":now,"decisions":["once","deny"]}}})).expect("read request");
                    match crate::tools::execute_tool_call(app.clone(), request, app.state()).await {
                        Ok(result) if result.ok => {
                            ok = true;
                            output = json!({"read":"passed","resultBytes":result.output.len()});
                        }
                        Ok(_) => output = json!({"error":"Native read returned failure"}),
                        Err(error) => output = json!({"error":error}),
                    }
                }
                calls.push(json!({"tool":tool,"ok":ok,"result":output}));
                let response = serde_json::from_value(json!({"requestId":request_id,"approvalRequestId":event["requestId"],"result":{"callId":event["callId"],"ok":ok,"output":output.to_string()}})).expect("tool response");
                if crate::codex_app_server::respond_codex_app_server_approval(response, app.state())
                    .is_err()
                {
                    break;
                }
            }
            "done" => {
                completed = true;
                break;
            }
            "error" | "cancelled" | "process-exited" => break,
            _ => {}
        }
    }
    let _ = crate::codex_app_server::shutdown_codex_app_server_turn(request_id);
    app.unlisten(listener);
    let all_read = allowed.iter().all(|spec| {
        calls
            .iter()
            .any(|call| call["tool"] == spec["name"] && call["ok"] == true)
    });
    json!({"completed":completed && all_read,"firstEventMs":first_event_ms,"elapsedMs":started.elapsed().as_millis(),"toolCalls":calls})
}

async fn check(app: &tauri::AppHandle) -> Value {
    let scope = match crate::authorized_scope::active_command_scope(
        crate::authorized_scope::ScopeAccess::Read,
    ) {
        Ok(scope) => scope,
        Err(error) => return json!({"error": error}),
    };
    let statuses = match crate::connectors::list_connector_statuses(
        app.clone(),
        Some(scope.data.workspace_id().into()),
    ) {
        Ok(statuses) => statuses,
        Err(error) => return json!({"error": error.message}),
    };
    let mut report = Vec::new();
    for connector in statuses
        .into_iter()
        .filter(|connector| connector.id != "local-files")
    {
        let mut row = json!({"connector": connector.id, "status": connector.status});
        if connector.status == "connected" {
            let spec = match connector.id.as_str() {
                "gmail" => Some((
                    "gmail-read",
                    json!({"operation": "search", "query": "", "limit": 1}),
                )),
                "google-drive" => Some((
                    "google-drive-read",
                    json!({"operation": "search", "query": "", "limit": 1}),
                )),
                "google-calendar" => {
                    Some(("google-calendar-read", json!({"operation": "calendars"})))
                }
                "github" => Some((
                    "github-read",
                    json!({"capability": "repositories.list", "input": {"limit": 1}}),
                )),
                "vercel" => Some((
                    "vercel-read",
                    json!({"capability": "projects.read", "input": {"limit": 1}}),
                )),
                "linear" => Some((
                    "linear-read",
                    json!({"capability": "issues.read", "input": {"limit": 1}}),
                )),
                "notion" => Some(("search-notion", json!({"query": "", "limit": 1}))),
                "slack" => Some(("search-slack", json!({"query": "in:general", "limit": 1}))),
                _ => None,
            };
            if let Some((tool, arguments)) = spec {
                let data: Vec<String> = arguments
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| {
                        format!(
                            "{key}: {}",
                            value
                                .as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| value.to_string())
                        )
                    })
                    .collect();
                let now = chrono::Utc::now().to_rfc3339();
                let request = serde_json::from_value(json!({
                    "tool": tool, "arguments": arguments, "workspaceId": scope.data.workspace_id(),
                    "approval": {"decision": "once", "decidedAt": now, "request": {
                        "id": format!("connector-check-{}-{}", std::process::id(), connector.id), "service": "Fable",
                        "action": tool, "mode": "read-only", "riskLevel": crate::tools::tool_policy(tool).unwrap().1, "dataUsed": data,
                        "consequence": "Read connected source", "requestedAt": now, "decisions": ["once", "deny"]
                    }}
                })).expect("native check request");
                match crate::tools::execute_tool_call(app.clone(), request, app.state()).await {
                    Ok(result) if result.ok => {
                        row["read"] = json!("passed");
                        row["resultBytes"] = json!(result.output.len());
                    }
                    Ok(result) => {
                        row["read"] = json!("failed");
                        row["error"] = json!(result.output);
                    }
                    Err(error) => {
                        row["read"] = json!("failed");
                        row["error"] = json!(error);
                    }
                }
            } else {
                row["read"] = json!("not checked");
            }
        }
        report.push(row);
    }
    json!({"connectors": report})
}
