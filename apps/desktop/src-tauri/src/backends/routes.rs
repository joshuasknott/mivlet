//! Native provider route identity, evidence, and validation policy.
use super::*;

pub(crate) fn validate_account_native_provider_model(
    tx: &rusqlite::Connection,
    internal_user_id: &str,
    provider_id: &str,
    model: &str,
) -> Result<String, String> {
    let entry = catalog_entry(provider_id)
        .filter(|entry| entry.backend_type == "native-api")
        .ok_or_else(|| "Provider routing requires a registered native API provider.".to_string())?;
    if !crate::store::repos::backend_connection::list(tx, internal_user_id)
        .map_err(|error| error.to_string())?
        .iter()
        .any(|id| id == provider_id)
    {
        return Err("Provider routing requires this installation's connected provider.".into());
    }
    let model_available = if provider_id == "custom" {
        CredentialStores {
            internal_user_id: internal_user_id.to_string(),
        }
        .get(provider_id)?
        .map(|credential| {
            crate::native_api::configured_custom_provider_model_id(&credential)
                .is_ok_and(|configured_model| configured_model == model)
        })
        .unwrap_or(false)
    } else {
        entry.models.iter().any(|(id, _)| *id == model)
    };
    if !model_available {
        return Err("Provider routing requires an available catalog model.".into());
    }
    Ok(account_native_provider_route_id(
        internal_user_id,
        provider_id,
        model,
    ))
}

pub(crate) fn account_native_provider_route_id(
    internal_user_id: &str,
    provider_id: &str,
    model: &str,
) -> String {
    let digest = Sha256::digest(format!("{internal_user_id}:{provider_id}:{model}").as_bytes());
    format!("provider-route:v2:{provider_id}:{digest:x}")
}

pub(super) fn account_provider_connection_id(internal_user_id: &str, provider_id: &str) -> String {
    let digest = Sha256::digest(format!("{internal_user_id}:{provider_id}").as_bytes());
    format!("connection:provider-account:v1:{provider_id}:{digest:x}")
}

pub(crate) fn native_provider_route_reason(
    provider_id: &str,
    model: &str,
) -> Result<String, String> {
    let entry = catalog_entry(provider_id)
        .filter(|entry| entry.backend_type == "native-api")
        .ok_or_else(|| "Provider routing requires a registered native API provider.".to_string())?;
    let label = entry
        .models
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, label)| *label)
        .map(str::to_string)
        .or_else(|| {
            if provider_id != "custom" {
                return None;
            }
            crate::native_api::normalize_custom_model_id(model)
                .ok()
                .filter(|normalized| normalized == model)
        })
        .ok_or_else(|| "Provider routing requires an available catalog model.".to_string())?;
    Ok(format!("Selected {} {} for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.", entry.label, label))
}

pub(super) fn native_provider_route_reason_with_evidence(
    provider_id: &str,
    model: &str,
    observation: Option<&crate::models::ProviderRouteObservationSnapshot>,
    quality: Option<&crate::models::ProviderRouteQualitySnapshot>,
    cost: Option<&crate::models::ProviderRouteCostSnapshot>,
) -> Result<String, String> {
    let reason = native_provider_route_reason(provider_id, model)?;
    let reason = match quality {
        Some(value) => reason.replace(
            "quality unobserved",
            &format!(
                "policy evidence {} of {} outputs passed",
                value.passed_count, value.sample_count
            ),
        ),
        None => reason,
    };
    let reason = match cost {
        Some(value) => reason.replace(
            "cost unobserved",
            &format!(
                "estimated cost {} {} minor units",
                value.estimated_cost_minor_units, value.currency_code
            ),
        ),
        None => reason,
    };
    Ok(match observation {
        Some(value) => reason.replace(
            "latency unobserved",
            &format!("estimated latency {} ms", value.median_latency_ms),
        ),
        None => reason,
    })
}

const GPT5_PRICING_SOURCE: &str = "https://developers.openai.com/api/docs/models/gpt-5";
const GPT5_PRICING_REVIEWED_AT: &str = "2026-07-13T00:00:00Z";
// Digest input: native-cited-brief-policy:v1|receipt.version=2|trust=provider-generated-with-external-evidence|citations.nonempty|requiredEvidence.subset
pub(crate) const NATIVE_CITED_BRIEF_POLICY_REVISION: &str =
    "native-policy:cited-brief:v1:2c6c266fe616417ded9cf81a667dddca7a5590204e84c708b1f4ca32d6eb5527";

pub(crate) fn exact_model_pricing_evidence(
    provider_id: &str,
    model: &str,
) -> Option<crate::models::ProviderRoutePricingEvidence> {
    if provider_id != "openai" || model != "gpt-5" {
        return None;
    }
    let currency_code = "USD";
    let input_rate_minor_units = 125;
    let output_rate_minor_units = 1_000;
    let unit_tokens = 1_000_000;
    let digest = Sha256::digest(format!(
        "{provider_id}:{model}:{currency_code}:{input_rate_minor_units}:{output_rate_minor_units}:{unit_tokens}:{GPT5_PRICING_SOURCE}:{GPT5_PRICING_REVIEWED_AT}"
    ));
    Some(crate::models::ProviderRoutePricingEvidence {
        reference: format!("route-pricing:v1:{digest:x}"),
        currency_code: currency_code.into(),
        input_rate_minor_units,
        output_rate_minor_units,
        unit_tokens,
        source_url: GPT5_PRICING_SOURCE.into(),
        reviewed_at: GPT5_PRICING_REVIEWED_AT.into(),
    })
}

pub(crate) fn provider_route_observation_snapshot(
    summary: &crate::store::repos::provider_route_observation::ProviderRouteObservationSummary,
) -> crate::models::ProviderRouteObservationSnapshot {
    crate::models::ProviderRouteObservationSnapshot {
        reference: summary.reference.clone(),
        sample_count: summary.sample_count,
        median_latency_ms: summary.median_latency_ms,
        usage_sample_count: summary.usage_sample_count,
        latest_observed_at: summary.latest_observed_at.clone(),
    }
}

pub(crate) fn native_provider_route_boundary(provider_id: &str) -> String {
    format!(
        "boundary:installation-private:user-owned-provider:{provider_id}:local-credential-egress"
    )
}

/// Pin the configured native route for a headless caller using the same current
/// observations and boundary checks as renderer-selected routes. No fallback.
pub(crate) fn select_native_background_route(
    provider_id: &str,
    model: &str,
) -> Result<crate::models::ProviderRouteExecutionBinding, String> {
    let owner = require_current_internal_user()?;
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    let (id, observation) = store
        .with_conn(|conn| {
            let id = validate_account_native_provider_model(conn, &owner, provider_id, model)
                .map_err(crate::store::StoreError::Invalid)?;
            let observations =
                crate::store::repos::provider_route_observation::summaries(conn, store, &owner)?;
            let observation = observations
                .get(&id)
                .map(provider_route_observation_snapshot);
            Ok((id, observation))
        })
        .map_err(|e| e.to_string())?;
    let result = crate::models::ProviderRouteExecutionBinding {
        workspace_id: crate::store::repos::scope::DEFAULT_WORKSPACE_ID.into(),
        selection: crate::models::ProviderRouteSelection {
            provider_route_id: id,
            selected_at: chrono::Utc::now().to_rfc3339(),
            reason: native_provider_route_reason_with_evidence(
                provider_id,
                model,
                observation.as_ref(),
                None,
                None,
            )?,
            boundary_policy_ref: Some(native_provider_route_boundary(provider_id)),
            fallback_from_provider_route_id: None,
            observation,
            quality: None,
            cost: None,
        },
    };
    validate_current_native_provider_route(provider_id, model, &result)?;
    Ok(result)
}

pub(crate) fn validate_current_native_provider_route(
    provider_id: &str,
    model: &str,
    binding: &crate::models::ProviderRouteExecutionBinding,
) -> Result<String, String> {
    let internal_user_id = require_current_internal_user()?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let (expected, observation) = store
        .with_conn(|tx| {
            if binding.workspace_id != crate::store::repos::scope::DEFAULT_WORKSPACE_ID {
                return Err(crate::store::StoreError::Invalid(
                    "The selected provider route is not scoped to this installation.".into(),
                ));
            }
            let expected =
                validate_account_native_provider_model(tx, &internal_user_id, provider_id, model)
                    .map_err(crate::store::StoreError::Invalid)?;
            let observations = crate::store::repos::provider_route_observation::summaries(
                tx,
                store,
                &internal_user_id,
            )?;
            Ok((
                expected.clone(),
                observations
                    .get(&expected)
                    .map(provider_route_observation_snapshot),
            ))
        })
        .map_err(|error| error.to_string())?;
    validate_native_provider_route_binding(
        provider_id,
        model,
        &expected,
        observation.as_ref(),
        exact_model_pricing_evidence(provider_id, model).as_ref(),
        binding,
    )?;
    Ok(expected)
}

pub(crate) fn record_current_native_provider_route_observation(
    provider_id: &str,
    model: &str,
    binding: &crate::models::ProviderRouteExecutionBinding,
    request_id: &str,
    latency_ms: u64,
    usage: Option<(i64, i64)>,
    observed_at: &str,
) -> Result<(), String> {
    let route_id = validate_current_native_provider_route(provider_id, model, binding)?;
    let internal_user_id = require_current_internal_user()?;
    record_native_provider_route_observation(
        &internal_user_id,
        provider_id,
        model,
        &route_id,
        request_id,
        latency_ms,
        usage,
        observed_at,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_native_provider_route_observation(
    internal_user_id: &str,
    provider_id: &str,
    model: &str,
    provider_route_id: &str,
    request_id: &str,
    latency_ms: u64,
    usage: Option<(i64, i64)>,
    observed_at: &str,
) -> Result<(), String> {
    let expected = account_native_provider_route_id(internal_user_id, provider_id, model);
    if expected != provider_route_id {
        return Err("Provider route observation does not match its account route.".into());
    }
    let digest = Sha256::digest(format!("{internal_user_id}:{request_id}").as_bytes());
    let observation_id = format!("route-observation:v1:{digest:x}");
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::provider_route_observation::record(
                tx,
                store,
                internal_user_id,
                provider_id,
                provider_route_id,
                &observation_id,
                model,
                latency_ms,
                usage.map(|value| value.0),
                usage.map(|value| value.1),
                observed_at,
            )
        })
        .map_err(|error| error.to_string())
}

pub(super) fn validate_native_provider_route_binding(
    provider_id: &str,
    model: &str,
    expected_route_id: &str,
    expected_observation: Option<&crate::models::ProviderRouteObservationSnapshot>,
    expected_pricing: Option<&crate::models::ProviderRoutePricingEvidence>,
    binding: &crate::models::ProviderRouteExecutionBinding,
) -> Result<(), String> {
    validate_provider_route_observation_snapshot(
        expected_route_id,
        binding.selection.observation.as_ref(),
    )?;
    validate_provider_route_cost_snapshot(
        provider_id,
        model,
        expected_pricing,
        binding.selection.cost.as_ref(),
    )?;
    let expected_reason = native_provider_route_reason_with_evidence(
        provider_id,
        model,
        expected_observation,
        None,
        binding.selection.cost.as_ref(),
    )?;
    let expected_boundary = native_provider_route_boundary(provider_id);
    if binding.selection.provider_route_id != expected_route_id
        || binding.selection.reason != expected_reason
        || binding.selection.observation.as_ref() != expected_observation
        || binding.selection.quality.is_some()
        || binding.selection.boundary_policy_ref.as_deref() != Some(expected_boundary.as_str())
        || binding.selection.fallback_from_provider_route_id.is_some()
        || chrono::DateTime::parse_from_rfc3339(&binding.selection.selected_at).is_err()
    {
        return Err("Native provider egress does not match its selected route.".into());
    }
    Ok(())
}

pub(crate) fn validate_persisted_native_provider_route_selection(
    provider_id: &str,
    model: &str,
    expected_route_id: &str,
    selection: &crate::models::ProviderRouteSelection,
) -> Result<(), String> {
    validate_persisted_native_provider_route_selection_for_policy(
        provider_id,
        model,
        expected_route_id,
        None,
        selection,
    )
}

pub(crate) fn validate_persisted_native_provider_route_selection_for_policy(
    provider_id: &str,
    model: &str,
    expected_route_id: &str,
    quality_policy_ref: Option<&str>,
    selection: &crate::models::ProviderRouteSelection,
) -> Result<(), String> {
    validate_provider_route_observation_snapshot(
        expected_route_id,
        selection.observation.as_ref(),
    )?;
    validate_provider_route_quality_snapshot(expected_route_id, selection.quality.as_ref())?;
    if selection
        .quality
        .as_ref()
        .is_some_and(|quality| Some(quality.policy_revision_ref.as_str()) != quality_policy_ref)
        || (quality_policy_ref.is_none() && selection.quality.is_some())
    {
        return Err("Native provider route policy evidence does not match its evaluator.".into());
    }
    let pricing = exact_model_pricing_evidence(provider_id, model);
    validate_provider_route_cost_snapshot(
        provider_id,
        model,
        pricing.as_ref(),
        selection.cost.as_ref(),
    )?;
    let expected_reason = native_provider_route_reason_with_evidence(
        provider_id,
        model,
        selection.observation.as_ref(),
        selection.quality.as_ref(),
        selection.cost.as_ref(),
    )?;
    if selection.provider_route_id != expected_route_id
        || selection.reason != expected_reason
        || selection.boundary_policy_ref.as_deref()
            != Some(native_provider_route_boundary(provider_id).as_str())
        || selection.fallback_from_provider_route_id.is_some()
        || chrono::DateTime::parse_from_rfc3339(&selection.selected_at).is_err()
    {
        return Err("Native provider route selection is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_provider_route_cost_snapshot(
    provider_id: &str,
    model: &str,
    expected_pricing: Option<&crate::models::ProviderRoutePricingEvidence>,
    cost: Option<&crate::models::ProviderRouteCostSnapshot>,
) -> Result<(), String> {
    let Some(cost) = cost else {
        return Ok(());
    };
    let Some(expected) = expected_pricing else {
        return Err("Provider route cost has no exact-model pricing evidence.".into());
    };
    if cost.unit_tokens == 0 {
        return Err("Provider route cost snapshot is invalid.".into());
    }
    let numerator = u128::from(cost.estimated_input_tokens)
        .checked_mul(u128::from(cost.input_rate_minor_units))
        .and_then(|value| {
            u128::from(cost.estimated_output_tokens)
                .checked_mul(u128::from(cost.output_rate_minor_units))
                .and_then(|output| value.checked_add(output))
        })
        .ok_or_else(|| "Provider route cost estimate is invalid.".to_string())?;
    let unit = u128::from(cost.unit_tokens);
    let estimated = numerator
        .checked_add(unit.saturating_sub(1))
        .map(|value| value / unit)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| "Provider route cost estimate is invalid.".to_string())?;
    if cost.reference != expected.reference
        || cost.currency_code != expected.currency_code
        || cost.input_rate_minor_units != expected.input_rate_minor_units
        || cost.output_rate_minor_units != expected.output_rate_minor_units
        || cost.unit_tokens != expected.unit_tokens
        || cost.source_url != expected.source_url
        || cost.reviewed_at != expected.reviewed_at
        || cost.currency_code != "USD"
        || estimated != cost.estimated_cost_minor_units
        || chrono::DateTime::parse_from_rfc3339(&cost.reviewed_at).is_err()
        || !cost
            .source_url
            .starts_with("https://developers.openai.com/")
        || provider_id != "openai"
        || model != "gpt-5"
    {
        return Err("Provider route cost snapshot is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_provider_route_observation_snapshot(
    provider_route_id: &str,
    observation: Option<&crate::models::ProviderRouteObservationSnapshot>,
) -> Result<(), String> {
    let Some(observation) = observation else {
        return Ok(());
    };
    let expected = crate::store::repos::provider_route_observation::summary_reference(
        provider_route_id,
        observation.sample_count,
        observation.median_latency_ms,
        observation.usage_sample_count,
        &observation.latest_observed_at,
    );
    if observation.reference != expected
        || observation.sample_count == 0
        || observation.sample_count > 50
        || observation.usage_sample_count > observation.sample_count
        || observation.median_latency_ms > 24 * 60 * 60 * 1_000
        || chrono::DateTime::parse_from_rfc3339(&observation.latest_observed_at).is_err()
    {
        return Err("Provider route observation snapshot is invalid.".into());
    }
    Ok(())
}

pub(super) fn validate_provider_route_quality_snapshot(
    provider_route_id: &str,
    quality: Option<&crate::models::ProviderRouteQualitySnapshot>,
) -> Result<(), String> {
    let Some(quality) = quality else {
        return Ok(());
    };
    if quality.sample_count == 0
        || quality.sample_count > 50
        || quality.passed_count > quality.sample_count
    {
        return Err("Provider route policy snapshot is invalid.".into());
    }
    let expected_score = ((quality.passed_count + 1) * 10_000) / (quality.sample_count + 2);
    let expected_reference =
        crate::store::repos::provider_route_quality_observation::summary_reference(
            provider_route_id,
            &quality.policy_revision_ref,
            quality.sample_count,
            quality.passed_count,
            quality.routing_score_basis_points,
            &quality.latest_evaluated_at,
        );
    if quality.reference != expected_reference
        || quality.policy_revision_ref != NATIVE_CITED_BRIEF_POLICY_REVISION
        || usize::from(quality.routing_score_basis_points) != expected_score
        || chrono::DateTime::parse_from_rfc3339(&quality.latest_evaluated_at).is_err()
    {
        return Err("Provider route policy snapshot is invalid.".into());
    }
    Ok(())
}

pub(super) fn build_account_native_provider_routes(
    internal_user_id: &str,
    workspace_id: &str,
    member_id: &str,
    rows: &[crate::store::repos::backend_connection::BackendConnectionRow],
    availability: &HashMap<String, bool>,
    configured_models: &HashMap<String, String>,
    observations: &std::collections::BTreeMap<
        String,
        crate::store::repos::provider_route_observation::ProviderRouteObservationSummary,
    >,
    quality: &std::collections::BTreeMap<
        String,
        crate::store::repos::provider_route_quality_observation::ProviderRouteQualitySummary,
    >,
) -> Vec<serde_json::Value> {
    let mut routes = Vec::new();
    for row in rows {
        let Some(entry) =
            catalog_entry(&row.provider_id).filter(|entry| entry.backend_type == "native-api")
        else {
            continue;
        };
        let credential_available = availability.get(&row.provider_id).copied().unwrap_or(false);
        let connection_id = account_provider_connection_id(internal_user_id, &row.provider_id);
        let binding_digest = Sha256::digest(
            format!("{}:{}:credential", internal_user_id, row.provider_id).as_bytes(),
        );
        let configured_model = (row.provider_id == "custom")
            .then(|| configured_models.get(&row.provider_id))
            .flatten();
        for (model, label) in entry
            .models
            .iter()
            .copied()
            .chain(configured_model.map(|model| (model.as_str(), model.as_str())))
        {
            let route_id =
                account_native_provider_route_id(internal_user_id, &row.provider_id, model);
            let route_updated_at = observations
                .get(&route_id)
                .map(|summary| summary.latest_observed_at.as_str())
                .into_iter()
                .chain(
                    quality
                        .get(&route_id)
                        .map(|summary| summary.latest_evaluated_at.as_str()),
                )
                .chain(std::iter::once(row.updated_at.as_str()))
                .max()
                .expect("provider route update time has a connection fallback");
            let mut route = serde_json::json!({
                "id":&route_id,
                "recordType":"provider-route","connectionId":connection_id,"kind":"api-model",
                "displayName":format!("{} {}",entry.label,label),"providerFamily":row.provider_id,
                "modelOrRuntimeReference":model,"state":if credential_available{"available"}else{"unavailable"},
                "health":{"state":if credential_available{"healthy"}else{"unavailable"},"checkedAt":row.updated_at,
                    "summary":if credential_available{"Local credential is present; live egress rechecks it."}else{"Local credential is unavailable."}},
                "placement":{"allowedKinds":["local-desktop"],"requiresCredentialHoldingNode":true},
                "boundaries":{"privacyBoundary":"installation-private","billingBoundary":"user-owned-provider",
                    "providerBoundary":row.provider_id,"placementBoundary":"local-credential-egress"},
                "credentialBinding":{"custody":"os-secure-store","state":if credential_available{"available"}else{"unavailable"},
                    "bindingReference":format!("credential-binding:v1:{binding_digest:x}"),"lastValidatedAt":row.updated_at,"refreshSupported":false},
                "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":member_id,
                "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
                "createdAt":row.connected_at,"updatedAt":route_updated_at,"discoveredAt":row.updated_at
            });
            if let Some(summary) = observations.get(&route_id) {
                route
                    .as_object_mut()
                    .expect("provider route projection is an object")
                    .insert("observationSummary".into(), serde_json::json!(summary));
            }
            if let Some(summary) = quality.get(&route_id) {
                route
                    .as_object_mut()
                    .expect("provider route projection is an object")
                    .insert("qualitySummary".into(), serde_json::json!(summary));
            }
            if let Some(pricing) = exact_model_pricing_evidence(&row.provider_id, model) {
                route
                    .as_object_mut()
                    .expect("provider route projection is an object")
                    .insert("pricingSummary".into(), serde_json::json!(pricing));
            }
            routes.push(route);
        }
    }
    routes
}

/// Apply the provider-owned Codex CLI install/auth status without exposing its
/// executable path or any token-bearing data. The version is normalized and
/// the auth method is reduced to a controlled label before it reaches UI copy.
pub(crate) fn apply_codex_cli_status(
    provider: &mut BackendProvider,
    status: &crate::codex_app_server::CodexCliStatus,
) {
    let version = status
        .version
        .as_deref()
        .map(normalize_spaces)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_characters(&value, 120));
    let auth_label = match status.auth_method.as_deref() {
        Some("chatgpt") => Some("ChatGPT"),
        Some("api-key") => Some("API key"),
        Some("provider-login") => Some("Provider login"),
        _ => None,
    };

    if !status.installed {
        provider.auth_state = "install-required".to_string();
        provider.capabilities.clear();
        for model in &mut provider.models {
            model.available = false;
        }
        return;
    }

    if !status.authenticated {
        provider.auth_state = "sign-in-required".to_string();
        provider.capabilities.clear();
        for model in &mut provider.models {
            model.available = false;
        }
        provider.install_hint = Some(match version {
            Some(version) => format!("Codex runtime {version} - sign in required"),
            None => "Codex runtime installed - sign in required".to_string(),
        });
        return;
    }

    provider.auth_state = "connected".to_string();
    provider.capabilities = CODEX_CAPS
        .iter()
        .filter(|cap| BACKEND_CAPABILITIES.contains(cap))
        .take(MAX_BACKEND_CAPABILITIES)
        .map(|cap| (*cap).to_string())
        .collect();
    for model in &mut provider.models {
        model.available = true;
    }
    provider.install_hint = match (version, auth_label) {
        (Some(version), Some(auth)) => Some(format!("Codex runtime {version} - {auth}")),
        (Some(version), None) => Some(format!("Codex runtime {version}")),
        (None, Some(auth)) => Some(format!("Codex runtime - {auth}")),
        (None, None) => Some("Codex runtime".to_string()),
    };
}
