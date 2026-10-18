use super::*;

pub(super) fn codex_cli_status() -> CodexCliStatus {
    let Some(path) = find_codex_executable() else {
        return CodexCliStatus {
            installed: false,
            authenticated: false,
            auth_method: None,
            version: None,
            message: Some(missing_codex_runtime_message()),
        };
    };

    let version = codex_command(&path)
        .ok()
        .and_then(|mut command| command.arg("--version").output().ok())
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .filter(|value| !value.is_empty());

    // `codex login status` exposes only whether the provider-owned session is
    // usable and its broad login kind. Mivlet never reads auth.json or tokens.
    let login = codex_command(&path)
        .ok()
        .and_then(|mut command| command.args(["login", "status"]).output().ok());
    let authenticated = login.as_ref().is_some_and(|output| output.status.success());
    let login_copy = login
        .as_ref()
        .map(|output| {
            format!(
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
            .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let auth_method = if !authenticated {
        None
    } else if login_copy.contains("api key") {
        Some("api-key".to_string())
    } else if login_copy.contains("chatgpt") {
        Some("chatgpt".to_string())
    } else {
        Some("provider-login".to_string())
    };

    CodexCliStatus {
        installed: true,
        authenticated,
        auth_method,
        version,
        message: if authenticated {
            None
        } else {
            Some("The Codex runtime is installed but not signed in.".to_string())
        },
    }
}

/// Ask the installed app-server for its current model catalog.
///
/// Codex owns both authentication and model availability. Keeping this lookup
/// at the native process boundary avoids stale hardcoded model IDs without
/// exposing any auth material to JavaScript.
pub(super) fn codex_model_catalog() -> Result<Vec<CodexModelCatalogEntry>, String> {
    let path = find_codex_executable().ok_or_else(missing_codex_runtime_message)?;
    let mut command = codex_command(&path)?;
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });

    let request_result = (|| {
        write_json_line(
            &stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "mivlet",
                        "title": "Mivlet",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true,
                        "requestAttestation": false
                    }
                }
            }),
        )?;
        write_json_line(&stdin, &json!({ "method": "initialized" }))?;
        write_json_line(
            &stdin,
            &json!({
                "id": 2,
                "method": "model/list",
                "params": { "limit": 100 }
            }),
        )?;

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex app-server did not return its model list.".to_string());
            }
            let value = receiver
                .recv_timeout(remaining)
                .map_err(|_| "Codex app-server did not return its model list.".to_string())?;
            if value.get("id").and_then(Value::as_i64) != Some(2) {
                continue;
            }
            if value.get("error").is_some() {
                return Err("Codex app-server could not list available models.".to_string());
            }

            let mut models = value
                .pointer("/result/data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|model| {
                    !model
                        .get("hidden")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .filter_map(|model| {
                    let id = model.get("model").and_then(Value::as_str)?.trim();
                    if id.is_empty() {
                        return None;
                    }
                    let label = model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|label| !label.is_empty())
                        .unwrap_or(id);
                    Some(CodexModelCatalogEntry {
                        id: id.to_string(),
                        label: label.to_string(),
                        reasoning: model_reasoning(model),
                        fast_mode: model_fast_mode(model),
                        supports_images: model
                            .get("inputModalities")
                            .and_then(Value::as_array)
                            .is_some_and(|items| {
                                items.iter().any(|item| item.as_str() == Some("image"))
                            }),
                        is_default: model
                            .get("isDefault")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>();
            models.sort_by_key(|model| !model.is_default);
            if models.is_empty() {
                return Err("Codex app-server returned no available models.".to_string());
            }
            if let Ok(mut catalog) = IMAGE_MODELS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
            {
                catalog.clear();
                for model in &models {
                    catalog.insert(model.id.clone(), (model.supports_images, Instant::now()));
                }
            }
            return Ok(models);
        }
    })();

    let _ = child.kill();
    let _ = child.wait();
    request_result
}
