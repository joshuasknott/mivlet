//! Native-API transport boundary: Rust owns the API key + HTTP/SSE egress.
//!
//! TypeScript shapes the request body (pure, fixture-tested in
//! `@fable/connectors/native-api/`) and hands Rust an opaque
//! `{ providerId, requestId, model, body }`. Rust looks the key up from the
//! credential store, adds the provider-specific auth header, issues the
//! streaming `reqwest` request, and relays normalized SSE lines back over the
//! legacy Tauri event channel `arden://backend/<requestId>`. Its name remains
//! stable so existing runtime integrations continue to receive events.
//! the in-flight future via the cancel map.
//!
//! Hard invariants:
//!   - The API key never crosses into JavaScript — it is added to a header here.
//!   - No socket is opened in tests; only the pure helpers are unit-tested.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::backends::read_credential;
use tauri::{AppHandle, Emitter};

/// Which wire family a native provider speaks (selects endpoint + auth header).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    /// openai, xai, openrouter — Chat Completions format.
    OpenAiCompat,
    Anthropic,
    Gemini,
}

/// Map a provider id to its wire family.
pub fn provider_kind(provider_id: &str) -> ProviderKind {
    match provider_id {
        "anthropic" => ProviderKind::Anthropic,
        "gemini" => ProviderKind::Gemini,
        _ => ProviderKind::OpenAiCompat, // openai, xai, openrouter
    }
}

/// The provider-specific auth header. The key is never returned to JS — it is
/// placed into this header here, then sent on the request.
pub fn auth_header_for(provider_id: &str, key: &str) -> (String, String) {
    match provider_kind(provider_id) {
        ProviderKind::Anthropic => ("x-api-key".to_string(), key.to_string()),
        ProviderKind::Gemini => ("x-goog-api-key".to_string(), key.to_string()),
        ProviderKind::OpenAiCompat => ("Authorization".to_string(), format!("Bearer {key}")),
    }
}

/// The streaming endpoint URL for a provider. Vertex host selection for
/// Anthropic/Gemini under Vertex is a future extension; API-key hosts ship now.
pub fn endpoint_for(provider_id: &str) -> String {
    match provider_kind(provider_id) {
        ProviderKind::OpenAiCompat if provider_id == "xai" => {
            "https://api.x.ai/v1/chat/completions".to_string()
        }
        ProviderKind::OpenAiCompat if provider_id == "openrouter" => {
            "https://openrouter.ai/api/v1/chat/completions".to_string()
        }
        ProviderKind::OpenAiCompat => "https://api.openai.com/v1/chat/completions".to_string(),
        ProviderKind::Anthropic => "https://api.anthropic.com/v1/messages".to_string(),
        ProviderKind::Gemini => {
            "https://generativelanguage.googleapis.com/v1beta/models/streamGenerateContent"
                .to_string()
        }
    }
}

pub fn endpoint_for_model(provider_id: &str, model: &str) -> Result<String, String> {
    if provider_kind(provider_id) != ProviderKind::Gemini {
        return Ok(endpoint_for(provider_id));
    }
    if model.is_empty()
        || !model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-._".contains(character))
    {
        return Err("Gemini model id contains unsupported characters.".to_string());
    }
    Ok(format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    ))
}

/// Additional headers a provider requires beyond auth (e.g. anthropic-version).
pub fn extra_headers(provider_id: &str) -> Vec<(String, String)> {
    match provider_kind(provider_id) {
        ProviderKind::Anthropic => {
            vec![("anthropic-version".to_string(), "2023-06-01".to_string())]
        }
        _ => Vec::new(),
    }
}

/// Strip the SSE `data:` prefix; return None for blank lines, comments, [DONE].
pub fn normalize_sse_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let payload = trimmed
        .strip_prefix("data:")
        .map(str::trim)
        .unwrap_or(trimmed);
    if payload == "[DONE]" {
        return None;
    }
    Some(payload.to_string())
}

/// The opaque request TS hands to Rust. `body` is the provider-shaped JSON; the
/// API key is never present — Rust adds it as a header from the credential store.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStreamRequest {
    pub provider_id: String,
    pub request_id: String,
    /// The model name is also embedded in `body`; kept on the request so the
    /// transport contract is explicit even though Rust routes the body verbatim.
    pub model: String,
    pub body: serde_json::Value,
}

/// Cancel map: requestId -> oneshot sender. Dropping/sending cancels the future.
type CancelMap = HashMap<String, tokio::sync::watch::Sender<bool>>;
static CANCEL_MAP: OnceLock<Mutex<CancelMap>> = OnceLock::new();

fn cancel_map() -> &'static Mutex<CancelMap> {
    CANCEL_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Look up the key for a provider, preferring the OS keychain and falling back
/// to the in-memory store. Returns Err if neither has a credential — the
/// command then fails closed (no egress). The resolved key never crosses into
/// JavaScript; it is placed into a header here.
fn require_key(provider_id: &str) -> Result<String, String> {
    read_credential(provider_id)?.ok_or_else(|| format!("{provider_id} has no stored credential."))
}

const EVENT_CHANNEL_PREFIX: &str = "arden://backend/";
const MAX_ATTEMPTS: usize = 3;
const NATIVE_PROVIDER_IDS: [&str; 5] = ["openai", "anthropic", "gemini", "xai", "openrouter"];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportControlEvent<'a> {
    kind: &'a str,
    code: &'a str,
    message: String,
    retryable: bool,
    attempt: usize,
    retry_after_ms: Option<u64>,
}

fn retryable_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_after(response: &reqwest::Response, attempt: usize) -> Duration {
    let header_seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    Duration::from_millis(
        header_seconds
            .map(|seconds| seconds.saturating_mul(1_000))
            .unwrap_or_else(|| 250_u64.saturating_mul(2_u64.pow(attempt as u32)))
            .min(30_000),
    )
}

fn status_error_code(status: reqwest::StatusCode) -> &'static str {
    match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => "authentication",
        reqwest::StatusCode::TOO_MANY_REQUESTS => "rate-limited",
        status if status.is_server_error() => "provider-unavailable",
        _ => "invalid-request",
    }
}

fn emit_control(app: &AppHandle, channel: &str, event: TransportControlEvent<'_>) {
    if let Ok(payload) = serde_json::to_string(&serde_json::json!({
        "__fableTransport": event
    })) {
        let _ = app.emit(channel, payload);
    }
}

/// Stream a native-API completion. Looks up the key, issues the streaming
/// request, and emits each normalized SSE line as a Tauri event. Real
/// cancellation drops the future when `cancel_backend_completion` is called.
#[tauri::command]
pub async fn stream_backend_completion(
    app: AppHandle,
    request: BackendStreamRequest,
) -> Result<(), String> {
    if !NATIVE_PROVIDER_IDS.contains(&request.provider_id.as_str()) {
        return Err("Provider is not registered for native API egress.".to_string());
    }
    if request.request_id.is_empty()
        || request.request_id.len() > 160
        || !request
            .request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
    {
        return Err("Native provider request id is invalid.".to_string());
    }
    if request.body.to_string().len() > 2 * 1024 * 1024 {
        return Err("Native provider request body exceeds the supported limit.".to_string());
    }
    let key = require_key(&request.provider_id)?;
    let (auth_name, auth_value) = auth_header_for(&request.provider_id, &key);
    let url = endpoint_for_model(&request.provider_id, &request.model)?;
    let channel = format!("{EVENT_CHANNEL_PREFIX}{}", request.request_id);

    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|_| "Fable could not initialize the provider client.".to_string())?;
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the cancel map.".to_string())?
        .insert(request.request_id.clone(), tx);

    use futures_util::StreamExt;
    let mut cancelled = false;
    let mut completed = false;

    for attempt in 0..MAX_ATTEMPTS {
        let mut req = client
            .post(&url)
            .header(&auth_name, &auth_value)
            .json(&request.body);
        for (name, value) in extra_headers(&request.provider_id) {
            req = req.header(name, value);
        }

        let response = tokio::select! {
            changed = rx.changed() => {
                if changed.is_ok() && *rx.borrow() {
                    cancelled = true;
                    break;
                }
                continue;
            }
            response = req.send() => response
        };

        let response = match response {
            Ok(response) => response,
            Err(_) if attempt + 1 < MAX_ATTEMPTS => {
                let delay =
                    Duration::from_millis(250_u64.saturating_mul(2_u64.pow(attempt as u32)));
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "retrying",
                        code: "transport",
                        message: "Provider connection failed; retrying.".to_string(),
                        retryable: true,
                        attempt: attempt + 1,
                        retry_after_ms: Some(delay.as_millis() as u64),
                    },
                );
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    changed = rx.changed() => {
                        if changed.is_ok() && *rx.borrow() {
                            cancelled = true;
                            break;
                        }
                    }
                }
                if cancelled {
                    break;
                }
                continue;
            }
            Err(_) => {
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "error",
                        code: "transport",
                        message: "Provider connection failed after retrying.".to_string(),
                        retryable: true,
                        attempt: attempt + 1,
                        retry_after_ms: None,
                    },
                );
                completed = true;
                break;
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let retryable = retryable_status(status);
            if retryable && attempt + 1 < MAX_ATTEMPTS {
                let delay = retry_after(&response, attempt);
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "retrying",
                        code: status_error_code(status),
                        message: format!("Provider returned HTTP {status}; retrying."),
                        retryable: true,
                        attempt: attempt + 1,
                        retry_after_ms: Some(delay.as_millis() as u64),
                    },
                );
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    changed = rx.changed() => {
                        if changed.is_ok() && *rx.borrow() {
                            cancelled = true;
                            break;
                        }
                    }
                }
                if cancelled {
                    break;
                }
                continue;
            }
            emit_control(
                &app,
                &channel,
                TransportControlEvent {
                    kind: "error",
                    code: status_error_code(status),
                    message: format!("Provider request failed with HTTP {status}."),
                    retryable,
                    attempt: attempt + 1,
                    retry_after_ms: None,
                },
            );
            completed = true;
            break;
        }

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
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
                            buffer.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(newline_pos) = buffer.find('\n') {
                                let line: String = buffer.drain(..=newline_pos).collect();
                                if let Some(payload) = normalize_sse_line(&line) {
                                    let _ = app.emit(&channel, payload);
                                }
                            }
                        }
                        Some(Err(_)) => {
                            emit_control(&app, &channel, TransportControlEvent {
                                kind: "error",
                                code: "transport",
                                message: "Provider stream ended unexpectedly.".to_string(),
                                retryable: true,
                                attempt: attempt + 1,
                                retry_after_ms: None,
                            });
                            break;
                        }
                        None => {
                            completed = true;
                            break;
                        },
                    }
                }
            }
        }
        if !buffer.is_empty() && !cancelled {
            if let Some(payload) = normalize_sse_line(&buffer) {
                let _ = app.emit(&channel, payload);
            }
        }
        break;
    }

    let _ = cancel_map()
        .lock()
        .map(|mut map| map.remove(&request.request_id));
    let terminal = if cancelled { "[CANCELLED]" } else { "[DONE]" };
    let _ = app.emit(&channel, terminal);
    if !cancelled && !completed {
        return Err("Provider request ended without a terminal state.".to_string());
    }
    Ok(())
}

/// Cancel an in-flight completion by dropping its future (real cancellation).
#[tauri::command]
pub fn cancel_backend_completion(request_id: String) -> Result<bool, String> {
    let removed = cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the cancel map.".to_string())?
        .remove(&request_id);
    if let Some(sender) = removed {
        let _ = sender.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod transport_policy_tests {
    use super::*;

    #[test]
    fn retries_only_rate_limits_and_provider_failures() {
        assert!(retryable_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!retryable_status(reqwest::StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn gemini_stream_endpoint_is_bound_to_the_selected_model() {
        let endpoint = endpoint_for_model("gemini", "gemini-2.5-pro").expect("endpoint");
        assert!(endpoint.contains("/models/gemini-2.5-pro:streamGenerateContent"));
        assert!(endpoint.ends_with("alt=sse"));
        assert!(endpoint_for_model("gemini", "../escape?key=secret").is_err());
    }
}
