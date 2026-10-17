//! Explicit cloud text tasks. Canonical Work and the native approval ledger own
//! admission; the task Worker owns one API request. There is no native fallback.
mod commands;
pub(crate) mod dispatch;
pub(crate) mod models;
pub(crate) mod public_web;
#[cfg(test)]
mod tests;
pub(crate) mod transport;
pub(crate) use commands::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) fn opaque(prefix: &str) -> Result<String, String> {
    let mut random = [0u8; 24];
    getrandom::fill(&mut random).map_err(|_| "Cloud task identity is unavailable.")?;
    Ok(format!("{prefix}-{}", hex::encode(random)))
}
pub(crate) fn valid_id(value: &str) -> Result<(), String> {
    if !(3..=160).contains(&value.len())
        || !value
            .bytes()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || i > 0 && b"._:-".contains(&c))
    {
        return Err("Invalid cloud task identity.".into());
    }
    Ok(())
}
pub(crate) fn supported_provider(value: &str) -> bool {
    matches!(
        value,
        "openai" | "anthropic" | "gemini" | "xai" | "deepseek"
    )
}
pub(crate) fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(items) => {
            let sorted: std::collections::BTreeMap<_, _> = items.iter().collect();
            let mut output = serde_json::Map::new();
            for (key, value) in sorted {
                output.insert(key.clone(), canonical(value));
            }
            Value::Object(output)
        }
        value => value.clone(),
    }
}
pub(crate) fn digest_value(value: &Value) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(&canonical(value)).map_err(|_| "Cloud task encoding failed.")?,
    )))
}
pub(crate) fn text_failure(content: &str) -> bool {
    if content.contains('\0')
        || crate::secret_redaction::redact_secret_text(content) != content
        || crate::secret_redaction::looks_secret(content)
        || crate::secret_redaction::secret_marker_survives(content)
    {
        return true;
    }
    static PATH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATH.get_or_init(|| regex::Regex::new(r#"(?im)(?:^|[\s\"'`(])(?:[A-Za-z]:[\\/]|\\\\|file://|/(?:Users|home|tmp|var|etc|root|mnt|media|private)/)"#).expect("fixed local path expression")).is_match(content)
}
pub(crate) fn validate_result(
    binding: &models::Binding,
    previous: Option<&models::TaskSnapshot>,
    result: &models::TaskResult,
) -> Result<(), String> {
    let s = &result.snapshot;
    public_web::validate_receipt(binding, s)?;
    if &s.binding != binding
        || s.generation == 0
        || s.sequence == 0
        || s.created_at <= 0
        || s.updated_at < s.created_at
        || s.retained_until < s.created_at
        || s.retained_until > s.created_at + 86_400_000
        || s.result_bytes > binding.budget.max_result_bytes
        || !matches!(
            s.status.as_str(),
            "queued" | "running" | "completed" | "failed" | "cancelled" | "uncertain" | "expired"
        )
        || s.error_code.as_ref().is_some_and(|v| {
            v.len() > 80 || !v.bytes().all(|c| c.is_ascii_lowercase() || c == b'-')
        })
        || previous.is_some_and(|p| {
            s.generation < p.generation
                || s.sequence < p.sequence
                || s.created_at != p.created_at
                || s.retained_until != p.retained_until
        })
    {
        return Err("The cloud task receipt did not match its immutable native admission.".into());
    }
    if s.status == "completed" {
        if result.text.trim().is_empty()
            || result.text.len() != s.result_bytes
            || s.result_sha256.as_deref()
                != Some(hex::encode(Sha256::digest(result.text.as_bytes())).as_str())
            || text_failure(&result.text)
        {
            return Err("The cloud answer failed its size, content or checksum validation.".into());
        }
    } else if !result.text.is_empty() || s.result_bytes != 0 {
        return Err("A non-completed cloud task cannot supply answer text.".into());
    }
    if let Some(usage) = &s.usage {
        let object = usage.as_object().ok_or("Invalid cloud usage receipt.")?;
        if object.keys().any(|k| {
            ![
                "inputTokens",
                "outputTokens",
                "cachedInputTokens",
                "cacheWriteTokens",
                "reasoningTokens",
                "costUsd",
                "costEstimated",
                "costUnknown",
            ]
            .contains(&k.as_str())
        }) || object
            .get("inputTokens")
            .and_then(Value::as_u64)
            .is_none_or(|v| v > 2_000_000)
            || object
                .get("outputTokens")
                .and_then(Value::as_u64)
                .is_none_or(|v| v > binding.budget.max_output_tokens.into())
            || !object
                .get("costUsd")
                .and_then(Value::as_f64)
                .is_some_and(|v| v.is_finite() && v >= 0.0)
            || object
                .get("costEstimated")
                .and_then(Value::as_bool)
                .is_none()
            || object.get("costUnknown").and_then(Value::as_bool).is_none()
            || ["cachedInputTokens", "cacheWriteTokens", "reasoningTokens"]
                .iter()
                .any(|k| {
                    object
                        .get(*k)
                        .is_some_and(|v| v.as_u64().is_none_or(|v| v > 2_000_000))
                })
        {
            return Err("Invalid cloud usage receipt.".into());
        }
    }
    Ok(())
}
