//! Master-key lifecycle in OS secure storage.
//!
//! The vault master key is a 32-byte AES-256 key stored under a dedicated
//! keyring service (`com.fable.workspace.vault`), separate from the backend
//! API-key service (`com.fable.workspace`) and the connector OAuth-token
//! service (`com.fable.workspace.connectors`). The key never persists to the
//! database or the filesystem.
//!
//! Lifecycle:
//! - **Fresh install:** no key exists → generate one, store it, proceed.
//! - **Normal launch:** key exists → read it, build the [`Vault`].
//! - **Missing key over an existing vault:** treated as key loss → fail closed
//!   with recoverable guidance (see [`crate::store::recovery`]). Never silently
//!   re-key over unreadable data.

use keyring::Entry;

use super::vault::MasterKey;

/// The dedicated keyring service for the vault master key. Distinct from the
/// backend-key and connector-token services so the vault key's lifecycle is
/// independent.
pub const VAULT_KEYRING_SERVICE: &str = "com.fable.workspace.vault";
/// The keyring entry name (user) for the master key.
pub const VAULT_KEYRING_ENTRY: &str = "master-key";

/// How the master key is encoded in the keyring entry: lowercase hex (64 chars).
/// Hex keeps the value ASCII-safe across all platform keychain backends.
const KEY_HEX_LEN: usize = 64;

/// A handle to OS secure storage for the vault master key. The `mock` backend
/// (in-process, no OS keychain) is used by tests; production uses the
/// platform-native store selected by the `keyring` feature flags.
pub trait KeyStore {
    /// Read the stored key bytes, or `None` if no key is stored.
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    /// Store the given key bytes, replacing any existing value.
    fn set(&self, key: &[u8]) -> Result<(), String>;
}

/// Production key store backed by the OS keychain via `keyring`.
pub struct NativeKeyStore {
    entry: Entry,
}

impl NativeKeyStore {
    pub fn new() -> Result<Self, String> {
        let entry = Entry::new(VAULT_KEYRING_SERVICE, VAULT_KEYRING_ENTRY)
            .map_err(|_| "Fable could not reach the OS credential store.".to_string())?;
        Ok(Self { entry })
    }
}

impl KeyStore for NativeKeyStore {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match self.entry.get_password() {
            Ok(hex) => decode_hex_key(&hex).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Fable could not read the vault key from the credential store.".into()),
        }
    }

    fn set(&self, key: &[u8]) -> Result<(), String> {
        let hex = encode_hex_key(key);
        self.entry
            .set_password(&hex)
            .map_err(|_| "Fable could not store the vault key in the credential store.".into())
    }
}

/// Outcome of opening the key on launch. Drives the recovery UI.
pub enum KeyResolution {
    /// A key existed and was read successfully.
    Existing(MasterKey),
    /// No key existed (fresh install); a new one was generated and stored.
    /// `true` when a fresh key was created, `false` if the key already existed.
    FreshlyCreated(MasterKey),
}

/// Resolve the master key on launch against `store`.
///
/// - If a key exists, return [`KeyResolution::Existing`].
/// - If no key exists, generate one, store it, and return
///   [`KeyResolution::FreshlyCreated`].
///
/// This never overwrites an existing key. To detect "key missing over an
/// existing vault", the caller checks the database existence *before* calling
/// this (see [`crate::store::Store::open`]).
pub fn resolve_or_create(store: &dyn KeyStore) -> Result<KeyResolution, String> {
    match store.get()? {
        Some(bytes) => {
            let key = key_bytes_to_master(&bytes)?;
            Ok(KeyResolution::Existing(key))
        }
        None => {
            let key = MasterKey::generate().map_err(|_| {
                "Fable could not generate an encryption key from the OS random source.".to_string()
            })?;
            store.set(&key.to_raw_bytes())?;
            Ok(KeyResolution::FreshlyCreated(key))
        }
    }
}

/// Resolve a key while enforcing the missing-key-over-existing-database
/// boundary. This is separated for deterministic tests with a mock key store.
pub fn resolve_for_database(
    store: &dyn KeyStore,
    database_exists: bool,
) -> Result<KeyResolution, String> {
    if database_exists && store.get()?.is_none() {
        return Err(
            "Fable's encrypted database exists but its OS-secure key is missing. Restore the key or a matched backup; the database was not overwritten."
                .to_string(),
        );
    }
    resolve_or_create(store)
}

fn key_bytes_to_master(bytes: &[u8]) -> Result<MasterKey, String> {
    let mut arr = [0u8; super::vault::KEY_LEN];
    if bytes.len() != arr.len() {
        return Err("The stored vault key is the wrong length.".into());
    }
    arr.copy_from_slice(bytes);
    Ok(MasterKey::from_bytes(arr))
}

fn encode_hex_key(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

fn decode_hex_key(hex_str: &str) -> Result<Vec<u8>, String> {
    if hex_str.len() != KEY_HEX_LEN {
        return Err("The stored vault key is malformed.".into());
    }
    hex::decode(hex_str).map_err(|_| "The stored vault key is malformed.".into())
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use std::cell::RefCell;

    /// In-memory key store for tests. Never touches the OS keychain.
    pub struct MockKeyStore {
        cell: RefCell<Option<Vec<u8>>>,
    }

    impl MockKeyStore {
        pub fn new() -> Self {
            Self {
                cell: RefCell::new(None),
            }
        }
        pub fn empty() -> Self {
            Self::new()
        }
        pub fn with_key(bytes: Vec<u8>) -> Self {
            Self {
                cell: RefCell::new(Some(bytes)),
            }
        }
    }

    impl Default for MockKeyStore {
        fn default() -> Self {
            Self::new()
        }
    }

    impl KeyStore for MockKeyStore {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.cell.borrow().clone())
        }
        fn set(&self, key: &[u8]) -> Result<(), String> {
            *self.cell.borrow_mut() = Some(key.to_vec());
            Ok(())
        }
    }

    #[test]
    fn resolve_or_create_generates_on_fresh_install() {
        let store = MockKeyStore::empty();
        match resolve_or_create(&store) {
            Ok(KeyResolution::FreshlyCreated(key)) => {
                // The key was persisted.
                assert_eq!(store.get().unwrap().unwrap(), key.to_raw_bytes());
            }
            other => panic!("expected FreshlyCreated, got {:?}", other.is_ok()),
        }
    }

    #[test]
    fn resolve_or_create_reads_existing() {
        let key = MasterKey::generate().unwrap();
        let store = MockKeyStore::with_key(key.to_raw_bytes());
        match resolve_or_create(&store) {
            Ok(KeyResolution::Existing(read)) => {
                assert_eq!(read.to_raw_bytes(), key.to_raw_bytes());
            }
            _ => panic!("expected Existing"),
        }
    }

    #[test]
    fn resolve_or_create_never_overwrites() {
        let key = MasterKey::generate().unwrap();
        let store = MockKeyStore::with_key(key.to_raw_bytes());
        // A second resolve must return the SAME key, not generate a new one.
        match resolve_or_create(&store) {
            Ok(KeyResolution::Existing(read)) => {
                assert_eq!(read.to_raw_bytes(), key.to_raw_bytes());
            }
            _ => panic!("expected Existing"),
        }
    }

    #[test]
    fn existing_database_with_missing_key_fails_without_creating_one() {
        let store = MockKeyStore::empty();
        let error = match resolve_for_database(&store, true) {
            Ok(_) => panic!("missing key must fail"),
            Err(error) => error,
        };
        assert!(error.contains("database exists"));
        assert!(store.get().unwrap().is_none());
    }
}
