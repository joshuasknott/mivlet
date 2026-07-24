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
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

/// Strip the SSE `data:` prefix; return None for blank lines, comments,
/// control fields, and `[DONE]`. Provider event labels are control-plane
/// metadata; only the bounded `data:` JSON may reach parsers or the renderer.
pub fn normalize_sse_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if ["event:", "id:", "retry:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return None;
    }
    let payload = if lower.starts_with("data:") {
        trimmed[5..].trim().to_string()
    } else {
        trimmed.to_string()
    };
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    Some(payload)
}

/// Helper extracted from stream_backend_completion buffer path.
/// Drives the shipped size bound check and byte accumulation used before strict UTF-8 framing.
fn accumulate_and_check_bound(
    response_bytes: &mut usize,
    buffer: &mut Vec<u8>,
    bytes: &[u8],
) -> bool {
    *response_bytes = response_bytes.saturating_add(bytes.len());
    if *response_bytes > MAX_STREAM_RESPONSE_BYTES {
        return true;
    }
    buffer.extend_from_slice(bytes);
    false
}

fn drain_strict_sse_lines(buffer: &mut Vec<u8>, final_flush: bool) -> Result<Vec<String>, ()> {
    let mut lines = Vec::new();
    loop {
        let delimiter = buffer
            .iter()
            .position(|byte| matches!(*byte, b'\n' | b'\r'));
        let Some(index) = delimiter else {
            break;
        };
        if buffer[index] == b'\r' && index + 1 == buffer.len() && !final_flush {
            break;
        }
        let delimiter_len = if buffer[index] == b'\r' && buffer.get(index + 1) == Some(&b'\n') {
            2
        } else {
            1
        };
        let drained = buffer.drain(..index + delimiter_len).collect::<Vec<_>>();
        lines.push(
            std::str::from_utf8(&drained[..index])
                .map_err(|_| ())?
                .to_string(),
        );
    }
    if final_flush && !buffer.is_empty() {
        let remaining = std::mem::take(buffer);
        lines.push(std::str::from_utf8(&remaining).map_err(|_| ())?.to_string());
    }
    Ok(lines)
}

/// The opaque request TS hands to Rust. `body` is the provider-shaped JSON; the
/// API key is never present — Rust adds it as a header from the credential store.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendStreamRequest {
    pub provider_id: String,
    pub request_id: String,
    /// The model name is also embedded in `body`; kept on the request so the
    /// transport contract is explicit even though Rust routes the body verbatim.
    pub model: String,
    pub body: serde_json::Value,
    pub provider_route: Option<crate::models::ProviderRouteExecutionBinding>,
    pub mission_worker_execution: Option<crate::mission_workers::NativeWorkerExecutionBinding>,
}

#[derive(Default)]
struct OpenAiCompatibleTerminalObservation {
    saw_payload: bool,
    finish_reason: Option<String>,
    provider_error: bool,
    capture_output: bool,
    output: String,
    output_overflow: bool,
    usage: Option<(i64, i64)>,
    cumulative_output: bool,
    cumulative_snapshot: String,
}

impl OpenAiCompatibleTerminalObservation {
    fn new_for_provider(provider_id: &str, capture_output: bool) -> Self {
        Self {
            capture_output,
            cumulative_output: provider_id == "minimax",
            ..Self::default()
        }
    }

    fn observe(&mut self, payload: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            self.provider_error = true;
            return;
        };
        let terminal_was_seen = self.finish_reason.is_some();
        let usage_was_seen = self.usage.is_some();
        self.saw_payload = true;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            self.provider_error = true;
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            if !terminal_was_seen || usage_was_seen {
                self.provider_error = true;
            }
            let parsed = usage.as_object().and_then(|usage| {
                Some((
                    usage.get("prompt_tokens")?.as_i64()?,
                    usage.get("completion_tokens")?.as_i64()?,
                ))
            });
            match parsed {
                Some((input, output)) if input >= 0 && output >= 0 => {
                    if terminal_was_seen && !usage_was_seen {
                        self.usage = Some((input, output));
                    }
                }
                _ => self.provider_error = true,
            }
        }
        if value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|choices| choices.len() > 1)
            || value
                .pointer("/choices/0/delta/tool_calls")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
            || value
                .pointer("/choices/0/delta/content")
                .is_some_and(|content| !content.is_null() && !content.is_string())
        {
            self.provider_error = true;
        }
        if usage_was_seen
            && value
                .get("choices")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|choices| !choices.is_empty())
        {
            self.provider_error = true;
        }
        let content = value
            .pointer("/choices/0/delta/content")
            .and_then(serde_json::Value::as_str);
        if terminal_was_seen && content.is_some() {
            self.provider_error = true;
        }
        if self.capture_output {
            if let Some(content) = content {
                self.append_output(content);
            }
        } else if let Some(content) = content {
            self.validate_cumulative_content(content);
        }
        if let Some(reason) = value
            .pointer("/choices/0/finish_reason")
            .and_then(serde_json::Value::as_str)
        {
            if terminal_was_seen {
                self.provider_error = true;
            } else {
                self.finish_reason = Some(reason.to_string());
            }
        }
    }

    fn clean_stop(&self) -> bool {
        self.saw_payload
            && !self.provider_error
            && self.finish_reason.as_deref() == Some("stop")
            && self.usage.is_some()
            && (!self.capture_output || (!self.output.trim().is_empty() && !self.output_overflow))
    }

    fn append_output(&mut self, content: &str) {
        let delta = if self.cumulative_output {
            if content.starts_with(&self.cumulative_snapshot) {
                let delta = content[self.cumulative_snapshot.len()..].to_string();
                self.cumulative_snapshot = content.to_string();
                delta
            } else if self.cumulative_snapshot.starts_with(content) {
                String::new()
            } else {
                self.provider_error = true;
                return;
            }
        } else {
            content.to_string()
        };
        if self.output.len().saturating_add(delta.len()) > 65_536 {
            self.output_overflow = true;
        } else if !self.output_overflow {
            self.output.push_str(&delta);
        }
    }

    fn validate_cumulative_content(&mut self, content: &str) {
        if !self.cumulative_output {
            return;
        }
        if content.starts_with(&self.cumulative_snapshot) {
            self.cumulative_snapshot = content.to_string();
        } else if !self.cumulative_snapshot.starts_with(content) {
            self.provider_error = true;
        }
    }
}

#[derive(Default)]
struct AnthropicTerminalObservation {
    saw_payload: bool,
    message_started: bool,
    message_stopped: bool,
    active_content_block: Option<i64>,
    finish_reason: Option<String>,
    provider_error: bool,
    capture_output: bool,
    output: String,
    output_overflow: bool,
    input_tokens: Option<i64>,
    usage: Option<(i64, i64)>,
}

impl AnthropicTerminalObservation {
    fn new(capture_output: bool) -> Self {
        Self {
            capture_output,
            ..Self::default()
        }
    }

    fn observe(&mut self, payload: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            self.provider_error = true;
            return;
        };
        self.saw_payload = true;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            self.provider_error = true;
            return;
        }
        let Some(event_type) = value.get("type").and_then(serde_json::Value::as_str) else {
            self.provider_error = true;
            return;
        };
        if self.message_stopped && event_type != "ping" {
            self.provider_error = true;
            return;
        }
        match event_type {
            "message_start" => {
                let input_tokens = value
                    .pointer("/message/usage/input_tokens")
                    .and_then(serde_json::Value::as_i64);
                if self.message_started
                    || self.finish_reason.is_some()
                    || input_tokens.is_none_or(|tokens| tokens < 0)
                {
                    self.provider_error = true;
                } else {
                    self.message_started = true;
                    self.input_tokens = input_tokens;
                }
            }
            "content_block_start" => {
                let index = value.get("index").and_then(serde_json::Value::as_i64);
                let initial_text = value
                    .pointer("/content_block/text")
                    .and_then(serde_json::Value::as_str);
                if !self.message_started
                    || self.finish_reason.is_some()
                    || self.active_content_block.is_some()
                    || index.is_none_or(|index| index < 0)
                    || value
                        .pointer("/content_block/type")
                        .and_then(serde_json::Value::as_str)
                        != Some("text")
                    || initial_text.is_none()
                {
                    self.provider_error = true;
                } else {
                    self.active_content_block = index;
                    if self.capture_output {
                        self.append_output(initial_text.unwrap_or_default());
                    }
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(serde_json::Value::as_i64);
                let delta_type = value
                    .pointer("/delta/type")
                    .and_then(serde_json::Value::as_str);
                let text = value
                    .pointer("/delta/text")
                    .and_then(serde_json::Value::as_str);
                if !self.message_started
                    || self.finish_reason.is_some()
                    || index != self.active_content_block
                    || delta_type != Some("text_delta")
                    || text.is_none()
                {
                    self.provider_error = true;
                } else if self.capture_output {
                    self.append_output(text.unwrap_or_default());
                }
            }
            "content_block_stop" => {
                let index = value.get("index").and_then(serde_json::Value::as_i64);
                if !self.message_started
                    || self.finish_reason.is_some()
                    || index != self.active_content_block
                {
                    self.provider_error = true;
                } else {
                    self.active_content_block = None;
                }
            }
            "message_delta" => {
                let reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(serde_json::Value::as_str);
                let output_tokens = value
                    .pointer("/usage/output_tokens")
                    .and_then(serde_json::Value::as_i64);
                if !self.message_started
                    || self.finish_reason.is_some()
                    || self.active_content_block.is_some()
                    || reason.is_none()
                    || output_tokens.is_none_or(|tokens| tokens < 0)
                    || self.input_tokens.is_none()
                {
                    self.provider_error = true;
                } else {
                    self.finish_reason = Some(
                        match reason.unwrap_or_default() {
                            "end_turn" | "stop_sequence" => "stop",
                            "max_tokens" => "length",
                            "tool_use" => "tool-calls",
                            other => other,
                        }
                        .to_string(),
                    );
                    self.usage = self
                        .input_tokens
                        .zip(output_tokens)
                        .filter(|(input, output)| *input >= 0 && *output >= 0);
                }
            }
            "message_stop" => {
                if !self.message_started
                    || self.message_stopped
                    || self.finish_reason.is_none()
                    || self.usage.is_none()
                {
                    self.provider_error = true;
                } else {
                    self.message_stopped = true;
                }
            }
            "ping" => {}
            _ => self.provider_error = true,
        }
    }

    fn append_output(&mut self, text: &str) {
        if self.output.len().saturating_add(text.len()) > 65_536 {
            self.output_overflow = true;
        } else if !self.output_overflow {
            self.output.push_str(text);
        }
    }

    fn clean_stop(&self) -> bool {
        self.saw_payload
            && self.message_started
            && self.message_stopped
            && !self.provider_error
            && self.finish_reason.as_deref() == Some("stop")
            && self.usage.is_some()
            && (!self.capture_output || (!self.output.trim().is_empty() && !self.output_overflow))
    }
}

#[derive(Default)]
struct GeminiTerminalObservation {
    saw_payload: bool,
    finish_reason: Option<String>,
    provider_error: bool,
    capture_output: bool,
    output: String,
    output_overflow: bool,
    usage: Option<(i64, i64)>,
}

impl GeminiTerminalObservation {
    fn new(capture_output: bool) -> Self {
        Self {
            capture_output,
            ..Self::default()
        }
    }

    fn observe(&mut self, payload: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            self.provider_error = true;
            return;
        };
        self.saw_payload = true;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            self.provider_error = true;
            return;
        }
        let candidates = value
            .get("candidates")
            .and_then(serde_json::Value::as_array);
        let has_usage = value
            .get("usageMetadata")
            .is_some_and(|usage| !usage.is_null());
        if candidates.is_none() && !has_usage {
            self.provider_error = true;
            return;
        }
        if candidates.is_some_and(|candidates| candidates.len() > 1) {
            self.provider_error = true;
            return;
        }
        let candidate = candidates.and_then(|candidates| candidates.first());
        if self.finish_reason.is_some() && candidate.is_some() {
            self.provider_error = true;
            return;
        }
        if let Some(parts) = candidate
            .and_then(|candidate| candidate.pointer("/content/parts"))
            .and_then(serde_json::Value::as_array)
        {
            for part in parts {
                let Some(part) = part.as_object() else {
                    self.provider_error = true;
                    continue;
                };
                if part.contains_key("functionCall")
                    || part.contains_key("function_call")
                    || part.keys().any(|key| key != "text")
                {
                    self.provider_error = true;
                    continue;
                }
                let Some(text) = part.get("text").and_then(serde_json::Value::as_str) else {
                    self.provider_error = true;
                    continue;
                };
                if self.capture_output {
                    self.append_output(text);
                }
            }
        }
        if let Some(reason) = candidate
            .and_then(|candidate| candidate.get("finishReason"))
            .and_then(serde_json::Value::as_str)
        {
            if self.finish_reason.is_some() {
                self.provider_error = true;
            } else {
                self.finish_reason = Some(
                    match reason {
                        "STOP" => "stop",
                        "MAX_TOKENS" => "length",
                        other => other,
                    }
                    .to_string(),
                );
            }
        }
        if let Some(usage) = value.get("usageMetadata").filter(|usage| !usage.is_null()) {
            let parsed = usage.as_object().and_then(|usage| {
                Some((
                    usage.get("promptTokenCount")?.as_i64()?,
                    usage.get("candidatesTokenCount")?.as_i64()?,
                ))
            });
            if self.usage.is_some()
                || self.finish_reason.is_none()
                || parsed.is_none_or(|(input, output)| input < 0 || output < 0)
            {
                self.provider_error = true;
            } else {
                self.usage = parsed;
            }
        }
    }

    fn append_output(&mut self, text: &str) {
        if self.output.len().saturating_add(text.len()) > 65_536 {
            self.output_overflow = true;
        } else if !self.output_overflow {
            self.output.push_str(text);
        }
    }

    fn clean_stop(&self) -> bool {
        self.saw_payload
            && !self.provider_error
            && self.finish_reason.as_deref() == Some("stop")
            && self.usage.is_some()
            && (!self.capture_output || (!self.output.trim().is_empty() && !self.output_overflow))
    }
}

enum MissionTerminalObservation {
    OpenAiCompatible(OpenAiCompatibleTerminalObservation),
    Anthropic(AnthropicTerminalObservation),
    Gemini(GeminiTerminalObservation),
}

impl MissionTerminalObservation {
    fn new(provider_id: &str, capture_output: bool) -> Self {
        match provider_kind(provider_id) {
            ProviderKind::OpenAiCompat => Self::OpenAiCompatible(
                OpenAiCompatibleTerminalObservation::new_for_provider(provider_id, capture_output),
            ),
            ProviderKind::Anthropic => {
                Self::Anthropic(AnthropicTerminalObservation::new(capture_output))
            }
            ProviderKind::Gemini => Self::Gemini(GeminiTerminalObservation::new(capture_output)),
        }
    }

    fn observe(&mut self, payload: &str) {
        match self {
            Self::OpenAiCompatible(observation) => observation.observe(payload),
            Self::Anthropic(observation) => observation.observe(payload),
            Self::Gemini(observation) => observation.observe(payload),
        }
    }

    fn provider_error(&self) -> bool {
        match self {
            Self::OpenAiCompatible(observation) => observation.provider_error,
            Self::Anthropic(observation) => observation.provider_error,
            Self::Gemini(observation) => observation.provider_error,
        }
    }

    fn output_overflow(&self) -> bool {
        match self {
            Self::OpenAiCompatible(observation) => observation.output_overflow,
            Self::Anthropic(observation) => observation.output_overflow,
            Self::Gemini(observation) => observation.output_overflow,
        }
    }

    fn finish_reason(&self) -> Option<&str> {
        match self {
            Self::OpenAiCompatible(observation) => observation.finish_reason.as_deref(),
            Self::Anthropic(observation) => observation.finish_reason.as_deref(),
            Self::Gemini(observation) => observation.finish_reason.as_deref(),
        }
    }

    fn clean_stop(&self) -> bool {
        match self {
            Self::OpenAiCompatible(observation) => observation.clean_stop(),
            Self::Anthropic(observation) => observation.clean_stop(),
            Self::Gemini(observation) => observation.clean_stop(),
        }
    }

    fn usage(&self) -> Option<(i64, i64)> {
        match self {
            Self::OpenAiCompatible(observation) => observation.usage,
            Self::Anthropic(observation) => observation.usage,
            Self::Gemini(observation) => observation.usage,
        }
    }

    fn captures_output(&self) -> bool {
        match self {
            Self::OpenAiCompatible(observation) => observation.capture_output,
            Self::Anthropic(observation) => observation.capture_output,
            Self::Gemini(observation) => observation.capture_output,
        }
    }

    fn output(&self) -> &str {
        match self {
            Self::OpenAiCompatible(observation) => &observation.output,
            Self::Anthropic(observation) => &observation.output,
            Self::Gemini(observation) => &observation.output,
        }
    }
}

#[derive(Clone, Copy)]
struct MissionProviderFailure {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

/// Cancel map: requestId -> oneshot sender. Dropping/sending cancels the future.
type CancelMap = HashMap<String, tokio::sync::watch::Sender<bool>>;
static CANCEL_MAP: OnceLock<Mutex<CancelMap>> = OnceLock::new();

fn cancel_map() -> &'static Mutex<CancelMap> {
    CANCEL_MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

static MISSION_EXECUTIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn mission_executions() -> &'static Mutex<HashSet<String>> {
    MISSION_EXECUTIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

struct MissionExecutionLease {
    key: String,
}

impl Drop for MissionExecutionLease {
    fn drop(&mut self) {
        if let Ok(mut executions) = mission_executions().lock() {
            executions.remove(&self.key);
        }
    }
}

fn acquire_mission_execution(
    binding: &crate::mission_workers::NativeWorkerExecutionBinding,
) -> Result<MissionExecutionLease, String> {
    let key = format!(
        "{}\0{}\0{}",
        binding.run_id, binding.worker_id, binding.worker_started_event_id
    );
    let mut executions = mission_executions()
        .lock()
        .map_err(|_| "Fable could not access the mission execution registry.".to_string())?;
    if !executions.insert(key.clone()) {
        return Err("This mission worker is already executing.".into());
    }
    Ok(MissionExecutionLease { key })
}

pub(crate) fn mission_run_has_active_native_execution(run_id: &str) -> Result<bool, String> {
    let prefix = format!("{run_id}\0");
    mission_executions()
        .lock()
        .map(|executions| executions.iter().any(|key| key.starts_with(&prefix)))
        .map_err(|_| "Fable could not access the mission execution registry.".to_string())
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

pub(crate) fn supports_native_mission_provider(provider_id: &str) -> bool {
    NATIVE_PROVIDER_IDS.contains(&provider_id)
}

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

#[derive(Debug, PartialEq, Eq)]
enum MissionBoundary<T> {
    Ready(T),
    Cancelled,
    DeadlineExceeded,
}

async fn wait_for_cancel(rx: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            futures_util::future::pending::<()>().await;
        }
    }
}

async fn wait_for_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => futures_util::future::pending::<()>().await,
    }
}

async fn await_mission_boundary<T>(
    future: impl Future<Output = T>,
    rx: &mut tokio::sync::watch::Receiver<bool>,
    deadline: Option<tokio::time::Instant>,
) -> MissionBoundary<T> {
    tokio::select! {
        biased;
        _ = wait_for_cancel(rx) => MissionBoundary::Cancelled,
        _ = wait_for_deadline(deadline) => MissionBoundary::DeadlineExceeded,
        result = future => MissionBoundary::Ready(result),
    }
}

fn observed_mission_duration_ms(started: Instant, maximum_ms: i64, deadline_exceeded: bool) -> i64 {
    if deadline_exceeded {
        return maximum_ms;
    }
    i64::try_from(started.elapsed().as_millis())
        .unwrap_or(i64::MAX)
        .clamp(0, maximum_ms)
}

fn status_error_code(status: reqwest::StatusCode) -> &'static str {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => "authentication",
        reqwest::StatusCode::PAYMENT_REQUIRED | reqwest::StatusCode::FORBIDDEN => "entitlement",
        reqwest::StatusCode::TOO_MANY_REQUESTS => "rate-limited",
        status if status.is_server_error() => "provider-unavailable",
        _ => "invalid-request",
    }
}

fn request_error_code(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() || error.is_request() {
        "offline"
    } else {
        "transport"
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
    crate::execution_control::ensure_active_execution_allowed()?;
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
    match (&request.mission_worker_execution, &request.provider_route) {
        (Some(_), Some(_)) => {
            return Err("Native provider egress has ambiguous route authority.".to_string())
        }
        (None, Some(binding)) => {
            crate::backends::validate_current_native_provider_route(
                &request.provider_id,
                &request.model,
                binding,
            )?;
        }
        (None, None) => {
            return Err("Native provider egress requires an authorized provider route.".to_string())
        }
        (Some(_), None) => {}
    }
    let channel = format!("{EVENT_CHANNEL_PREFIX}{}", request.request_id);
    // Register the mission execution before reading its journal. This closes the
    // preflight-to-egress race with early cancellation finalization: either the
    // finalizer observes this lease, or this preflight observes its terminal fact.
    let _mission_execution_lease = request
        .mission_worker_execution
        .as_ref()
        .map(acquire_mission_execution)
        .transpose()?;
    let mission_preflight = request
        .mission_worker_execution
        .as_ref()
        .map(|binding| {
            crate::mission_workers::preflight_native_worker_completion(
                binding,
                &request.provider_id,
                &request.model,
                &request.body,
            )
        })
        .transpose()?;
    let mission_authority = match mission_preflight {
        Some(crate::mission_workers::NativeWorkerCompletionPreflight::Execute(authority)) => {
            Some(authority)
        }
        Some(crate::mission_workers::NativeWorkerCompletionPreflight::AlreadyCompleted) => {
            let _ = app.emit(&channel, "[DONE]");
            return Ok(());
        }
        None => None,
    };
    let observation_started = Instant::now();
    let mission_duration_limit_ms = mission_authority
        .as_ref()
        .map(|authority| authority.max_duration_ms());
    let mission_deadline = mission_duration_limit_ms
        .map(|maximum| {
            u64::try_from(maximum)
                .ok()
                .and_then(|milliseconds| {
                    tokio::time::Instant::from_std(observation_started)
                        .checked_add(Duration::from_millis(milliseconds))
                })
                .ok_or_else(|| "Mission worker duration budget is invalid.".to_string())
        })
        .transpose()?;
    let credential = require_key(&request.provider_id)?;
    let connection =
        resolve_provider_connection(&request.provider_id, &credential, &request.model)?;
    let url = connection.chat_endpoint;
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
    let mut transport_failed = false;
    let mut duration_budget_exceeded = false;
    let mut terminal_observation = MissionTerminalObservation::new(
        &request.provider_id,
        mission_authority
            .as_ref()
            .is_some_and(|authority| authority.expects_output()),
    );
    let mut mission_failure: Option<MissionProviderFailure> = None;

    for attempt in 0..MAX_ATTEMPTS {
        let mut req = client.post(&url).json(&request.body);
        if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
            req = req.header(auth_name.as_str(), auth_value.as_str());
        }
        for (name, value) in extra_headers(&request.provider_id) {
            req = req.header(name, value);
        }

        let response = match await_mission_boundary(req.send(), &mut rx, mission_deadline).await {
            MissionBoundary::Ready(response) => response,
            MissionBoundary::Cancelled => {
                cancelled = true;
                break;
            }
            MissionBoundary::DeadlineExceeded => {
                duration_budget_exceeded = true;
                completed = true;
                mission_failure = Some(MissionProviderFailure {
                    code: "native-worker-duration-budget-exceeded",
                    message: "The native provider exceeded the worker duration budget.",
                    retryable: false,
                });
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "error",
                        code: "duration-budget-exceeded",
                        message: "The mission reached its provider-time limit.".to_string(),
                        retryable: false,
                        attempt: attempt + 1,
                        retry_after_ms: None,
                    },
                );
                break;
            }
        };

        let response = match response {
            Ok(response) => response,
            Err(error) if attempt + 1 < MAX_ATTEMPTS => {
                let code = request_error_code(&error);
                let delay =
                    Duration::from_millis(250_u64.saturating_mul(2_u64.pow(attempt as u32)));
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "retrying",
                        code,
                        message: if code == "timeout" {
                            "Provider request timed out; retrying.".to_string()
                        } else {
                            "Provider connection failed; retrying.".to_string()
                        },
                        retryable: true,
                        attempt: attempt + 1,
                        retry_after_ms: Some(delay.as_millis() as u64),
                    },
                );
                match await_mission_boundary(tokio::time::sleep(delay), &mut rx, mission_deadline)
                    .await
                {
                    MissionBoundary::Ready(()) => {}
                    MissionBoundary::Cancelled => {
                        cancelled = true;
                        break;
                    }
                    MissionBoundary::DeadlineExceeded => {
                        duration_budget_exceeded = true;
                        completed = true;
                        mission_failure = Some(MissionProviderFailure {
                            code: "native-worker-duration-budget-exceeded",
                            message: "The native provider exceeded the worker duration budget.",
                            retryable: false,
                        });
                        emit_control(
                            &app,
                            &channel,
                            TransportControlEvent {
                                kind: "error",
                                code: "duration-budget-exceeded",
                                message: "The mission reached its provider-time limit.".to_string(),
                                retryable: false,
                                attempt: attempt + 1,
                                retry_after_ms: None,
                            },
                        );
                        break;
                    }
                }
                if cancelled {
                    break;
                }
                continue;
            }
            Err(error) => {
                let code = request_error_code(&error);
                emit_control(
                    &app,
                    &channel,
                    TransportControlEvent {
                        kind: "error",
                        code,
                        message: if code == "timeout" {
                            "Provider request timed out after retrying.".to_string()
                        } else {
                            "Provider connection failed after retrying.".to_string()
                        },
                        retryable: true,
                        attempt: attempt + 1,
                        retry_after_ms: None,
                    },
                );
                completed = true;
                transport_failed = true;
                mission_failure = Some(MissionProviderFailure {
                    code: "native-provider-transport-failed",
                    message: "The native provider connection failed after retrying.",
                    retryable: true,
                });
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
                match await_mission_boundary(tokio::time::sleep(delay), &mut rx, mission_deadline)
                    .await
                {
                    MissionBoundary::Ready(()) => {}
                    MissionBoundary::Cancelled => {
                        cancelled = true;
                        break;
                    }
                    MissionBoundary::DeadlineExceeded => {
                        duration_budget_exceeded = true;
                        completed = true;
                        mission_failure = Some(MissionProviderFailure {
                            code: "native-worker-duration-budget-exceeded",
                            message: "The native provider exceeded the worker duration budget.",
                            retryable: false,
                        });
                        emit_control(
                            &app,
                            &channel,
                            TransportControlEvent {
                                kind: "error",
                                code: "duration-budget-exceeded",
                                message: "The mission reached its provider-time limit.".to_string(),
                                retryable: false,
                                attempt: attempt + 1,
                                retry_after_ms: None,
                            },
                        );
                        break;
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
            transport_failed = true;
            mission_failure = Some(if retryable {
                MissionProviderFailure {
                    code: "native-provider-temporarily-unavailable",
                    message: "The native provider remained unavailable after retrying.",
                    retryable: true,
                }
            } else {
                MissionProviderFailure {
                    code: "native-provider-request-rejected",
                    message: "The native provider rejected the request.",
                    retryable: false,
                }
            });
            break;
        }

        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut response_bytes = 0usize;
        loop {
            tokio::select! {
                biased;
                _ = wait_for_cancel(&mut rx) => {
                    cancelled = true;
                    break;
                }
                _ = wait_for_deadline(mission_deadline) => {
                    duration_budget_exceeded = true;
                    completed = true;
                    mission_failure = Some(MissionProviderFailure {
                        code: "native-worker-duration-budget-exceeded",
                        message: "The native provider exceeded the worker duration budget.",
                        retryable: false,
                    });
                    emit_control(&app, &channel, TransportControlEvent {
                        kind: "error", code: "duration-budget-exceeded",
                        message: "The mission reached its provider-time limit.".to_string(),
                        retryable: false, attempt: attempt + 1, retry_after_ms: None,
                    });
                    break;
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
                                transport_failed = true;
                                mission_failure = Some(MissionProviderFailure {
                                    code: "native-provider-response-too-large",
                                    message: "The native provider response exceeded Fable's limit.",
                                    retryable: false,
                                });
                                break;
                            }
                            let lines = match drain_strict_sse_lines(&mut buffer, false) {
                                Ok(lines) => lines,
                                Err(()) => {
                                    emit_control(&app, &channel, TransportControlEvent {
                                        kind: "error", code: "invalid-utf8",
                                        message: "Provider stream contained invalid UTF-8.".to_string(),
                                        retryable: false, attempt: attempt + 1, retry_after_ms: None,
                                    });
                                    completed = true;
                                    transport_failed = true;
                                    mission_failure = Some(MissionProviderFailure {
                                        code: "native-provider-invalid-utf8",
                                        message: "The native provider stream contained invalid UTF-8.",
                                        retryable: false,
                                    });
                                    buffer.clear();
                                    break;
                                }
                            };
                            for line in lines {
                                if let Some(payload) = normalize_sse_line(&line) {
                                    if mission_authority.is_some() {
                                        terminal_observation.observe(&payload);
                                    }
                                    let _ = app.emit(&channel, payload);
                                }
                            }
                        }
                        Some(Err(error)) => {
                            let code = request_error_code(&error);
                            emit_control(&app, &channel, TransportControlEvent {
                                kind: "error",
                                code,
                                message: "Provider stream ended unexpectedly.".to_string(),
                                retryable: true,
                                attempt: attempt + 1,
                                retry_after_ms: None,
                            });
                            completed = true;
                            transport_failed = true;
                            mission_failure = Some(MissionProviderFailure {
                                code: "native-provider-stream-interrupted",
                                message: "The native provider stream ended unexpectedly.",
                                retryable: true,
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
        if !buffer.is_empty() && !cancelled && !transport_failed && !duration_budget_exceeded {
            match drain_strict_sse_lines(&mut buffer, true) {
                Ok(lines) => {
                    for line in lines {
                        if let Some(payload) = normalize_sse_line(&line) {
                            if mission_authority.is_some() {
                                terminal_observation.observe(&payload);
                            }
                            let _ = app.emit(&channel, payload);
                        }
                    }
                }
                Err(()) => {
                    emit_control(
                        &app,
                        &channel,
                        TransportControlEvent {
                            kind: "error",
                            code: "invalid-utf8",
                            message: "Provider stream contained invalid UTF-8.".to_string(),
                            retryable: false,
                            attempt: attempt + 1,
                            retry_after_ms: None,
                        },
                    );
                    completed = true;
                    transport_failed = true;
                    mission_failure = Some(MissionProviderFailure {
                        code: "native-provider-invalid-utf8",
                        message: "The native provider stream contained invalid UTF-8.",
                        retryable: false,
                    });
                }
            }
        }
        break;
    }

    let _ = cancel_map()
        .lock()
        .map(|mut map| map.remove(&request.request_id));
    let terminal = if cancelled { "[CANCELLED]" } else { "[DONE]" };
    let _ = app.emit(&channel, terminal);
    if mission_authority.is_some() && !cancelled && completed && mission_failure.is_none() {
        mission_failure = if terminal_observation.provider_error() {
            Some(MissionProviderFailure {
                code: "native-provider-payload-error",
                message: "The native provider returned an error payload.",
                retryable: false,
            })
        } else if terminal_observation.output_overflow() {
            Some(MissionProviderFailure {
                code: "native-provider-output-too-large",
                message: "The native provider output exceeded Fable's mission receipt limit.",
                retryable: false,
            })
        } else if terminal_observation.finish_reason() == Some("length") {
            Some(MissionProviderFailure {
                code: "native-provider-output-limit",
                message: "The native provider reached the worker output limit.",
                retryable: false,
            })
        } else if !terminal_observation.clean_stop() {
            Some(MissionProviderFailure {
                code: "native-provider-terminal-incomplete",
                message: "The native provider ended without a successful stop.",
                retryable: false,
            })
        } else {
            None
        };
    }
    if !cancelled && mission_failure.is_none() {
        if let (Some(authority), Some((input_tokens, output_tokens))) =
            (mission_authority.as_ref(), terminal_observation.usage())
        {
            if authority.usage_exceeds_budget(input_tokens, output_tokens) {
                mission_failure = Some(MissionProviderFailure {
                    code: "native-worker-token-budget-exceeded",
                    message: "The native provider usage exceeded the worker token budget.",
                    retryable: false,
                });
            }
        }
    }
    let mission_settlement = if let Some(authority) = mission_authority.as_ref() {
        let duration_ms = observed_mission_duration_ms(
            observation_started,
            authority.max_duration_ms(),
            duration_budget_exceeded,
        );
        let attempt_number = authority.attempt_number();
        let outcome = if cancelled {
            Some(crate::mission_workers::NativeWorkerTerminalOutcome::Cancelled)
        } else if completed && mission_failure.is_none() {
            Some(
                crate::mission_workers::NativeWorkerTerminalOutcome::Completed {
                    text: terminal_observation
                        .captures_output()
                        .then(|| terminal_observation.output().to_string()),
                    input_tokens: terminal_observation
                        .usage()
                        .map(|usage| usage.0)
                        .unwrap_or_default(),
                    output_tokens: terminal_observation
                        .usage()
                        .map(|usage| usage.1)
                        .unwrap_or_default(),
                    duration_ms,
                    attempt_number,
                },
            )
        } else {
            mission_failure.map(|failure| {
                crate::mission_workers::NativeWorkerTerminalOutcome::Failed {
                    code: failure.code,
                    message: failure.message,
                    retryable: failure.retryable,
                    usage: terminal_observation.usage(),
                    duration_ms,
                    attempt_number,
                }
            })
        };
        outcome.map_or(Ok(()), |outcome| {
            crate::mission_workers::settle_native_worker_completion(authority, outcome)
        })
    } else {
        Ok(())
    };
    // Record the model-call lifecycle into the unified action-history store
    // (observation only; no payload content is retained).
    let (status, code) = if cancelled {
        ("cancelled", "cancelled")
    } else if let Some(failure) = mission_failure {
        ("failed", failure.code)
    } else if transport_failed {
        ("failed", "provider-failed")
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
    mission_settlement?;
    if !cancelled
        && completed
        && !transport_failed
        && mission_failure.is_none()
        && terminal_observation.clean_stop()
    {
        let latency_ms =
            u64::try_from(observation_started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let observed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        if let Some(authority) = mission_authority.as_ref() {
            let _ = crate::backends::record_native_provider_route_observation(
                authority.observation_owner(),
                &request.provider_id,
                &request.model,
                authority.provider_route_id(),
                &request.request_id,
                latency_ms,
                terminal_observation.usage(),
                &observed_at,
            );
        } else if let Some(binding) = request.provider_route.as_ref() {
            let _ = crate::backends::record_current_native_provider_route_observation(
                &request.provider_id,
                &request.model,
                binding,
                &request.request_id,
                latency_ms,
                terminal_observation.usage(),
                &observed_at,
            );
        }
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
    fn mission_terminal_observation_requires_one_clean_compatible_stop() {
        let mut observation = OpenAiCompatibleTerminalObservation::default();
        observation.observe(r#"{"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}"#);
        assert!(!observation.clean_stop());
        observation.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        observation.observe(r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}"#);
        assert!(observation.clean_stop());
        observation.observe(r#"{"error":{"message":"late failure"}}"#);
        assert!(!observation.clean_stop());
        let mut late_content =
            OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        late_content.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        late_content.observe(r#"{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}"#);
        late_content.observe(r#"{"choices":[{"delta":{"content":"late"}}]}"#);
        assert!(!late_content.clean_stop());
        let mut early_usage =
            OpenAiCompatibleTerminalObservation::new_for_provider("openai", false);
        early_usage.observe(r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#);
        early_usage.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        assert!(!early_usage.clean_stop());
    }

    #[test]
    fn mission_terminal_observation_captures_one_bounded_native_text_output() {
        let mut observation = OpenAiCompatibleTerminalObservation::new_for_provider("openai", true);
        observation.observe(r#"{"choices":[{"delta":{"content":"Hello "}}]}"#);
        observation
            .observe(r#"{"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}"#);
        observation.observe(r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#);
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");
        let mut empty = OpenAiCompatibleTerminalObservation::new_for_provider("openai", true);
        empty.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        empty.observe(r#"{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":0}}"#);
        assert!(!empty.clean_stop());
    }

    #[test]
    fn minimax_mission_terminal_deduplicates_cumulative_content() {
        let mut observation =
            OpenAiCompatibleTerminalObservation::new_for_provider("minimax", true);
        observation.observe(r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#);
        observation
            .observe(r#"{"choices":[{"delta":{"content":"Hello world"},"finish_reason":null}]}"#);
        observation.observe(r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#);
        observation.observe(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#);
        observation.observe(r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#);
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");

        let mut divergent = OpenAiCompatibleTerminalObservation::new_for_provider("minimax", true);
        divergent.observe(r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#);
        divergent
            .observe(r#"{"choices":[{"delta":{"content":"Different"},"finish_reason":null}]}"#);
        assert!(!divergent.clean_stop());
    }

    #[test]
    fn anthropic_mission_terminal_requires_start_delta_usage_and_stop() {
        let mut observation = AnthropicTerminalObservation::new(true);
        observation.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":7}}}"#);
        observation.observe(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        );
        observation.observe(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        );
        observation.observe(r#"{"type":"content_block_stop","index":0}"#);
        observation.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
        );
        observation.observe(r#"{"type":"message_stop"}"#);
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello");
        assert_eq!(observation.usage, Some((7, 2)));

        let mut tool = AnthropicTerminalObservation::new(false);
        tool.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#);
        tool.observe(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"write"}}"#,
        );
        tool.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}"#,
        );
        tool.observe(r#"{"type":"message_stop"}"#);
        assert!(!tool.clean_stop());

        let mut unordered = AnthropicTerminalObservation::new(true);
        unordered.observe(r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#);
        unordered.observe(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Skipped start"}}"#,
        );
        unordered.observe(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}"#,
        );
        unordered.observe(r#"{"type":"message_stop"}"#);
        assert!(!unordered.clean_stop());
    }

    #[test]
    fn gemini_mission_terminal_requires_exact_stop_and_final_usage() {
        let mut observation = GeminiTerminalObservation::new(true);
        observation.observe(r#"{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}"#);
        observation.observe(
            r#"{"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2}}"#,
        );
        assert!(observation.clean_stop());
        assert_eq!(observation.output, "Hello world");
        assert_eq!(observation.usage, Some((7, 2)));

        let mut tool = GeminiTerminalObservation::new(false);
        tool.observe(
            r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"write","args":{}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}"#,
        );
        assert!(!tool.clean_stop());

        let mut unknown = GeminiTerminalObservation::new(false);
        unknown.observe(r#"{"modelVersion":"gemini-test"}"#);
        assert!(!unknown.clean_stop());
    }

    #[test]
    fn mission_execution_lease_rejects_concurrent_provider_egress() {
        let binding = crate::mission_workers::NativeWorkerExecutionBinding {
            run_id: "lease-run".into(),
            worker_id: "lease-worker".into(),
            worker_started_event_id: "lease-start".into(),
            route_selected_event_id: "lease-route".into(),
            usage_event_id: "lease-usage".into(),
            completion_event_id: "lease-complete".into(),
            evaluation_event_id: "lease-evaluation".into(),
            result_event_id: "lease-result".into(),
            failure_event_id: "lease-fail".into(),
            idempotency_key: "lease-terminal".into(),
            expected_run_revision: 3,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let lease = acquire_mission_execution(&binding).expect("first lease");
        assert!(acquire_mission_execution(&binding).is_err());
        let mut sibling = binding.clone();
        sibling.worker_id = "lease-worker-sibling".into();
        sibling.worker_started_event_id = "lease-start-sibling".into();
        let sibling_lease = acquire_mission_execution(&sibling)
            .expect("another worker in the same run owns an independent lease");
        assert!(mission_run_has_active_native_execution("lease-run").unwrap());
        drop(sibling_lease);
        drop(lease);
        assert!(acquire_mission_execution(&binding).is_ok());
    }

    #[tokio::test]
    async fn mission_boundary_enforces_one_deadline_across_work_and_backoff() {
        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(5);
        let delayed = await_mission_boundary(
            tokio::time::sleep(Duration::from_millis(50)),
            &mut rx,
            Some(deadline),
        )
        .await;
        assert_eq!(delayed, MissionBoundary::DeadlineExceeded);

        let (_tx, mut rx) = tokio::sync::watch::channel(false);
        let ready = await_mission_boundary(
            async { "ready" },
            &mut rx,
            Some(tokio::time::Instant::now() + Duration::from_secs(1)),
        )
        .await;
        assert_eq!(ready, MissionBoundary::Ready("ready"));

        let (tx, mut rx) = tokio::sync::watch::channel(false);
        drop(tx);
        let ready_after_sender_close = await_mission_boundary(
            async { "ready-after-close" },
            &mut rx,
            Some(tokio::time::Instant::now() + Duration::from_secs(1)),
        )
        .await;
        assert_eq!(
            ready_after_sender_close,
            MissionBoundary::Ready("ready-after-close")
        );
    }

    #[tokio::test]
    async fn mission_boundary_gives_an_observed_cancellation_priority() {
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        tx.send(true).unwrap();
        let outcome = await_mission_boundary(
            async { "provider-finished" },
            &mut rx,
            Some(tokio::time::Instant::now()),
        )
        .await;
        assert_eq!(outcome, MissionBoundary::Cancelled);
        assert_eq!(
            observed_mission_duration_ms(Instant::now(), 120_000, true),
            120_000
        );
    }

    #[test]
    fn streaming_statuses_distinguish_auth_entitlement_rate_limit_and_provider_failure() {
        use reqwest::StatusCode;

        assert_eq!(
            status_error_code(StatusCode::UNAUTHORIZED),
            "authentication"
        );
        assert_eq!(status_error_code(StatusCode::FORBIDDEN), "entitlement");
        assert_eq!(
            status_error_code(StatusCode::PAYMENT_REQUIRED),
            "entitlement"
        );
        assert_eq!(
            status_error_code(StatusCode::TOO_MANY_REQUESTS),
            "rate-limited"
        );
        assert_eq!(
            status_error_code(StatusCode::SERVICE_UNAVAILABLE),
            "provider-unavailable"
        );
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
    fn mission_provider_family_is_registered_and_fail_closed() {
        for provider_id in ["openai", "xai", "openrouter", "deepseek", "zai", "custom"] {
            assert!(supports_native_mission_provider(provider_id));
            assert_eq!(provider_kind(provider_id), ProviderKind::OpenAiCompat);
        }
        for provider_id in ["anthropic", "gemini"] {
            assert!(supports_native_mission_provider(provider_id));
            assert_ne!(provider_kind(provider_id), ProviderKind::OpenAiCompat);
        }
        for provider_id in ["unknown", ""] {
            assert!(!supports_native_mission_provider(provider_id));
        }
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
    fn normalize_sse_line_drops_control_fields_comments_blanks_and_done() {
        assert!(normalize_sse_line("").is_none());
        assert!(normalize_sse_line("   ").is_none());
        assert!(normalize_sse_line(": comment heartbeat").is_none());
        assert!(normalize_sse_line("event: message_start").is_none());
        assert!(normalize_sse_line("id: event-1").is_none());
        assert!(normalize_sse_line("retry: 1000").is_none());
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
        assert!((5000..=30000).contains(&d1));
        let d2 = retry_after_ms(Some("120"), 1);
        assert!(d2 <= 30000);
        let d3 = retry_after_ms(Some("Fri, 31 Dec 1999 23:59:59 GMT"), 0);
        assert!((1..=30000).contains(&d3));
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
    fn strict_sse_framing_carries_split_utf8_and_crlf_boundaries() {
        let encoded = "data: {\"text\":\"café\"}\r\n".as_bytes();
        let split = encoded.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&encoded[..split]);
        assert!(drain_strict_sse_lines(&mut buffer, false)
            .unwrap()
            .is_empty());
        buffer.extend_from_slice(&encoded[split..]);
        assert_eq!(
            drain_strict_sse_lines(&mut buffer, false).unwrap(),
            vec!["data: {\"text\":\"café\"}"]
        );
        let mut invalid = vec![b'd', 0xff, b'\n'];
        assert!(drain_strict_sse_lines(&mut invalid, false).is_err());
    }

    #[test]
    fn bounded_stream_and_max_constants() {
        // Drives the shipped > MAX check via the helper used in stream_backend buffer.
        let mut acc: usize = MAX_STREAM_RESPONSE_BYTES - 5;
        let mut b = Vec::new();
        let big = vec![b'x'; 10];
        assert!(accumulate_and_check_bound(&mut acc, &mut b, &big));
    }

    #[test]
    fn accumulate_drives_real_size_check_and_buffer_path() {
        // Directly exercises the shipped accumulate_and_check_bound byte path.
        // used inside stream_backend_completion's bytes loop.
        let mut bytes_acc: usize = 0;
        let mut buf = Vec::new();
        let small = b"data: hello\r\n";
        assert!(!accumulate_and_check_bound(&mut bytes_acc, &mut buf, small));
        assert!(bytes_acc > 0);
        assert!(buf.starts_with(b"data: hello"));

        // Now cross the limit with a huge chunk (simulates large SSE payload chunk)
        let mut big_acc: usize = MAX_STREAM_RESPONSE_BYTES - 10;
        let mut big_buf = Vec::new();
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
