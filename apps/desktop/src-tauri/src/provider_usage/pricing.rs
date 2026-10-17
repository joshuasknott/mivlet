//! Public price catalogue only. No credentials, account IDs or model history leave the device.
use super::*;
use futures_util::StreamExt;

pub(super) const SOURCE: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const KEY: &str = "provider-usage-automatic-prices";
const MAX_BYTES: usize = 16 * 1024 * 1024;
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    status: String,
    source: String,
    observed_at: Option<String>,
    checked_at: Option<String>,
    reason: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
    key: String,
    vendor: String,
    price: Price,
    standard_input_limit: Option<u64>,
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Catalog {
    observed_at: Option<String>,
    checked_at: Option<String>,
    reason: Option<String>,
    entries: Vec<Entry>,
}

fn age(stamp: Option<&str>, at: &str) -> Option<i64> {
    let age = DateTime::parse_from_rfc3339(at)
        .ok()?
        .signed_duration_since(DateTime::parse_from_rfc3339(stamp?).ok()?)
        .num_seconds();
    (age >= 0).then_some(age)
}

impl Catalog {
    pub(super) fn status(&self, at: &str) -> Status {
        let age = age(self.observed_at.as_deref(), at);
        Status {
            status: if age.is_some_and(|s| s <= 86400) {
                "available"
            } else if age.is_some_and(|s| s <= 7 * 86400) {
                "stale"
            } else {
                "unavailable"
            }
            .into(),
            source: SOURCE.into(),
            observed_at: self.observed_at.clone(),
            checked_at: self.checked_at.clone(),
            reason: self.reason.clone(),
        }
    }

    pub(super) fn price(
        &self,
        provider: &str,
        model: &str,
        usage: &crate::models::ExecutionAttemptUsage,
        at: &str,
    ) -> Option<Price> {
        if age(self.observed_at.as_deref(), at)? > 7 * 86400 || usage.cached_input_tokens.is_none()
        {
            return None;
        }
        // Never expand family names, strip version/context suffixes, or borrow another host's rates.
        let vendor = match provider {
            "codex" | "openai" => "openai",
            "claude" | "anthropic" => "anthropic",
            "gemini" => "gemini",
            "xai" => "xai",
            "deepseek" => "deepseek",
            "mistral" => "mistral",
            "groq" => "groq",
            "openrouter" => "openrouter",
            _ => return None,
        };
        if vendor == "anthropic" && usage.cache_write_tokens.is_none() {
            return None;
        }
        if matches!(model, "default" | "auto" | "opus" | "sonnet" | "haiku") {
            return None;
        }
        let prefixed = format!("{vendor}/{model}");
        let mut matches = self.entries.iter().filter(|entry| {
            entry.vendor == vendor
                && (entry.key == model || entry.key == prefixed)
                && entry
                    .standard_input_limit
                    .is_none_or(|limit| usage.input_tokens <= limit)
        });
        let entry = matches.next()?;
        // Conflicting exact aliases are deliberately unpriced.
        if matches.any(|other| !same_rates(&entry.price, &other.price)) {
            return None;
        }
        Some(Price {
            provider_id: provider.into(),
            model: model.into(),
            ..entry.price.clone()
        })
    }
}

fn same_rates(a: &Price, b: &Price) -> bool {
    a.input_per_million_usd == b.input_per_million_usd
        && a.output_per_million_usd == b.output_per_million_usd
        && a.cached_input_per_million_usd == b.cached_input_per_million_usd
        && a.cache_write_per_million_usd == b.cache_write_per_million_usd
}

fn rate(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 0.01)
        .map(|n| n * 1_000_000.0)
}

fn parse(value: &Value, at: &str) -> Result<Catalog> {
    let rows = value
        .as_object()
        .ok_or_else(|| invalid("The public price catalogue is invalid."))?;
    let mut entries = Vec::new();
    for (key, row) in rows.iter().take(20000) {
        let Some(vendor) = row["litellm_provider"].as_str() else {
            continue;
        };
        if row["mode"].as_str() != Some("chat")
            || key.len() > 200
            || key.chars().any(char::is_control)
        {
            continue;
        }
        let (Some(input), Some(output)) = (
            rate(&row["input_cost_per_token"]),
            rate(&row["output_cost_per_token"]),
        ) else {
            continue;
        };
        let standard_input_limit = row
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(field, _)| {
                let threshold = field
                    .strip_prefix("input_cost_per_token_above_")?
                    .strip_suffix("_tokens")?;
                let (number, scale) = threshold
                    .strip_suffix('k')
                    .map(|n| (n, 1000))
                    .or_else(|| threshold.strip_suffix('m').map(|n| (n, 1_000_000)))
                    .unwrap_or((threshold, 1));
                number.parse::<u64>().ok()?.checked_mul(scale)
            })
            .min();
        entries.push(Entry {
            key: key.clone(),
            vendor: vendor.into(),
            standard_input_limit,
            price: Price {
                provider_id: vendor.into(),
                model: key.clone(),
                input_per_million_usd: input,
                output_per_million_usd: output,
                cached_input_per_million_usd: rate(&row["cache_read_input_token_cost"]),
                cache_write_per_million_usd: rate(&row["cache_creation_input_token_cost"]),
                source: SOURCE.into(),
                observed_at: at.into(),
                origin: Some("automatic".into()),
            },
        });
    }
    if entries.len() < 2 {
        return Err(invalid(
            "The public price catalogue contains no usable exact-model rates.",
        ));
    }
    Ok(Catalog {
        observed_at: Some(at.into()),
        checked_at: Some(at.into()),
        reason: None,
        entries,
    })
}

pub(super) fn load(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<Catalog> {
    preferences::get_scoped(conn, store, &scope.data, KEY)?
        .map(serde_json::from_value)
        .transpose()
        .map(|v| v.unwrap_or_default())
        .map_err(|_| invalid("Saved public prices are invalid."))
}

async fn download() -> std::result::Result<Value, ()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ())?;
    let response = client.get(SOURCE).send().await.map_err(|_| ())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ())
}

#[tauri::command]
pub(crate) async fn refresh_provider_usage_prices(
    force: bool,
) -> std::result::Result<Status, String> {
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    let scope = store
        .with_conn(|conn| authorized_scope::resolve(conn, None, None, ScopeAccess::Read))
        .map_err(|e| e.to_string())?;
    let _guard = REFRESH.lock().await;
    let mut catalog = store
        .with_conn(|conn| {
            let current = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            if current.internal_user_id != scope.internal_user_id
                || current.data.workspace_id() != scope.data.workspace_id()
            {
                return Err(invalid(
                    "The account or workspace changed during the price update.",
                ));
            }
            load(conn, store, &scope)
        })
        .map_err(|e| e.to_string())?;
    let at = time();
    if !force
        && (age(catalog.observed_at.as_deref(), &at).is_some_and(|s| s < 86400)
            || age(catalog.checked_at.as_deref(), &at).is_some_and(|s| s < 300))
    {
        return Ok(catalog.status(&at));
    }
    let result = download()
        .await
        .and_then(|value| parse(&value, &time()).map_err(|_| ()));
    match result {
        Ok(value) => catalog = value,
        Err(_) => {
            catalog.checked_at = Some(time());
            catalog.reason = Some("Public prices could not be updated. Recent saved rates and your overrides remain available.".into());
        }
    }
    store
        .transaction(|conn| {
            let current = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            if current.internal_user_id != scope.internal_user_id
                || current.data.workspace_id() != scope.data.workspace_id()
            {
                return Err(invalid(
                    "The account or workspace changed during the price update.",
                ));
            }
            preferences::upsert_scoped(conn, store, &scope.data, KEY, &json!(catalog), &time())?;
            Ok(catalog.status(&time()))
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_prices_only_known_standard_receipts_and_preserves_overrides_and_reported_zero() {
        use crate::store::vault::{MasterKey, Vault};
        let at = "2026-10-17T12:00:00Z";
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store.transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let catalog = parse(&json!({
                "exact-model":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000002,"output_cost_per_token":0.000008,"cache_read_input_token_cost":0.0000005},
                "other-model":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000003,"output_cost_per_token":0.000009}
            }), at)?;
            preferences::upsert_scoped(conn, &store, &scope.data, KEY, &json!(catalog), at)?;
            for (id, tier) in [("standard", Some("standard")), ("fast", Some("priority")), ("legacy", None)] {
                let payload = json!({"usage":{"inputTokens":140,"outputTokens":20,"cachedInputTokens":40,"costUsd":0,"costUnknown":true,"pricingTier":tier}});
                execution_attempt::upsert_scoped(conn, &store, &scope.data, id, None, "codex", "exact-model", "failed", 1, true, 0, at, at, &payload)?;
            }
            let first = history::read(conn, &store, &scope, at, None)?;
            assert_eq!(first.models[0].estimated_cost_attempts, 1);
            assert_eq!(first.models[0].unpriced_attempts, 2);
            assert!((first.models[0].estimated_cost_usd - 0.00038).abs() < 1e-10);
            let price = Price { provider_id: "codex".into(), model: "exact-model".into(), input_per_million_usd: 4.0,
                output_per_million_usd: 10.0, cached_input_per_million_usd: Some(1.0), cache_write_per_million_usd: None,
                source: "https://example.test/pricing".into(), observed_at: at.into(), origin: Some("override".into()) };
            preferences::upsert_scoped(conn, &store, &scope.data, "provider-usage-prices", &json!([price]), at)?;
            let next = history::read(conn, &store, &scope, at, None)?;
            assert_eq!(next.models[0].estimated_cost_attempts, 3);
            assert_eq!(next.models[0].unpriced_attempts, 0);
            assert!((next.models[0].estimated_cost_usd - 0.00192).abs() < 1e-10);
            let payload = json!({"usage":{"inputTokens":140,"outputTokens":20,"cachedInputTokens":40,"costUsd":0,"costUnknown":false,"pricingTier":"standard"}});
            execution_attempt::upsert_scoped(conn, &store, &scope.data, "reported-free", None, "codex", "exact-model", "completed", 1, false, 0, at, at, &payload)?;
            let final_report = history::read(conn, &store, &scope, at, None)?;
            assert_eq!(final_report.models[0].reported_cost_attempts, 1);
            assert_eq!(final_report.models[0].reported_cost_usd, 0.0);
            assert_eq!(final_report.models[0].estimated_cost_attempts, 3);
            let bytes: Vec<u8> = conn.query_row("SELECT payload FROM preferences WHERE key=?1", [KEY], |r| r.get(0))?;
            assert!(!String::from_utf8_lossy(&bytes).contains("exact-model"));
            Ok(())
        }).unwrap();
    }
    #[test]
    fn exact_vendor_model_cache_rates_age_and_context_tiers_fail_closed() {
        let at = "2026-10-17T12:00:00Z";
        let catalog = parse(&json!({
            "exact-model":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.000002,"output_cost_per_token":0.000008,"cache_read_input_token_cost":0.0000005,"input_cost_per_token_above_200k_tokens":0.000004},
            "sonnet":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":0.000003,"output_cost_per_token":0.000015},
            "negative":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":-1,"output_cost_per_token":1}
        }), at).unwrap();
        let mut usage: crate::models::ExecutionAttemptUsage = serde_json::from_value(json!({"inputTokens":140,"outputTokens":20,"cachedInputTokens":40,"costUsd":0,"costUnknown":true})).unwrap();
        let price = catalog.price("codex", "exact-model", &usage, at).unwrap();
        assert!((estimate(&usage, &price).unwrap() - 0.00038).abs() < 1e-10);
        assert!(catalog.price("claude", "sonnet", &usage, at).is_none());
        assert!(catalog.price("custom", "exact-model", &usage, at).is_none());
        assert!(catalog
            .price("anthropic", "exact-model", &usage, at)
            .is_none());
        assert!(catalog
            .price("codex", "exact-model[1m]", &usage, at)
            .is_none());
        assert!(catalog
            .price("codex", "exact-model", &usage, "2026-10-25T12:00:00Z")
            .is_none());
        usage.input_tokens = 200001;
        assert!(catalog.price("codex", "exact-model", &usage, at).is_none());
        usage.cache_write_tokens = Some(10);
        assert!(estimate(&usage, &price).is_none());
    }
}
