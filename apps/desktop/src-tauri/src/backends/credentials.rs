//! Native credential storage and connected-provider persistence.
use super::*;

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
        keyring::Entry::new(
            KEYRING_SERVICE,
            &crate::account_session::credential_key(provider_id)?,
        )
        .map_err(|_| "Mivlet could not open the OS secure store.".to_string())
    }
}

impl BackendCredentialStore for KeyringStore {
    fn get(&self, provider_id: &str) -> Result<Option<String>, String> {
        let entry = Self::entry(provider_id)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(other) => Err(format!(
                "Mivlet could not read the OS secure store: {other}"
            )),
        }
    }

    fn set(&mut self, provider_id: &str, secret: &str) -> Result<(), String> {
        let entry = Self::entry(provider_id)?;
        entry
            .set_password(secret)
            .map_err(|_| "Mivlet could not save to the OS secure store.".to_string())
    }

    fn remove(&mut self, provider_id: &str) -> Result<(), String> {
        let entry = Self::entry(provider_id)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // Nothing to remove is a normal miss, not an unavailable store.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Mivlet could not clear the OS secure store.".to_string()),
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

pub(crate) fn connected_providers_for(internal_user_id: &str) -> Result<Vec<String>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| crate::store::repos::backend_connection::list(tx, internal_user_id))
        .map_err(|error| error.to_string())
}

pub(crate) fn record_connected_provider(
    internal_user_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    store
        .transaction(|tx| {
            crate::store::repos::backend_connection::upsert(tx, internal_user_id, provider_id, &now)
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn remove_connected_provider(
    internal_user_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
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

pub(super) fn scoped_credential_key(internal_user_id: &str, provider_id: &str) -> String {
    let digest = Sha256::digest(internal_user_id.as_bytes());
    format!("account-{:x}:{provider_id}", digest)
}

pub(crate) fn require_current_internal_user() -> Result<String, String> {
    crate::account_session::ensure_current()?;
    Ok(crate::account_session::principals()?.0)
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
            .map_err(|_| "Mivlet could not acquire the credential store.".to_string())?;
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
            .map_err(|_| "Mivlet could not acquire the credential store.".to_string())?;
        BackendCredentialStore::remove(&mut *store, &scoped_key)?;
        Ok(())
    }
}

fn log_pre_release_warning_once() {
    PRE_RELEASE_WARNING_LOGGED.get_or_init(|| {
        if BACKENDS_PRE_RELEASE {
            eprintln!(
                "mivlet: backend credential storage is PRE-RELEASE. Secrets are held in the \
                 OS secure store (with a process-scoped fallback). Do not ship pre-release."
            );
        }
    });
}

/// Validate a provider id against the supported catalog.
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
        .map_err(|_| "Mivlet could not read connected backends.".to_string())?;

    if contents.trim().is_empty() {
        return Ok(ConnectedBackends::default());
    }

    let parsed: BTreeSet<String> = serde_json::from_str(&contents)
        .map_err(|_| "Mivlet could not parse connected backends.".to_string())?;

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
        .map_err(|_| "Mivlet could not encode connected backends.".to_string())?;
    fs::write(path, encoded).map_err(|_| "Mivlet could not save connected backends.".to_string())
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
