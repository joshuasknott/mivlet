//! Account-owned measurements. Provider protocols stay in native adapters;
//! canonical encrypted attempts supply history, never CLI transcript/auth scans.
mod history;
pub(crate) mod imports;
pub(crate) mod pricing;
#[cfg(test)]
mod tests;

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
use crate::store::repos::{backend_connection, execution_attempt, preferences};
use crate::store::{Store, StoreError};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Result<T> = crate::store::Result<T>;
const MAX_AGE_SECONDS: i64 = 300;
type CollectionLock = std::sync::Arc<tokio::sync::Mutex<()>>;
static COLLECTIONS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, CollectionLock>>,
> = std::sync::OnceLock::new();

fn collection_lock(key: String) -> std::result::Result<CollectionLock, String> {
    let mut locks = COLLECTIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Usage collection is unavailable.")?;
    locks.retain(|_, lock| std::sync::Arc::strong_count(lock) > 1);
    Ok(locks
        .entry(key)
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Window {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_duration_mins: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Opportunity {
    pub id: String,
    pub resets_at: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Allowance {
    pub provider_id: String,
    pub identity: String,
    pub identity_kind: String,
    pub status: String,
    pub checked_at: String,
    pub observed_at: Option<String>,
    pub windows: Vec<Window>,
    pub reason: Option<String>,
    pub reset_opportunity: Option<Opportunity>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Price {
    pub provider_id: String,
    pub model: String,
    pub input_per_million_usd: f64,
    pub output_per_million_usd: f64,
    pub cached_input_per_million_usd: Option<f64>,
    pub cache_write_per_million_usd: Option<f64>,
    pub source: String,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Model {
    provider_id: String,
    model: String,
    attempts: u64,
    input_tokens: u64,
    output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_write_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_tokens: Option<u64>,
    reported_cost_usd: f64,
    reported_cost_attempts: u64,
    estimated_cost_usd: f64,
    estimated_cost_attempts: u64,
    unpriced_attempts: u64,
    latest_observed_at: String,
    cached_input_attempts: u64,
    cache_write_attempts: u64,
    reasoning_attempts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    cache_savings_usd: Option<f64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    checked_at: String,
    coverage: &'static str,
    models: Vec<Model>,
    allowances: Vec<Allowance>,
    prices: Vec<Price>,
    since: String,
    until: String,
    buckets: Vec<history::Bucket>,
    pricing: pricing::Status,
    imports: imports::Summary,
    missing_usage_attempts: u64,
}
fn invalid(message: &str) -> StoreError {
    StoreError::Invalid(message.into())
}
fn time() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn epoch(value: &Value) -> Option<String> {
    DateTime::from_timestamp(value.as_i64()?, 0)
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn iso(value: &Value) -> Option<String> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|v| {
        v.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}
pub(crate) fn opportunity(allowance: &Allowance) -> Option<Opportunity> {
    let exhausted: Vec<_> = allowance
        .windows
        .iter()
        .filter(|w| w.used_percent >= 100.0)
        .collect();
    if exhausted.is_empty() {
        return None;
    }
    let resets = exhausted
        .iter()
        .map(|w| w.resets_at.as_ref())
        .collect::<Option<Vec<_>>>()?;
    let resets_at = resets.into_iter().max()?.clone();
    let evidence = serde_json::to_string(&exhausted).ok()?;
    Some(Opportunity {
        id: hash(&format!(
            "{}:{}:{evidence}",
            allowance.provider_id, allowance.identity
        )),
        resets_at,
    })
}
pub(crate) fn codex(owner: &str, account: &Value, response: &Value, at: &str) -> Allowance {
    let account_id = account
        .get("id")
        .or_else(|| account.get("accountId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256);
    let mut report = unavailable(
        owner,
        "codex",
        at,
        "The provider returned no allowance windows.",
    );
    if let Some(id) = account_id {
        report.identity = hash(&format!("{owner}:codex:{id}"));
        report.identity_kind = "reported-account".into();
    }
    let buckets = response
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .take(16)
                .map(|(k, v)| (k.clone(), v))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![("codex".into(), &response["rateLimits"])]);
    for (bucket, value) in buckets {
        if bucket.is_empty() || bucket.len() > 80 || bucket.chars().any(char::is_control) {
            continue;
        }
        for position in ["primary", "secondary"] {
            let raw = &value[position];
            let Some(percent) = raw["usedPercent"]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
            else {
                continue;
            };
            report.windows.push(Window {
                id: format!("{bucket}:{position}"),
                label: format!("{bucket} · {position}"),
                used_percent: percent.min(100.0),
                window_duration_mins: raw["windowDurationMins"].as_u64().filter(|n| *n > 0),
                resets_at: epoch(&raw["resetsAt"]),
            });
        }
    }
    finish_report(report, at)
}
pub(crate) fn claude(owner: &str, response: &Value, at: &str) -> Allowance {
    let mut report = unavailable(
        owner,
        "claude",
        at,
        "The Claude SDK returned no supported allowance windows.",
    );
    for (id, label, duration) in [
        ("five_hour", "Five hour", 300),
        ("seven_day", "Weekly", 10080),
    ] {
        let raw = &response["rate_limits"][id];
        if let Some(percent) = raw["utilization"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            report.windows.push(Window {
                id: id.into(),
                label: label.into(),
                used_percent: percent.min(100.0),
                window_duration_mins: Some(duration),
                resets_at: iso(&raw["resets_at"]),
            });
        }
    }
    if let Some(rows) = response["rate_limits"]["model_scoped"].as_array() {
        for (index, raw) in rows.iter().take(16).enumerate() {
            let Some(name) = raw["display_name"]
                .as_str()
                .filter(|n| !n.is_empty() && n.len() <= 100 && !n.chars().any(char::is_control))
            else {
                continue;
            };
            let Some(percent) = raw["utilization"]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
            else {
                continue;
            };
            report.windows.push(Window {
                id: format!("model:{index}"),
                label: format!("Weekly · {name}"),
                used_percent: percent.min(100.0),
                window_duration_mins: Some(10080),
                resets_at: iso(&raw["resets_at"]),
            });
        }
    }
    finish_report(report, at)
}
fn finish_report(mut report: Allowance, at: &str) -> Allowance {
    if !report.windows.is_empty() {
        report.status = "available".into();
        report.reason = None;
        report.observed_at = Some(at.into());
        report.reset_opportunity = opportunity(&report);
    }
    report
}
fn unavailable(owner: &str, provider: &str, at: &str, reason: &str) -> Allowance {
    Allowance {
        provider_id: provider.into(),
        identity: hash(&format!("{owner}:{provider}:managed-custody")),
        identity_kind: "managed-connection".into(),
        status: "unavailable".into(),
        checked_at: at.into(),
        observed_at: None,
        windows: vec![],
        reason: Some(reason.into()),
        reset_opportunity: None,
    }
}
fn not_collected(owner: &str, provider: &str, reason: &str) -> Allowance {
    let mut report = unavailable(owner, provider, "", reason);
    report.checked_at.clear();
    report
}
fn key(owner: &str, provider: &str) -> String {
    format!("provider-allowance:{owner}:{provider}")
}
pub(crate) fn cached(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    provider: &str,
    at: &str,
) -> Result<Allowance> {
    let connected = backend_connection::list_records(conn, &scope.internal_user_id)?;
    let Some(connection) = connected.iter().find(|c| c.provider_id == provider) else {
        return Ok(not_collected(
            &scope.internal_user_id,
            provider,
            "Connect this provider in Mivlet to read its allowance.",
        ));
    };
    let Some(value) = preferences::get_scoped(
        conn,
        store,
        &scope.data,
        &key(&scope.internal_user_id, provider),
    )?
    else {
        return Ok(not_collected(
            &scope.internal_user_id,
            provider,
            "Refresh to check supported provider measurements.",
        ));
    };
    let mut report: Allowance = serde_json::from_value(value)
        .map_err(|_| invalid("Stored provider measurements are invalid."))?;
    if report
        .observed_at
        .as_deref()
        .or(Some(report.checked_at.as_str()))
        .is_some_and(|observed| observed < connection.updated_at.as_str())
    {
        return Ok(not_collected(
            &scope.internal_user_id,
            provider,
            "The provider connection changed. Refresh its allowance.",
        ));
    }
    if !fresh(&report, at) && !report.windows.is_empty() {
        report.status = "stale".into();
        report.reset_opportunity = None;
        if report.reason.is_none() {
            report.reason =
                Some("These measurements are stale. Refresh before relying on them.".into());
        }
    }
    Ok(report)
}
pub(crate) fn fresh(report: &Allowance, at: &str) -> bool {
    let Some(observed) = report
        .observed_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
    else {
        return false;
    };
    let Ok(now) = DateTime::parse_from_rfc3339(at) else {
        return false;
    };
    let age = now.signed_duration_since(observed);
    report.status == "available"
        && age >= Duration::zero()
        && age <= Duration::seconds(MAX_AGE_SECONDS)
}
pub(crate) fn store_allowance(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    report: &Allowance,
) -> Result<()> {
    preferences::upsert_scoped(
        conn,
        store,
        &scope.data,
        &key(&scope.internal_user_id, &report.provider_id),
        &json!(report),
        &report.checked_at,
    )
}

/// Adapter-only typed limit evidence. No renderer command can manufacture it.
pub(crate) fn record_limit_failure(provider: &str, run: Option<&str>) {
    let Some(run) = run else {
        return;
    };
    let Some(store) = crate::store::try_global() else {
        return;
    };
    let _ = store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
        crate::collaboration::ensure_run_current(conn, store, Some(run))?;
        let row = execution_attempt::get_scoped(conn, store, &scope.data, run)?
            .ok_or_else(|| invalid("Limit evidence needs a current attempt."))?;
        if row.provider_id != provider {
            return Err(invalid("Limit evidence provider changed."));
        }
        preferences::upsert_scoped(
            conn,
            store,
            &scope.data,
            &format!("provider-limit-failure:{}:{run}", scope.internal_user_id),
            &json!({"providerId":provider,"reportedAt":time()}),
            &time(),
        )
    });
}
pub(crate) fn has_limit_failure(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    provider: &str,
    run: &str,
) -> Result<bool> {
    Ok(preferences::get_scoped(
        conn,
        store,
        &scope.data,
        &format!("provider-limit-failure:{}:{run}", scope.internal_user_id),
    )?
    .is_some_and(|v| v["providerId"].as_str() == Some(provider)))
}

pub(crate) fn codex_event_is_limit(value: &Value) -> bool {
    value["method"] == "turn/completed"
        && value.pointer("/params/turn/status").and_then(Value::as_str) == Some("failed")
        && value
            .pointer("/params/turn/error/codexErrorInfo")
            .and_then(Value::as_str)
            == Some("usageLimitExceeded")
}
pub(crate) fn claude_event_is_limit(value: &Value) -> bool {
    value["type"] == "rate_limit_event"
        && value
            .pointer("/rate_limit_info/status")
            .and_then(Value::as_str)
            == Some("rejected")
}

#[tauri::command]
pub(crate) async fn refresh_provider_allowance(
    app: tauri::AppHandle,
    provider_id: String,
) -> std::result::Result<Allowance, String> {
    if !crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return Err("Unsupported provider.".into());
    }
    let owner = crate::backends::require_current_internal_user()?;
    if !crate::backends::connected_providers_for(&owner)?.contains(&provider_id) {
        return Ok(unavailable(
            &owner,
            &provider_id,
            &time(),
            "Connect this provider in Mivlet first.",
        ));
    }
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    let requested_at = time();
    let (connection_revision, workspace_id) = store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            if scope.internal_user_id != owner {
                return Err(invalid("The account changed during collection."));
            }
            backend_connection::list_records(conn, &owner)?
                .into_iter()
                .find(|c| c.provider_id == provider_id)
                .map(|c| (c.updated_at, scope.data.workspace_id().to_owned()))
                .ok_or_else(|| invalid("The provider connection is unavailable."))
        })
        .map_err(|e| e.to_string())?;
    let collector = collection_lock(hash(&format!(
        "{owner}:{workspace_id}:{provider_id}:{connection_revision}"
    )))?;
    let _guard = collector.lock().await;
    // A queued caller reuses the collection that just completed for this exact custody.
    let recent = store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            if scope.internal_user_id != owner || scope.data.workspace_id() != workspace_id {
                return Err(invalid(
                    "The account or workspace changed during collection.",
                ));
            }
            if !backend_connection::list_records(conn, &owner)?
                .iter()
                .any(|c| c.provider_id == provider_id && c.updated_at == connection_revision)
            {
                return Err(invalid(
                    "The provider connection changed during collection. Refresh its allowance.",
                ));
            }
            let cached = cached(conn, store, &scope, &provider_id, &time())?;
            Ok(
                (cached.checked_at >= requested_at && cached.checked_at <= time())
                    .then_some(cached),
            )
        })
        .map_err(|e| e.to_string())?;
    if let Some(report) = recent {
        return Ok(report);
    }
    let requested = provider_id.clone();
    let principal = owner.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        let at = time();
        let result = match requested.as_str() {
            "codex" => crate::codex_app_server::usage_probe().map(|(a,r)| codex(&principal,&a,&r,&at)),
            "claude" => crate::managed_runtime::claude_usage(&app,&principal).map(|r| claude(&principal,&r,&at)),
            "cursor" | "grok" | "opencode" => Ok(unavailable(&principal,&requested,&at,"This runtime needs verified Mivlet account isolation before its subscription limits can be collected. Check the provider's own account dashboard.")),
            "antigravity" => Ok(unavailable(&principal,&requested,&at,"Mivlet's managed Antigravity ACP connection has no supported allowance adapter. Check Antigravity's own usage view.")),
            _ => Ok(unavailable(&principal,&requested,&at,"This API route has no subscription allowance adapter. Saved token receipts remain available.")),
        };
        result.unwrap_or_else(|_| unavailable(&principal,&requested,&at,"The managed provider could not report allowance. Check its connection or runtime; no personal credentials were read."))
    }).await.map_err(|_| "Provider usage collection stopped unexpectedly.")?;
    if crate::backends::require_current_internal_user()? != owner {
        return Err("The account changed during collection.".into());
    }
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            if scope.internal_user_id != owner || scope.data.workspace_id() != workspace_id {
                return Err(invalid(
                    "The account or workspace changed during collection.",
                ));
            }
            if !backend_connection::list_records(conn, &owner)?
                .iter()
                .any(|c| c.provider_id == provider_id && c.updated_at == connection_revision)
            {
                return Err(invalid(
                    "The provider connection changed during collection. Refresh its allowance.",
                ));
            }
            let report = if report.status == "unavailable" {
                let mut old = cached(conn, store, &scope, &provider_id, &time())?;
                if old.windows.is_empty() {
                    report.clone()
                } else {
                    old.status = "stale".into();
                    old.checked_at = report.checked_at.clone();
                    old.reason = report.reason.clone();
                    old.reset_opportunity = None;
                    old
                }
            } else {
                report.clone()
            };
            store_allowance(conn, store, &scope, &report)?;
            Ok(report)
        })
        .map_err(|e| e.to_string())
}

fn prices(conn: &Connection, store: &Store, scope: &AuthorizedCommandScope) -> Result<Vec<Price>> {
    preferences::get_scoped(conn, store, &scope.data, "provider-usage-prices")?
        .map(|v| serde_json::from_value(v).map_err(|_| invalid("Stored usage prices are invalid.")))
        .transpose()
        .map(|v| v.unwrap_or_default())
}
fn estimate(usage: &crate::models::ExecutionAttemptUsage, price: &Price) -> Option<f64> {
    let cached = usage.cached_input_tokens.unwrap_or(0);
    let write = usage.cache_write_tokens.unwrap_or(0);
    Some(
        ((usage.input_tokens.checked_sub(cached)? as f64 * price.input_per_million_usd)
            + cached as f64
                * if cached > 0 {
                    price.cached_input_per_million_usd?
                } else {
                    0.0
                }
            + write as f64
                * if write > 0 {
                    price.cache_write_per_million_usd?
                } else {
                    0.0
                }
            + usage.output_tokens as f64 * price.output_per_million_usd)
            / 1_000_000.0,
    )
}
#[cfg(test)]
pub(crate) fn report(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    at: &str,
) -> Result<Report> {
    history::read(conn, store, scope, at, None)
}
#[tauri::command]
pub(crate) async fn provider_usage_report(
    query: Option<history::Query>,
) -> std::result::Result<Report, String> {
    tauri::async_runtime::spawn_blocking(move || provider_usage_report_blocking(query))
        .await
        .map_err(|_| "Usage history loading stopped unexpectedly.".to_string())?
}
fn provider_usage_report_blocking(
    query: Option<history::Query>,
) -> std::result::Result<Report, String> {
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            history::read(conn, store, &scope, &time(), query)
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn provider_allowance(
    provider_id: String,
) -> std::result::Result<Allowance, String> {
    tauri::async_runtime::spawn_blocking(move || provider_allowance_blocking(provider_id))
        .await
        .map_err(|_| "Usage loading stopped unexpectedly.".to_string())?
}
fn provider_allowance_blocking(provider_id: String) -> std::result::Result<Allowance, String> {
    if !crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&provider_id.as_str()) {
        return Err("Unsupported provider.".into());
    }
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            cached(conn, store, &scope, &provider_id, &time())
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn reset_provider_usage_price(
    provider_id: String,
    model: String,
) -> std::result::Result<(), String> {
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let mut records = prices(conn, store, &scope)?;
            records.retain(|p| p.provider_id != provider_id || p.model != model);
            preferences::upsert_scoped(
                conn,
                store,
                &scope.data,
                "provider-usage-prices",
                &json!(records),
                &time(),
            )
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn set_provider_usage_price(mut price: Price) -> std::result::Result<(), String> {
    let valid_source = url::Url::parse(&price.source).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    });
    if !crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&price.provider_id.as_str())
        || price.model.is_empty()
        || price.model.len() > 160
        || price.model.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(&price.model)
        || price.source.is_empty()
        || price.source.len() > 300
        || !valid_source
        || crate::secret_redaction::looks_secret(&price.source)
        || DateTime::parse_from_rfc3339(&price.observed_at)
            .ok()
            .is_none_or(|date| date > Utc::now() + Duration::minutes(1))
        || [
            Some(price.input_per_million_usd),
            Some(price.output_per_million_usd),
            price.cached_input_per_million_usd,
            price.cache_write_per_million_usd,
        ]
        .into_iter()
        .flatten()
        .any(|v| !v.is_finite() || !(0.0..=10000.0).contains(&v))
    {
        return Err(
            "Use exact-model nonnegative rates, an HTTPS source and a valid observation date."
                .into(),
        );
    }
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let mut records = prices(conn, store, &scope)?;
            records.retain(|p| p.provider_id != price.provider_id || p.model != price.model);
            if records.len() >= 256 {
                return Err(invalid("Usage price limit reached."));
            }
            price.origin = Some("override".into());
            records.push(price.clone());
            preferences::upsert_scoped(
                conn,
                store,
                &scope.data,
                "provider-usage-prices",
                &json!(records),
                &time(),
            )
        })
        .map_err(|e| e.to_string())
}
