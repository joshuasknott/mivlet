//! A lazy projection of canonical receipts, never a second store for Mivlet attempts.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    pub since: String,
    pub until: String,
    pub bucket_starts: Vec<String>,
    pub source: String,
}

impl Query {
    fn default_at(at: &str) -> Result<Self> {
        let end = DateTime::parse_from_rfc3339(at).map_err(|_| invalid("Invalid usage date."))?;
        let start = end - Duration::days(30);
        Ok(Self {
            since: start.to_rfc3339_opts(SecondsFormat::Millis, true),
            until: (end + Duration::milliseconds(1)).to_rfc3339_opts(SecondsFormat::Millis, true),
            bucket_starts: (0..30)
                .map(|i| (start + Duration::days(i)).to_rfc3339_opts(SecondsFormat::Millis, true))
                .collect(),
            source: "mivlet".into(),
        })
    }
    fn validated(mut self, at: &str) -> Result<Self> {
        let parse =
            |s: &str| DateTime::parse_from_rfc3339(s).map_err(|_| invalid("Invalid usage window."));
        let (start, end, now) = (parse(&self.since)?, parse(&self.until)?, parse(at)?);
        if start < now - Duration::days(91)
            || end <= start
            || end > now + Duration::minutes(1)
            || end - start > Duration::days(91)
            || !matches!(self.source.as_str(), "mivlet" | "imported")
            || self.bucket_starts.is_empty()
            || self.bucket_starts.len() > 96
        {
            return Err(invalid("Choose a usage window of up to 90 days."));
        }
        let mut previous = None;
        for (index, stamp) in self.bucket_starts.iter_mut().enumerate() {
            let date = parse(stamp)?;
            if (index == 0 && date != start)
                || date < start
                || date >= end
                || previous.is_some_and(|p| date <= p || date - p > Duration::hours(26))
            {
                return Err(invalid("Usage chart boundaries are invalid."));
            }
            previous = Some(date);
            *stamp = date
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true);
        }
        if previous.is_none_or(|p| end - p > Duration::hours(26)) {
            return Err(invalid("Usage chart boundaries are incomplete."));
        }
        self.since = start
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        self.until = end
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        Ok(self)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub observed_at: String,
    pub usage: crate::models::ExecutionAttemptUsage,
    pub standard_pricing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bucket {
    starts_at: String,
    #[serde(flatten)]
    model: Model,
}

struct Cost {
    reported: bool,
    amount: Option<f64>,
    cache_savings: Option<f64>,
}

fn add(model: &mut Model, receipt: &Receipt, cost: &Cost) {
    let usage = &receipt.usage;
    model.provider_id = receipt.provider_id.clone();
    model.model = receipt.model.clone();
    model.attempts += 1;
    model.input_tokens = model.input_tokens.saturating_add(usage.input_tokens);
    model.output_tokens = model.output_tokens.saturating_add(usage.output_tokens);
    for (total, count, value) in [
        (
            &mut model.cached_input_tokens,
            &mut model.cached_input_attempts,
            usage.cached_input_tokens,
        ),
        (
            &mut model.cache_write_tokens,
            &mut model.cache_write_attempts,
            usage.cache_write_tokens,
        ),
        (
            &mut model.reasoning_tokens,
            &mut model.reasoning_attempts,
            usage.reasoning_tokens,
        ),
    ] {
        if let Some(value) = value {
            *total = Some(total.unwrap_or(0).saturating_add(value));
            *count += 1;
        }
    }
    if receipt.observed_at > model.latest_observed_at {
        model.latest_observed_at = receipt.observed_at.clone();
    }
    if let Some(amount) = cost.amount {
        if cost.reported {
            model.reported_cost_usd += amount;
            model.reported_cost_attempts += 1;
        } else {
            model.estimated_cost_usd += amount;
            model.estimated_cost_attempts += 1;
        }
    } else {
        model.unpriced_attempts += 1;
    }
    if let Some(savings) = cost.cache_savings {
        model.cache_savings_usd = Some(model.cache_savings_usd.unwrap_or(0.0) + savings);
    }
}

pub(super) fn read(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    at: &str,
    query: Option<Query>,
) -> Result<Report> {
    let query = match query {
        Some(query) => query,
        None => Query::default_at(at)?,
    }
    .validated(at)?;
    let overrides = prices(conn, store, scope)?;
    let catalog = pricing::load(conn, store, scope)?;
    let imports = imports::load(conn, store, scope)?;
    let mut receipts = Vec::new();
    let mut missing = 0;
    if query.source == "mivlet" {
        let mut stmt = conn.prepare("SELECT id FROM run WHERE workspace_id=?1 AND julianday(updated_at)>=julianday(?2) AND julianday(updated_at)<=julianday(?3) ORDER BY id")?;
        let ids = stmt
            .query_map(
                rusqlite::params![
                    scope.data.workspace_id(),
                    query.since,
                    (DateTime::parse_from_rfc3339(at)
                        .map_err(|_| invalid("Invalid usage date."))?
                        + Duration::minutes(1))
                    .to_rfc3339()
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in ids {
            let row = execution_attempt::get_scoped(conn, store, &scope.data, &id)?
                .ok_or_else(|| invalid("Usage receipt is unavailable."))?;
            let Some(raw) = row.payload.get("usage").filter(|v| !v.is_null()) else {
                missing += 1;
                continue;
            };
            let usage: crate::models::ExecutionAttemptUsage =
                serde_json::from_value(raw.clone())
                    .map_err(|_| invalid("Usage receipt is invalid."))?;
            let standard_pricing = usage.pricing_tier.as_deref() == Some("standard");
            let observed_at = DateTime::parse_from_rfc3339(
                usage.observed_at.as_deref().unwrap_or(&row.updated_at),
            )
            .map_err(|_| invalid("Usage receipt date is invalid."))?
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);
            receipts.push(Receipt {
                id,
                provider_id: row.provider_id,
                model: row.model,
                observed_at,
                usage,
                standard_pricing,
            });
        }
    } else {
        receipts.extend(imports.records.values().cloned());
    }
    let mut models: BTreeMap<(String, String), Model> = BTreeMap::new();
    let mut buckets: BTreeMap<(usize, String, String), Model> = BTreeMap::new();
    let mut applied = BTreeMap::new();
    for receipt in receipts {
        if receipt.observed_at < query.since || receipt.observed_at >= query.until {
            continue;
        }
        let usage = &receipt.usage;
        if !usage.cost_usd.is_finite()
            || usage.cost_usd < 0.0
            || usage
                .cached_input_tokens
                .is_some_and(|n| n > usage.input_tokens)
            || usage
                .reasoning_tokens
                .is_some_and(|n| n > usage.output_tokens)
        {
            return Err(invalid("Usage measurement is invalid."));
        }
        let unknown = usage.cost_unknown.unwrap_or(usage.cost_usd == 0.0);
        let reported = !unknown
            && !usage.cost_estimated
            && !matches!(receipt.provider_id.as_str(), "claude" | "opencode");
        let manual = overrides
            .iter()
            .find(|p| p.provider_id == receipt.provider_id && p.model == receipt.model);
        let automatic = receipt
            .standard_pricing
            .then(|| catalog.price(&receipt.provider_id, &receipt.model, usage, at))
            .flatten();
        let selected_price = manual.or(automatic.as_ref());
        let estimate = selected_price.and_then(|price| estimate(usage, price));
        let amount = if reported || (!unknown && manual.is_none()) {
            Some(usage.cost_usd)
        } else {
            estimate.or_else(|| (!unknown).then_some(usage.cost_usd))
        };
        let cache_savings = (!reported && estimate.is_some())
            .then(|| {
                let price = selected_price?;
                Some(
                    usage.cached_input_tokens? as f64
                        * (price.input_per_million_usd - price.cached_input_per_million_usd?)
                            .max(0.0)
                        / 1_000_000.0,
                )
            })
            .flatten();
        if let Some(price) = selected_price {
            if estimate.is_some() {
                applied.insert(
                    (receipt.provider_id.clone(), receipt.model.clone()),
                    price.clone(),
                );
            }
        }
        let cost = Cost {
            reported,
            amount,
            cache_savings,
        };
        add(
            models
                .entry((receipt.provider_id.clone(), receipt.model.clone()))
                .or_default(),
            &receipt,
            &cost,
        );
        let index = query
            .bucket_starts
            .partition_point(|s| s <= &receipt.observed_at)
            .saturating_sub(1);
        add(
            buckets
                .entry((index, receipt.provider_id.clone(), receipt.model.clone()))
                .or_default(),
            &receipt,
            &cost,
        );
    }
    let allowances = backend_connection::list(conn, &scope.internal_user_id)?
        .iter()
        .map(|p| cached(conn, store, scope, p, at))
        .collect::<Result<Vec<_>>>()?;
    let mut price_list = overrides;
    for (key, price) in applied {
        if !price_list
            .iter()
            .any(|p| (p.provider_id.clone(), p.model.clone()) == key)
        {
            price_list.push(price);
        }
    }
    Ok(Report {
        checked_at: at.into(),
        coverage: if query.source == "mivlet" {
            "saved-mivlet-attempts"
        } else {
            "imported-provider-history"
        },
        models: models.into_values().collect(),
        allowances,
        prices: price_list,
        since: query.since,
        until: query.until,
        buckets: buckets
            .into_iter()
            .map(|((index, _, _), model)| Bucket {
                starts_at: query.bucket_starts[index].clone(),
                model,
            })
            .collect(),
        pricing: catalog.status(at),
        imports: imports.summary(),
        missing_usage_attempts: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn receipt_dates_normalize_offsets_and_do_not_move_on_later_recovery_writes() {
        use crate::store::vault::{MasterKey, Vault};
        let at = "2026-10-17T12:00:00Z";
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        store.transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let payload = json!({"usage":{"inputTokens":140,"outputTokens":20,"cacheWriteTokens":10,"costUsd":0,"costUnknown":true,"observedAt":"2026-10-16T08:00:00-04:00"}});
            execution_attempt::upsert_scoped(conn, &store, &scope.data, "recovered", None, "codex", "exact", "interrupted", 1, true, 0, at, at, &payload)?;
            let query = Query { since: "2026-10-15T00:00:00Z".into(), until: at.into(), source: "mivlet".into(), bucket_starts: vec!["2026-10-15T00:00:00Z".into(), "2026-10-16T00:00:00Z".into(), "2026-10-17T00:00:00Z".into()] };
            let result = read(conn, &store, &scope, at, Some(query.clone()))?;
            assert_eq!(result.models[0].attempts, 1);
            assert_eq!(result.models[0].latest_observed_at, "2026-10-16T12:00:00.000Z");
            assert_eq!(result.buckets[0].starts_at, "2026-10-16T00:00:00.000Z");
            let today = Query { since: "2026-10-17T00:00:00Z".into(), bucket_starts: vec!["2026-10-17T00:00:00Z".into()], ..query };
            assert!(read(conn, &store, &scope, at, Some(today))?.models.is_empty());
            Ok(())
        }).unwrap();
    }
    #[test]
    fn local_calendar_boundaries_preserve_dst_and_reject_invalid_windows() {
        let at = "2026-10-26T12:00:00Z";
        let query = Query {
            since: "2026-10-23T23:00:00Z".into(),
            until: at.into(),
            source: "mivlet".into(),
            bucket_starts: vec![
                "2026-10-23T23:00:00Z".into(),
                "2026-10-24T23:00:00Z".into(),
                "2026-10-26T00:00:00Z".into(),
            ],
        };
        assert!(query.clone().validated(at).is_ok());
        let mut invalid = query.clone();
        invalid.bucket_starts.swap(0, 1);
        assert!(invalid.validated(at).is_err());
        let mut invalid = query;
        invalid.until = "2026-10-27T12:00:00Z".into();
        assert!(invalid.validated(at).is_err());
    }
    #[test]
    fn cache_writes_are_additive_and_reasoning_is_not_counted_twice() {
        let receipt = Receipt { id: "r".into(), provider_id: "claude".into(), model: "exact".into(), observed_at: "2026-10-17T12:00:00Z".into(), standard_pricing: true,
            usage: serde_json::from_value(json!({"inputTokens":140,"cachedInputTokens":40,"cacheWriteTokens":10,"outputTokens":20,"reasoningTokens":5,"costUsd":0,"costUnknown":true})).unwrap() };
        let mut model = Model::default();
        add(
            &mut model,
            &receipt,
            &Cost {
                amount: None,
                reported: false,
                cache_savings: None,
            },
        );
        assert_eq!(
            model.input_tokens + model.cache_write_tokens.unwrap_or(0) + model.output_tokens,
            170
        );
        assert_eq!(model.cached_input_attempts, 1);
        assert_eq!(model.reasoning_attempts, 1);
        assert_eq!(model.unpriced_attempts, 1);
    }
}
