//! Native-API transport boundary: Rust owns the API key + HTTP/SSE egress.
//!
//! TypeScript shapes the request body (pure, fixture-tested in
//! `@mivlet/connectors/native-api/`) and hands Rust an opaque
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
use std::time::{Duration, Instant};

use crate::backends::read_credential;
use crate::models::BackendVerifyResult;
use tauri::{AppHandle, Emitter};

pub(crate) mod computer;
#[cfg(test)]
mod providers_tests;

mod providers;

pub use providers::{
    auth_header_for, endpoint_for, endpoint_for_model, extra_headers, provider_kind, ProviderKind,
};
pub(crate) use providers::{
    configured_custom_provider_model_id, normalize_custom_model_id, validate_native_credential,
};
use providers::{
    configured_custom_provider_result, is_additional_native_provider, normalize_alibaba_base_url,
    openai_compat_profile, parse_alibaba_credential, parse_custom_provider_credential,
    resolve_provider_connection, shape_deepseek_egress_body, shape_provider_egress_body,
    OPENAI_COMPAT_PROFILES,
};

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
    pub computer_session_id: Option<String>,
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
    /// DeepSeek documents that usage rides the same terminal chunk as
    /// finish_reason ("no separate usage-only chunk is emitted",
    /// api-docs.deepseek.com /api/create-chat-completion). OpenAI instead
    /// emits a separate usage-only chunk; this flag accepts the DeepSeek shape
    /// while keeping the shared shape strict.
    usage_rides_terminal_chunk: bool,
    repeated_finish_usage: bool,
}

impl OpenAiCompatibleTerminalObservation {
    fn new_for_provider(provider_id: &str, capture_output: bool) -> Self {
        Self {
            capture_output,
            cumulative_output: false,
            usage_rides_terminal_chunk: provider_id == "deepseek",
            repeated_finish_usage: provider_id == "openrouter",
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
        // Whether this payload itself carries the terminal finish reason (the
        // DeepSeek usage-riding-terminal-chunk shape checks this in place of a
        // previously seen finish).
        let terminal_here = value
            .pointer("/choices/0/finish_reason")
            .and_then(serde_json::Value::as_str)
            .is_some();
        // OpenRouter repeats the terminal reason in its one final accounting
        // frame. Accept only a content-free frame with the same reason and
        // usage; later content, conflicting reasons and duplicate usage fail.
        let accounting_frame = self.repeated_finish_usage
            && terminal_was_seen
            && !usage_was_seen
            && value.get("usage").is_some_and(|usage| !usage.is_null())
            && value
                .pointer("/choices/0/finish_reason")
                .and_then(serde_json::Value::as_str)
                == self.finish_reason.as_deref()
            && value
                .pointer("/choices/0/delta")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|delta| {
                    delta.iter().all(|(key, value)| match key.as_str() {
                        "content" => value.is_null() || value.as_str() == Some(""),
                        "role" => value.is_null() || value.as_str() == Some("assistant"),
                        _ => false,
                    })
                });
        self.saw_payload = true;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            self.provider_error = true;
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            // DeepSeek documents usage riding the same terminal chunk as
            // finish_reason; every other OpenAI-compatible provider must have
            // seen the terminal chunk already.
            let usage_allowed =
                terminal_was_seen || (self.usage_rides_terminal_chunk && terminal_here);
            if !usage_allowed || usage_was_seen {
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
                    if usage_allowed && !usage_was_seen {
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
        if terminal_was_seen && content.is_some() && !accounting_frame {
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
            if terminal_was_seen && !accounting_frame {
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

enum ProviderTerminalObservation {
    OpenAiCompatible(OpenAiCompatibleTerminalObservation),
    Anthropic(AnthropicTerminalObservation),
    Gemini(GeminiTerminalObservation),
}

impl ProviderTerminalObservation {
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
}

/// Cancel map: requestId -> oneshot sender. Dropping/sending cancels the future.
type CancelMap = HashMap<String, tokio::sync::watch::Sender<bool>>;
static CANCEL_MAP: OnceLock<Mutex<CancelMap>> = OnceLock::new();

fn cancel_map() -> &'static Mutex<CancelMap> {
    CANCEL_MAP.get_or_init(|| Mutex::new(HashMap::new()))
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

async fn wait_for_request_cancel(
    rx: &mut tokio::sync::watch::Receiver<bool>,
    computer: Option<&computer::ComputerStream>,
) {
    if let Some(computer) = computer {
        tokio::select! {
            biased;
            _ = wait_for_cancel(rx) => {}
            _ = computer.wait_for_cancel() => {}
        }
    } else {
        wait_for_cancel(rx).await;
    }
}

fn emit_provider_payload(
    emit: &(dyn Fn(String) + Send + Sync),
    payload: String,
    computer: &mut Option<computer::ComputerStream>,
    terminal: &mut ProviderTerminalObservation,
) -> Result<(), String> {
    if let Some(computer) = computer {
        for binding in computer.observe(&payload)? {
            emit(binding.to_string());
        }
    }
    terminal.observe(&payload);
    emit(payload);
    Ok(())
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
        "deepseek" => "Add a DeepSeek API key to connect.".to_string(),
        "gemini" => "Add a Gemini API key to connect.".to_string(),
        _ => format!("Add an {provider_id} API key to connect."),
    }
}

const EVENT_CHANNEL_PREFIX: &str = "arden://backend/";
const MAX_ATTEMPTS: usize = 3;
const MAX_STREAM_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const NATIVE_PROVIDER_IDS: &[&str] = &[
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "deepseek",
    "alibaba",
    "moonshot",
    "zai",
    "groq",
    "together",
    "fireworks",
    "cerebras",
    "mistral",
    "openrouter",
    "nvidia",
    "siliconflow",
    "cohere",
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

fn emit_control(emit: &(dyn Fn(String) + Send + Sync), event: TransportControlEvent<'_>) {
    if let Ok(payload) = serde_json::to_string(&serde_json::json!({
        "__mivletTransport": event
    })) {
        emit(payload);
    }
}

/// Stream a native-API completion. Looks up the key, issues the streaming
/// request, and emits each normalized SSE line as a Tauri event. Real
/// cancellation drops the future when `cancel_backend_completion` is called.
#[tauri::command]
pub async fn stream_backend_completion(
    app: AppHandle,
    request: BackendStreamRequest,
    computers: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
) -> Result<(), String> {
    let channel = format!("{EVENT_CHANNEL_PREFIX}{}", request.request_id);
    stream_completion(request, computers.inner(), &|payload| {
        let _ = app.emit(&channel, payload);
    })
    .await
}

/// Shared credential-bearing egress for the visual route and embedded host.
/// Neither caller receives provider credentials.
pub(crate) async fn stream_completion(
    mut request: BackendStreamRequest,
    computers: &std::sync::Arc<crate::local_computer::LocalComputerState>,
    emit: &(dyn Fn(String) + Send + Sync),
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
    if request
        .body
        .get("model")
        .and_then(serde_json::Value::as_str)
        != Some(&request.model)
    {
        return Err("The provider request body does not match the selected model.".into());
    }
    let route = request.provider_route.as_ref().ok_or_else(|| {
        "Native provider egress requires an authorized provider route.".to_string()
    })?;
    crate::backends::validate_current_native_provider_route(
        &request.provider_id,
        &request.model,
        route,
    )?;

    let mut body = std::mem::take(&mut request.body);
    let mut computer = computer::begin_stream(&request, &mut body, computers)?;
    if computer.is_some() && request.provider_id == "openai" {
        body["store"] = serde_json::json!(false);
    }
    // DeepSeek thinking mode is default-enabled and its documented
    // reasoning_content round-trip contract (the API returns 400 when a later
    // tool turn omits it) is not bridged by the shared OpenAI-compatible
    // shaper or the pinned SDK. This single egress choke point covers both the
    // embedded host and the local wire route: unsupported options fail closed
    // and every DeepSeek request runs the documented non-thinking mode.
    shape_provider_egress_body(&request.provider_id, &mut body)?;

    let observation_started = Instant::now();
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
        .map_err(|_| "Mivlet could not initialize the provider client.".to_string())?;
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    cancel_map()
        .lock()
        .map_err(|_| "Mivlet could not access the cancel map.".to_string())?
        .insert(request.request_id.clone(), tx);

    use futures_util::StreamExt;
    let mut cancelled = false;
    let mut completed = false;
    let mut transport_failed = false;
    let mut terminal_observation = ProviderTerminalObservation::new(&request.provider_id, false);

    // Screenshot deliveries are single-use: never silently resend their pixels
    // after an uncertain network outcome, rate limit or provider failure.
    let max_attempts = if computer.as_ref().is_some_and(|c| c.has_image()) {
        1
    } else {
        MAX_ATTEMPTS
    };
    for attempt in 0..max_attempts {
        if let Some(visual) = &computer {
            if let Err(message) = visual.before_send(computers) {
                emit_control(
                    emit,
                    TransportControlEvent {
                        kind: "error",
                        code: "stale-observation",
                        message,
                        retryable: false,
                        attempt: attempt + 1,
                        retry_after_ms: None,
                    },
                );
                completed = true;
                transport_failed = true;
                break;
            }
        }
        let mut outbound = client.post(&url).json(&body);
        if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
            outbound = outbound.header(auth_name.as_str(), auth_value.as_str());
        }
        for (name, value) in extra_headers(&request.provider_id) {
            outbound = outbound.header(name, value);
        }

        let response = tokio::select! {
            biased;
            _ = wait_for_request_cancel(&mut rx, computer.as_ref()) => {
                cancelled = true;
                None
            }
            response = outbound.send() => Some(response)
        };
        let Some(response) = response else {
            break;
        };
        let response = match response {
            Ok(response) => response,
            Err(error) if attempt + 1 < max_attempts => {
                let code = request_error_code(&error);
                let delay =
                    Duration::from_millis(250_u64.saturating_mul(2_u64.pow(attempt as u32)));
                emit_control(
                    emit,
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
                tokio::select! {
                    biased;
                    _ = wait_for_request_cancel(&mut rx, computer.as_ref()) => {
                        cancelled = true;
                        break;
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }
            Err(error) => {
                let code = request_error_code(&error);
                emit_control(
                    emit,
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
                break;
            }
        };

        if !response.status().is_success() {
            let status = response.status();
            let retryable = retryable_status(status);
            if retryable && attempt + 1 < max_attempts {
                let delay = retry_after(&response, attempt);
                emit_control(
                    emit,
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
                    biased;
                    _ = wait_for_request_cancel(&mut rx, computer.as_ref()) => {
                        cancelled = true;
                        break;
                    }
                    _ = tokio::time::sleep(delay) => {}
                }
                continue;
            }
            emit_control(
                emit,
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
            break;
        }

        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut response_bytes = 0usize;
        loop {
            tokio::select! {
                biased;
                _ = wait_for_request_cancel(&mut rx, computer.as_ref()) => {
                    cancelled = true;
                    break;
                }
                chunk = stream.next() => {
                    match chunk {
                        Some(Ok(bytes)) => {
                            if accumulate_and_check_bound(&mut response_bytes, &mut buffer, &bytes) {
                                emit_control(emit, TransportControlEvent {
                                    kind: "error",
                                    code: "response-too-large",
                                    message: "Provider stream exceeded Mivlet's response-size limit.".to_string(),
                                    retryable: false,
                                    attempt: attempt + 1,
                                    retry_after_ms: None,
                                });
                                completed = true;
                                transport_failed = true;
                                break;
                            }
                            let lines = match drain_strict_sse_lines(&mut buffer, false) {
                                Ok(lines) => lines,
                                Err(()) => {
                                    emit_control(emit, TransportControlEvent {
                                        kind: "error",
                                        code: "invalid-utf8",
                                        message: "Provider stream contained invalid UTF-8.".to_string(),
                                        retryable: false,
                                        attempt: attempt + 1,
                                        retry_after_ms: None,
                                    });
                                    completed = true;
                                    transport_failed = true;
                                    buffer.clear();
                                    break;
                                }
                            };
                            for line in lines {
                                if let Some(payload) = normalize_sse_line(&line) {
                                    if let Err(message) = emit_provider_payload(emit, payload, &mut computer, &mut terminal_observation) {
                                        emit_control(emit, TransportControlEvent {
                                            kind: "error", code: "invalid-tool-protocol", message,
                                            retryable: false, attempt: attempt + 1, retry_after_ms: None,
                                        });
                                        completed = true;
                                        transport_failed = true;
                                        break;
                                    }
                                }
                            }
                            if transport_failed { break; }
                        }
                        Some(Err(error)) => {
                            emit_control(emit, TransportControlEvent {
                                kind: "error",
                                code: request_error_code(&error),
                                message: "Provider stream ended unexpectedly.".to_string(),
                                retryable: true,
                                attempt: attempt + 1,
                                retry_after_ms: None,
                            });
                            completed = true;
                            transport_failed = true;
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
        if !buffer.is_empty() && !cancelled && !transport_failed {
            match drain_strict_sse_lines(&mut buffer, true) {
                Ok(lines) => {
                    for line in lines {
                        if let Some(payload) = normalize_sse_line(&line) {
                            if let Err(message) = emit_provider_payload(
                                emit,
                                payload,
                                &mut computer,
                                &mut terminal_observation,
                            ) {
                                emit_control(
                                    emit,
                                    TransportControlEvent {
                                        kind: "error",
                                        code: "invalid-tool-protocol",
                                        message,
                                        retryable: false,
                                        attempt: attempt + 1,
                                        retry_after_ms: None,
                                    },
                                );
                                transport_failed = true;
                                break;
                            }
                        }
                    }
                }
                Err(()) => {
                    emit_control(
                        emit,
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
                }
            }
        }
        break;
    }

    if let Some(visual) = &mut computer {
        if !cancelled {
            if let Err(message) = visual.complete(completed && !transport_failed) {
                emit_control(
                    emit,
                    TransportControlEvent {
                        kind: "error",
                        code: "invalid-tool-protocol",
                        message,
                        retryable: false,
                        attempt: 1,
                        retry_after_ms: None,
                    },
                );
                transport_failed = true;
            }
        }
    }
    let _ = cancel_map()
        .lock()
        .map(|mut map| map.remove(&request.request_id));
    let terminal = if cancelled { "[CANCELLED]" } else { "[DONE]" };
    emit(terminal.to_string());

    let (status, code) = if cancelled {
        ("cancelled", "cancelled")
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
    if !cancelled && completed && !transport_failed && terminal_observation.clean_stop() {
        let latency_ms =
            u64::try_from(observation_started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let observed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let _ = crate::backends::record_current_native_provider_route_observation(
            &request.provider_id,
            &request.model,
            route,
            &request.request_id,
            latency_ms,
            terminal_observation.usage(),
            &observed_at,
        );
    }
    Ok(())
}

pub(crate) fn shutdown_account() {
    if let Ok(mut calls) = cancel_map().lock() {
        for (_, sender) in calls.drain() {
            let _ = sender.send(true);
        }
    }
}

/// Cancel an in-flight completion by dropping its future (real cancellation).
#[tauri::command]
pub fn cancel_backend_completion(request_id: String) -> Result<bool, String> {
    let removed = cancel_map()
        .lock()
        .map_err(|_| "Mivlet could not access the cancel map.".to_string())?
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

mod discovery;
use discovery::{
    discovery_cursor, MAX_DISCOVERED_MODELS, MAX_DISCOVERY_PAGES, MAX_DISCOVERY_RESPONSE_BYTES,
};
pub use discovery::{
    models_endpoint_for, parse_models_body, DiscoveredModel, ModelDiscoveryResult,
};

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
                label: None,
                capabilities: None,
                reasoning: None,
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
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Mivlet could not initialize the provider client.".to_string())?;
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
            } else if provider_id == "openrouter" {
                // OpenRouter paginates with an offset into the full catalog.
                "offset"
            } else if provider_kind(&provider_id) == ProviderKind::Anthropic {
                "after_id"
            } else if provider_id == "cohere" {
                "page_token"
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
            .map_err(|_| "Mivlet could not read the provider model list.".to_string())?
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
                    message: Some("Mivlet could not parse the provider model list.".to_string()),
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

fn credential_verification_body(provider_id: &str) -> Result<Option<serde_json::Value>, String> {
    if !is_additional_native_provider(provider_id) {
        return Ok(None);
    }
    let model = crate::backends::native_verification_model(provider_id)
        .ok_or("The provider has no verification model.")?;
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "Reply OK." }],
        "max_tokens": 16,
        "stream": false
    });
    shape_provider_egress_body(provider_id, &mut body)?;
    Ok(Some(body))
}

fn verification_response_valid(body: &serde_json::Value) -> bool {
    body.get("error").is_none_or(serde_json::Value::is_null)
        && matches!(
            body.pointer("/choices/0/finish_reason")
                .and_then(serde_json::Value::as_str),
            Some("stop" | "length")
        )
        && body
            .pointer("/choices/0/message")
            .is_some_and(serde_json::Value::is_object)
}

/// Verify a stored native-API credential by hit-testing it against the
/// provider's list-models endpoint. The key never crosses into JavaScript —
/// Rust looks it up via the credential boundary, adds the auth header, and
/// issues a single bounded GET. Custom endpoints have no required discovery
/// endpoint, so their validated configuration returns `configured`; the first
/// conversation performs the truthful transport check. The HTTP result maps to a
/// [`BackendVerifyResult`]:
///   - 2xx → `ready`
///   - 401/403 → `auth-failed` (the key is bad/expired)
///   - network error → `offline`
///   - 404/405/501 → `unsupported`
///   - anything else → `failed`
///
/// Codex owns its official browser sign-in and never passes through this API-key
/// boundary, so it fails closed with `unsupported` here.
#[tauri::command]
pub async fn verify_backend_credential(provider_id: String) -> Result<BackendVerifyResult, String> {
    if !NATIVE_PROVIDER_IDS.contains(&provider_id.as_str()) {
        // Codex app-server owns its browser sign-in. Mivlet cannot verify it
        // through the API-key boundary.
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

    if provider_id == "custom" {
        return configured_custom_provider_result(&credential);
    }

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
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Mivlet could not initialize the provider client.".to_string())?;

    // Model catalogues can be public (for example OpenRouter). New direct routes
    // validate actual model access with one bounded inference request instead.
    let mut request = if let Some(body) = credential_verification_body(&provider_id)? {
        client.post(&connection.chat_endpoint).json(&body)
    } else {
        client.get(&url)
    };
    if let Some((auth_name, auth_value)) = connection.auth_header.as_ref() {
        request = request.header(auth_name.as_str(), auth_value.as_str());
    }
    for (name, value) in extra_headers(&provider_id) {
        request = request.header(name, value);
    }

    let mut response = match request.send().await {
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
    if status.is_success() && is_additional_native_provider(&provider_id) {
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read the provider verification response.".to_string())?
        {
            if bytes.len().saturating_add(chunk.len()) > 65_536 {
                return Ok(BackendVerifyResult {
                    provider_id,
                    outcome: "failed".into(),
                    message: Some(
                        "The provider verification response exceeded the supported size.".into(),
                    ),
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        if !serde_json::from_slice::<serde_json::Value>(&bytes)
            .is_ok_and(|body| verification_response_valid(&body))
        {
            return Ok(BackendVerifyResult {
                provider_id,
                outcome: "failed".into(),
                message: Some(
                    "The provider did not return a valid model verification response.".into(),
                ),
            });
        }
    }
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
mod tests;
