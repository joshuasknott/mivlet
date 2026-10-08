use super::*;
use crate::store::vault::{MasterKey, Vault};

const AT: &str = "2026-10-08T12:00:00.000Z";
fn store() -> Store {
    Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
}
fn limits() -> Value {
    json!({"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":1791464400},"secondary":{"usedPercent":45,"windowDurationMins":10080,"resetsAt":1791500000}},"spark":{"primary":{"usedPercent":12,"windowDurationMins":60}}}})
}
#[test]
fn codex_multi_bucket_preserves_duration_unknown_reset_and_identity_isolation() {
    let report = codex("owner-a", &json!({"id":"provider-account"}), &limits(), AT);
    assert_eq!(report.provider_id, "codex");
    assert!(crate::models::SUPPORTED_BACKEND_PROVIDER_IDS.contains(&report.provider_id.as_str()));
    assert_eq!(report.windows.len(), 3);
    assert_eq!(report.windows[0].used_percent, 100.0);
    assert_eq!(report.identity_kind, "reported-account");
    assert!(!report.identity.contains("provider-account"));
    assert!(report.reset_opportunity.is_some());
    assert_ne!(
        report.identity,
        codex("owner-b", &json!({"id":"provider-account"}), &limits(), AT).identity
    );
    assert_eq!(
        report.identity,
        codex("owner-a", &json!({"id":"provider-account"}), &limits(), AT).identity
    );
    let unknown = codex(
        "owner-a",
        &json!({}),
        &json!({"rateLimits":{"primary":{"usedPercent":100}}}),
        AT,
    );
    assert!(unknown.reset_opportunity.is_none());
    assert!(unknown.windows[0].window_duration_mins.is_none());
}
#[test]
fn only_typed_provider_limit_events_establish_failure() {
    assert!(!codex_event_is_limit(
        &json!({"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"usage limit exceeded"}}}})
    ));
    assert!(codex_event_is_limit(
        &json!({"method":"turn/completed","params":{"turn":{"status":"failed","error":{"codexErrorInfo":"usageLimitExceeded"}}}})
    ));
    assert!(!claude_event_is_limit(
        &json!({"type":"result","is_error":true,"result":"rate limit reached"})
    ));
    assert!(claude_event_is_limit(
        &json!({"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}})
    ));
}
#[test]
fn claude_percentages_are_not_rescaled_and_missing_categories_stay_unknown() {
    let report = claude(
        "owner",
        &json!({"rate_limits":{"five_hour":{"utilization":60,"resets_at":"2026-10-08T13:00:00Z"},"seven_day":{"utilization":null},"model_scoped":[{"display_name":"Sonnet","utilization":100,"resets_at":null}]}}),
        AT,
    );
    assert_eq!(report.windows.len(), 2);
    assert_eq!(report.windows[0].used_percent, 60.0);
    assert!(report.reset_opportunity.is_none());
    assert_eq!(report.identity_kind, "managed-connection");
    assert!(fresh(&report, AT));
    assert!(fresh(&report, "2026-10-08T12:05:00.000Z"));
    assert!(!fresh(&report, "2026-10-08T12:05:00.001Z"));
    assert!(!fresh(&report, "2026-10-08T12:05:01.000Z"));
    assert!(!fresh(&report, "2026-10-08T11:59:59.999Z"));
    assert!(!fresh(&report, "2026-10-08T11:59:59.000Z"));
}
#[test]
fn measurements_are_encrypted_scope_bound_and_invalidated_by_reconnect() {
    let store = store();
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            backend_connection::upsert(conn, &scope.internal_user_id, "codex", AT)?;
            let report = codex(&scope.internal_user_id, &json!({}), &limits(), AT);
            store_allowance(conn, &store, &scope, &report)?;
            assert_eq!(
                cached(conn, &store, &scope, "codex", AT)?.status,
                "available"
            );
            assert_eq!(
                cached(conn, &store, &scope, "codex", "2026-10-08T12:06:00.000Z")?.status,
                "stale"
            );
            let other = AuthorizedCommandScope {
                internal_user_id: "other-account".into(),
                ..scope.clone()
            };
            assert_eq!(
                cached(conn, &store, &other, "codex", AT)?.status,
                "unavailable"
            );
            backend_connection::upsert(
                conn,
                &scope.internal_user_id,
                "codex",
                "2026-10-08T12:01:00.000Z",
            )?;
            assert_eq!(
                cached(conn, &store, &scope, "codex", "2026-10-08T12:01:00.000Z")?.status,
                "unavailable"
            );
            let bytes: Vec<u8> = conn.query_row(
                "SELECT payload FROM preferences WHERE key LIKE 'provider-allowance:%'",
                [],
                |r| r.get(0),
            )?;
            assert!(!String::from_utf8_lossy(&bytes).contains("usedPercent"));
            Ok(())
        })
        .unwrap();
}
#[test]
fn exact_model_estimates_require_cache_prices_and_cost_unknown_survives_decode() {
    let usage:crate::models::ExecutionAttemptUsage=serde_json::from_value(json!({"inputTokens":100,"outputTokens":20,"cachedInputTokens":40,"cacheWriteTokens":10,"costUsd":0,"costUnknown":true})).unwrap();
    assert_eq!(usage.cost_unknown, Some(true));
    assert_eq!(json!(usage)["costUnknown"], true);
    let legacy: crate::models::ExecutionAttemptUsage =
        serde_json::from_value(json!({"inputTokens":100,"outputTokens":20,"costUsd":0})).unwrap();
    assert!(legacy.cost_unknown.is_none());
    assert!(json!(legacy).get("costUnknown").is_none());
    let mut price = Price {
        provider_id: "openai".into(),
        model: "exact-model".into(),
        input_per_million_usd: 2.0,
        output_per_million_usd: 8.0,
        cached_input_per_million_usd: None,
        cache_write_per_million_usd: None,
        source: "https://example.test/pricing".into(),
        observed_at: AT.into(),
    };
    assert!(estimate(&usage, &price).is_none());
    price.cached_input_per_million_usd = Some(0.5);
    price.cache_write_per_million_usd = Some(3.0);
    assert!((estimate(&usage, &price).unwrap() - 0.00033).abs() < 1e-10);
}

#[test]
fn saved_attempt_rollup_counts_partial_receipts_once_and_keeps_cost_evidence_separate() {
    let store = store();
    store.transaction(|conn| {
        let scope=authorized_scope::resolve(conn,None,None,ScopeAccess::Write)?;
        let receipt=|id:&str,provider:&str,model:&str,status:&str,at:&str,usage:Value| {
            let payload=json!({"usage":usage,"transcript":"private receipt text"});
            execution_attempt::upsert_scoped(conn,&store,&scope.data,id,None,provider,model,status,1,true,0,at,at,&payload)
        };
        receipt("reported","openrouter","model-a","completed",AT,json!({"inputTokens":100,"outputTokens":20,"cachedInputTokens":30,"reasoningTokens":5,"costUsd":0.2,"costUnknown":false}))?;
        // The exact terminal receipt can be replayed, but contributes only once.
        receipt("reported","openrouter","model-a","completed",AT,json!({"inputTokens":100,"outputTokens":20,"cachedInputTokens":30,"reasoningTokens":5,"costUsd":0.2,"costUnknown":false}))?;
        receipt("free","openrouter","model-a","failed",AT,json!({"inputTokens":10,"outputTokens":2,"costUsd":0,"costUnknown":false}))?;
        receipt("legacy-unknown","openrouter","model-a","interrupted",AT,json!({"inputTokens":5,"outputTokens":1,"costUsd":0}))?;
        receipt("sdk-estimate","claude","model-b","failed",AT,json!({"inputTokens":50,"outputTokens":10,"costUsd":0.3}))?;
        receipt("old","openrouter","model-a","completed","2026-08-01T12:00:00.000Z",json!({"inputTokens":999,"outputTokens":999,"costUsd":1}))?;
        let result=report(conn,&store,&scope,AT)?;
        let a=result.models.iter().find(|m|m.model=="model-a").unwrap();
        assert_eq!(a.attempts,3); assert_eq!(a.input_tokens,115); assert_eq!(a.output_tokens,23);
        assert_eq!(a.cached_input_tokens,Some(30)); assert_eq!(a.cache_write_tokens,None);
        assert_eq!(a.reported_cost_attempts,2); assert_eq!(a.reported_cost_usd,0.2); assert_eq!(a.unpriced_attempts,1);
        let b=result.models.iter().find(|m|m.model=="model-b").unwrap();
        assert_eq!(b.reported_cost_attempts,0); assert_eq!(b.estimated_cost_attempts,1); assert_eq!(b.estimated_cost_usd,0.3);
        assert!(!serde_json::to_string(&result).unwrap().contains("private receipt text"));
        Ok(())
    }).unwrap();
}

#[test]
fn claude_reset_dates_normalize_offsets_before_latest_exhausted_window_selection() {
    let measurement = claude(
        "owner",
        &json!({"rate_limits":{"five_hour":{"utilization":100,"resets_at":"2026-10-08T14:00:00+02:00"},"seven_day":{"utilization":100,"resets_at":"2026-10-08T12:30:00Z"}}}),
        AT,
    );
    assert_eq!(
        measurement.reset_opportunity.unwrap().resets_at,
        "2026-10-08T12:30:00.000Z"
    );
}
