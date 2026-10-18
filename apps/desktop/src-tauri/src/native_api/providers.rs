//! Provider profiles, credential envelopes, and vendor egress shaping.
//!
//! This module keeps provider-specific configuration and SSRF validation out
//! of the streaming transport while the parent module retains its stable facade.

use crate::models::BackendVerifyResult;
use url::{Host, Url};

/// Which wire family a native provider speaks (selects endpoint + auth header).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    /// OpenAI, xAI, and a user-configured compatible endpoint.
    OpenAiCompat,
    Anthropic,
    Gemini,
}

/// Map a provider id to its wire family.
pub fn provider_kind(provider_id: &str) -> ProviderKind {
    match provider_id {
        "anthropic" => ProviderKind::Anthropic,
        "gemini" => ProviderKind::Gemini,
        _ => ProviderKind::OpenAiCompat,
    }
}

#[derive(Clone, Copy)]
pub(super) struct OpenAiCompatProfile {
    pub(super) id: &'static str,
    pub(super) chat_endpoint: &'static str,
    pub(super) models_endpoint: Option<&'static str>,
    pub(super) auth_required: bool,
}

/// Fixed provider profiles. An absent models endpoint means credential
/// verification and discovery are unsupported, while chat execution remains
/// available through the curated model fallback.
pub(super) const OPENAI_COMPAT_PROFILES: &[OpenAiCompatProfile] = &[
    OpenAiCompatProfile {
        id: "alibaba",
        chat_endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        models_endpoint: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "moonshot",
        chat_endpoint: "https://api.moonshot.ai/v1/chat/completions",
        models_endpoint: Some("https://api.moonshot.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "zai",
        chat_endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
        models_endpoint: Some("https://api.z.ai/api/paas/v4/models"),
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
        id: "fireworks",
        chat_endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
        models_endpoint: Some("https://api.fireworks.ai/inference/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "cerebras",
        chat_endpoint: "https://api.cerebras.ai/v1/chat/completions",
        models_endpoint: Some("https://api.cerebras.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "mistral",
        chat_endpoint: "https://api.mistral.ai/v1/chat/completions",
        models_endpoint: Some("https://api.mistral.ai/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "openrouter",
        chat_endpoint: "https://openrouter.ai/api/v1/chat/completions",
        models_endpoint: Some("https://openrouter.ai/api/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "nvidia",
        chat_endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
        models_endpoint: Some("https://integrate.api.nvidia.com/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "siliconflow",
        chat_endpoint: "https://api.siliconflow.com/v1/chat/completions",
        models_endpoint: Some("https://api.siliconflow.com/v1/models"),
        auth_required: true,
    },
    OpenAiCompatProfile {
        id: "cohere",
        chat_endpoint: "https://api.cohere.ai/compatibility/v1/chat/completions",
        models_endpoint: Some("https://api.cohere.ai/v1/models?endpoint=chat"),
        auth_required: true,
    },
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
    // Official DeepSeek platform: OpenAI-compatible base URL
    // https://api.deepseek.com with POST /chat/completions and GET /models
    // (api-docs.deepseek.com /api/create-chat-completion and /api/list-models).
    OpenAiCompatProfile {
        id: "deepseek",
        chat_endpoint: "https://api.deepseek.com/chat/completions",
        models_endpoint: Some("https://api.deepseek.com/models"),
        auth_required: true,
    },
];

pub(super) fn openai_compat_profile(provider_id: &str) -> Option<&'static OpenAiCompatProfile> {
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
pub(super) struct CustomProviderCredential {
    version: u8,
    kind: String,
    base_url: String,
    pub(super) model_id: String,
    api_key: Option<String>,
}

#[derive(Clone)]
pub(super) struct ResolvedProviderConnection {
    pub(super) chat_endpoint: String,
    pub(super) models_endpoint: Option<String>,
    pub(super) auth_header: Option<(String, String)>,
}

pub(super) fn normalize_custom_base_url(raw: &str) -> Result<String, String> {
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

pub(crate) fn normalize_custom_model_id(raw: &str) -> Result<String, String> {
    let model_id = raw.trim().to_string();
    if model_id.is_empty() || model_id.len() > 256 || model_id.chars().any(char::is_control) {
        return Err("Custom provider model ID is invalid.".to_string());
    }
    Ok(model_id)
}

pub(super) fn parse_custom_provider_credential(
    secret: &str,
) -> Result<CustomProviderCredential, String> {
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
    credential.model_id = normalize_custom_model_id(&credential.model_id)?;
    if let Some(api_key) = credential.api_key.as_deref() {
        if api_key.is_empty() || api_key.chars().any(char::is_control) {
            return Err("Custom provider API key is invalid.".to_string());
        }
    }
    Ok(credential)
}

pub(crate) fn configured_custom_provider_model_id(secret: &str) -> Result<String, String> {
    Ok(parse_custom_provider_credential(secret)?.model_id)
}

pub(super) fn configured_custom_provider_result(
    credential: &str,
) -> Result<BackendVerifyResult, String> {
    parse_custom_provider_credential(credential)?;
    Ok(BackendVerifyResult {
        provider_id: "custom".to_string(),
        outcome: "configured".to_string(),
        message: Some(
            "Custom endpoint configuration saved. Mivlet will check it when you send a message."
                .to_string(),
        ),
    })
}

/// Validate structured native credentials before they enter the secure store.
/// Fixed remote providers accept opaque API keys; custom endpoints use a
/// validated configuration envelope.
pub(crate) fn validate_native_credential(provider_id: &str, secret: &str) -> Result<(), String> {
    match provider_id {
        "custom" => parse_custom_provider_credential(secret).map(|_| ()),
        "alibaba" => parse_alibaba_credential(secret).map(|_| ()),
        _ => Ok(()),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AlibabaCredential {
    version: u8,
    base_url: String,
    api_key: String,
}

pub(super) fn parse_alibaba_credential(secret: &str) -> Result<AlibabaCredential, String> {
    let mut credential: AlibabaCredential = serde_json::from_str(secret)
        .map_err(|_| "Enter an Alibaba API key and Model Studio endpoint.".to_string())?;
    if credential.version != 1
        || credential.api_key.trim().is_empty()
        || credential.api_key.chars().any(char::is_control)
    {
        return Err("The Alibaba API credential is invalid.".into());
    }
    credential.base_url = normalize_alibaba_base_url(&credential.base_url)?;
    Ok(credential)
}

pub(super) fn normalize_alibaba_base_url(raw: &str) -> Result<String, String> {
    let base = normalize_custom_base_url(raw)?;
    let url = Url::parse(&base).map_err(|_| "The Model Studio endpoint is invalid.")?;
    let host = url.host_str().unwrap_or_default();
    let legacy = [
        "dashscope-intl.aliyuncs.com",
        "dashscope.aliyuncs.com",
        "dashscope-us.aliyuncs.com",
        "cn-hongkong.dashscope.aliyuncs.com",
    ]
    .contains(&host);
    let workspace = [
        "cn-beijing",
        "ap-southeast-1",
        "cn-hongkong",
        "ap-northeast-1",
    ]
    .iter()
    .any(|region| {
        host.strip_suffix(&format!(".{region}.maas.aliyuncs.com"))
            .is_some_and(|id| {
                !id.is_empty()
                    && id.len() <= 63
                    && !id.starts_with('-')
                    && !id.ends_with('-')
                    && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
    });
    if url.scheme() != "https"
        || url.port().is_some()
        || url.path() != "/compatible-mode/v1"
        || (!legacy && !workspace)
    {
        return Err(
            "Use the official Alibaba Model Studio endpoint for your region and workspace.".into(),
        );
    }
    Ok(base)
}

pub(super) fn resolve_provider_connection(
    provider_id: &str,
    credential: &str,
    model: &str,
) -> Result<ResolvedProviderConnection, String> {
    if provider_id == "alibaba" {
        let config = parse_alibaba_credential(credential)?;
        return Ok(ResolvedProviderConnection {
            chat_endpoint: format!("{}/chat/completions", config.base_url),
            models_endpoint: Some(format!("{}/models", config.base_url)),
            auth_header: Some(("Authorization".into(), format!("Bearer {}", config.api_key))),
        });
    }
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
            // Mivlet uses the explicit, user-configured model ID instead.
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
    let models_endpoint = super::models_endpoint_for(provider_id).ok();
    let auth_required = openai_compat_profile(provider_id)
        .map(|profile| profile.auth_required)
        .unwrap_or(true);
    Ok(ResolvedProviderConnection {
        chat_endpoint,
        models_endpoint,
        auth_header: auth_required.then(|| auth_header_for(provider_id, credential)),
    })
}

/// Pure DeepSeek egress shaping: rejects unsupported thinking options and
/// forces the documented non-thinking mode. Applied to every DeepSeek body at
/// the single Rust egress boundary (embedded host and wire route alike).
pub(super) fn shape_deepseek_egress_body(body: &mut serde_json::Value) -> Result<(), String> {
    if body.get("reasoning_effort").is_some() {
        return Err("DeepSeek thinking mode is not supported by this route.".into());
    }
    if body
        .get("thinking")
        .and_then(|value| value.get("type"))
        .and_then(serde_json::Value::as_str)
        == Some("enabled")
    {
        return Err("DeepSeek thinking mode is not supported by this route.".into());
    }
    body["thinking"] = serde_json::json!({ "type": "disabled" });
    Ok(())
}

/// Vendor-specific options are enforced once, after either SDK or wire shaping.
/// Unbridged reasoning state must never make a later tool turn invalid.
pub(super) fn shape_provider_egress_body(
    provider_id: &str,
    body: &mut serde_json::Value,
) -> Result<(), String> {
    if provider_id == "deepseek" {
        return shape_deepseek_egress_body(body);
    }
    if is_additional_native_provider(provider_id) {
        if body.get("reasoning_effort").is_some()
            || body.get("reasoning").is_some()
            || body
                .pointer("/thinking/type")
                .and_then(serde_json::Value::as_str)
                == Some("enabled")
            || body
                .get("enable_thinking")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            return Err("Reasoning controls are not supported by this provider route.".into());
        }
        match provider_id {
            "alibaba" => body["enable_thinking"] = serde_json::json!(false),
            "moonshot" | "zai" => body["thinking"] = serde_json::json!({ "type": "disabled" }),
            "openrouter" => body["provider"] = serde_json::json!({ "require_parameters": true }),
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn is_additional_native_provider(provider_id: &str) -> bool {
    openai_compat_profile(provider_id).is_some()
        && !matches!(provider_id, "openai" | "xai" | "deepseek")
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
