//! Agent-runtime backend credential boundary.
//!
//! Rust owns credential access for native API-key agent backends. Catalog-only
//! subscription/CLI providers remain gated until their real runtime adapter is
//! available. Secrets live in the
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

/// Local runtimes are reachable only through an explicitly configured literal
/// loopback service. They never accept or retain an API key in Fable.
const LOCAL_LOOPBACK_CAPS: &[&str] = &["streaming", "model-availability", "cancellation"];

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
        models: &[("cursor-default", "Cursor default")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "copilot",
        backend_type: "acp",
        label: "GitHub Copilot",
        description: "Reaches Copilot over ACP using the installed GitHub Copilot CLI and its existing login or token configuration.",
        install_hint: "Requires GitHub Copilot CLI. Install it and run copilot login.",
        models: &[("copilot-default", "Copilot default")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "grok",
        backend_type: "acp",
        label: "Grok Build",
        description: "Reaches your Grok account over ACP (stdio/JSON-RPC) using your installed Grok CLI. Entitlements are checked after login.",
        install_hint: "Requires the Grok CLI. Install it, then connect.",
        models: &[("grok-default", "Grok")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "opencode",
        backend_type: "acp",
        label: "OpenCode",
        description: "Uses your installed OpenCode agent over ACP, including the providers and models already configured in OpenCode.",
        install_hint: "Requires the OpenCode CLI. Install it and configure at least one provider.",
        models: &[("opencode-default", "OpenCode default")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "kimi",
        backend_type: "acp",
        label: "Kimi Code",
        description: "Uses your Kimi Code subscription through the official Kimi ACP runtime and its provider-owned device login.",
        install_hint: "Requires Kimi Code CLI. Install it and run kimi login.",
        models: &[("kimi-default", "Kimi default")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "mistral-vibe",
        backend_type: "acp",
        label: "Mistral Vibe",
        description: "Uses your configured Mistral Vibe account or API profile through the official Vibe ACP runtime.",
        install_hint: "Requires Mistral Vibe. Install it and run vibe --setup.",
        models: &[("mistral-vibe-default", "Vibe default")],
        capabilities: ACP_CAPS,
    },
    BackendCatalogEntry {
        id: "ollama",
        backend_type: "local-loopback",
        label: "Ollama",
        description: "Use an externally managed Ollama service on 127.0.0.1. Fable never bundles models or downloads them automatically.",
        install_hint: "Install Ollama, start its local service, then pull a model with Ollama before returning to Fable.",
        models: &[],
        capabilities: LOCAL_LOOPBACK_CAPS,
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
        id: "openrouter",
        backend_type: "native-api",
        label: "OpenRouter",
        description: "Reach many models through OpenRouter with an OpenRouter API key. Fable owns the agent loop.",
        install_hint: "",
        models: &[("openrouter/auto", "OpenRouter Auto")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "deepseek",
        backend_type: "native-api",
        label: "DeepSeek",
        description: "Reach DeepSeek models directly with a DeepSeek API key.",
        install_hint: "",
        models: &[
            ("deepseek-v4-pro", "DeepSeek V4 Pro"),
            ("deepseek-v4-flash", "DeepSeek V4 Flash"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "zai",
        backend_type: "native-api",
        label: "Z.AI",
        description: "Reach GLM models through the general Z.AI API.",
        install_hint: "",
        models: &[("glm-5.1", "GLM-5.1")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "minimax",
        backend_type: "native-api",
        label: "MiniMax",
        description: "Reach MiniMax text and coding models with a MiniMax API key.",
        install_hint: "",
        models: &[
            ("MiniMax-M2.7", "MiniMax M2.7"),
            ("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed"),
        ],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "alibaba",
        backend_type: "native-api",
        label: "Alibaba Cloud",
        description: "Reach Qwen models through Alibaba Cloud Model Studio's international API.",
        install_hint: "",
        models: &[("qwen3.7-plus", "Qwen 3.7 Plus")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "fireworks",
        backend_type: "native-api",
        label: "Fireworks AI",
        description: "Reach serverless and deployed models through Fireworks AI.",
        install_hint: "",
        models: &[("accounts/fireworks/models/deepseek-v3p1", "DeepSeek V3.1")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "huggingface",
        backend_type: "native-api",
        label: "Hugging Face",
        description: "Reach models routed by Hugging Face Inference Providers.",
        install_hint: "",
        models: &[],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "moonshot",
        backend_type: "native-api",
        label: "Moonshot AI",
        description: "Reach Kimi models through the Moonshot AI platform API.",
        install_hint: "",
        models: &[("kimi-k2.6", "Kimi K2.6")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "kimi-code",
        backend_type: "native-api",
        label: "Kimi Code",
        description: "Use a Kimi Code membership API key through Kimi's official coding endpoint.",
        install_hint: "",
        models: &[("kimi-for-coding", "Kimi for Coding")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "mistral",
        backend_type: "native-api",
        label: "Mistral AI",
        description: "Reach Mistral models directly with a Mistral API key.",
        install_hint: "",
        models: &[],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "meta",
        backend_type: "native-api",
        label: "Meta Llama",
        description: "Reach models available to your Meta Llama API account.",
        install_hint: "",
        models: &[],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "perplexity",
        backend_type: "native-api",
        label: "Perplexity",
        description: "Reach Perplexity Sonar through its OpenAI-compatible API.",
        install_hint: "",
        models: &[("sonar", "Sonar")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "tencent",
        backend_type: "native-api",
        label: "Tencent TokenHub",
        description: "Reach models through Tencent TokenHub's international endpoint.",
        install_hint: "",
        models: &[("hy3", "Hy3")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "xiaomi",
        backend_type: "native-api",
        label: "Xiaomi MiMo",
        description: "Reach MiMo models through Xiaomi's API platform.",
        install_hint: "",
        models: &[("mimo-v2.5-pro", "MiMo V2.5 Pro")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "groq",
        backend_type: "native-api",
        label: "Groq",
        description: "Reach supported models through Groq's low-latency inference API.",
        install_hint: "",
        models: &[("openai/gpt-oss-120b", "GPT OSS 120B")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "together",
        backend_type: "native-api",
        label: "Together AI",
        description: "Reach open and partner models through Together AI.",
        install_hint: "",
        models: &[("openai/gpt-oss-20b", "GPT OSS 20B")],
        capabilities: NATIVE_API_CAPS,
    },
    BackendCatalogEntry {
        id: "cerebras",
        backend_type: "native-api",
        label: "Cerebras",
        description: "Reach supported models through Cerebras Inference.",
        install_hint: "",
        models: &[("gpt-oss-120b", "GPT OSS 120B")],
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
    CredentialStores.get(provider_id)
}

/// The composed production store. Reads retain an in-memory test/headless seam;
/// writes require the OS keyring so a connection is never reported successful
/// when its credential would disappear at restart. It is never serialized and
/// exposes a secret — it is only ever asked whether a credential *exists* or
/// handed one to persist.
pub(crate) struct CredentialStores;

impl BackendCredentialStore for CredentialStores {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        // Keychain first. A hit resolves; a miss OR an unavailable keychain
        // falls through to the in-memory store (so the same miss/miss path is
        // taken either way, and headless builds still work).
        if let Ok(Some(secret)) = KeyringStore.get(provider_id) {
            return Ok(Some(secret));
        }
        let store = credential_store()
            .lock()
            .map_err(|_| "Fable could not acquire the credential store.".to_string())?;
        Ok(store.get(provider_id).cloned())
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        // Production writes must be durable and OS-protected. The in-memory
        // map remains an injectable/headless read seam for tests, but a failed
        // keyring write is never reported as a successful connection.
        KeyringStore.set(provider_id, secret)
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        // Do not report a disconnect until durable secure-store deletion
        // succeeds. Otherwise metadata could say disconnected while the secret
        // remains in the OS keyring.
        KeyringStore.remove(provider_id)?;
        let mut store = credential_store()
            .lock()
            .map_err(|_| "Fable could not acquire the credential store.".to_string())?;
        BackendCredentialStore::remove(&mut *store, provider_id)?;
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

/// Resolve auth state from the credential store. Only native API-key providers
/// can become connected through this boundary. Catalog-only subscription/CLI
/// providers stay gated until a real runtime adapter reports capabilities.
fn resolve_auth_state<S: BackendCredentialStore>(provider_id: &str, store: &S) -> String {
    let entry = catalog_entry(provider_id);
    let is_native = entry
        .map(|entry| entry.backend_type == "native-api")
        .unwrap_or(false);
    if is_native && matches!(store.get(provider_id), Ok(Some(_))) {
        return "connected".to_string();
    }

    let is_local_loopback = entry
        .map(|entry| entry.backend_type == "local-loopback")
        .unwrap_or(false);
    if is_local_loopback {
        return "unavailable".to_string();
    }

    let is_acp = entry
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
            Some(version) => format!("Codex CLI {version} - sign in required"),
            None => "Codex CLI installed - sign in required".to_string(),
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
        (Some(version), Some(auth)) => Some(format!("Codex CLI {version} - {auth}")),
        (Some(version), None) => Some(format!("Codex CLI {version}")),
        (None, Some(auth)) => Some(format!("Codex CLI - {auth}")),
        (None, None) => Some("Codex CLI".to_string()),
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
    let path = connected_backends_path(&app)?;
    // Auth state is resolved against the keychain (primary) with the in-memory
    // store as fallback — never against a raw secret. A persisted connected id
    // re-resolves to "connected" when the keychain still holds the entry.
    let mut providers = list_providers_from(&CredentialStores, &path)?;
    if let Some(codex) = providers.iter_mut().find(|provider| provider.id == "codex") {
        let status = crate::codex_app_server::codex_cli_status();
        apply_codex_cli_status(codex, &status);
    }
    Ok(providers)
}

#[tauri::command]
pub fn store_backend_credential(
    app: tauri::AppHandle,
    request: BackendCredentialRequest,
) -> Result<String, String> {
    let path = connected_backends_path(&app)?;
    let mut stores = CredentialStores;
    store_credential_into(&mut stores, &path, request)
}

#[tauri::command]
pub fn clear_backend_credential(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<String, String> {
    let path = connected_backends_path(&app)?;
    let mut stores = CredentialStores;
    clear_credential_into(&mut stores, &path, &provider_id)
}

#[tauri::command]
pub fn record_backend_event(
    event: BackendConsequentialEvent,
    decided_at: String,
) -> Result<ApprovalAuditEntry, String> {
    normalize_backend_event(event, &decided_at)
}
