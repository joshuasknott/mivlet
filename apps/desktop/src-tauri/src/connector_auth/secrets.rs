//! OS-backed credential storage for connector OAuth state and tokens.

const KEYRING_SERVICE: &str = "com.fable.workspace.connectors";

pub(super) trait ConnectorSecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

pub(super) struct NativeConnectorSecretStore;

impl NativeConnectorSecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(
            KEYRING_SERVICE,
            &crate::account_session::credential_key(key)?,
        )
        .map_err(|_| "Mivlet could not open the OS secure store.".to_string())
    }
}

impl ConnectorSecretStore for NativeConnectorSecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Mivlet could not read connector credentials.".to_string()),
        }
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| "Mivlet could not store connector credentials.".to_string())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Mivlet could not remove connector credentials.".to_string()),
        }
    }
}
