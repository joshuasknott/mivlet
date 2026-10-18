//! Agent-runtime backend credential boundary.
//!
//! Rust owns credential access for native API-key agent backends and the
//! secret-free status boundary for official Codex browser sign-in. Secrets live in the
//! OS-secure store (Windows Credential Manager / macOS Keychain / Linux Secret
//! Service) via the `keyring` crate, with a process-scoped `Mutex<HashMap>`
//! kept as the test/headless fallback. Both are reached through the
//! [`BackendCredentialStore`] trait so the storage backend is pluggable and
//! mockable without touching the Tauri command surface.
//!
//! Hard invariants:
//!   - Secrets never cross the Tauri command boundary into JavaScript.
//!   - `list_backends` returns auth state + capabilities + models only.
//!   - Secrets are never logged, serialized into `RuntimeSnapshot`, or written
//!     to disk in the snapshot path. Only *which* backends are connected is
//!     persisted (to `connected-backends.json`), as provider ids — so auth state
//!     can be re-resolved against the keychain after a restart.
//!
//! Public Tauri commands (names must stay stable): `list_backends`,
//! `store_backend_credential`, `clear_backend_credential`,
//! `record_backend_event`.

use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};

use sha2::{Digest, Sha256};

use crate::models::{
    ApprovalAuditEntry, BackendConsequentialEvent, BackendCredentialRequest, BackendModel,
    BackendProvider, ProviderSetup, APPROVAL_DECISIONS, APPROVAL_MODES, APPROVAL_RISK_LEVELS,
    BACKENDS_PRE_RELEASE, BACKEND_AUTH_STATES, BACKEND_CAPABILITIES, BACKEND_TYPES,
    MAX_BACKEND_CAPABILITIES, MAX_BACKEND_MODELS, MAX_BACKEND_SECRET_CHARACTERS,
    SUPPORTED_BACKEND_PROVIDER_IDS,
};
use crate::paths::{connected_backends_path, normalize_spaces, truncate_characters};

mod catalog;
mod credentials;
mod routes;

pub(crate) use catalog::native_verification_model;
use catalog::{
    build_provider, catalog_entry, require_supported_provider, resolve_auth_state,
    validate_backend_secret, validate_catalog_vocabulary, BackendCatalogEntry, CATALOG,
};
use credentials::{
    clear_credential_into, list_providers_from, read_connected_backends, scoped_credential_key,
    store_credential_into, BackendCredentialStore, CredentialStores, KeyringStore,
};
pub(crate) use credentials::{
    connected_providers_for, credential_store, read_credential, record_connected_provider,
    remove_connected_provider, require_current_internal_user,
};
use routes::{
    account_native_provider_route_id, account_provider_connection_id, apply_codex_cli_status,
    build_account_native_provider_routes, native_provider_route_reason_with_evidence,
    validate_native_provider_route_binding,
};
pub(crate) use routes::{
    exact_model_pricing_evidence, native_provider_route_boundary, native_provider_route_reason,
    provider_route_observation_snapshot, record_current_native_provider_route_observation,
    record_native_provider_route_observation, select_native_background_route,
    validate_account_native_provider_model, validate_current_native_provider_route,
    validate_persisted_native_provider_route_selection,
    validate_persisted_native_provider_route_selection_for_policy,
    NATIVE_CITED_BRIEF_POLICY_REVISION,
};

/// Normalize a backend consequential event and produce the audit entry that
/// records it. Used when a backend reports an action it wants to take (or has
/// already taken internally). The audit entry feeds the existing approval
/// audit log — Mivlet never lets a backend bypass its approval layer.
pub(crate) fn normalize_backend_event(
    event: BackendConsequentialEvent,
    decided_at: &str,
) -> Result<ApprovalAuditEntry, String> {
    require_supported_provider(&event.provider_id)?;
    let service = truncate_characters(&normalize_spaces(&event.service), 120);
    let action = truncate_characters(&normalize_spaces(&event.action), 240);
    let mode = normalize_spaces(&event.mode).to_ascii_lowercase();
    let risk_level = normalize_spaces(&event.risk_level).to_ascii_lowercase();

    if service.is_empty() || action.is_empty() {
        return Err("Backend events need a service and action.".to_string());
    }
    if !APPROVAL_MODES.contains(&mode.as_str()) {
        return Err("Backend event mode is not recognized.".to_string());
    }
    if !APPROVAL_RISK_LEVELS.contains(&risk_level.as_str()) {
        return Err("Backend event risk level is not recognized.".to_string());
    }
    if decided_at.trim().is_empty() {
        return Err("Backend events need a decision time.".to_string());
    }

    // A backend that already approved something internally is recorded as a
    // `once` audit entry naming the backend — it does not bypass Mivlet's layer
    // for future actions.
    let decision = if event.backend_preapproved.unwrap_or(false) {
        "once"
    } else {
        "deny"
    };
    if !APPROVAL_DECISIONS.contains(&decision) {
        return Err("Backend event decision is not recognized.".to_string());
    }

    let id = format!(
        "backend-{}-{}",
        normalize_spaces(&event.provider_id),
        truncate_characters(&normalize_spaces(&format!("{service}-{action}")), 80)
    );
    // Include the consequence + data scope in the note so the audit trail
    // records what the backend wanted to do and with what data — without ever
    // recording a secret.
    let data_scope = event
        .data_used
        .iter()
        .take(4)
        .map(|value| normalize_spaces(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    let consequence = truncate_characters(&normalize_spaces(&event.consequence), 160);
    let note = if data_scope.is_empty() && consequence.is_empty() {
        truncate_characters(
            &normalize_spaces(&format!(
                "{service} {action} via {provider}",
                provider = event.provider_id
            )),
            240,
        )
    } else {
        truncate_characters(
            &normalize_spaces(&format!(
                "{service} {action} via {provider}: {consequence} ({data})",
                provider = event.provider_id,
                data = data_scope
            )),
            240,
        )
    };

    Ok(ApprovalAuditEntry {
        id,
        request_id: format!(
            "backend-{}-{}",
            normalize_spaces(&event.provider_id),
            truncate_characters(&normalize_spaces(&action), 80)
        ),
        decision: decision.to_string(),
        decided_at: decided_at.to_string(),
        note,
    })
}

#[tauri::command]
pub async fn list_backends(app: tauri::AppHandle) -> Result<Vec<BackendProvider>, String> {
    // Managed provider probes can wait for a child process. Never perform them
    // on the WebView's command thread: even closing a dialog must stay usable.
    tauri::async_runtime::spawn_blocking(move || list_backends_blocking(app))
        .await
        .map_err(|_| "Provider discovery stopped unexpectedly.".to_string())?
}

fn list_backends_blocking(app: tauri::AppHandle) -> Result<Vec<BackendProvider>, String> {
    let internal_user_id = require_current_internal_user()?;
    let connected = connected_providers_for(&internal_user_id)?;
    let path = connected_backends_path(&app)?;
    // Auth state is resolved against the keychain (primary) with the in-memory
    // store as fallback — never against a raw secret. A persisted connected id
    // re-resolves to "connected" when the keychain still holds the entry.
    let stores = CredentialStores {
        internal_user_id: internal_user_id.clone(),
    };
    let mut providers = list_providers_from(&stores, &path)?;
    for provider in &mut providers {
        let native_api = catalog_entry(&provider.id)
            .map(|entry| entry.backend_type == "native-api")
            .unwrap_or(false);
        if native_api && !connected.iter().any(|id| id == &provider.id) {
            provider.auth_state = "needs-auth".into();
            provider.capabilities.clear();
            for model in &mut provider.models {
                model.available = false;
            }
        }
    }
    if let Some(codex) = providers.iter_mut().find(|provider| provider.id == "codex") {
        let status = crate::codex_app_server::codex_cli_status();
        apply_codex_cli_status(codex, &status);
        if status.authenticated {
            match crate::codex_app_server::codex_model_catalog() {
                Ok(models) => {
                    codex.models = models
                        .into_iter()
                        .take(MAX_BACKEND_MODELS)
                        .map(|model| BackendModel {
                            id: model.id,
                            label: model.label,
                            available: true,
                            capabilities: Some(
                                serde_json::json!({ "vision": model.supports_images }),
                            ),
                            reasoning: model.reasoning,
                            fast_mode: model.fast_mode,
                        })
                        .collect();
                }
                Err(message) => {
                    codex.auth_state = "unavailable".to_string();
                    codex.capabilities.clear();
                    codex.models.clear();
                    codex.install_hint = Some(message);
                }
            }
        }
    }
    if let Some(antigravity) = providers
        .iter_mut()
        .find(|provider| provider.id == "antigravity")
    {
        let is_connected = connected.iter().any(|id| id == "antigravity");
        let status = crate::antigravity_acp::status_for(&app, is_connected);
        if !status.installed {
            antigravity.auth_state = "install-required".to_string();
            antigravity.capabilities.clear();
            antigravity.models.clear();
            antigravity.install_hint = status.message;
        } else if status.authenticated {
            antigravity.auth_state = "connected".to_string();
            antigravity.models = crate::antigravity_acp::cached_models(&app, &internal_user_id);
            antigravity.install_hint = status
                .version
                .map(|version| format!("Antigravity ACP {version} is installed."));
        } else {
            antigravity.auth_state = "needs-auth".to_string();
            antigravity.capabilities.clear();
            antigravity.models.clear();
        }
    }
    for provider_id in ["claude", "cursor", "grok", "opencode"] {
        let Some(provider) = providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
        else {
            continue;
        };
        let is_connected = connected.iter().any(|id| id == provider_id);
        let status = crate::managed_runtime::status_for(provider_id, is_connected);
        if !status.installed {
            provider.auth_state = "install-required".to_string();
            provider.capabilities.clear();
            provider.models.clear();
            provider.install_hint = status.message;
        } else if status.authenticated {
            provider.auth_state = "connected".to_string();
            provider.capabilities = catalog_entry(provider_id)
                .map(|entry| {
                    entry
                        .capabilities
                        .iter()
                        .filter(|capability| BACKEND_CAPABILITIES.contains(capability))
                        .map(|capability| (*capability).to_string())
                        .collect()
                })
                .unwrap_or_default();
            provider.models =
                crate::managed_runtime::cached_models(&app, &internal_user_id, provider_id);
            provider.install_hint = status.message;
        } else {
            provider.auth_state = "sign-in-required".to_string();
            provider.capabilities.clear();
            provider.models.clear();
            provider.install_hint = status.message;
        }
    }
    if require_current_internal_user()? != internal_user_id {
        return Err("The account changed during provider discovery.".into());
    }
    if providers
        .iter()
        .any(|provider| provider.id == "codex" && provider.auth_state == "connected")
    {
        // Codex verifies its account-owned profile independently of the API-key
        // registry. Older successful logins did not populate usage metadata.
        let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
        store
            .transaction(|conn| {
                crate::store::repos::backend_connection::ensure_verified(
                    conn,
                    &internal_user_id,
                    "codex",
                    &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(providers)
}

#[tauri::command]
pub fn store_backend_credential(
    app: tauri::AppHandle,
    request: BackendCredentialRequest,
) -> Result<String, String> {
    let internal_user_id = require_current_internal_user()?;
    let path = connected_backends_path(&app)?;
    let mut stores = CredentialStores {
        internal_user_id: internal_user_id.clone(),
    };
    let provider_id = store_credential_into(&mut stores, &path, request)?;
    if let Err(error) = record_connected_provider(&internal_user_id, &provider_id) {
        let _ = stores.remove(&provider_id);
        return Err(error);
    }
    Ok(provider_id)
}

#[tauri::command]
pub fn clear_backend_credential(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<String, String> {
    let internal_user_id = require_current_internal_user()?;
    let path = connected_backends_path(&app)?;
    let mut stores = CredentialStores {
        internal_user_id: internal_user_id.clone(),
    };
    let provider_id = clear_credential_into(&mut stores, &path, &provider_id)?;
    remove_connected_provider(&internal_user_id, &provider_id)?;
    Ok(provider_id)
}

#[tauri::command]
pub fn record_backend_event(
    event: BackendConsequentialEvent,
    decided_at: String,
) -> Result<ApprovalAuditEntry, String> {
    normalize_backend_event(event, &decided_at)
}

#[tauri::command]
pub fn list_native_provider_routes() -> Result<Vec<serde_json::Value>, String> {
    let internal_user_id = require_current_internal_user()?;
    let (_, member_id) = crate::account_session::principals()?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let (rows, observations, quality) = store
        .with_conn(|tx| {
            let rows =
                crate::store::repos::backend_connection::list_records(tx, &internal_user_id)?;
            let observations = crate::store::repos::provider_route_observation::summaries(
                tx,
                store,
                &internal_user_id,
            )?;
            let quality =
                crate::store::repos::provider_route_quality_observation::summaries_for_policy(
                    tx,
                    store,
                    &internal_user_id,
                    NATIVE_CITED_BRIEF_POLICY_REVISION,
                )?;
            Ok((rows, observations, quality))
        })
        .map_err(|error| error.to_string())?;
    let stores = CredentialStores {
        internal_user_id: internal_user_id.clone(),
    };
    let mut availability = HashMap::new();
    let mut configured_models = HashMap::new();
    for row in &rows {
        let credential = stores.get(&row.provider_id)?;
        let mut credential_available = credential.is_some();
        if row.provider_id == "custom" {
            credential_available = credential
                .as_deref()
                .and_then(|secret| {
                    crate::native_api::configured_custom_provider_model_id(secret).ok()
                })
                .map(|model| {
                    configured_models.insert(row.provider_id.clone(), model);
                    true
                })
                .unwrap_or(false);
        }
        availability.insert(row.provider_id.clone(), credential_available);
    }
    Ok(build_account_native_provider_routes(
        &internal_user_id,
        crate::store::repos::scope::DEFAULT_WORKSPACE_ID,
        &member_id,
        &rows,
        &availability,
        &configured_models,
        &observations,
        &quality,
    ))
}
#[cfg(test)]
mod provider_route_tests;
