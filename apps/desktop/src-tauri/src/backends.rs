//! Agent-runtime backend credential boundary.
//!
//! Rust owns credential access for the agent-runtime AI backends (Codex,
//! Cursor, Copilot, Grok). Secrets live in a process-scoped store — a
//! `Mutex<HashMap<ProviderId, SecretString>>` now, behind the
//! `BACKENDS_PRE_RELEASE` flag, with OS keychain as the future swap point.
//!
//! Hard invariants:
//!   - Secrets never cross the Tauri command boundary into JavaScript.
//!   - `list_backends` returns auth state + capabilities + models only.
//!   - Secrets are never logged, serialized into `RuntimeSnapshot`, or written
//!     to disk in the snapshot path. Only *which* backends are connected is
//!     persisted (to `connected-backends.json`), as provider ids.
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

const ACP_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "cancellation",
];

const COPILOT_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "model-availability",
    "cancellation",
    "usage-cost",
];

/// Native-API providers declare the full capability set when connected: Arden
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
        description: "Continue with ChatGPT/Codex via the Codex app-server. Supports subscription and OpenAI API-key auth.",
        install_hint: "Requires the Codex CLI. Install it, then connect.",
        models: &[
            ("gpt-5", "GPT-5"),
            ("gpt-5-thinking", "GPT-5 Thinking"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        capabilities: CODEX_CAPS,
    },
    BackendCatalogEntry {
        id: "cursor",
        backend_type: "acp",
        label: "Cursor",
        description: "Reaches your Cursor subscription over ACP (stdio/JSON-RPC) using your installed Cursor CLI.",
        install_hint: "Requires the Cursor CLI. Install it, then connect.",
        models: &[("cursor-default", "Cursor default"), ("cursor-composer", "Cursor composer")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "copilot",
        backend_type: "copilot-sdk",
        label: "GitHub Copilot",
        description: "Reaches Copilot through its SDK. Supports subscriber, OAuth app, automation token, and BYOK auth.",
        install_hint: "Requires the Copilot SDK to be available in this build.",
        models: &[("copilot-default", "Copilot default"), ("copilot-claude", "Copilot + Claude")],
        capabilities: COPILOT_CAPS,
    },
    BackendCatalogEntry {
        id: "grok",
        backend_type: "acp",
        label: "Grok",
        description: "Reaches your Grok account over ACP (stdio/JSON-RPC) using your installed Grok CLI. Entitlements are checked after login.",
        install_hint: "Requires the Grok CLI. Install it, then connect.",
        models: &[("grok-default", "Grok")],
        capabilities: ACP_CAPS,
    },
    // Native-API providers: Arden owns the entire agent loop (tool dispatch,
    // streaming, approval routing, memory, usage/cost, cancellation). All are
    // API-key only; compliance copy names only the allowed auth paths.
    BackendCatalogEntry {
        id: "openai",
        backend_type: "native-api",
        label: "OpenAI",
        description: "Reach GPT models directly with an OpenAI API key. Arden owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[
            ("gpt-5", "GPT-5"),
            ("gpt-5-thinking", "GPT-5 Thinking"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "anthropic",
        backend_type: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key, Vertex AI, or Amazon Bedrock. Arden owns the agent loop.",
        install_hint: "",
        models: &[("claude-sonnet-4", "Claude Sonnet 4"), ("claude-opus-4", "Claude Opus 4")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "gemini",
        backend_type: "native-api",
        label: "Google Gemini",
        description: "Reach Gemini via a Google AI API key or Vertex AI. Arden owns the agent loop.",
        install_hint: "",
        models: &[("gemini-2-pro", "Gemini 2 Pro"), ("gemini-2-flash", "Gemini 2 Flash")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "xai",
        backend_type: "native-api",
        label: "xAI",
        description: "Reach Grok models directly with an xAI API key. Arden owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[("grok-4", "Grok 4")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "openrouter",
        backend_type: "native-api",
        label: "OpenRouter",
        description: "Reach many models through OpenRouter with an OpenRouter API key. Arden owns the agent loop.",
        install_hint: "",
        models: &[
            ("openrouter:auto", "OpenRouter Auto"),
            ("openrouter:claude", "OpenRouter Claude"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
];

/// Process-scoped credential store. The secret string is held here and never
/// serialized into a Tauri response or the runtime snapshot.
static CREDENTIAL_STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static PRE_RELEASE_WARNING_LOGGED: OnceLock<()> = OnceLock::new();

fn credential_store() -> &'static Mutex<HashMap<String, String>> {
    CREDENTIAL_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn log_pre_release_warning_once() {
    PRE_RELEASE_WARNING_LOGGED.get_or_init(|| {
        if BACKENDS_PRE_RELEASE {
            eprintln!(
                "arden: backend credential storage is PRE-RELEASE (local process store). \
                 OS keychain is not wired yet. Secrets are held in memory only."
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

/// Resolve the auth state for a provider from the credential store + the
/// persisted connected-backends manifest. ACP providers (cursor, grok) are
/// `install-required` until a credential is present (the CLI is the gating
/// dependency for this pre-release boundary).
fn resolve_auth_state(
    provider_id: &str,
    has_credential: bool,
    _connected: &ConnectedBackends,
) -> String {
    if has_credential {
        return "connected".to_string();
    }

    let is_acp = catalog_entry(provider_id)
        .map(|entry| entry.backend_type == "acp")
        .unwrap_or(false);

    if is_acp {
        "install-required".to_string()
    } else {
        "needs-auth".to_string()
    }
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

/// Compile-time assertion that the hardcoded catalog only uses recognized
/// backend-type and capability vocabulary values. Panicking here (at first
/// use) is correct: a bad catalog value is a programming error, not runtime
/// data.
fn validate_catalog_vocabulary() {
    for entry in CATALOG {
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
    if !path.exists() {
        return Ok(ConnectedBackends::default());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "Arden could not read connected backends.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(ConnectedBackends::default());
    }

    let parsed: BTreeSet<String> = serde_json::from_str(&contents)
        .map_err(|_| "Arden could not parse connected backends.".to_string())?;

    let ids: Vec<String> = parsed
        .into_iter()
        .filter(|id| SUPPORTED_BACKEND_PROVIDER_IDS.contains(&id.as_str()))
        .take(SUPPORTED_BACKEND_PROVIDER_IDS.len())
        .collect();

    Ok(ConnectedBackends(ids))
}

fn write_connected_backends(path: &Path, connected: &ConnectedBackends) -> Result<(), String> {
    let set: BTreeSet<&String> = connected.ids().iter().collect();
    let encoded = serde_json::to_string_pretty(&set)
        .map_err(|_| "Arden could not encode connected backends.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Arden could not save connected backends.".to_string())
}

/// Validate the secret length and write it to the given store. The secret is
/// never returned and never persisted to disk. Pure over the store + path so
/// tests can pass a fresh store; the Tauri command wrapper passes the global
/// process store.
pub(crate) fn store_credential_into(
    store: &mut HashMap<String, String>,
    connected_path: &Path,
    request: BackendCredentialRequest,
) -> Result<String, String> {
    require_supported_provider(&request.provider_id)?;
    let provider_id = normalize_spaces(&request.provider_id);
    let secret = truncate_characters(
        &normalize_spaces(&request.secret),
        MAX_BACKEND_SECRET_CHARACTERS,
    );

    if secret.is_empty() {
        return Err("Backend credentials need a non-empty secret.".to_string());
    }

    log_pre_release_warning_once();
    store.insert(provider_id.clone(), secret);

    let mut connected = read_connected_backends(connected_path)?;
    connected.add(&provider_id);
    write_connected_backends(connected_path, &connected)?;

    Ok(provider_id)
}

/// Remove a credential from the store and drop the provider from the manifest.
pub(crate) fn clear_credential_into(
    store: &mut HashMap<String, String>,
    connected_path: &Path,
    provider_id: &str,
) -> Result<String, String> {
    require_supported_provider(provider_id)?;
    let provider_id = normalize_spaces(provider_id);

    store.remove(&provider_id);

    let mut connected = read_connected_backends(connected_path)?;
    connected.remove(&provider_id);
    write_connected_backends(connected_path, &connected)?;

    Ok(provider_id)
}

/// Serve every catalog provider with its resolved auth state. Never includes
/// secrets — only auth state, capabilities, and model availability.
pub(crate) fn list_providers_from(
    store: &HashMap<String, String>,
    connected_path: &Path,
) -> Result<Vec<BackendProvider>, String> {
    validate_catalog_vocabulary();
    let connected = read_connected_backends(connected_path)?;
    let providers = CATALOG
        .iter()
        .map(|entry| {
            let auth_state = resolve_auth_state(entry.id, store.contains_key(entry.id), &connected);
            build_provider(entry, auth_state)
        })
        .collect();
    Ok(providers)
}

/// Normalize a backend consequential event and produce the audit entry that
/// records it. Used when a backend reports an action it wants to take (or has
/// already taken internally). The audit entry feeds the existing approval
/// audit log — Arden never lets a backend bypass its approval layer.
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
    // `once` audit entry naming the backend — it does not bypass Arden's layer
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
    let path = connected_backends_path(&app)?;
    let store = credential_store()
        .lock()
        .map_err(|_| "Arden could not acquire the credential store.".to_string())?;
    let store_snapshot: HashMap<String, String> = store.clone();
    drop(store);
    list_providers_from(&store_snapshot, &path)
}

#[tauri::command]
pub fn store_backend_credential(
    app: tauri::AppHandle,
    request: BackendCredentialRequest,
) -> Result<String, String> {
    let path = connected_backends_path(&app)?;
    let mut store = credential_store()
        .lock()
        .map_err(|_| "Arden could not acquire the credential store.".to_string())?;
    store_credential_into(&mut store, &path, request)
}

#[tauri::command]
pub fn clear_backend_credential(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<String, String> {
    let path = connected_backends_path(&app)?;
    let mut store = credential_store()
        .lock()
        .map_err(|_| "Arden could not acquire the credential store.".to_string())?;
    clear_credential_into(&mut store, &path, &provider_id)
}

#[tauri::command]
pub fn record_backend_event(
    event: BackendConsequentialEvent,
    decided_at: String,
) -> Result<ApprovalAuditEntry, String> {
    normalize_backend_event(event, &decided_at)
}
