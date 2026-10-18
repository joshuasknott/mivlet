use super::*;

#[derive(Debug)]
pub(crate) enum CodexBackendDiscoveryError {
    UnsupportedAccountRead,
    Unavailable {
        status: CodexCliStatus,
        message: String,
    },
}

pub(crate) struct CodexBackendSnapshot {
    pub(crate) status: CodexCliStatus,
    pub(crate) models: Vec<CodexModelCatalogEntry>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AccountReadOutcome {
    Authenticated(String),
    SignedOut,
    Unsupported,
    Malformed,
}

struct CodexAppServerClient {
    child: crate::provider_process::SupervisedChild,
    stdin: Arc<Mutex<ChildStdin>>,
    receiver: mpsc::Receiver<Value>,
    reader: Option<thread::JoinHandle<()>>,
}

pub(super) trait CodexRpcClient {
    fn send(&mut self, value: &Value) -> Result<(), String>;
    fn receive_response(&mut self, id: i64, deadline: Instant) -> Result<Value, String>;
}

impl CodexAppServerClient {
    fn start(path: &PathBuf) -> Result<Self, String> {
        let mut command = codex_command(path)?;
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
        let reader = thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            receiver,
            reader: Some(reader),
        })
    }

    fn receive_response_inner(&self, id: i64, deadline: Instant) -> Result<Value, String> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex app-server did not return the requested response.".into());
            }
            let value = self
                .receiver
                .recv_timeout(remaining)
                .map_err(|_| "Codex app-server did not return the requested response.")?;
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                return Ok(value);
            }
        }
    }

    fn shutdown(&mut self) {
        self.child.terminate();
        // A provider descendant can inherit stdout after the supervised root
        // exits on Unix. Dropping the handle keeps shutdown bounded; Windows
        // job supervision still terminates the complete provider tree.
        self.reader.take();
    }
}

impl CodexRpcClient for CodexAppServerClient {
    fn send(&mut self, value: &Value) -> Result<(), String> {
        write_json_line(&self.stdin, value)
    }

    fn receive_response(&mut self, id: i64, deadline: Instant) -> Result<Value, String> {
        self.receive_response_inner(id, deadline)
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        self.shutdown();
    }
}

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

    let version = codex_version(&path);
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

    status_for_auth(version, authenticated, auth_method)
}

/// Discover Codex auth and its current model catalog through one fresh
/// app-server process. Model availability is accepted only after account/read
/// proves that the provider-owned account is authenticated.
pub(super) fn codex_backend_snapshot() -> Result<CodexBackendSnapshot, CodexBackendDiscoveryError> {
    let Some(path) = find_codex_executable() else {
        return Ok(CodexBackendSnapshot {
            status: CodexCliStatus {
                installed: false,
                authenticated: false,
                auth_method: None,
                version: None,
                message: Some(missing_codex_runtime_message()),
            },
            models: Vec::new(),
        });
    };
    let version = codex_version(&path);
    let mut client = CodexAppServerClient::start(&path).map_err(|message| {
        CodexBackendDiscoveryError::Unavailable {
            status: status_for_auth(version.clone(), false, None),
            message,
        }
    })?;
    discover_backend_with_client(&mut client, version)
}

fn initialize_client(client: &mut impl CodexRpcClient, deadline: Instant) -> Result<(), String> {
    client.send(&json!({
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
    }))?;
    let response = client.receive_response(1, deadline)?;
    if response.get("error").is_some()
        || response.get("result").and_then(Value::as_object).is_none()
    {
        return Err("Codex app-server initialization failed.".into());
    }
    client.send(&json!({ "method": "initialized" }))
}

pub(super) fn discover_backend_with_client(
    client: &mut impl CodexRpcClient,
    version: Option<String>,
) -> Result<CodexBackendSnapshot, CodexBackendDiscoveryError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    initialize_client(client, deadline).map_err(|message| {
        CodexBackendDiscoveryError::Unavailable {
            status: status_for_auth(version.clone(), false, None),
            message,
        }
    })?;
    let account_response = client
        .send(&json!({
            "id": 2,
            "method": "account/read",
            "params": { "refreshToken": false }
        }))
        .and_then(|_| client.receive_response(2, deadline))
        .map_err(|message| CodexBackendDiscoveryError::Unavailable {
            status: status_for_auth(version.clone(), false, None),
            message,
        })?;
    let account_outcome = classify_account_read(&account_response);
    let auth_method = match account_outcome {
        AccountReadOutcome::Authenticated(auth_method) => auth_method,
        AccountReadOutcome::SignedOut => {
            return Ok(CodexBackendSnapshot {
                status: status_for_auth(version, false, None),
                models: Vec::new(),
            });
        }
        AccountReadOutcome::Unsupported => {
            return Err(CodexBackendDiscoveryError::UnsupportedAccountRead);
        }
        AccountReadOutcome::Malformed => {
            return Err(CodexBackendDiscoveryError::Unavailable {
                status: status_for_auth(version, false, None),
                message: "Codex app-server returned an invalid account response.".into(),
            });
        }
    };
    let status = status_for_auth(version, true, Some(auth_method));

    let model_response = client
        .send(&json!({
            "id": 3,
            "method": "model/list",
            "params": { "limit": 100 }
        }))
        .and_then(|_| client.receive_response(3, deadline))
        .map_err(|message| CodexBackendDiscoveryError::Unavailable {
            status: status.clone(),
            message,
        })?;
    let models = parse_model_list(&model_response).map_err(|message| {
        CodexBackendDiscoveryError::Unavailable {
            status: status.clone(),
            message,
        }
    })?;
    Ok(CodexBackendSnapshot { status, models })
}

fn codex_version(path: &PathBuf) -> Option<String> {
    codex_command(path)
        .ok()
        .and_then(|mut command| command.arg("--version").output().ok())
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .filter(|value| !value.is_empty())
}

fn status_for_auth(
    version: Option<String>,
    authenticated: bool,
    auth_method: Option<String>,
) -> CodexCliStatus {
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

pub(super) fn classify_account_read(value: &Value) -> AccountReadOutcome {
    if value.get("error").is_some() {
        return if is_unsupported_account_read(value) {
            AccountReadOutcome::Unsupported
        } else {
            AccountReadOutcome::SignedOut
        };
    }
    let Some(account) = value.pointer("/result/account") else {
        return AccountReadOutcome::Malformed;
    };
    if account.is_null() {
        return AccountReadOutcome::SignedOut;
    }
    let Some(account_type) = account
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return AccountReadOutcome::Malformed;
    };
    let auth_method = match account_type.to_ascii_lowercase().as_str() {
        "chatgpt" => "chatgpt",
        "apikey" => "api-key",
        _ => return AccountReadOutcome::Malformed,
    };
    AccountReadOutcome::Authenticated(auth_method.to_string())
}

fn is_unsupported_account_read(value: &Value) -> bool {
    let Some(error) = value.get("error") else {
        return false;
    };
    if error.get("code").and_then(Value::as_i64) == Some(-32601) {
        return true;
    }
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(
        code,
        "method_not_found" | "method-not-found" | "unsupported_method" | "unsupported-method"
    ) {
        return true;
    }
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|message| {
            message.contains("method not found")
                || message.contains("unknown method")
                || message.contains("unsupported method")
        })
}

/// Ask the installed app-server for its current model catalog.
///
/// Codex owns both authentication and model availability. Keeping this lookup
/// at the native process boundary avoids stale hardcoded model IDs without
/// exposing any auth material to JavaScript.
pub(super) fn codex_model_catalog() -> Result<Vec<CodexModelCatalogEntry>, String> {
    let path = find_codex_executable().ok_or_else(missing_codex_runtime_message)?;
    let mut client = CodexAppServerClient::start(&path)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    initialize_client(&mut client, deadline)?;
    client.send(&json!({
        "id": 2,
        "method": "model/list",
        "params": { "limit": 100 }
    }))?;
    let response = client.receive_response(2, deadline)?;
    parse_model_list(&response)
}

fn parse_model_list(value: &Value) -> Result<Vec<CodexModelCatalogEntry>, String> {
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
                    .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("image"))),
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
    Ok(models)
}
