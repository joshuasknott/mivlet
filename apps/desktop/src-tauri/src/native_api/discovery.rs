//! Native model discovery parsing and bounded pagination policy.
//!
//! Provider response parsing is pure and kept separate from the credential-owned
//! HTTP loop in the parent facade.

use super::{openai_compat_profile, provider_kind, ProviderKind};

/// The maximum number of model ids a discovery response may surface. Caps a
/// hostile or pathological provider response so the merge step stays bounded.
pub(super) const MAX_DISCOVERED_MODELS: usize = 1_000;
pub(super) const MAX_DISCOVERY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_DISCOVERY_PAGES: usize = 10;

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
/// invented here — the TS merge step attaches catalogue capabilities where
/// known, and OpenRouter discovery carries the model's own bounded metadata.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    pub id: String,
    pub available: bool,
    /// Provider-reported display name (OpenRouter `name`), bounded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Provider-reported capabilities mapped into the Mivlet capability
    /// vocabulary, bounded and validated by this boundary. Only fields the
    /// provider metadata substantiates are present; unknown stays absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    /// Provider-reported reasoning levels mapped into the Mivlet reasoning
    /// contract, bounded and validated by this boundary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<serde_json::Value>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub outcome: &'static str,
    pub models: Vec<DiscoveredModel>,
    pub message: Option<String>,
}

pub(super) fn is_generation_model(provider_id: &str, model: &serde_json::Value, id: &str) -> bool {
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

/// OpenRouter reasoning-effort vocabulary (documented `ReasoningEffort` enum).
const OPENROUTER_REASONING_EFFORTS: [&str; 7] =
    ["max", "xhigh", "high", "medium", "low", "minimal", "none"];

/// Bounds accepted by the embedded host context budget validation.
const OPENROUTER_CONTEXT_MIN: u64 = 1_024;
const OPENROUTER_CONTEXT_MAX: u64 = 2_000_000;

/// Map OpenRouter model metadata into Mivlet's bounded capability vocabulary.
///
/// Truth rules (sources: openrouter.ai/docs/api/api-reference/models and the
/// live GET /api/v1/models shape):
///   - contextWindow from `context_length` (bounded; absent when unknown).
///   - tools only when `supported_parameters` lists both `tools` and
///     `tool_choice` — a model without tool support never inherits it.
///   - structuredOutput only when `structured_outputs` is listed.
///   - vision is deliberately never advertised: the OpenRouter metadata lists
///     `image` input for many models, but Mivlet's OpenRouter route has no
///     verified image-egress protocol (native screenshot delivery and image
///     turns both fail closed on this route).
///   - reasoning is advertised only when the `reasoning` object and
///     `reasoning_effort` parameter are both present (see
///     [`openrouter_reasoning`]).
///
/// Unknown metadata produces no field — unknown is never treated as capable.
fn openrouter_capabilities(model: &serde_json::Value) -> Option<serde_json::Value> {
    let context = model
        .get("context_length")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (OPENROUTER_CONTEXT_MIN..=OPENROUTER_CONTEXT_MAX).contains(value));
    let parameters = model
        .get("supported_parameters")
        .and_then(serde_json::Value::as_array);
    let supports = |name: &str| {
        parameters.is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some(name)))
    };
    let tools = supports("tools") && supports("tool_choice");
    let structured = supports("structured_outputs");
    let mut capabilities = serde_json::json!({ "streaming": true });
    if let Some(context) = context {
        capabilities["contextWindow"] = serde_json::json!(context);
    }
    if tools {
        capabilities["tools"] = serde_json::json!(true);
    }
    if structured {
        capabilities["structuredOutput"] = serde_json::json!(true);
    }
    if openrouter_reasoning(model).is_some() {
        capabilities["reasoning"] = serde_json::json!(true);
    }
    Some(capabilities)
}

/// Map OpenRouter `reasoning` metadata into the Mivlet reasoning contract.
/// Only models that list `reasoning_effort` as a supported parameter and carry
/// a non-empty allowlist of recognized effort levels advertise levels; a
/// `null` allowlist ("all gateway effort values accepted") stays unadvertised
/// so Mivlet never rejects a valid level it does not know.
fn openrouter_reasoning(model: &serde_json::Value) -> Option<serde_json::Value> {
    let reasoning = model.get("reasoning")?;
    if reasoning.is_null() {
        return None;
    }
    let supports = |name: &str| {
        model
            .get("supported_parameters")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some(name)))
    };
    if !supports("reasoning_effort") {
        return None;
    }
    let efforts: Vec<String> = reasoning
        .get("supported_efforts")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter(|effort| OPENROUTER_REASONING_EFFORTS.contains(effort))
        .take(8)
        .map(str::to_string)
        .collect();
    if efforts.is_empty() {
        return None;
    }
    let default = reasoning
        .get("default_effort")
        .and_then(serde_json::Value::as_str)
        .filter(|effort| efforts.iter().any(|known| known == effort))
        .map(str::to_string);
    let mut result = serde_json::json!({ "supportedEfforts": efforts });
    if let Some(default) = default {
        result["defaultEffort"] = serde_json::json!(default);
    }
    Some(result)
}

/// Bounded display name from OpenRouter `name`, or None when absent/unclean.
fn openrouter_label(model: &serde_json::Value) -> Option<String> {
    let label = model
        .get("name")
        .and_then(serde_json::Value::as_str)?
        .trim();
    if label.is_empty() || label.chars().count() > 240 {
        return None;
    }
    Some(label.to_string())
}

/// A `~` "latest alias" entry resolves to a different model over time and has
/// no stable identity of its own; only the canonical rows are surfaced.
fn is_openrouter_alias(model: &serde_json::Value, id: &str) -> bool {
    id.starts_with('~')
        || model
            .get("alias_target")
            .is_some_and(|target| !target.is_null())
}

/// OpenRouter chat-completions models produce text; non-text output rows
/// (image/embedding/audio generation) have no chat-completions route.
fn is_openrouter_text_output(model: &serde_json::Value) -> bool {
    model
        .get("architecture")
        .and_then(|architecture| architecture.get("output_modalities"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|modalities| {
            modalities
                .iter()
                .any(|modality| modality.as_str() == Some("text"))
        })
}

/// Extract model ids from a list-models JSON body across provider shapes. Pure
/// helper so the per-provider parsing contract is unit-tested without a socket.
///
/// Recognized shapes:
///   - OpenAI / xAI: `{ "data": [{ "id": "..." }] }`
///   - OpenRouter: `{ "data": [{ "id", "name", "context_length",
///     "architecture", "supported_parameters", "reasoning" }] }` — the same
///     `data` array, with bounded per-model capability metadata attached and
///     unstable `~` alias rows and non-text-output rows filtered out.
///   - Anthropic: `{ "data": [{ "id": "..." }] }`
///   - Gemini: `{ "models": [{ "name": "models/gemini-...", "supportedGenerationMethods": [...] }] }`
pub fn parse_models_body(provider_id: &str, body: &serde_json::Value) -> Vec<DiscoveredModel> {
    let mut out = Vec::new();
    if provider_id == "cohere" {
        if let Some(models) = body.get("models").and_then(serde_json::Value::as_array) {
            for model in models.iter().take(MAX_DISCOVERED_MODELS) {
                let id = model
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .trim();
                if id.is_empty()
                    || model
                        .get("is_deprecated")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                    || !model
                        .get("endpoints")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|endpoints| {
                            endpoints.iter().any(|endpoint| endpoint == "chat")
                        })
                {
                    continue;
                }
                out.push(DiscoveredModel {
                    id: id.into(),
                    available: true,
                    label: None,
                    capabilities: None,
                    reasoning: None,
                });
            }
        }
        return out;
    }
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
                        label: None,
                        capabilities: None,
                        reasoning: None,
                    });
                }
            }
        }
        return out;
    }

    // Together also documents a top-level array of model records.
    if let Some(data) = body.get("data").and_then(|v| v.as_array()).or_else(|| {
        (provider_id == "together")
            .then(|| body.as_array())
            .flatten()
    }) {
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
            if provider_id == "openrouter" {
                // Unstable aliases and non-chat output rows are not selectable
                // routes for Mivlet's chat-completions transport.
                if is_openrouter_alias(model, id) || !is_openrouter_text_output(model) {
                    continue;
                }
                out.push(DiscoveredModel {
                    id: id.to_string(),
                    available: crate::backends::native_provider_route_reason(provider_id, id)
                        .is_ok(),
                    label: openrouter_label(model),
                    capabilities: openrouter_capabilities(model),
                    reasoning: openrouter_reasoning(model),
                });
                continue;
            }
            out.push(DiscoveredModel {
                id: id.to_string(),
                available: true,
                label: None,
                capabilities: None,
                reasoning: None,
            });
        }
    }
    out
}

pub(super) fn discovery_cursor(provider_id: &str, body: &serde_json::Value) -> Option<String> {
    if provider_id == "cohere" {
        return body
            .get("next_page_token")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    if provider_kind(provider_id) == ProviderKind::Gemini {
        return body
            .get("nextPageToken")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .filter(|value| !value.is_empty());
    }
    if provider_id == "openrouter" {
        // OpenRouter paginates with `links.next` (e.g. "/api/v1/models?offset=500&limit=500").
        // Only the bounded offset value is trusted; the path itself is pinned
        // to the known models endpoint.
        let next = body
            .get("links")
            .and_then(|links| links.get("next"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let offset = next
            .strip_prefix("/api/v1/models?offset=")
            .or_else(|| next.strip_prefix("?offset="));
        return offset
            .and_then(|rest| rest.split('&').next())
            .filter(|value| !value.is_empty() && value.len() <= 20)
            .map(str::to_string)
            .filter(|value| value.chars().all(|character| character.is_ascii_digit()));
    }
    if body.get("has_more").and_then(|value| value.as_bool()) != Some(true) {
        return None;
    }
    body.get("last_id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}
