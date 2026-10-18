//! Backend catalog and native route regression tests.
use crate::backends::credentials::{scoped_credential_key, BackendCredentialStore, KeyringStore};
use crate::backends::routes::{
    account_native_provider_route_id, account_provider_connection_id, exact_model_pricing_evidence,
    native_provider_route_boundary, native_provider_route_reason,
    native_provider_route_reason_with_evidence, validate_native_provider_route_binding,
    validate_persisted_native_provider_route_selection_for_policy,
};

#[test]
#[ignore = "read-only inventory of this installation's real OS-stored direct API credentials"]
fn live_visual_provider_connection_inventory() {
    let user = super::require_current_internal_user().unwrap();
    for provider in ["openai", "anthropic", "gemini", "xai", "deepseek", "custom"] {
        let present = KeyringStore
            .get(&scoped_credential_key(&user, provider))
            .expect("OS credential store is unavailable")
            .is_some();
        println!(
            "{provider}: native credential {}",
            if present { "present" } else { "unavailable" }
        );
    }
}

use super::*;

#[test]
fn provider_catalogue_exposes_stable_instances_and_driver_kinds() {
    validate_catalog_vocabulary();
    assert_eq!(
        CATALOG.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        SUPPORTED_BACKEND_PROVIDER_IDS
    );
    for entry in CATALOG {
        let provider = build_provider(entry, resolve_auth_state(entry.id, &HashMap::new()));
        assert_eq!(provider.instance_id, provider.id);
        assert!(!provider.driver_kind.is_empty());
        assert!(!provider.setup.label.is_empty());
        if matches!(
            entry.backend_type,
            "claude-agent" | "cursor-acp" | "grok-acp" | "opencode-server"
        ) {
            assert_eq!(provider.auth_state, "unavailable");
            assert!(provider.capabilities.is_empty());
        }
    }
}

#[test]
fn account_routes_are_model_specific_and_connection_stable() {
    let gpt5 = account_native_provider_route_id("user-1", "openai", "gpt-5");
    let gpt52 = account_native_provider_route_id("user-1", "openai", "gpt-5.2");
    assert_ne!(gpt5, gpt52);
    assert!(gpt5.starts_with("provider-route:v2:openai:"));
    assert_eq!(
        account_provider_connection_id("user-1", "openai"),
        account_provider_connection_id("user-1", "openai")
    );
    assert_ne!(
        account_provider_connection_id("user-1", "openai"),
        account_provider_connection_id("user-2", "openai")
    );
    let rows = [
        crate::store::repos::backend_connection::BackendConnectionRow {
            provider_id: "openai".into(),
            connected_at: "2026-07-12T00:00:00Z".into(),
            updated_at: "2026-07-12T01:00:00Z".into(),
        },
    ];
    let availability = HashMap::from([("openai".to_string(), true)]);
    let observations = std::collections::BTreeMap::from([(
        gpt5.clone(),
        crate::store::repos::provider_route_observation::ProviderRouteObservationSummary {
            reference: crate::store::repos::provider_route_observation::summary_reference(
                &account_native_provider_route_id("user-1", "openai", "gpt-5"),
                3,
                200,
                2,
                "2026-07-12T02:00:00Z",
            ),
            sample_count: 3,
            median_latency_ms: 200,
            usage_sample_count: 2,
            latest_observed_at: "2026-07-12T02:00:00Z".into(),
        },
    )]);
    let quality = std::collections::BTreeMap::from([(
        gpt5.clone(),
        crate::store::repos::provider_route_quality_observation::ProviderRouteQualitySummary {
            reference: crate::store::repos::provider_route_quality_observation::summary_reference(
                &gpt5,
                NATIVE_CITED_BRIEF_POLICY_REVISION,
                3,
                2,
                6_000,
                "2026-07-12T03:00:00Z",
            ),
            policy_revision_ref: NATIVE_CITED_BRIEF_POLICY_REVISION.into(),
            sample_count: 3,
            passed_count: 2,
            routing_score_basis_points: 6_000,
            latest_evaluated_at: "2026-07-12T03:00:00Z".into(),
        },
    )]);
    let routes = build_account_native_provider_routes(
        "user-1",
        "workspace-1",
        "member-1",
        &rows,
        &availability,
        &HashMap::new(),
        &observations,
        &quality,
    );
    let route = routes
        .iter()
        .find(|route| route["modelOrRuntimeReference"] == "gpt-5")
        .unwrap();
    assert_eq!(route["state"], "available");
    assert_eq!(route["workspaceId"], "workspace-1");
    assert_eq!(route["credentialBinding"]["custody"], "os-secure-store");
    assert_eq!(route["observationSummary"]["medianLatencyMs"], 200);
    assert_eq!(route["qualitySummary"]["passedCount"], 2);
    assert_eq!(route["qualitySummary"]["routingScoreBasisPoints"], 6_000);
    assert_eq!(route["pricingSummary"]["currencyCode"], "USD");
    assert_eq!(route["pricingSummary"]["inputRateMinorUnits"], 125);
    assert_eq!(route["pricingSummary"]["outputRateMinorUnits"], 1_000);
    assert_eq!(
        route["pricingSummary"]["sourceUrl"],
        "https://developers.openai.com/api/docs/models/gpt-5"
    );
    assert_eq!(route["updatedAt"], "2026-07-12T03:00:00Z");
    assert_eq!(
        route["boundaries"]["placementBoundary"],
        "local-credential-egress"
    );
}

#[test]
fn deepseek_catalogue_projects_exact_model_routes_without_pricing_claims() {
    let flash = account_native_provider_route_id("user-1", "deepseek", "deepseek-flash");
    let pro = account_native_provider_route_id("user-1", "deepseek", "deepseek-v4-pro");
    assert_ne!(flash, pro);
    assert!(flash.starts_with("provider-route:v2:deepseek:"));
    assert!(native_provider_route_reason("deepseek", "deepseek-flash")
        .unwrap()
        .contains("DeepSeek DeepSeek Flash"));
    assert!(native_provider_route_reason("deepseek", "ghost-model").is_err());
    assert_eq!(
        native_provider_route_boundary("deepseek"),
        "boundary:installation-private:user-owned-provider:deepseek:local-credential-egress"
    );
    // DeepSeek pricing is not hardcoded: Mivlet fails closed with
    // costUnknown instead of copying rates from memory.
    assert!(exact_model_pricing_evidence("deepseek", "deepseek-flash").is_none());
    let rows = [
        crate::store::repos::backend_connection::BackendConnectionRow {
            provider_id: "deepseek".into(),
            connected_at: "2026-09-11T10:00:00Z".into(),
            updated_at: "2026-09-11T10:01:00Z".into(),
        },
    ];
    let routes = build_account_native_provider_routes(
        "user-1",
        "workspace-1",
        "member-1",
        &rows,
        &HashMap::from([("deepseek".to_string(), true)]),
        &HashMap::new(),
        &std::collections::BTreeMap::new(),
        &std::collections::BTreeMap::new(),
    );
    assert_eq!(routes.len(), 2);
    assert!(routes
        .iter()
        .all(|route| route["providerFamily"] == "deepseek"));
    assert!(routes.iter().all(|route| route["state"] == "available"));
    assert!(routes.iter().all(|route| route["pricingSummary"].is_null()));
}

#[test]
fn gemini_catalogue_entry_is_a_native_api_key_route_distinct_from_antigravity() {
    let gemini = catalog_entry("gemini").expect("gemini catalogue entry");
    assert_eq!(gemini.backend_type, "native-api");
    assert_eq!(gemini.driver_kind, "native-api");
    assert_eq!(gemini.setup_kind, "api-key");
    assert_eq!(gemini.setup_label, "Gemini API key");
    assert!(!gemini.recommended);
    assert!(gemini
        .models
        .iter()
        .any(|(id, _)| *id == "gemini-3.5-flash"));
    assert!(gemini.models.iter().any(|(id, _)| *id == "gemini-2.5-pro"));

    let antigravity = catalog_entry("antigravity").expect("antigravity catalogue entry");
    assert_eq!(antigravity.backend_type, "antigravity-acp");
    assert_eq!(antigravity.setup_kind, "browser");
    assert!(antigravity.recommended);

    let provider = build_provider(gemini, resolve_auth_state("gemini", &HashMap::new()));
    assert_eq!(provider.auth_state, "needs-auth");
    assert!(provider.capabilities.is_empty());
    assert!(provider.models.iter().all(|model| !model.available));
    assert_eq!(provider.install_hint.as_deref(), Some(""));
}

#[test]
fn configured_custom_model_projects_one_exact_local_route() {
    let rows = [
        crate::store::repos::backend_connection::BackendConnectionRow {
            provider_id: "custom".into(),
            connected_at: "2026-08-29T10:00:00Z".into(),
            updated_at: "2026-08-29T10:01:00Z".into(),
        },
    ];
    let routes = build_account_native_provider_routes(
        "user-1",
        "workspace-1",
        "member-1",
        &rows,
        &HashMap::from([("custom".to_string(), true)]),
        &HashMap::from([("custom".to_string(), "mivlet-smoke".to_string())]),
        &std::collections::BTreeMap::new(),
        &std::collections::BTreeMap::new(),
    );

    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0]["providerFamily"], "custom");
    assert_eq!(routes[0]["modelOrRuntimeReference"], "mivlet-smoke");
    assert_eq!(routes[0]["displayName"], "Custom provider mivlet-smoke");
    assert_eq!(routes[0]["state"], "available");
    assert_eq!(
        native_provider_route_boundary("custom"),
        "boundary:installation-private:user-owned-provider:custom:local-credential-egress"
    );
    assert!(native_provider_route_reason("custom", "mivlet-smoke")
        .unwrap()
        .contains("Custom provider mivlet-smoke"));
    assert!(native_provider_route_reason("custom", "  ").is_err());
}

#[test]
fn native_egress_accepts_only_the_exact_no_fallback_route_selection() {
    let expected = account_native_provider_route_id("user-1", "openai", "gpt-5");
    let mut binding = crate::models::ProviderRouteExecutionBinding {
        workspace_id: "workspace-1".into(),
        selection: crate::models::ProviderRouteSelection {
            provider_route_id: expected.clone(),
            selected_at: "2026-07-12T12:00:00Z".into(),
            reason: native_provider_route_reason("openai", "gpt-5").unwrap(),
            fallback_from_provider_route_id: None,
            boundary_policy_ref: Some(native_provider_route_boundary("openai")),
            observation: None,
            quality: None,
            cost: None,
        },
    };
    assert!(validate_native_provider_route_binding(
        "openai", "gpt-5", &expected, None, None, &binding,
    )
    .is_ok());
    binding.selection.fallback_from_provider_route_id = Some("other-route".into());
    assert!(validate_native_provider_route_binding(
        "openai", "gpt-5", &expected, None, None, &binding,
    )
    .is_err());
    binding.selection.fallback_from_provider_route_id = None;
    binding.selection.reason = "Renderer supplied reason".into();
    assert!(validate_native_provider_route_binding(
        "openai", "gpt-5", &expected, None, None, &binding,
    )
    .is_err());

    let observation = crate::models::ProviderRouteObservationSnapshot {
        reference: crate::store::repos::provider_route_observation::summary_reference(
            &expected,
            3,
            200,
            2,
            "2026-07-12T02:00:00Z",
        ),
        sample_count: 3,
        median_latency_ms: 200,
        usage_sample_count: 2,
        latest_observed_at: "2026-07-12T02:00:00Z".into(),
    };
    binding.selection.reason = native_provider_route_reason_with_evidence(
        "openai",
        "gpt-5",
        Some(&observation),
        None,
        None,
    )
    .unwrap();
    binding.selection.observation = Some(observation.clone());
    assert!(validate_native_provider_route_binding(
        "openai",
        "gpt-5",
        &expected,
        Some(&observation),
        None,
        &binding,
    )
    .is_ok());
    binding.selection.observation.as_mut().unwrap().sample_count += 1;
    assert!(validate_native_provider_route_binding(
        "openai",
        "gpt-5",
        &expected,
        Some(&observation),
        None,
        &binding,
    )
    .is_err());

    binding.selection.observation = Some(observation.clone());
    let pricing = exact_model_pricing_evidence("openai", "gpt-5").unwrap();
    let cost = crate::models::ProviderRouteCostSnapshot {
        reference: pricing.reference.clone(),
        currency_code: pricing.currency_code.clone(),
        input_rate_minor_units: pricing.input_rate_minor_units,
        output_rate_minor_units: pricing.output_rate_minor_units,
        unit_tokens: pricing.unit_tokens,
        source_url: pricing.source_url.clone(),
        reviewed_at: pricing.reviewed_at.clone(),
        estimated_input_tokens: 2_000,
        estimated_output_tokens: 1_000,
        estimated_cost_minor_units: 2,
    };
    binding.selection.reason = native_provider_route_reason_with_evidence(
        "openai",
        "gpt-5",
        Some(&observation),
        None,
        Some(&cost),
    )
    .unwrap();
    binding.selection.cost = Some(cost);
    assert!(validate_native_provider_route_binding(
        "openai",
        "gpt-5",
        &expected,
        Some(&observation),
        Some(&pricing),
        &binding,
    )
    .is_ok());
    let encoded = serde_json::to_value(&binding).unwrap();
    let decoded =
        serde_json::from_value::<crate::models::ProviderRouteExecutionBinding>(encoded).unwrap();
    assert_eq!(decoded, binding);
    binding
        .selection
        .cost
        .as_mut()
        .unwrap()
        .estimated_cost_minor_units = 1;
    assert!(validate_native_provider_route_binding(
        "openai",
        "gpt-5",
        &expected,
        Some(&observation),
        Some(&pricing),
        &binding,
    )
    .is_err());
}

#[test]
fn persisted_cited_route_accepts_only_its_exact_policy_cohort() {
    let expected = account_native_provider_route_id("user-1", "openai", "gpt-5");
    let quality = crate::models::ProviderRouteQualitySnapshot {
        reference: crate::store::repos::provider_route_quality_observation::summary_reference(
            &expected,
            NATIVE_CITED_BRIEF_POLICY_REVISION,
            3,
            2,
            6_000,
            "2026-07-13T00:00:00Z",
        ),
        policy_revision_ref: NATIVE_CITED_BRIEF_POLICY_REVISION.into(),
        sample_count: 3,
        passed_count: 2,
        routing_score_basis_points: 6_000,
        latest_evaluated_at: "2026-07-13T00:00:00Z".into(),
    };
    let mut selection = crate::models::ProviderRouteSelection {
        provider_route_id: expected.clone(),
        selected_at: "2026-07-13T00:01:00Z".into(),
        reason: native_provider_route_reason_with_evidence(
            "openai",
            "gpt-5",
            None,
            Some(&quality),
            None,
        )
        .unwrap(),
        fallback_from_provider_route_id: None,
        boundary_policy_ref: Some(native_provider_route_boundary("openai")),
        observation: None,
        quality: Some(quality),
        cost: None,
    };
    assert!(
        validate_persisted_native_provider_route_selection_for_policy(
            "openai",
            "gpt-5",
            &expected,
            Some(NATIVE_CITED_BRIEF_POLICY_REVISION),
            &selection,
        )
        .is_ok()
    );
    assert!(validate_persisted_native_provider_route_selection(
        "openai", "gpt-5", &expected, &selection,
    )
    .is_err());
    selection
        .quality
        .as_mut()
        .unwrap()
        .routing_score_basis_points = 6_001;
    assert!(
        validate_persisted_native_provider_route_selection_for_policy(
            "openai",
            "gpt-5",
            &expected,
            Some(NATIVE_CITED_BRIEF_POLICY_REVISION),
            &selection,
        )
        .is_err()
    );
}
