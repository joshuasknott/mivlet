//! Separate account-keyed OS custody. There is deliberately no memory fallback
//! and no serializable/debuggable secret type.
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::Failure;

pub(super) struct Secret(Zeroizing<String>);
impl Secret {
    pub(super) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::ops::Deref for Secret {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}

pub(super) trait Custody: Send + Sync {
    fn put(&self, account: &str, id: &str, value: &str) -> Result<(), Failure>;
    fn get(&self, account: &str, id: &str) -> Result<Option<Secret>, Failure>;
    fn remove(&self, account: &str, id: &str) -> Result<(), Failure>;
}

pub(super) struct NativeCustody;

impl NativeCustody {
    fn entry(account: &str, id: &str) -> Result<keyring::Entry, Failure> {
        keyring::Entry::new(
            "com.fable.workspace.protected-secrets",
            &format!(
                "account-{}:{id}",
                hex::encode(Sha256::digest(account.as_bytes()))
            ),
        )
        .map_err(|_| Failure::Custody)
    }
}

impl Custody for NativeCustody {
    fn put(&self, account: &str, id: &str, value: &str) -> Result<(), Failure> {
        Self::entry(account, id)?
            .set_password(value)
            .map_err(|_| Failure::Custody)
    }

    fn get(&self, account: &str, id: &str) -> Result<Option<Secret>, Failure> {
        match Self::entry(account, id)?.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Failure::Custody),
        }
    }

    fn remove(&self, account: &str, id: &str) -> Result<(), Failure> {
        match Self::entry(account, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Failure::Custody),
        }
    }
}
