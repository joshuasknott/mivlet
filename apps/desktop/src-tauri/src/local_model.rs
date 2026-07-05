//! Local loopback model runtime integration.
//!
//! This module talks only to explicitly trusted literal-loopback runtimes such
//! as an externally managed Ollama service. It does not use the connector
//! web-fetch tool, does not store credentials, does not download models, and
//! never logs prompt/response payloads.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::models::{BackendModel, MAX_BACKEND_MODELS};
use tauri::{AppHandle, Emitter};
use url::{Host, Url};

const PROVIDER_ID: &str = "ollama";
const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
const LOCAL_CHANNEL_PREFIX: &str = "arden://local-model/";
const MAX_LOCAL_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOCAL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOCAL_DISCOVERY_BYTES: usize = 4 * 1024 * 1024;

type CancelMap = HashMap<String, tokio::sync::watch::Sender<bool>>;
static CANCEL_MAP: OnceLock<Mutex<CancelMap>> = OnceLock::new();

fn cancel_map() -> &'static Mutex<CancelMap> {
    CANCEL_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStreamRequest {
    pub provider_id: String,
    pub request_id: String,
    pub model: String,
    pub body: serde_json::Value,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelStatus {
    pub provider_id: String,
    pub auth_state: String,
    pub version: Option<String>,
    pub endpoint: Option<String>,
    pub message: String,
    pub models: Vec<BackendModel>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub outcome: &'static str,
    pub models: Vec<DiscoveredModel>,
    pub message: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportControlEvent<'a> {
    kind: &'a str,
    code: &'a str,
    message: String,
    retryable: bool,
}

pub fn local_loopback_base_url() -> String {
    std::env::var("FABLE_OLLAMA_BASE_URL").unwrap_or_else(|_| DEFAULT_OLLAMA_BASE_URL.to_string())
}

pub fn validate_literal_loopback_base_url(raw: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(raw).map_err(|_| "Local model endpoint is not a valid URL.".to_string())?;
    if url.scheme() != "http" {
        return Err("Local model endpoint must use http on a loopback address.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Local model endpoint must not include credentials.".to_string());
    }
    if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Local model endpoint must be a loopback base URL without a path, query, or fragment."
                .to_string(),
        );
    }
    match url.host() {
        Some(Host::Ipv4(addr)) if addr.is_loopback() => {}
        Some(Host::Ipv6(addr)) if addr.is_loopback() => {}
        _ => {
            return Err(
                "Local model endpoint must use a literal loopback IP such as 127.0.0.1."
                    .to_string(),
            )
        }
    }
    url.set_path("");
    Ok(url)
}

fn endpoint(path: &str) -> Result<Url, String> {
    let mut url = validate_literal_loopback_base_url(&local_loopback_base_url())?;
    url.set_path(path);
    Ok(url)
}

fn model_capabilities_from_show(show: &serde_json::Value) -> Option<serde_json::Value> {
    let caps: Vec<String> = show
        .get("capabilities")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_ascii_lowercase))
                .collect()
        })
        .unwrap_or_default();
    if !caps.iter().any(|cap| cap == "completion") {
        return None;
    }
    let context_window = context_length_from_show(show).unwrap_or(4096);
    Some(serde_json::json!({
        "contextWindow": context_window,
        "maxOutputTokens": 2048,
        "streaming": true,
        "tools": caps.iter().any(|cap| cap == "tools"),
        "vision": caps.iter().any(|cap| cap == "vision"),
        "reasoning": caps.iter().any(|cap| cap == "thinking"),
        "structuredOutput": true
    }))
}

fn context_length_from_show(show: &serde_json::Value) -> Option<u64> {
    show.get("model_info")
        .and_then(|value| value.as_object())
        .and_then(|object| {
            object
                .iter()
                .find(|(key, value)| key.ends_with(".context_length") && value.as_u64().is_some())
                .and_then(|(_, value)| value.as_u64())
        })
        .or_else(|| {
            let params = show.get("parameters")?.as_str()?;
            for line in params.lines() {
                let mut parts = line.split_whitespace();
                if parts.next() == Some("num_ctx") {
                    return parts.next().and_then(|value| value.parse::<u64>().ok());
                }
            }
            None
        })
}

fn parse_tags(body: &serde_json::Value) -> Vec<String> {
    body.get("models")
        .and_then(|value| value.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    model
                        .get("name")
                        .or_else(|| model.get("model"))
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                })
                .take(MAX_BACKEND_MODELS)
                .collect()
        })
        .unwrap_or_default()
}

async fn read_bounded_json(
    response: reqwest::Response,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let mut response = response;
    let mut total = 0usize;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Local model runtime response could not be read.".to_string())?
    {
        total = total.saturating_add(chunk.len());
        if total > limit {
            return Err("Local model runtime response exceeded Fable's size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Local model runtime returned malformed JSON.".to_string())
}

async fn ollama_cli_installed() -> bool {
    let command = tokio::process::Command::new("ollama")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    matches!(tokio::time::timeout(Duration::from_secs(2), command).await, Ok(Ok(status)) if status.success())
}

async fn discover_models_with_client(
    client: &reqwest::Client,
) -> Result<Vec<BackendModel>, String> {
    let tags_url = endpoint("/api/tags")?;
    let response = client
        .get(tags_url)
        .send()
        .await
        .map_err(|_| "Ollama model discovery is offline.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama model discovery returned HTTP {}.",
            response.status()
        ));
    }
    let tags = read_bounded_json(response, MAX_LOCAL_DISCOVERY_BYTES).await?;
    let ids = parse_tags(&tags);
    let mut models = Vec::new();
    for id in ids {
        let show_url = endpoint("/api/show")?;
        let response = client
            .post(show_url.as_str())
            .json(&serde_json::json!({ "model": id }))
            .send()
            .await;
        let capabilities = match response {
            Ok(response) if response.status().is_success() => {
                read_bounded_json(response, MAX_LOCAL_DISCOVERY_BYTES)
                    .await
                    .ok()
                    .and_then(|show| model_capabilities_from_show(&show))
            }
            _ => None,
        };
        models.push(BackendModel {
            id: id.clone(),
            label: id,
            available: capabilities.is_some(),
            capabilities,
        });
    }
    Ok(models)
}

#[tauri::command]
pub async fn detect_local_model_runtime(provider_id: String) -> Result<LocalModelStatus, String> {
    if provider_id != PROVIDER_ID {
        return Ok(LocalModelStatus {
            provider_id,
            auth_state: "unsupported".to_string(),
            version: None,
            endpoint: None,
            message: "Only Ollama is supported as a local loopback provider in this build."
                .to_string(),
            models: Vec::new(),
        });
    }
    let base = match validate_literal_loopback_base_url(&local_loopback_base_url()) {
        Ok(url) => url,
        Err(message) => {
            return Ok(LocalModelStatus {
                provider_id,
                auth_state: "unavailable".to_string(),
                version: None,
                endpoint: None,
                message,
                models: Vec::new(),
            })
        }
    };
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Fable could not initialize the local model client.".to_string())?;

    let version_url = endpoint("/api/version")?;
    let version_response = client.get(version_url).send().await;
    let version = match version_response {
        Ok(response) if response.status().is_success() => read_bounded_json(response, 64 * 1024)
            .await
            .ok()
            .and_then(|body| {
                body.get("version")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            }),
        Ok(response) => {
            return Ok(LocalModelStatus {
                provider_id,
                auth_state: "failed".to_string(),
                version: None,
                endpoint: Some(base.to_string()),
                message: format!(
                    "Ollama returned HTTP {} during version probing.",
                    response.status()
                ),
                models: Vec::new(),
            })
        }
        Err(_) => {
            let installed = ollama_cli_installed().await;
            return Ok(LocalModelStatus {
                provider_id,
                auth_state: if installed {
                    "start-required"
                } else {
                    "install-required"
                }
                .to_string(),
                version: None,
                endpoint: Some(base.to_string()),
                message: if installed {
                    "Ollama is installed, but its local service is not running.".to_string()
                } else {
                    "Install Ollama, then start its local service. Fable will not install it for you.".to_string()
                },
                models: Vec::new(),
            });
        }
    };

    let models = discover_models_with_client(&client)
        .await
        .unwrap_or_default();
    if models.is_empty() {
        return Ok(LocalModelStatus {
            provider_id,
            auth_state: "download-required".to_string(),
            version,
            endpoint: Some(base.to_string()),
            message: "Ollama is running, but no local generation models are installed. Pull a model in Ollama first.".to_string(),
            models,
        });
    }
    Ok(LocalModelStatus {
        provider_id,
        auth_state: "connected".to_string(),
        version,
        endpoint: Some(base.to_string()),
        message: "Ollama is running locally with at least one installed model.".to_string(),
        models,
    })
}

#[tauri::command]
pub async fn list_local_model_models(provider_id: String) -> Result<ModelDiscoveryResult, String> {
    if provider_id != PROVIDER_ID {
        return Ok(ModelDiscoveryResult {
            outcome: "unsupported",
            models: Vec::new(),
            message: Some("Only Ollama local model discovery is supported.".to_string()),
        });
    }
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "Fable could not initialize the local model client.".to_string())?;
    match discover_models_with_client(&client).await {
        Ok(models) => Ok(ModelDiscoveryResult {
            outcome: if models.is_empty() {
                "empty"
            } else {
                "success"
            },
            models: models
                .into_iter()
                .map(|model| DiscoveredModel {
                    id: model.id,
                    available: model.available,
                    capabilities: model.capabilities,
                })
                .collect(),
            message: None,
        }),
        Err(message) if message.contains("offline") => Ok(ModelDiscoveryResult {
            outcome: "offline",
            models: Vec::new(),
            message: Some(message),
        }),
        Err(message) => Ok(ModelDiscoveryResult {
            outcome: "failed",
            models: Vec::new(),
            message: Some(message),
        }),
    }
}

fn emit_control(app: &AppHandle, channel: &str, event: TransportControlEvent<'_>) {
    if let Ok(payload) = serde_json::to_string(&serde_json::json!({
        "__fableTransport": event
    })) {
        let _ = app.emit(channel, payload);
    }
}

fn normalize_chunk(chunk: &str) -> String {
    chunk.replace("\r\n", "\n").replace('\r', "\n")
}

fn validate_stream_request(request: &LocalModelStreamRequest) -> Result<(), String> {
    if request.provider_id != PROVIDER_ID {
        return Err("Provider is not registered for local model egress.".to_string());
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 160
        || !request
            .request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    {
        return Err("Local model request id is invalid.".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("Local model request needs a model.".to_string());
    }
    let Some(body) = request.body.as_object() else {
        return Err("Local model request body must be a JSON object.".to_string());
    };
    if body.get("model").and_then(|value| value.as_str()) != Some(request.model.as_str()) {
        return Err("Local model request body must match the selected model.".to_string());
    }
    if body.get("stream").and_then(|value| value.as_bool()) != Some(true) {
        return Err("Local model requests must use streaming generation.".to_string());
    }
    if request.body.to_string().len() > MAX_LOCAL_REQUEST_BYTES {
        return Err("Local model request body exceeds the supported limit.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn stream_local_model_completion(
    app: AppHandle,
    request: LocalModelStreamRequest,
) -> Result<(), String> {
    validate_stream_request(&request)?;
    let url = endpoint("/api/chat")?;
    let channel = format!("{LOCAL_CHANNEL_PREFIX}{}", request.request_id);
    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "Fable could not initialize the local model client.".to_string())?;
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the local model cancel map.".to_string())?
        .insert(request.request_id.clone(), tx);

    use futures_util::StreamExt;
    let mut cancelled = false;
    let mut completed = false;
    let response = tokio::select! {
        changed = rx.changed() => {
            if changed.is_ok() && *rx.borrow() {
                cancelled = true;
            }
            None
        }
        response = client.post(url).json(&request.body).send() => Some(response)
    };
    if let Some(response) = response {
        match response {
            Ok(response) if response.status().is_success() => {
                let mut stream = response.bytes_stream();
                let mut buffer = String::new();
                let mut response_bytes = 0usize;
                loop {
                    tokio::select! {
                        changed = rx.changed() => {
                            if changed.is_ok() && *rx.borrow() {
                                cancelled = true;
                                break;
                            }
                        }
                        chunk = stream.next() => {
                            match chunk {
                                Some(Ok(bytes)) => {
                                    response_bytes = response_bytes.saturating_add(bytes.len());
                                    if response_bytes > MAX_LOCAL_RESPONSE_BYTES {
                                        emit_control(&app, &channel, TransportControlEvent {
                                            kind: "error",
                                            code: "response-too-large",
                                            message: "Local model stream exceeded Fable's response-size limit.".to_string(),
                                            retryable: false,
                                        });
                                        completed = true;
                                        break;
                                    }
                                    buffer.push_str(&normalize_chunk(&String::from_utf8_lossy(&bytes)));
                                    while let Some(newline_pos) = buffer.find('\n') {
                                        let line: String = buffer.drain(..=newline_pos).collect();
                                        let trimmed = line.trim();
                                        if !trimmed.is_empty() {
                                            let _ = app.emit(&channel, trimmed.to_string());
                                        }
                                    }
                                }
                                Some(Err(_)) => {
                                    emit_control(&app, &channel, TransportControlEvent {
                                        kind: "error",
                                        code: "transport",
                                        message: "Local model stream ended unexpectedly.".to_string(),
                                        retryable: true,
                                    });
                                    completed = true;
                                    break;
                                }
                                None => {
                                    completed = true;
                                    break;
                                }
                            }
                        }
                    }
                }
                if !buffer.trim().is_empty() && !cancelled {
                    let _ = app.emit(&channel, buffer.trim().to_string());
                }
            }
            Ok(response) => {
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "error",
                        code: if response.status().as_u16() == 404 {
                            "invalid-request"
                        } else {
                            "transport"
                        },
                        message: format!(
                            "Local model request failed with HTTP {}.",
                            response.status()
                        ),
                        retryable: false,
                    },
                );
                completed = true;
            }
            Err(_) => {
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "error",
                        code: "transport",
                        message: "Could not reach the local model runtime.".to_string(),
                        retryable: true,
                    },
                );
                completed = true;
            }
        }
    }

    let _ = cancel_map()
        .lock()
        .map(|mut map| map.remove(&request.request_id));
    let terminal = if cancelled { "[CANCELLED]" } else { "[DONE]" };
    let _ = app.emit(&channel, terminal);
    crate::action_history::Recorder::new(
        crate::action_history::categories::MODEL_CALL,
        &request.provider_id,
        &request.model,
        if cancelled { "cancelled" } else { "ok" },
    )
    .actor("system")
    .correlation(&request.request_id)
    .summary(&format!(
        "{} model call via local {}",
        request.model, request.provider_id
    ))
    .record();
    if !cancelled && !completed {
        return Err("Local model request ended without a terminal state.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_local_model_completion(request_id: String) -> Result<bool, String> {
    let removed = cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the local model cancel map.".to_string())?
        .remove(&request_id);
    if let Some(sender) = removed {
        let _ = sender.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    static TEST_ENV_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

    async fn lock_test_env() -> tokio::sync::MutexGuard<'static, ()> {
        TEST_ENV_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await
    }

    fn restore_env(name: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    async fn spawn_fake_ollama() -> String {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake ollama");
        let endpoint = format!("http://{}", listener.local_addr().expect("local addr"));
        tokio::spawn(async move {
            for _ in 0..3 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = [0u8; 4096];
                let Ok(read) = socket.read(&mut request).await else {
                    return;
                };
                let request = String::from_utf8_lossy(&request[..read]);
                let request_line = request.lines().next().unwrap_or_default();
                let (status, body) = if request_line.starts_with("GET /api/version ") {
                    (
                        "200 OK",
                        serde_json::json!({ "version": "0.9.0" }).to_string(),
                    )
                } else if request_line.starts_with("GET /api/tags ") {
                    (
                        "200 OK",
                        serde_json::json!({
                            "models": [{ "name": "llama3.2:latest" }]
                        })
                        .to_string(),
                    )
                } else if request_line.starts_with("POST /api/show ") {
                    (
                        "200 OK",
                        serde_json::json!({
                            "license": "do not surface this",
                            "capabilities": ["completion", "tools"],
                            "model_info": { "llama.context_length": 8192 }
                        })
                        .to_string(),
                    )
                } else {
                    (
                        "404 Not Found",
                        serde_json::json!({ "error": "not found" }).to_string(),
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        endpoint
    }

    #[test]
    fn loopback_validation_rejects_non_literal_or_non_http_urls() {
        assert!(validate_literal_loopback_base_url("http://127.0.0.1:11434").is_ok());
        assert!(validate_literal_loopback_base_url("http://[::1]:11434").is_ok());
        assert!(validate_literal_loopback_base_url("http://localhost:11434").is_err());
        assert!(validate_literal_loopback_base_url("https://127.0.0.1:11434").is_err());
        assert!(validate_literal_loopback_base_url("http://192.168.1.2:11434").is_err());
        assert!(validate_literal_loopback_base_url("http://user:pass@127.0.0.1:11434").is_err());
        assert!(validate_literal_loopback_base_url("http://127.0.0.1:11434/api/tags").is_err());
    }

    #[test]
    fn parses_tags_and_model_capabilities_without_license_payload() {
        let tags = serde_json::json!({
            "models": [
                { "name": "llama3.2:latest" },
                { "model": "qwen2.5-coder:7b" },
                { "name": "" }
            ]
        });
        assert_eq!(
            parse_tags(&tags),
            vec!["llama3.2:latest", "qwen2.5-coder:7b"]
        );
        let show = serde_json::json!({
            "license": "large model license text",
            "capabilities": ["completion", "tools", "thinking"],
            "model_info": { "llama.context_length": 8192 }
        });
        let caps = model_capabilities_from_show(&show).expect("completion model");
        assert_eq!(caps["contextWindow"], 8192);
        assert_eq!(caps["tools"], true);
        assert!(caps.get("license").is_none());
    }

    #[test]
    fn validates_stream_request_model_and_stream_body() {
        let valid = LocalModelStreamRequest {
            provider_id: PROVIDER_ID.to_string(),
            request_id: "request-1".to_string(),
            model: "llama3.2".to_string(),
            body: serde_json::json!({
                "model": "llama3.2",
                "messages": [{ "role": "user", "content": "hello" }],
                "stream": true
            }),
        };
        assert!(validate_stream_request(&valid).is_ok());

        let mut wrong_model = LocalModelStreamRequest {
            body: serde_json::json!({
                "model": "other",
                "messages": [],
                "stream": true
            }),
            ..valid
        };
        assert!(validate_stream_request(&wrong_model)
            .expect_err("mismatched body model")
            .contains("selected model"));

        wrong_model.body = serde_json::json!({
            "model": "llama3.2",
            "messages": [],
            "stream": false
        });
        assert!(validate_stream_request(&wrong_model)
            .expect_err("non-streaming body")
            .contains("streaming"));
    }

    #[tokio::test]
    async fn fake_ollama_server_drives_discovery_contract() {
        let _guard = lock_test_env().await;
        let original = std::env::var("FABLE_OLLAMA_BASE_URL").ok();
        let endpoint = spawn_fake_ollama().await;
        std::env::set_var("FABLE_OLLAMA_BASE_URL", &endpoint);

        let status = detect_local_model_runtime(PROVIDER_ID.to_string())
            .await
            .expect("detect fake ollama");

        restore_env("FABLE_OLLAMA_BASE_URL", original);
        assert_eq!(status.auth_state, "connected");
        assert_eq!(status.version.as_deref(), Some("0.9.0"));
        let expected_endpoint = format!("{endpoint}/");
        assert_eq!(status.endpoint.as_deref(), Some(expected_endpoint.as_str()));
        assert_eq!(status.models.len(), 1);
        assert_eq!(status.models[0].id, "llama3.2:latest");
        assert!(status.models[0].available);
        assert!(status.models[0]
            .capabilities
            .as_ref()
            .expect("capabilities")["tools"]
            .as_bool()
            .expect("tools flag"));
    }

    #[tokio::test]
    async fn real_ollama_smoke_is_opt_in() {
        if std::env::var("FABLE_RUN_OLLAMA_SMOKE").ok().as_deref() != Some("1") {
            return;
        }
        let status = detect_local_model_runtime(PROVIDER_ID.to_string())
            .await
            .expect("detect real ollama");
        assert_eq!(status.auth_state, "connected");
        assert!(
            !status.models.is_empty(),
            "Ollama must have at least one local generation model installed"
        );
    }
}
