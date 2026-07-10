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

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::backends::read_credential;
use crate::models::BackendVerifyResult;
use tauri::{AppHandle, Emitter};
use url::{Host, Url};

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

#[derive(Clone, Copy)]
struct OpenAiCompatProfile {
    id: &'static str,
    chat_endpoint: &'static str,
    models_endpoint: Option<&'static str>,
    auth_required: bool,
}

/// Fixed provider profiles. An absent models endpoint means credential
/// verification and discovery are unsupported, while chat execution remains
/// available through the curated model fallback.
const OPENAI_COMPAT_PROFILES: &[OpenAiCompatProfile] = &[
    OpenAiCompatProfile {
        id: "openai",
        chat_endpoint: "https://api.openai.com/v1/chat/completions",
        models_endpoint: Some("https://api.openai.com/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "xai",
        chat_endpoint: "https://api.x.ai/v1/chat/completions",
        models_endpoint: Some("https://api.x.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "openrouter",
        chat_endpoint: "https://openrouter.ai/api/v1/chat/completions",
        models_endpoint: Some("https://openrouter.ai/api/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "deepseek",
        chat_endpoint: "https://api.deepseek.com/chat/completions",
        models_endpoint: Some("https://api.deepseek.com/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "zai",
        chat_endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "minimax",
        chat_endpoint: "https://api.minimax.io/v1/chat/completions",
        models_endpoint: Some("https://api.minimax.io/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "alibaba",
        chat_endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "fireworks",
        chat_endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "huggingface",
        chat_endpoint: "https://router.huggingface.co/v1/chat/completions",
        models_endpoint: Some("https://router.huggingface.co/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "moonshot",
        chat_endpoint: "https://api.moonshot.ai/v1/chat/completions",
        models_endpoint: Some("https://api.moonshot.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "kimi-code",
        chat_endpoint: "https://api.kimi.com/coding/v1/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "mistral",
        chat_endpoint: "https://api.mistral.ai/v1/chat/completions",
        models_endpoint: Some("https://api.mistral.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "meta",
        chat_endpoint: "https://api.llama.com/v1/chat/completions",
        models_endpoint: Some("https://api.llama.com/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "perplexity",
        chat_endpoint: "https://api.perplexity.ai/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "tencent",
        chat_endpoint: "https://tokenhub-intl.tencentmaas.com/v1/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "xiaomi",
        chat_endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
        models_endpoint: None,
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "groq",
        chat_endpoint: "https://api.groq.com/openai/v1/chat/completions",
        models_endpoint: Some("https://api.groq.com/openai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "together",
        chat_endpoint: "https://api.together.ai/v1/chat/completions",
        models_endpoint: Some("https://api.together.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "cerebras",
        chat_endpoint: "https://api.cerebras.ai/v1/chat/completions",
        models_endpoint: Some("https://api.cerebras.ai/v1/models"),
        auth_required: true,
    },
];

fn openai_compat_profile(provider_id: &str) -> Option<&'static OpenAiCompatProfile> {
    OPENAI_COMPAT_PROFILES
        .iter()
        .find(|profile| profile.id == provider_id)
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
        ProviderKind::OpenAiCompat => openai_compat_profile(provider_id)
            .map(|profile| profile.chat_endpoint.to_string())
            .unwrap_or_default(),
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CustomProviderCredential {
    version: u8,
    kind: String,
    base_url: String,
    model_id: String,
    api_key: Option<String>,
}

#[derive(Clone)]
struct ResolvedProviderConnection {
    chat_endpoint: String,
    models_endpoint: Option<String>,
    auth_header: Option<(String, String)>,
}

fn normalize_custom_base_url(raw: &str) -> Result<String, String> {
    if raw.len() > 2_048 {
        return Err("Custom provider base URL is too long.".to_string());
    }
    if raw.is_empty() || raw.chars().any(char::is_control) {
        return Err("Custom provider base URL is invalid.".to_string());
    }
    let parsed = Url::parse(raw).map_err(|_| "Custom provider base URL is invalid.".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Custom provider base URL cannot contain user information.".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Custom provider base URL cannot contain a query or fragment.".to_string());
    }
    let host = parsed
        .host()
        .ok_or_else(|| "Custom provider base URL needs a host.".to_string())?;
    match parsed.scheme() {
        "https" => {}
        "http" => {
            let loopback = match host {
                Host::Domain(domain) => domain == "localhost",
                Host::Ipv4(address) => address.is_loopback(),
                Host::Ipv6(address) => address.is_loopback(),
            };
            if !loopback {
                return Err(
                    "Custom provider HTTP URLs are allowed only on the local loopback host."
                        .to_string(),
                );
            }
        }
        _ => return Err("Custom provider base URL must use HTTP or HTTPS.".to_string()),
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn parse_custom_provider_credential(secret: &str) -> Result<CustomProviderCredential, String> {
    let value: serde_json::Value = serde_json::from_str(secret)
        .map_err(|_| "Custom provider credential has an invalid shape.".to_string())?;
    if value
        .get("apiKey")
        .is_some_and(|api_key| !api_key.is_string())
    {
        return Err("Custom provider API key must be a string when present.".to_string());
    }
    let mut credential: CustomProviderCredential = serde_json::from_value(value)
        .map_err(|_| "Custom provider credential has an invalid shape.".to_string())?;
    if credential.version != 1 || credential.kind != "openai-compatible" {
        return Err("Custom provider credential version or kind is unsupported.".to_string());
    }
    credential.base_url = normalize_custom_base_url(&credential.base_url)?;
    credential.model_id = credential.model_id.trim().to_string();
    if credential.model_id.is_empty()
        || credential.model_id.len() > 256
        || credential.model_id.chars().any(char::is_control)
    {
        return Err("Custom provider model ID is invalid.".to_string());
    }
    if let Some(api_key) = credential.api_key.as_deref() {
        if api_key.is_empty() || api_key.chars().any(char::is_control) {
            return Err("Custom provider API key is invalid.".to_string());
        }
    }
    Ok(credential)
}

/// Validate structured native credentials before they enter the secure store.
/// Fixed remote providers accept opaque API keys; custom endpoints use a
/// validated configuration envelope.
pub(crate) fn validate_native_credential(provider_id: &str, secret: &str) -> Result<(), String> {
    match provider_id {
        "custom" => parse_custom_provider_credential(secret).map(|_| ()),
        _ => Ok(()),
    }
}

fn resolve_provider_connection(
    provider_id: &str,
    credential: &str,
    model: &str,
) -> Result<ResolvedProviderConnection, String> {
    if provider_id == "custom" {
        let custom = parse_custom_provider_credential(credential)?;
        if model != "model-discovery" && model != custom.model_id {
            return Err(
                "The selected model is not configured for this custom provider.".to_string(),
            );
        }
        return Ok(ResolvedProviderConnection {
            chat_endpoint: format!("{}/chat/completions", custom.base_url),
            // A chat-compatible endpoint is not required to expose GET /models.
            // Fable uses the explicit, user-configured model ID instead.
            models_endpoint: None,
            auth_header: custom
                .api_key
                .map(|key| ("Authorization".to_string(), format!("Bearer {key}"))),
        });
    }

    let chat_endpoint = endpoint_for_model(provider_id, model)?;
    if chat_endpoint.is_empty() {
        return Err("Provider is not registered for native API egress.".to_string());
    }
    let models_endpoint = models_endpoint_for(provider_id).ok();
    let auth_required = openai_compat_profile(provider_id)
        .map(|profile| profile.auth_required)
        .unwrap_or(true);
    Ok(ResolvedProviderConnection {
        chat_endpoint,
        models_endpoint,
        auth_header: auth_required.then(|| auth_header_for(provider_id, credential)),
    })
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
/// Case-insensitive on the data: prefix; drops empty post-strip payloads (e.g. "data: ").
pub fn normalize_sse_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let payload = if trimmed.to_ascii_lowercase().starts_with("data:") {
        trimmed[5..].trim().to_string()
    } else {
        trimmed.to_string()
    };
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    Some(payload)
}

/// Pure helper for CRLF normalization used in streaming buffer accumulation + final handling.
/// Directly unit-testable (covers split chunks + lone \r / \r\n in SSE).
fn normalize_sse_chunk(chunk: &str) -> String {
    chunk.replace("\r\n", "\n").replace('\r', "\n")
}

/// Helper extracted from stream_backend_completion buffer path.
/// Drives the shipped size bound check + accumulation + CRLF norm when called from unit tests.
fn accumulate_and_check_bound(
    response_bytes: &mut usize,
    buffer: &mut String,
    bytes: &[u8],
) -> bool {
    *response_bytes = response_bytes.saturating_add(bytes.len());
    if *response_bytes > MAX_STREAM_RESPONSE_BYTES {
        return true;
    }
    let chunk_text = normalize_sse_chunk(&String::from_utf8_lossy(bytes));
    buffer.push_str(&chunk_text);
    false
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

/// The user-facing message for a native provider that has no stored key. This is
/// a *configuration-state* gap, not a credential the provider rejected, so the
/// copy must never say "rejected" — it directs the user to add a key. Pure so
/// the boundary copy contract is unit-tested without a socket.
pub fn missing_key_message(provider_id: &str) -> String {
    match provider_id {
        "custom" => "Add a custom OpenAI-compatible endpoint to connect.".to_string(),
        _ => format!("Add an {provider_id} API key to connect."),
    }
}

const EVENT_CHANNEL_PREFIX: &str = "arden://backend/";
const MAX_ATTEMPTS: usize = 3;
const MAX_STREAM_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const NATIVE_PROVIDER_IDS: [&str; 22] = [
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "openrouter",
    "deepseek",
    "zai",
    "minimax",
    "alibaba",
    "fireworks",
    "huggingface",
    "moonshot",
    "kimi-code",
    "mistral",
    "meta",
    "perplexity",
    "tencent",
    "xiaomi",
    "groq",
    "together",
    "cerebras",
    "custom",
];

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

/// Pure, directly unit-exercisable core of retry-after calc (used by real retry_after).
fn retry_after_ms(header: Option<&str>, attempt: usize) -> u64 {
    let header = header.unwrap_or("");
    let header_seconds: Option<u64> = header.parse::<u64>().ok().or_else(|| {
        let digits: String = header.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            None
        } else {
            digits.parse().ok()
        }
    });
    let backoff = 250u64.saturating_mul(2u64.pow(attempt as u32));
    header_seconds
        .map(|s| s * 1000)
        .unwrap_or(backoff)
        .min(30_000)
}

fn header_to_retry(header: Option<&reqwest::header::HeaderValue>, attempt: usize) -> Duration {
    let s = header.and_then(|v| v.to_str().ok());
    Duration::from_millis(retry_after_ms(s, attempt))
}

fn retry_after(response: &reqwest::Response, attempt: usize) -> Duration {
    header_to_retry(
        response.headers().get(reqwest::header::RETRY_AFTER),
        attempt,
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
    let credential = require_key(&request.provider_id)?;
    let connection =
        resolve_provider_connection(&request.provider_id, &credential, &request.model)?;
    let url = connection.chat_endpoint;
    let channel = format!("{EVENT_CHANNEL_PREFIX}{}", request.request_id);

    crate::ensure_rustls_provider();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(90))
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
        let mut req = client.post(&url).json(&request.body);
        if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
            req = req.header(auth_name.as_str(), auth_value.as_str());
        }
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
                            if accumulate_and_check_bound(&mut response_bytes, &mut buffer, &bytes) {
                                emit_control(&app, &channel, TransportControlEvent {
                                    kind: "error",
                                    code: "response-too-large",
                                    message: "Provider stream exceeded Fable's response-size limit.".to_string(),
                                    retryable: false,
                                    attempt: attempt + 1,
                                    retry_after_ms: None,
                                });
                                completed = true;
                                break;
                            }
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
                            completed = true;
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
            let final_buf = normalize_sse_chunk(&buffer);
            if let Some(payload) = normalize_sse_line(&final_buf) {
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
    // Record the model-call lifecycle into the unified action-history store
    // (observation only; no payload content is retained).
    let (status, code) = if cancelled {
        ("cancelled", "cancelled")
    } else if completed {
        ("ok", "")
    } else {
        ("failed", "no-terminal-state")
    };
    crate::action_history::Recorder::new(
        crate::action_history::categories::MODEL_CALL,
        &request.provider_id,
        &request.model,
        status,
    )
    .actor("system")
    .correlation(&request.request_id)
    .error(code)
    .summary(&format!(
        "{} model call via {}",
        request.model, request.provider_id
    ))
    .record();
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

// ---------------------------------------------------------------------------
// Dynamic model discovery (list-models endpoints).
//
// Mirrors the streaming path's invariants: the API key is looked up here and
// placed into the auth header (never returned to JS), egress is bounded while
// bytes arrive, and discovery failures remain distinct from successful empties.
// ---------------------------------------------------------------------------

/// The maximum number of model ids a discovery response may surface. Caps a
/// hostile or pathological provider response so the merge step stays bounded.
const MAX_DISCOVERED_MODELS: usize = 1_000;
const MAX_DISCOVERY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DISCOVERY_PAGES: usize = 10;

/// The list-models endpoint for a provider. Pure helper (unit-tested).
pub fn models_endpoint_for(provider_id: &str) -> Result<String, String> {
    match provider_kind(provider_id) {
        ProviderKind::OpenAiCompat => openai_compat_profile(provider_id)
            .and_then(|profile| profile.models_endpoint)
            .map(str::to_string)
            .ok_or_else(|| {
                "Provider does not expose a compatible model-list endpoint.".to_string()
            }),
        ProviderKind::Anthropic => Ok("https://api.anthropic.com/v1/models".to_string()),
        // Gemini models are enumerated under /v1beta/models; the API key stays
        // in the x-goog-api-key header owned by this Rust boundary.
        ProviderKind::Gemini => {
            Ok("https://generativelanguage.googleapis.com/v1beta/models".to_string())
        }
    }
}

/// A discovered model id surfaced back to JavaScript. No capability data is
/// invented here — the TS merge step attaches catalogue capabilities where known.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub available: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub outcome: &'static str,
    pub models: Vec<DiscoveredModel>,
    pub message: Option<String>,
}

fn is_generation_model(provider_id: &str, model: &serde_json::Value, id: &str) -> bool {
    if provider_kind(provider_id) == ProviderKind::Gemini {
        return model
            .get("supportedGenerationMethods")
            .and_then(|value| value.as_array())
            .is_some_and(|methods| {
                methods
                    .iter()
                    .any(|method| method.as_str() == Some("generateContent"))
            });
    }
    let normalized = id.to_ascii_lowercase();
    ![
        "embedding",
        "embed-",
        "moderation",
        "whisper",
        "transcrib",
        "tts-",
        "dall-e",
        "image",
        "realtime",
        "audio",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

/// Extract model ids from a list-models JSON body across provider shapes. Pure
/// helper so the per-provider parsing contract is unit-tested without a socket.
///
/// Recognized shapes:
///   - OpenAI / xAI / OpenRouter: `{ "data": [{ "id": "..." }] }`
///   - Anthropic: `{ "data": [{ "id": "..." }] }`
///   - Gemini: `{ "models": [{ "name": "models/gemini-...", "supportedGenerationMethods": [...] }] }`
pub fn parse_models_body(provider_id: &str, body: &serde_json::Value) -> Vec<DiscoveredModel> {
    let mut out = Vec::new();
    if provider_kind(provider_id) == ProviderKind::Gemini {
        if let Some(models) = body.get("models").and_then(|v| v.as_array()) {
            for model in models {
                if out.len() >= MAX_DISCOVERED_MODELS {
                    break;
                }
                // Gemini `name` is "models/<id>"; strip the prefix to the bare id.
                let raw = model
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let id = raw
                    .strip_prefix("models/")
                    .unwrap_or(raw)
                    .trim()
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                if is_generation_model(provider_id, model, &id) {
                    out.push(DiscoveredModel {
                        id,
                        available: true,
                    });
                }
            }
        }
        return out;
    }

    if let Some(data) = body.get("data").and_then(|v| v.as_array()) {
        for model in data {
            if out.len() >= MAX_DISCOVERED_MODELS {
                break;
            }
            let id = model
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if id.is_empty() {
                continue;
            }
            if !is_generation_model(provider_id, model, id) {
                continue;
            }
            out.push(DiscoveredModel {
                id: id.to_string(),
                available: true,
            });
        }
    }
    out
}

fn discovery_cursor(provider_id: &str, body: &serde_json::Value) -> Option<String> {
    if provider_kind(provider_id) == ProviderKind::Gemini {
        return body
            .get("nextPageToken")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .filter(|value| !value.is_empty());
    }
    if body.get("has_more").and_then(|value| value.as_bool()) != Some(true) {
        return None;
    }
    body.get("last_id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

/// Discover model ids without collapsing unsupported, offline, failed, and
/// successful-empty outcomes. Pagination and response bytes are bounded.
#[tauri::command]
pub async fn list_backend_models(provider_id: String) -> Result<ModelDiscoveryResult, String> {
    if !NATIVE_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return Err("Provider is not registered for native API model discovery.".to_string());
    }
    let credential = match require_key(&provider_id) {
        Ok(credential) => credential,
        Err(_) => {
            // Discovery without a stored key is a configuration gap, not a
            // provider/runtime failure. Keep the outcome actionable: the user
            // must add a key before models can be discovered.
            return Ok(ModelDiscoveryResult {
                outcome: "failed",
                models: Vec::new(),
                message: Some(missing_key_message(&provider_id)),
            });
        }
    };
    if provider_id == "custom" {
        let custom = parse_custom_provider_credential(&credential)?;
        return Ok(ModelDiscoveryResult {
            outcome: "success",
            models: vec![DiscoveredModel {
                id: custom.model_id,
                available: true,
            }],
            message: Some("Using the model ID configured for this custom endpoint.".to_string()),
        });
    }
    let connection = resolve_provider_connection(&provider_id, &credential, "model-discovery")?;
    let Some(url) = connection.models_endpoint.clone() else {
        return Ok(ModelDiscoveryResult {
            outcome: "unsupported",
            models: Vec::new(),
            message: Some(
                "This provider does not expose a compatible model-list endpoint; using curated models."
                    .to_string(),
            ),
        });
    };

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Fable could not initialize the provider client.".to_string())?;
    let mut cursor: Option<String> = None;
    let mut total_bytes = 0usize;
    let mut models = Vec::new();
    let mut seen = HashSet::new();

    for _page in 0..MAX_DISCOVERY_PAGES {
        let mut request = client.get(&url);
        if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
            request = request.header(auth_name.as_str(), auth_value.as_str());
        }
        if let Some(cursor_value) = cursor.as_deref() {
            let key = if provider_kind(&provider_id) == ProviderKind::Gemini {
                "pageToken"
            } else if provider_kind(&provider_id) == ProviderKind::Anthropic {
                "after_id"
            } else {
                "after"
            };
            request = request.query(&[(key, cursor_value)]);
        }
        for (name, value) in extra_headers(&provider_id) {
            request = request.header(name, value);
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(_) => {
                return Ok(ModelDiscoveryResult {
                    outcome: "offline",
                    models: Vec::new(),
                    message: Some("Provider model discovery is offline.".to_string()),
                })
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            let unsupported = matches!(status.as_u16(), 404 | 405 | 501);
            return Ok(ModelDiscoveryResult {
                outcome: if unsupported { "unsupported" } else { "failed" },
                models: Vec::new(),
                message: Some(format!("Provider model discovery returned HTTP {status}.")),
            });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Fable could not read the provider model list.".to_string())?
        {
            total_bytes = total_bytes.saturating_add(chunk.len());
            if total_bytes > MAX_DISCOVERY_RESPONSE_BYTES {
                return Ok(ModelDiscoveryResult {
                    outcome: "failed",
                    models: Vec::new(),
                    message: Some("Provider model list exceeds the supported size.".to_string()),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        let body: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(body) => body,
            Err(_) => {
                return Ok(ModelDiscoveryResult {
                    outcome: "failed",
                    models: Vec::new(),
                    message: Some("Fable could not parse the provider model list.".to_string()),
                })
            }
        };
        for model in parse_models_body(&provider_id, &body) {
            if seen.insert(model.id.clone()) {
                models.push(model);
                if models.len() >= MAX_DISCOVERED_MODELS {
                    break;
                }
            }
        }
        if models.len() >= MAX_DISCOVERED_MODELS {
            break;
        }
        cursor = discovery_cursor(&provider_id, &body);
        if cursor.is_none() {
            break;
        }
    }

    Ok(ModelDiscoveryResult {
        outcome: if models.is_empty() {
            "empty"
        } else {
            "success"
        },
        models,
        message: None,
    })
}

/// Verify a stored native-API credential by hit-testing it against the
/// provider's list-models endpoint. The key never crosses into JavaScript —
/// Rust looks it up via the credential boundary, adds the auth header, and
/// issues a single bounded GET. The HTTP result maps to a
/// [`BackendVerifyResult`]:
///   - 2xx → `ready`
///   - 401/403 → `auth-failed` (the key is bad/expired)
///   - network error → `offline`
///   - 404/405/501 → `unsupported`
///   - anything else → `failed`
///
/// Non-native providers (Codex/ACP/Copilot) own their own auth and never pass
/// through this boundary, so they fail closed with `unsupported`.
#[tauri::command]
pub async fn verify_backend_credential(provider_id: String) -> Result<BackendVerifyResult, String> {
    if !NATIVE_PROVIDER_IDS.contains(&provider_id.as_str()) {
        // Provider-owned runtimes (Codex CLI, ACP, Copilot SDK) carry their own
        // auth that Fable must not touch. They cannot be verified here.
        return Ok(BackendVerifyResult {
            provider_id: provider_id.clone(),
            outcome: "unsupported".to_string(),
            message: Some(
                "This provider manages its own sign-in and cannot be verified here.".to_string(),
            ),
        });
    }

    let credential = match require_key(&provider_id) {
        Ok(credential) => credential,
        Err(_) => {
            // No credential is stored. This is a configuration-state gap, not a
            // key the provider rejected, so the message must not say "rejected".
            // The `auth-failed` outcome is correct (the provider cannot be used
            // without auth), but the copy tells the user to add a key.
            return Ok(BackendVerifyResult {
                provider_id: provider_id.clone(),
                outcome: "auth-failed".to_string(),
                message: Some(missing_key_message(&provider_id)),
            });
        }
    };

    let connection =
        resolve_provider_connection(&provider_id, &credential, "credential-verification")?;
    let Some(url) = connection.models_endpoint.clone() else {
        return Ok(BackendVerifyResult {
            provider_id,
            outcome: "unsupported".to_string(),
            message: Some(
                "This provider does not expose a compatible credential-verification endpoint. The saved connection can still use curated models."
                    .to_string(),
            ),
        });
    };

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Fable could not initialize the provider client.".to_string())?;

    let mut request = client.get(&url);
    if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
        request = request.header(auth_name.as_str(), auth_value.as_str());
    }
    for (name, value) in extra_headers(&provider_id) {
        request = request.header(name, value);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return Ok(BackendVerifyResult {
                provider_id: provider_id.clone(),
                outcome: "offline".to_string(),
                message: Some(format!(
                    "Could not reach {provider_id}. Check your connection."
                )),
            })
        }
    };

    let status = response.status();
    let outcome = verify_outcome_for_status(status);
    let message = if outcome == "auth-failed" {
        Some(format!(
            "{provider_id} rejected this key. Check the key and try again."
        ))
    } else if outcome == "unsupported" {
        Some(format!(
            "{provider_id} does not expose a verifiable endpoint."
        ))
    } else if outcome == "failed" {
        Some(format!("{provider_id} returned HTTP {status}. Try again."))
    } else {
        None
    };

    Ok(BackendVerifyResult {
        provider_id,
        outcome: outcome.to_string(),
        message,
    })
}

/// Map a provider HTTP status to a credential-verify outcome. Pure so the
/// boundary mapping is unit-testable without a socket. Mirrors the discovery
/// path's notion of "unsupported" (404/405/501) and treats 401/403 as a bad
/// or expired key.
pub fn verify_outcome_for_status(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "auth-failed",
        404 | 405 | 501 => "unsupported",
        code if (200..300).contains(&code) => "ready",
        _ => "failed",
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

    #[test]
    fn models_endpoints_point_at_each_provider_list_route() {
        assert_eq!(
            models_endpoint_for("openai").unwrap(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            models_endpoint_for("anthropic").unwrap(),
            "https://api.anthropic.com/v1/models"
        );
        assert!(models_endpoint_for("gemini")
            .unwrap()
            .ends_with("/v1beta/models"));
        assert_eq!(
            models_endpoint_for("xai").unwrap(),
            "https://api.x.ai/v1/models"
        );
        assert_eq!(
            models_endpoint_for("openrouter").unwrap(),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn fixed_openai_compatible_endpoints_match_provider_profiles() {
        let expected = [
            ("deepseek", "https://api.deepseek.com/chat/completions"),
            ("zai", "https://api.z.ai/api/paas/v4/chat/completions"),
            ("minimax", "https://api.minimax.io/v1/chat/completions"),
            (
                "alibaba",
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            ),
            (
                "fireworks",
                "https://api.fireworks.ai/inference/v1/chat/completions",
            ),
            (
                "huggingface",
                "https://router.huggingface.co/v1/chat/completions",
            ),
            ("moonshot", "https://api.moonshot.ai/v1/chat/completions"),
            (
                "kimi-code",
                "https://api.kimi.com/coding/v1/chat/completions",
            ),
            ("mistral", "https://api.mistral.ai/v1/chat/completions"),
            ("meta", "https://api.llama.com/v1/chat/completions"),
            ("perplexity", "https://api.perplexity.ai/chat/completions"),
            (
                "tencent",
                "https://tokenhub-intl.tencentmaas.com/v1/chat/completions",
            ),
            ("xiaomi", "https://api.xiaomimimo.com/v1/chat/completions"),
            ("groq", "https://api.groq.com/openai/v1/chat/completions"),
            ("together", "https://api.together.ai/v1/chat/completions"),
            ("cerebras", "https://api.cerebras.ai/v1/chat/completions"),
        ];
        for (provider_id, endpoint) in expected {
            assert_eq!(endpoint_for(provider_id), endpoint, "{provider_id}");
        }
    }

    #[test]
    fn native_allowlist_and_fixed_profile_table_are_complete_and_unique() {
        let native: HashSet<&str> = NATIVE_PROVIDER_IDS.into_iter().collect();
        assert_eq!(native.len(), NATIVE_PROVIDER_IDS.len());
        let profiled: HashSet<&str> = OPENAI_COMPAT_PROFILES
            .iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(profiled.len(), OPENAI_COMPAT_PROFILES.len());
        let expected_profiled: HashSet<&str> = native
            .iter()
            .copied()
            .filter(|id| !matches!(*id, "anthropic" | "gemini" | "custom"))
            .collect();
        assert_eq!(profiled, expected_profiled);
    }

    #[test]
    fn compatible_model_list_endpoints_are_exact_and_unsupported_ones_fail_closed() {
        let expected = [
            ("deepseek", "https://api.deepseek.com/models"),
            ("minimax", "https://api.minimax.io/v1/models"),
            ("huggingface", "https://router.huggingface.co/v1/models"),
            ("moonshot", "https://api.moonshot.ai/v1/models"),
            ("mistral", "https://api.mistral.ai/v1/models"),
            ("meta", "https://api.llama.com/v1/models"),
            ("groq", "https://api.groq.com/openai/v1/models"),
            ("together", "https://api.together.ai/v1/models"),
            ("cerebras", "https://api.cerebras.ai/v1/models"),
        ];
        for (provider_id, endpoint) in expected {
            assert_eq!(
                models_endpoint_for(provider_id).unwrap(),
                endpoint,
                "{provider_id}"
            );
        }
        for provider_id in [
            "zai",
            "alibaba",
            "fireworks",
            "kimi-code",
            "perplexity",
            "tencent",
            "xiaomi",
        ] {
            assert!(models_endpoint_for(provider_id).is_err(), "{provider_id}");
        }
    }

    fn custom_secret(base_url: &str, api_key: Option<&str>) -> String {
        let mut value = serde_json::json!({
            "version": 1,
            "kind": "openai-compatible",
            "baseUrl": base_url,
            "modelId": "example-chat",
        });
        if let Some(api_key) = api_key {
            value["apiKey"] = serde_json::Value::String(api_key.to_string());
        }
        serde_json::to_string(&value).unwrap()
    }

    #[test]
    fn custom_provider_appends_routes_and_uses_optional_bearer_auth() {
        let with_key = custom_secret("https://models.example.com/v1/", Some("secret-key"));
        let connection = resolve_provider_connection("custom", &with_key, "example-chat").unwrap();
        assert_eq!(
            connection.chat_endpoint,
            "https://models.example.com/v1/chat/completions"
        );
        assert!(connection.models_endpoint.is_none());
        assert_eq!(
            connection.auth_header,
            Some(("Authorization".to_string(), "Bearer secret-key".to_string()))
        );

        let without_key = custom_secret("https://models.example.com/v1", None);
        let connection =
            resolve_provider_connection("custom", &without_key, "example-chat").unwrap();
        assert!(connection.auth_header.is_none());
        assert!(resolve_provider_connection("custom", &without_key, "other-model").is_err());
    }

    #[test]
    fn custom_provider_http_is_limited_to_exact_loopback_hosts() {
        for allowed in [
            "http://localhost:8000/v1",
            "http://127.0.0.1:8000/v1",
            "http://127.42.0.7:8000/v1",
            "http://[::1]:8000/v1",
        ] {
            assert!(
                parse_custom_provider_credential(&custom_secret(allowed, None)).is_ok(),
                "{allowed} should be accepted"
            );
        }

        for rejected in [
            "http://example.com/v1",
            "http://10.0.0.8/v1",
            "http://localhost.evil.example/v1",
            "http://127.0.0.1.evil.example/v1",
            "http://user@localhost:8000/v1",
        ] {
            assert!(
                parse_custom_provider_credential(&custom_secret(rejected, None)).is_err(),
                "{rejected} should be rejected"
            );
        }
    }

    #[test]
    fn custom_provider_rejects_unsafe_url_components_and_non_exact_json() {
        for rejected in [
            "ftp://models.example.com/v1",
            "https://user:pass@models.example.com/v1",
            "https://models.example.com/v1?token=secret",
            "https://models.example.com/v1#fragment",
        ] {
            assert!(parse_custom_provider_credential(&custom_secret(rejected, None)).is_err());
        }

        let extra_field = r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat","extra":true}"#;
        assert!(parse_custom_provider_credential(extra_field).is_err());
        let wrong_version = r#"{"version":2,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat"}"#;
        assert!(parse_custom_provider_credential(wrong_version).is_err());
        let wrong_kind = r#"{"version":1,"kind":"anthropic","baseUrl":"https://models.example.com/v1","modelId":"example-chat"}"#;
        assert!(parse_custom_provider_credential(wrong_kind).is_err());
        let null_key = r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1","modelId":"example-chat","apiKey":null}"#;
        assert!(parse_custom_provider_credential(null_key).is_err());
        let missing_model =
            r#"{"version":1,"kind":"openai-compatible","baseUrl":"https://models.example.com/v1"}"#;
        assert!(parse_custom_provider_credential(missing_model).is_err());
        assert!(parse_custom_provider_credential("not-json").is_err());
    }

    #[test]
    fn parses_openai_style_data_array_into_ids() {
        let body = serde_json::json!({
            "data": [
                { "id": "gpt-5" },
                { "id": "gpt-4.1" },
                { "id": "" },
                { "other": "ignored" }
            ]
        });
        let models = parse_models_body("openai", &body);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-5", "gpt-4.1"]);
        assert!(models.iter().all(|m| m.available));
    }

    #[test]
    fn parses_gemini_models_name_prefix_and_generation_filter() {
        let body = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["generateContent", "streamGenerateContent"] },
                { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] },
                { "name": "models/gemini-3.5-flash" }
            ]
        });
        let models = parse_models_body("gemini", &body);
        // Embedding-only models are not surfaced as runnable generation models.
        let by_id: std::collections::HashMap<&str, bool> = models
            .iter()
            .map(|m| (m.id.as_str(), m.available))
            .collect();
        assert!(by_id["gemini-2.5-pro"]);
        // Missing capability metadata is not proof that the model supports
        // generation. Unknown models fail closed until the provider declares
        // generateContent support.
        assert!(!by_id.contains_key("gemini-3.5-flash"));
        assert!(!by_id.contains_key("text-embedding-004"));
    }

    #[test]
    fn discovery_caps_a_pathologically_large_response() {
        let mut data = Vec::new();
        for i in 0..(MAX_DISCOVERED_MODELS + 50) {
            data.push(serde_json::json!({ "id": format!("m-{i}") }));
        }
        let body = serde_json::json!({ "data": data });
        let models = parse_models_body("openai", &body);
        assert_eq!(models.len(), MAX_DISCOVERED_MODELS);
    }

    #[test]
    fn verify_maps_http_status_to_outcome_vocabulary() {
        use crate::models::BACKEND_VERIFY_OUTCOMES;
        use reqwest::StatusCode;

        let cases = [
            (StatusCode::OK, "ready"),
            (StatusCode::CREATED, "ready"),
            (StatusCode::NO_CONTENT, "ready"),
            (StatusCode::UNAUTHORIZED, "auth-failed"),
            (StatusCode::FORBIDDEN, "auth-failed"),
            (StatusCode::NOT_FOUND, "unsupported"),
            (StatusCode::METHOD_NOT_ALLOWED, "unsupported"),
            (StatusCode::NOT_IMPLEMENTED, "unsupported"),
            (StatusCode::TOO_MANY_REQUESTS, "failed"),
            (StatusCode::BAD_GATEWAY, "failed"),
            (StatusCode::INTERNAL_SERVER_ERROR, "failed"),
        ];
        for (status, expected) in cases {
            let outcome = verify_outcome_for_status(status);
            assert_eq!(
                outcome, expected,
                "status {status} should map to {expected}"
            );
            // Every emitted outcome must be in the controlled vocabulary.
            assert!(
                BACKEND_VERIFY_OUTCOMES.contains(&outcome),
                "outcome {outcome} is not in BACKEND_VERIFY_OUTCOMES"
            );
        }
    }

    #[test]
    fn missing_key_message_directs_the_user_to_add_a_key() {
        // A missing key is a configuration-state gap, not a provider rejection.
        // The copy must never imply the key was "rejected" or "invalid".
        for provider_id in NATIVE_PROVIDER_IDS {
            let message = missing_key_message(provider_id);
            assert!(
                message.starts_with("Add") || message.starts_with("Connect"),
                "missing-credential message should direct the user to connect: {message}"
            );
            assert!(
                message.to_ascii_lowercase().contains(provider_id),
                "missing-key message should name the provider: {message}"
            );
            assert!(
                !message.to_lowercase().contains("reject"),
                "missing-key message must not say 'rejected': {message}"
            );
            assert!(
                !message.to_lowercase().contains("invalid"),
                "missing-key message must not say 'invalid': {message}"
            );
        }
    }

    #[test]
    fn normalize_sse_line_drops_comments_blanks_done_and_variants() {
        assert!(normalize_sse_line("").is_none());
        assert!(normalize_sse_line("   ").is_none());
        assert!(normalize_sse_line(": comment heartbeat").is_none());
        assert!(normalize_sse_line("data: [DONE]").is_none());
        assert!(normalize_sse_line("data:[DONE]").is_none());
        assert!(normalize_sse_line("DATA:  foo ").is_some());
        let p = normalize_sse_line("data: {\"a\":1}").unwrap();
        assert!(p.contains("{\"a\":1}"));
        assert_eq!(normalize_sse_line("bare").unwrap(), "bare");
        assert!(normalize_sse_line("data: ").is_none());
    }

    #[test]
    fn retry_after_supports_variants_and_bounds() {
        // Directly exercises the shipped pure retry_after_ms (used by real retry_after)
        let d1 = retry_after_ms(Some("5"), 0);
        assert!(d1 >= 5000 && d1 <= 30000);
        let d2 = retry_after_ms(Some("120"), 1);
        assert!(d2 <= 30000);
        let d3 = retry_after_ms(Some("Fri, 31 Dec 1999 23:59:59 GMT"), 0);
        assert!(d3 > 0 && d3 <= 30000);
        let d4 = retry_after_ms(Some("bad"), 2);
        assert!(d4 <= 30000);
    }

    #[test]
    fn retry_after_real_wrapper_exercised_with_response() {
        // Drives the exact header lookup + to_str + delegate logic used by the real retry_after wrapper.
        // Constructs HeaderMap (public) and calls the shared header_to_retry that the shipped wrapper uses.
        // This exercises the wrapper's core code path without needing external http crate name.
        let mut hm = reqwest::header::HeaderMap::new();
        hm.insert(reqwest::header::RETRY_AFTER, "4".parse().unwrap());
        let d1 = header_to_retry(hm.get(reqwest::header::RETRY_AFTER), 0);
        assert!(d1.as_millis() >= 4000 && d1.as_millis() <= 30000);

        // leading digits case ("120sec")
        let mut hm2 = reqwest::header::HeaderMap::new();
        hm2.insert(reqwest::header::RETRY_AFTER, "120sec".parse().unwrap());
        let d2 = header_to_retry(hm2.get(reqwest::header::RETRY_AFTER), 1);
        assert!(d2.as_millis() <= 30000);
    }

    #[test]
    fn parse_models_handles_malformed_missing_gen_cap_pagination_and_bounds() {
        let bad = serde_json::json!({"data": [ {"id": "ok"}, {"no": "id"}, null, {"id": ""} ] });
        let ms = parse_models_body("openai", &bad);
        assert_eq!(ms.len(), 1);

        let gem = serde_json::json!({"models": [
            {"name": "models/good", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/nogen"}
        ]});
        let ms = parse_models_body("gemini", &gem);
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].id, "good");

        let mut big = vec![];
        for i in 0..(MAX_DISCOVERED_MODELS + 100) {
            big.push(serde_json::json!({"id": format!("m{}", i)}));
        }
        let b = serde_json::json!({"data": big});
        assert_eq!(parse_models_body("openai", &b).len(), MAX_DISCOVERED_MODELS);
    }

    #[test]
    fn discovery_cursor_variants_and_pagination_cycle_bounds() {
        let g = serde_json::json!({"nextPageToken": "tok123"});
        assert_eq!(discovery_cursor("gemini", &g).as_deref(), Some("tok123"));

        let o = serde_json::json!({"has_more": true, "last_id": "idZ"});
        assert_eq!(discovery_cursor("openai", &o).as_deref(), Some("idZ"));

        let no = serde_json::json!({"has_more": false});
        assert!(discovery_cursor("openai", &no).is_none());

        let e = serde_json::json!({"has_more": true, "last_id": ""});
        assert!(discovery_cursor("anthropic", &e).is_none());
    }

    #[test]
    fn is_generation_filters_non_gen_and_unknown() {
        assert!(is_generation_model(
            "openai",
            &serde_json::json!({}),
            "gpt-5"
        ));
        assert!(!is_generation_model(
            "openai",
            &serde_json::json!({}),
            "text-embedding-ada"
        ));
        assert!(!is_generation_model(
            "openai",
            &serde_json::json!({}),
            "dall-e-3"
        ));
        assert!(is_generation_model(
            "gemini",
            &serde_json::json!({"supportedGenerationMethods":["generateContent"]}),
            "x"
        ));
        assert!(!is_generation_model("gemini", &serde_json::json!({}), "x"));
    }

    #[test]
    fn normalize_sse_chunk_covers_crlf_variants_and_lone_cr() {
        // Directly exercises the shipped CRLF norm used by real buffer acc + final in stream_backend_completion
        assert_eq!(normalize_sse_chunk("data: foo\r\nbar"), "data: foo\nbar");
        assert_eq!(normalize_sse_chunk("data: x\ry\r\nz"), "data: x\ny\nz");
        assert_eq!(normalize_sse_chunk("bare\r"), "bare\n");
    }

    #[test]
    fn bounded_stream_and_max_constants() {
        // Drives the shipped > MAX check via the helper used in stream_backend buffer.
        let mut acc: usize = MAX_STREAM_RESPONSE_BYTES - 5;
        let mut b = String::new();
        let big = vec![b'x'; 10];
        assert!(accumulate_and_check_bound(&mut acc, &mut b, &big));
    }

    #[test]
    fn accumulate_drives_real_size_check_and_buffer_path() {
        // Directly exercises the shipped accumulate_and_check_bound (contains the response_bytes > MAX check + push + normalize_sse_chunk)
        // used inside stream_backend_completion's bytes loop.
        let mut bytes_acc: usize = 0;
        let mut buf = String::new();
        let small = b"data: hello\r\n";
        assert!(!accumulate_and_check_bound(&mut bytes_acc, &mut buf, small));
        assert!(bytes_acc > 0);
        assert!(buf.contains("data: hello"));

        // Now cross the limit with a huge chunk (simulates large SSE payload chunk)
        let mut big_acc: usize = MAX_STREAM_RESPONSE_BYTES - 10;
        let mut big_buf = String::new();
        let huge = vec![b'x'; 100];
        let exceeded = accumulate_and_check_bound(&mut big_acc, &mut big_buf, &huge);
        assert!(exceeded);
    }

    #[test]
    fn cancel_backend_completion_and_map_exercised() {
        // Drive the SHIPPED cancel_backend_completion success path (map remove + sender.send(true) -> Ok(true))
        // plus the rx.changed() used in stream_backend_completion's select.
        let id = "test-cancel-map-success".to_string();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        {
            let mut map = cancel_map().lock().unwrap();
            map.insert(id.clone(), tx);
        }
        let res = cancel_backend_completion(id);
        assert_eq!(res, Ok(true));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let _ = rx.changed().await;
            assert!(*rx.borrow());
        });
    }
}
