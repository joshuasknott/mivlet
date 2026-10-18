//! Static backend catalogue and provider presentation policy.
use super::*;

/// The catalog the boundary serves. Mirrors the TypeScript registry's default
/// preview state; auth state is overridden at runtime by the credential store.
/// Keeping the catalog server-side means JavaScript never needs raw tokens to
/// render provider metadata.
pub(super) struct BackendCatalogEntry {
    pub(super) id: &'static str,
    pub(super) driver_kind: &'static str,
    pub(super) backend_type: &'static str,
    pub(super) label: &'static str,
    pub(super) description: &'static str,
    pub(super) install_hint: &'static str,
    pub(super) models: &'static [(&'static str, &'static str)],
    pub(super) capabilities: &'static [&'static str],
    pub(super) setup_kind: &'static str,
    pub(super) setup_label: &'static str,
    pub(super) setup_description: &'static str,
    pub(super) recommended: bool,
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

const ANTIGRAVITY_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "model-availability",
    "cancellation",
];

const MANAGED_AGENT_CAPS: &[&str] = &[
    "authentication",
    "threads",
    "streaming",
    "tool-requests",
    "approvals",
    "file-changes",
    "model-availability",
    "cancellation",
];

/// Native-API providers declare the full capability set when connected: Mivlet
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

pub(super) const CATALOG: &[BackendCatalogEntry] = &[
    BackendCatalogEntry {
        id: "codex",
        driver_kind: "codex",
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
        setup_kind: "browser",
        setup_label: "ChatGPT account",
        setup_description: "Sign in through the official browser flow managed by Codex.",
        recommended: true,
    },
    // Native-API providers: Mivlet owns the entire agent loop (tool dispatch,
    // streaming, approval routing, memory, usage/cost, cancellation). All are
    // Direct API credentials, plus explicit local/custom exceptions; compliance
    // copy names only the implemented connection path.
    BackendCatalogEntry {
        id: "openai",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "OpenAI",
        description: "Reach GPT models directly with an OpenAI API key. Mivlet owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[
            ("gpt-5.2", "GPT-5.2"),
            ("gpt-5", "GPT-5"),
            ("gpt-4.1", "GPT-4.1"),
        ],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "OpenAI API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "claude",
        driver_kind: "claude-agent",
        backend_type: "claude-agent",
        label: "Claude",
        description: "Use Claude through Anthropic's official Claude Agent runtime.",
        install_hint: "Install the official Claude runtime to continue with a Claude account.",
        models: &[("sonnet", "Claude Sonnet"), ("opus", "Claude Opus"), ("haiku", "Claude Haiku")],
        capabilities: MANAGED_AGENT_CAPS,
        setup_kind: "provider-cli",
        setup_label: "Claude account",
        setup_description: "Sign in with the official Claude runtime; Mivlet never handles the session token.",
        recommended: true,
    },
    BackendCatalogEntry {
        id: "anthropic",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Anthropic",
        description: "Reach Claude via an Anthropic API key. Mivlet owns the agent loop.",
        install_hint: "",
        models: &[
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-opus-4-8", "Claude Opus 4.8"),
        ],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Anthropic API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "antigravity",
        driver_kind: "antigravity-acp",
        backend_type: "antigravity-acp",
        label: "Google Antigravity",
        description: "Use Gemini models through Google's official Antigravity ACP agent and personal Google sign-in.",
        install_hint: "Mivlet installs Google's pinned Antigravity ACP runtime locally.",
        models: &[],
        capabilities: ANTIGRAVITY_CAPS,
        setup_kind: "browser",
        setup_label: "Google account",
        setup_description: "Sign in through Google's official Antigravity browser flow.",
        recommended: true,
    },
    BackendCatalogEntry {
        id: "gemini",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Gemini API",
        description: "Reach Gemini models directly with a Google AI Gemini API key. Mivlet owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[
            ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
        ],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Gemini API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "grok",
        driver_kind: "grok-acp",
        backend_type: "grok-acp",
        label: "Grok",
        description: "Use your xAI account through the official Grok ACP runtime.",
        install_hint: "Install the official Grok runtime to continue with a Grok account. An xAI API key remains available as an advanced route.",
        models: &[("grok-build", "Grok default")],
        capabilities: CODEX_CAPS,
        setup_kind: "provider-cli",
        setup_label: "Grok account",
        setup_description: "Sign in through xAI's official Grok runtime.",
        recommended: true,
    },
    BackendCatalogEntry {
        id: "xai",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "xAI",
        description: "Reach Grok models directly with an xAI API key. Mivlet owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[("grok-4", "Grok 4")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "xAI API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    // DeepSeek: OpenAI-compatible Chat Completions with a documented
    // list-models endpoint. Model IDs follow the official DeepSeek platform
    // (api-docs.deepseek.com); Mivlet disables the default-enabled thinking
    // mode at egress because the reasoning_content round-trip contract is not
    // bridged, so no reasoning levels are advertised.
    BackendCatalogEntry {
        id: "deepseek",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "DeepSeek",
        description: "Reach DeepSeek models directly with a DeepSeek API key. Mivlet owns the agent loop, tool dispatch, and approvals.",
        install_hint: "",
        models: &[
            ("deepseek-flash", "DeepSeek Flash"),
            ("deepseek-v4-pro", "DeepSeek V4 Pro"),
        ],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "DeepSeek API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "cursor",
        driver_kind: "cursor-acp",
        backend_type: "cursor-acp",
        label: "Cursor",
        description: "Use your Cursor account through Cursor's official ACP runtime.",
        install_hint: "Install the official Cursor Agent CLI to continue with a Cursor account.",
        models: &[("default", "Cursor default")],
        capabilities: CODEX_CAPS,
        setup_kind: "provider-cli",
        setup_label: "Cursor account",
        setup_description: "Sign in through Cursor's official agent runtime.",
        recommended: true,
    },
    BackendCatalogEntry {
        id: "opencode",
        driver_kind: "opencode",
        backend_type: "opencode-server",
        label: "OpenCode",
        description: "Use providers already configured in your local OpenCode runtime.",
        install_hint: "Install OpenCode and configure a provider with `opencode auth login`.",
        models: &[],
        capabilities: MANAGED_AGENT_CAPS,
        setup_kind: "provider-cli",
        setup_label: "OpenCode",
        setup_description: "Connect through your local OpenCode configuration.",
        recommended: true,
    },
    BackendCatalogEntry {
        id: "alibaba",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Alibaba / Qwen",
        description: "Use Qwen through Alibaba Cloud Model Studio. Choose the endpoint matching your API key's region and workspace.",
        install_hint: "",
        models: &[("qwen-plus", "Qwen Plus"), ("qwen-turbo", "Qwen Turbo"), ("qwen3-coder-plus", "Qwen3 Coder Plus")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Alibaba / Qwen API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "moonshot",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Moonshot / Kimi",
        description: "Use Kimi through Moonshot's international API in non-thinking mode.",
        install_hint: "",
        models: &[("kimi-k2.6", "Kimi K2.6")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Moonshot / Kimi API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "zai",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Z.ai / GLM",
        description: "Use GLM through Z.ai's standard API in non-thinking mode. Coding Plan keys use a separate service.",
        install_hint: "",
        models: &[("glm-4.7", "GLM 4.7"), ("glm-4.5-air", "GLM 4.5 Air")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Z.ai / GLM API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "groq",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Groq",
        description: "Use open models through Groq's inference API.",
        install_hint: "",
        models: &[("llama-3.3-70b-versatile", "Llama 3.3 70B"), ("llama-3.1-8b-instant", "Llama 3.1 8B")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Groq API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "together",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Together AI",
        description: "Use open models through Together AI's inference API.",
        install_hint: "",
        models: &[("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Together AI API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "fireworks",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Fireworks AI",
        description: "Use serverless models through Fireworks AI's inference API.",
        install_hint: "",
        models: &[("accounts/fireworks/models/gpt-oss-120b", "GPT OSS 120B")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Fireworks AI API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "cerebras",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Cerebras",
        description: "Use models through Cerebras Inference.",
        install_hint: "",
        models: &[("gpt-oss-120b", "GPT OSS 120B")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Cerebras API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "mistral",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Mistral",
        description: "Use Mistral models with a La Plateforme API key.",
        install_hint: "",
        models: &[("mistral-large-latest", "Mistral Large"), ("mistral-small-latest", "Mistral Small")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Mistral API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "openrouter",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "OpenRouter",
        description: "Use models through your OpenRouter account. Availability and billing depend on the selected upstream provider.",
        install_hint: "",
        models: &[("openai/gpt-4.1", "GPT-4.1"), ("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "OpenRouter API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "nvidia",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "NVIDIA NIM",
        description: "Use hosted NVIDIA API Catalog models with an NVIDIA API key.",
        install_hint: "",
        models: &[("meta/llama-3.3-70b-instruct", "Llama 3.3 70B")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "NVIDIA NIM API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "siliconflow",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "SiliconFlow",
        description: "Use open models through SiliconFlow's international API.",
        install_hint: "",
        models: &[("Qwen/Qwen2.5-72B-Instruct", "Qwen2.5 72B Instruct")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "SiliconFlow API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "cohere",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Cohere",
        description: "Use Command models through Cohere's OpenAI-compatible API.",
        install_hint: "",
        models: &[("command-a-03-2025", "Command A")],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "api-key",
        setup_label: "Cohere API key",
        setup_description: "Use a metered API key stored by Mivlet's local credential boundary.",
        recommended: false,
    },
    BackendCatalogEntry {
        id: "custom",
        driver_kind: "native-api",
        backend_type: "native-api",
        label: "Custom provider",
        description: "Connect an OpenAI-compatible base URL and model ID with an optional API key.",
        install_hint: "HTTPS is required except for loopback development endpoints.",
        models: &[],
        capabilities: NATIVE_API_CAPS,
        setup_kind: "custom",
        setup_label: "OpenAI-compatible endpoint",
        setup_description: "Use one explicit OpenAI-compatible endpoint.",
        recommended: false,
    },
];

/// Process-scoped fallback credential store. The OS-secure store
/// ([`KeyringStore`]) is primary; this in-memory map is the fallback used when
/// the keychain is unavailable (headless/test builds) and the backing store for
/// existing unit tests. Secrets held here are never serialized into a Tauri
/// response or the runtime snapshot.
pub(super) fn require_supported_provider(provider_id: &str) -> Result<(), String> {
    let normalized = normalize_spaces(provider_id);
    if !SUPPORTED_BACKEND_PROVIDER_IDS.contains(&normalized.as_str()) {
        return Err(format!(
            "{} is not a supported agent-runtime backend.",
            provider_id
        ));
    }
    Ok(())
}

pub(super) fn catalog_entry(provider_id: &str) -> Option<&'static BackendCatalogEntry> {
    CATALOG.iter().find(|entry| entry.id == provider_id)
}

pub(crate) fn native_verification_model(provider_id: &str) -> Option<&'static str> {
    let entry = catalog_entry(provider_id)?;
    (entry.backend_type == "native-api").then_some(entry.models.first()?.0)
}

pub(super) fn validate_backend_secret(secret: &str) -> Result<String, String> {
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
pub(super) fn resolve_auth_state<S: BackendCredentialStore>(
    provider_id: &str,
    store: &S,
) -> String {
    let entry = catalog_entry(provider_id);
    let is_native = entry
        .map(|entry| entry.backend_type == "native-api")
        .unwrap_or(false);
    if is_native && matches!(store.get(provider_id), Ok(Some(_))) {
        return "connected".to_string();
    }

    if matches!(
        entry.map(|candidate| candidate.backend_type),
        Some("claude-agent" | "cursor-acp" | "grok-acp" | "opencode-server")
    ) {
        "unavailable".to_string()
    } else {
        "needs-auth".to_string()
    }
}

/// Build the provider shape served to JavaScript (auth state + caps, no secret).
pub(super) fn build_provider(
    entry: &'static BackendCatalogEntry,
    auth_state: String,
) -> BackendProvider {
    let available = auth_state == "connected";
    let mut models = Vec::with_capacity(entry.models.len().min(MAX_BACKEND_MODELS));
    for (id, label) in entry.models.iter().take(MAX_BACKEND_MODELS) {
        models.push(BackendModel {
            id: (*id).to_string(),
            label: (*label).to_string(),
            available,
            capabilities: None,
            reasoning: None,
            fast_mode: None,
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
        instance_id: entry.id.to_string(),
        driver_kind: entry.driver_kind.to_string(),
        backend_type: entry.backend_type.to_string(),
        label: entry.label.to_string(),
        description: entry.description.to_string(),
        auth_state: safe_auth_state,
        capabilities,
        models,
        setup: ProviderSetup {
            kind: entry.setup_kind.to_string(),
            label: entry.setup_label.to_string(),
            description: entry.setup_description.to_string(),
            recommended: entry.recommended,
        },
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

pub(super) fn validate_catalog_vocabulary() {
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
