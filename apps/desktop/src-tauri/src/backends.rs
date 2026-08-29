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
    BackendProvider, APPROVAL_DECISIONS, APPROVAL_MODES, APPROVAL_RISK_LEVELS,
    BACKENDS_PRE_RELEASE, BACKEND_AUTH_STATES, BACKEND_CAPABILITIES, BACKEND_TYPES,
    MAX_BACKEND_CAPABILITIES, MAX_BACKEND_MODELS, MAX_BACKEND_SECRET_CHARACTERS,
    SUPPORTED_BACKEND_PROVIDER_IDS,
};
use crate::paths::{connected_backends_path, normalize_spaces, truncate_characters};

/// The catalog the boundary serves. Mirrors the TypeScript registry's default
/// preview state; auth state is overridden at runtime by the credential store.
/// Keeping the catalog server-side means JavaScript never needs raw tokens to
/// render provider metadata.
struct BackendCatalogEntry {
    id: &'static str,
    backend_type: &'static str,
    label: &'static str,
    description: &'static str,
    install_hint: &'static str,
    models: &'static [(&'static str, &'static str)],
    capabilities: &'static [&'static str],
}

const CODEX_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "model-availability",
    "cancellation",
];

/// Native-API providers declare the full capability set when connected: Fable
/// owns the loop, so it honors streaming, tool-requests + approvals, file
/// changes, usage-cost (metered against the API key), model availability, and
/// cancellation.
const NATIVE_API_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "usage-cost",
    "model-availability",
    "cancellation",
];

const CATALOG: &[BackendCatalogEntry] = &[
    BackendCatalogEntry {
        id: "codex",
        backend_type: "codex-app-server",
        label: "Codex",
        description: "Continue with ChatGPT through the official Codex browser sign-in flow.",
        install_hint: "Requires the official Codex desktop app components.",
        models: &[
            ("gpt-5", "GPT-5"),
            ("gpt-5-thinking", "GPT-5 Thinking"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        capabilities: CODEX_CAPS,
    },
    // Native-API providers: Fable owns the entire agent loop (tool dispatch,
    // streaming, approval routing, memory, usage/cost, cancellation). All are
    // Direct API credentials, plus explicit local/custom exceptions; compliance
    // copy names only the implemented connection path.
    BackendCatalogEntry {
        id: "openai",
        backend_type: "native-api",
        label: "OpenAI",
        description: "Reach GPT models directly with an OpenAI API key. Fable owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[
            ("gpt-5.2", "GPT-5.2"),
            ("gpt-5", "GPT-5"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "anthropic",
        backend_type: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key. Fable owns the agent loop.",
        install_hint: "",
        models: &[
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-opus-4-8", "Claude Opus 4.8"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "gemini",
        backend_type: "native-api",
        label: "Gemini",
        description: "Reach Gemini via a Google AI API key. Fable owns the agent loop.",
        install_hint: "",
        models: &[
            ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "xai",
        backend_type: "native-api",
        label: "xAI",
        description: "Reach Grok models directly with an xAI API key. Fable owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[("grok-4", "Grok 4")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "custom",
        backend_type: "native-api",
        label: "Custom provider",
        description: "Connect an OpenAI-compatible base URL and model ID with an optional API key.",
        install_hint: "HTTPS is required except for loopback development endpoints.",
        models: &[],
        capabilities: NATIVE_API_CAPS,
    },
];

/// Process-scoped fallback credential store. The OS-secure store
/// ([`KeyringStore`]) is primary; this in-memory map is the fallback used when
/// the keychain is unavailable (headless/test builds) and the backing store for
/// existing unit tests. Secrets held here are never serialized into a Tauri
/// response or the runtime snapshot.
static CREDENTIAL_STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PRE_RELEASE_WARNING_LOGGED: OnceLock<()> = OnceLock::new();

/// The service name under which every backend key is filed in the OS-secure
/// store. The entry name (a.k.a. user name) is the provider id, so a stored
/// connected id from `connected-backends.json` re-resolves to its secret after
/// a restart.
const KEYRING_SERVICE: &str = "com.fable.workspace";

/// Exposed crate-wide so the native-API transport (`native_api.rs`) can look up
/// a stored key to add it as an Authorization header — without duplicating the
/// store. The store itself (OnceLock + Mutex) is unchanged; it remains the
/// process-scoped fallback behind the keychain-backed store.
pub(crate) fn credential_store() -> &'static Mutex<HashMap<String, String>> {
    CREDENTIAL_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Pluggable, mockable credential storage for agent-runtime backends. The
/// production path is the OS-secure store; the in-memory map implements this so
/// it can remain the test/headless fallback. Every method returns owned errors
/// (never the secret) so a failure cannot leak the value across the boundary.
///
/// Contract for callers:
///   - `get` returns `Ok(None)` when no credential exists (a *normal* miss) and
///     `Err` only when the store itself is unavailable.
///   - `set`/`remove` return `Err` only when the store is unavailable.
pub(crate) trait BackendCredentialStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String>;
    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String>;
    fn remove(&mut self, provider_id: &str) -> Result<(), String>;
}

/// The keychain is the primary store. `keyring` maps a `(service, user)` pair —
/// here `("com.fable.workspace", provider_id)` — to a platform credential
/// (Windows Credential Manager / macOS Keychain / Linux Secret Service). A
/// missing entry is a normal miss (`Ok(None)`); only platform-unavailable
/// failures bubble up as `Err` so the command path can fall back to the
/// in-memory store.
pub(crate) struct KeyringStore;

impl KeyringStore {
    fn entry(provider_id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, provider_id)
            .map_err(|_| "Fable could not open the OS secure store.".to_string())
    }
}

impl BackendCredentialStore for KeyringStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        let entry = Self::entry(provider_id)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(format!("Fable could not read the OS secure store: {other}")),
        }
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        let entry = Self::entry(provider_id)?;
        entry
            .set_password(secret)
            .map_err(|_| "Fable could not save to the OS secure store.".to_string())
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        let entry = Self::entry(provider_id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Nothing to remove is a normal miss, not an unavailable store.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Fable could not clear the OS secure store.".to_string()),
        }
    }
}

/// The in-memory fallback. `HashMap<String, String>` is the process-scoped
/// store used when the keychain is unavailable (headless/test) and is also what
/// the existing unit tests drive directly.
impl BackendCredentialStore for HashMap<String, String> {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        Ok(self.get(provider_id).cloned())
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        self.insert(provider_id.to_string(), secret.to_string());
        Ok(())
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        self.remove(provider_id);
        Ok(())
    }
}

/// Read a credential for `provider_id`, preferring the keychain and falling
/// back to the in-memory store only when the keychain is unavailable or empty.
/// Returns `Ok(None)` when neither store has a value (a normal miss →
/// needs-auth). The in-memory fallback exists so headless/test runs without a
/// keychain still resolve.
pub(crate) fn read_credential(provider_id: &str) -> Result<Option<String>, String> {
    let internal_user_id = require_current_internal_user()?;
    let connected = connected_providers_for(&internal_user_id)?;
    if !connected.iter().any(|id| id == provider_id) {
        return Ok(None);
    }
    CredentialStores { internal_user_id }.get(provider_id)
}

fn connected_providers_for(internal_user_id: &str) -> Result<Vec<String>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| crate::store::repos::backend_connection::list(tx, internal_user_id))
        .map_err(|error| error.to_string())
}

fn record_connected_provider(internal_user_id: &str, provider_id: &str) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    store
        .transaction(|tx| {
            crate::store::repos::backend_connection::upsert(tx, internal_user_id, provider_id, &now)
        })
        .map_err(|error| error.to_string())
}

fn remove_connected_provider(internal_user_id: &str, provider_id: &str) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::backend_connection::delete(tx, internal_user_id, provider_id)
        })
        .map_err(|error| error.to_string())
}

/// The composed production store. Reads retain an in-memory test/headless seam;
/// writes require the OS keyring so a connection is never reported successful
/// when its credential would disappear at restart. It is never serialized and
/// exposes a secret — it is only ever asked whether a credential *exists* or
/// handed one to persist.
pub(crate) struct CredentialStores {
    internal_user_id: String,
}

fn scoped_credential_key(internal_user_id: &str, provider_id: &str) -> String {
    let digest = Sha256::digest(internal_user_id.as_bytes());
    format!("account-{:x}:{provider_id}", digest)
}

fn require_current_internal_user() -> Result<String, String> {
    Ok(crate::account_workspace::local_install_principals().0)
}

impl BackendCredentialStore for CredentialStores {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        let scoped_key = scoped_credential_key(&self.internal_user_id, provider_id);
        // Keychain first. A hit resolves; a miss OR an unavailable keychain
        // falls through to the in-memory store (so the same miss/miss path is
        // taken either way, and headless builds still work).
        if let Ok(Some(secret)) = KeyringStore.get(&scoped_key) {
            return Ok(Some(secret));
        }
        let store = credential_store()
            .lock()
            .map_err(|_| "Fable could not acquire the credential store.".to_string())?;
        Ok(store.get(&scoped_key).cloned())
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        // Production writes must be durable and OS-protected. The in-memory
        // map remains an injectable/headless read seam for tests, but a failed
        // keyring write is never reported as a successful connection.
        let scoped_key = scoped_credential_key(&self.internal_user_id, provider_id);
        KeyringStore.set(&scoped_key, secret)
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        // Do not report a disconnect until durable secure-store deletion
        // succeeds. Otherwise metadata could say disconnected while the secret
        // remains in the OS keyring.
        let scoped_key = scoped_credential_key(&self.internal_user_id, provider_id);
        KeyringStore.remove(&scoped_key)?;
        let mut store = credential_store()
            .lock()
            .map_err(|_| "Fable could not acquire the credential store.".to_string())?;
        BackendCredentialStore::remove(&mut *store, &scoped_key)?;
        Ok(())
    }
}

fn log_pre_release_warning_once() {
    PRE_RELEASE_WARNING_LOGGED.get_or_init(|| {
        if BACKENDS_PRE_RELEASE {
            eprintln!(
                "fable: backend credential storage is PRE-RELEASE. Secrets are held in the \
                 OS secure store (with a process-scoped fallback). Do not ship pre-release."
            );
        }
    });
}

/// Validate a provider id against the supported catalog.
fn require_supported_provider(provider_id: &str) -> Result<(), String> {
    let normalized = normalize_spaces(provider_id);
    if !SUPPORTED_BACKEND_PROVIDER_IDS.contains(&normalized.as_str()) {
        return Err(format!(
            "{} is not a supported agent-runtime backend.",
            provider_id
        ));
    }
    Ok(())
}

fn catalog_entry(provider_id: &str) -> Option<&'static BackendCatalogEntry> {
    CATALOG.iter().find(|entry| entry.id == provider_id)
}

fn validate_backend_secret(secret: &str) -> Result<String, String> {
    if secret.chars().any(|character| character.is_control()) {
        return Err("Backend credentials cannot contain control characters.".to_string());
    }

    let normalized = normalize_spaces(secret);

    if normalized.is_empty() {
        return Err("Backend credentials need a non-empty secret.".to_string());
    }
    if normalized.chars().count() > MAX_BACKEND_SECRET_CHARACTERS {
        return Err("Backend credential exceeds the supported length.".to_string());
    }

    Ok(normalized)
}

/// Resolve auth state from the credential store. Direct API providers become
/// connected only when the native credential boundary has a stored secret.
/// Codex uses its official browser sign-in path and remains gated until that
/// runtime reports a connection.
fn resolve_auth_state<S: BackendCredentialStore>(provider_id: &str, store: &S) -> String {
    let entry = catalog_entry(provider_id);
    let is_native = entry
        .map(|entry| entry.backend_type == "native-api")
        .unwrap_or(false);
    if is_native && matches!(store.get(provider_id), Ok(Some(_))) {
        return "connected".to_string();
    }

    "needs-auth".to_string()
}

/// Build the provider shape served to JavaScript (auth state + caps, no secret).
fn build_provider(entry: &'static BackendCatalogEntry, auth_state: String) -> BackendProvider {
    let available = auth_state == "connected";
    let mut models = Vec::with_capacity(entry.models.len().min(MAX_BACKEND_MODELS));
    for (id, label) in entry.models.iter().take(MAX_BACKEND_MODELS) {
        models.push(BackendModel {
            id: (*id).to_string(),
            label: (*label).to_string(),
            available,
            capabilities: None,
        });
    }

    let capabilities: Vec<String> = if auth_state == "connected" {
        entry
            .capabilities
            .iter()
            .filter(|cap| BACKEND_CAPABILITIES.contains(cap))
            .take(MAX_BACKEND_CAPABILITIES)
            .map(|cap| (*cap).to_string())
            .collect()
    } else {
        // Fail closed: declare no capabilities until authenticated.
        Vec::new()
    };

    // Guard: the served auth state must be a recognized vocabulary value. An
    // unrecognized state fails closed to "unavailable" rather than leaking a
    // capability-bearing provider.
    let safe_auth_state = if BACKEND_AUTH_STATES.contains(&auth_state.as_str()) {
        auth_state
    } else {
        "unavailable".to_string()
    };

    BackendProvider {
        id: entry.id.to_string(),
        backend_type: entry.backend_type.to_string(),
        label: entry.label.to_string(),
        description: entry.description.to_string(),
        auth_state: safe_auth_state,
        capabilities,
        models,
        install_hint: Some(entry.install_hint.to_string()),
        // Grok entitlements are detected post-login only — never pre-populated.
        entitlements: if entry.id == "grok" {
            Some(Vec::new())
        } else {
            None
        },
    }
}

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

fn account_provider_connection_id(internal_user_id: &str, provider_id: &str) -> String {
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

fn native_provider_route_reason_with_evidence(
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

pub(crate) fn validate_current_native_provider_route(
    provider_id: &str,
    model: &str,
    binding: &crate::models::ProviderRouteExecutionBinding,
) -> Result<String, String> {
    let internal_user_id = require_current_internal_user()?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
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
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
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

fn validate_native_provider_route_binding(
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

fn validate_provider_route_cost_snapshot(
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

fn validate_provider_route_observation_snapshot(
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

fn validate_provider_route_quality_snapshot(
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

#[tauri::command]
pub fn list_native_provider_routes() -> Result<Vec<serde_json::Value>, String> {
    let internal_user_id = require_current_internal_user()?;
    let (_, member_id) = crate::account_workspace::local_install_principals();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
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

fn build_account_native_provider_routes(
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

/// Compile-time assertion that the hardcoded catalog only uses recognized
/// backend-type and capability vocabulary values. Panicking here (at first
/// use) is correct: a bad catalog value is a programming error, not runtime
/// data.
fn validate_catalog_vocabulary() {
    let mut ids = BTreeSet::new();
    for entry in CATALOG {
        assert!(
            ids.insert(entry.id),
            "duplicate backend provider id {}",
            entry.id
        );
        assert!(
            SUPPORTED_BACKEND_PROVIDER_IDS.contains(&entry.id),
            "catalog provider {} is not in the supported provider vocabulary",
            entry.id
        );
        assert!(
            BACKEND_TYPES.contains(&entry.backend_type),
            "catalog backend type {} is not in the vocabulary",
            entry.backend_type
        );
        for cap in entry.capabilities {
            assert!(
                BACKEND_CAPABILITIES.contains(cap),
                "catalog capability {} is not in the vocabulary",
                cap
            );
        }
    }
    assert_eq!(
        ids.len(),
        SUPPORTED_BACKEND_PROVIDER_IDS.len(),
        "backend catalog and supported provider vocabulary differ"
    );
}

/// The persisted connected-backends manifest: provider ids only, no secrets.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnectedBackends(Vec<String>);

impl ConnectedBackends {
    pub(crate) fn has(&self, provider_id: &str) -> bool {
        self.0.iter().any(|id| id == provider_id)
    }

    fn add(&mut self, provider_id: &str) {
        if !self.has(provider_id) {
            self.0.push(provider_id.to_string());
        }
    }

    fn remove(&mut self, provider_id: &str) {
        self.0.retain(|id| id != provider_id);
    }

    pub(crate) fn ids(&self) -> &[String] {
        &self.0
    }
}

pub(crate) fn read_connected_backends(path: &Path) -> Result<ConnectedBackends, String> {
    if let Some(parsed) = crate::store::read_document::<BTreeSet<String>>(path)? {
        let ids = parsed
            .into_iter()
            .filter(|id| SUPPORTED_BACKEND_PROVIDER_IDS.contains(&id.as_str()))
            .take(SUPPORTED_BACKEND_PROVIDER_IDS.len())
            .collect();
        return Ok(ConnectedBackends(ids));
    }
    if !path.exists() {
        return Ok(ConnectedBackends::default());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read connected backends.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(ConnectedBackends::default());
    }

    let parsed: BTreeSet<String> = serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse connected backends.".to_string())?;

    let ids: Vec<String> = parsed
        .into_iter()
        .filter(|id| SUPPORTED_BACKEND_PROVIDER_IDS.contains(&id.as_str()))
        .take(SUPPORTED_BACKEND_PROVIDER_IDS.len())
        .collect();

    Ok(ConnectedBackends(ids))
}

fn write_connected_backends(path: &Path, connected: &ConnectedBackends) -> Result<(), String> {
    let set: BTreeSet<&String> = connected.ids().iter().collect();
    if crate::store::write_document(path, &set)? {
        return Ok(());
    }
    let encoded = serde_json::to_string_pretty(&set)
        .map_err(|_| "Fable could not encode connected backends.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Fable could not save connected backends.".to_string())
}

/// Validate the secret length and write it to the given store. The secret is
/// never returned and never persisted to disk. Pure over the store + path so
/// tests can pass a fresh store; the Tauri command wrapper passes the
/// keychain-backed [`CredentialStores`], which mirrors to the in-memory
/// fallback when the keychain is unavailable.
pub(crate) fn store_credential_into<S: BackendCredentialStore>(
    store: &mut S,
    connected_path: &Path,
    request: BackendCredentialRequest,
) -> Result<String, String> {
    require_supported_provider(&request.provider_id)?;
    let provider_id = normalize_spaces(&request.provider_id);
    let entry = catalog_entry(&provider_id)
        .ok_or_else(|| format!("{} is not a supported agent-runtime backend.", provider_id))?;
    if entry.backend_type != "native-api" {
        return Err(format!(
            "{} requires its real runtime adapter; it cannot connect through the API-key boundary.",
            entry.label
        ));
    }
    let secret = validate_backend_secret(&request.secret)?;
    crate::native_api::validate_native_credential(&provider_id, &secret)?;

    log_pre_release_warning_once();
    store.set(&provider_id, &secret)?;

    let mut connected = read_connected_backends(connected_path)?;
    connected.add(&provider_id);
    write_connected_backends(connected_path, &connected)?;

    Ok(provider_id)
}

/// Remove a credential from the store and drop the provider from the manifest.
/// The supplied store is responsible for clearing any fallbacks it owns.
pub(crate) fn clear_credential_into<S: BackendCredentialStore>(
    store: &mut S,
    connected_path: &Path,
    provider_id: &str,
) -> Result<String, String> {
    require_supported_provider(provider_id)?;
    let provider_id = normalize_spaces(provider_id);

    store.remove(&provider_id)?;

    let mut connected = read_connected_backends(connected_path)?;
    connected.remove(&provider_id);
    write_connected_backends(connected_path, &connected)?;

    Ok(provider_id)
}

/// Serve every catalog provider with its resolved auth state. Never includes
/// secrets — only auth state, capabilities, and model availability. Auth state
/// is resolved by asking the store whether a live credential exists, so a
/// persisted connected id re-resolves to "connected" after a restart when the
/// keychain still holds the entry.
pub(crate) fn list_providers_from<S: BackendCredentialStore>(
    store: &S,
    connected_path: &Path,
) -> Result<Vec<BackendProvider>, String> {
    validate_catalog_vocabulary();
    // The connected manifest is read so store/clear stay consistent with it;
    // auth state itself is resolved from the credential store (the keychain is
    // the source of truth), so a persisted connected id re-resolves to
    // "connected" when its keychain entry survives a restart.
    let _connected = read_connected_backends(connected_path)?;
    let providers = CATALOG
        .iter()
        .map(|entry| {
            let auth_state = resolve_auth_state(entry.id, store);
            build_provider(entry, auth_state)
        })
        .collect();
    Ok(providers)
}

/// Normalize a backend consequential event and produce the audit entry that
/// records it. Used when a backend reports an action it wants to take (or has
/// already taken internally). The audit entry feeds the existing approval
/// audit log — Fable never lets a backend bypass its approval layer.
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
    // `once` audit entry naming the backend — it does not bypass Fable's layer
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
pub fn list_backends(app: tauri::AppHandle) -> Result<Vec<BackendProvider>, String> {
    let internal_user_id = require_current_internal_user()?;
    let connected = connected_providers_for(&internal_user_id)?;
    let path = connected_backends_path(&app)?;
    // Auth state is resolved against the keychain (primary) with the in-memory
    // store as fallback — never against a raw secret. A persisted connected id
    // re-resolves to "connected" when the keychain still holds the entry.
    let stores = CredentialStores { internal_user_id };
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
                            capabilities: None,
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

#[cfg(test)]
mod provider_route_tests {
    use super::*;

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
                reference:
                    crate::store::repos::provider_route_quality_observation::summary_reference(
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
            &HashMap::from([("custom".to_string(), "fable-smoke".to_string())]),
            &std::collections::BTreeMap::new(),
            &std::collections::BTreeMap::new(),
        );

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0]["providerFamily"], "custom");
        assert_eq!(routes[0]["modelOrRuntimeReference"], "fable-smoke");
        assert_eq!(routes[0]["displayName"], "Custom provider fable-smoke");
        assert_eq!(routes[0]["state"], "available");
        assert_eq!(
            native_provider_route_boundary("custom"),
            "boundary:installation-private:user-owned-provider:custom:local-credential-egress"
        );
        assert!(native_provider_route_reason("custom", "fable-smoke")
            .unwrap()
            .contains("Custom provider fable-smoke"));
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
            serde_json::from_value::<crate::models::ProviderRouteExecutionBinding>(encoded)
                .unwrap();
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
}
