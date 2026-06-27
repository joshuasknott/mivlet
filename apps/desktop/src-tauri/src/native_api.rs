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
    #[allow(dead_code)]
    pub model: String,
    pub body: serde_json::Value,
}

/// Cancel map: requestId -> oneshot sender. Dropping/sending cancels the future.
type CancelMap = HashMap<String, tokio::sync::oneshot::Sender<()>>;
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

/// Stream a native-API completion. Looks up the key, issues the streaming
/// request, and emits each normalized SSE line as a Tauri event. Real
/// cancellation drops the future when `cancel_backend_completion` is called.
#[tauri::command]
pub async fn stream_backend_completion(
    app: AppHandle,
    request: BackendStreamRequest,
) -> Result<(), String> {
    let key = require_key(&request.provider_id)?;
    let (auth_name, auth_value) = auth_header_for(&request.provider_id, &key);
    let url = endpoint_for(&request.provider_id);

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .header(&auth_name, &auth_value)
        .json(&request.body);
    for (name, value) in extra_headers(&request.provider_id) {
        req = req.header(name, value);
    }

    // Register a cancel token for this request.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the cancel map.".to_string())?
        .insert(request.request_id.clone(), tx);

    use futures_util::StreamExt;
    use std::pin::Pin;
    let response = req.send().await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let channel = format!("{EVENT_CHANNEL_PREFIX}{}", request.request_id);
    let mut buffer = String::new();
    let mut cancelled = false;
    let mut rx = Pin::from(Box::new(rx));

    loop {
        tokio::select! {
            _ = &mut rx => { cancelled = true; break; }
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
                    Some(Err(e)) => {
                        let _ = app.emit(&channel, format!("{{\"__error__\":\"{}\"}}", e));
                        break;
                    }
                    None => break,
                }
            }
        }
    }

    // Flush any trailing buffered line without a newline.
    if !buffer.is_empty() {
        if let Some(payload) = normalize_sse_line(&buffer) {
            let _ = app.emit(&channel, payload);
        }
    }

    let _ = cancel_map()
        .lock()
        .map(|mut map| map.remove(&request.request_id));
    let _ = app.emit(&channel, if cancelled { "[CANCELLED]" } else { "[DONE]" });
    Ok(())
}

/// Cancel an in-flight completion by dropping its future (real cancellation).
#[tauri::command]
pub fn cancel_backend_completion(request_id: String) -> Result<bool, String> {
    let removed = cancel_map()
        .lock()
        .map_err(|_| "Fable could not access the cancel map.".to_string())?
        .remove(&request_id);
    Ok(removed.is_some())
}
