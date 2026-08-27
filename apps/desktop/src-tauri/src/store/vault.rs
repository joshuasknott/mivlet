//! Application-layer encryption for the durable local store.
//!
//! See `docs/architecture/encrypted-storage.md`.
//!
//! Each sensitive payload is stored as two columns: a 12-byte random `nonce`
//! and an AES-256-GCM `ciphertext` that authenticates both the plaintext and
//! additional data (`aad`) binding the value to its row identity. This prevents
//! ciphertext block-swapping between rows while keeping SQLite's structural
//! metadata (table/column names, indexes) plaintext — the documented residual
//! metadata trade-off of app-layer encryption.
//!
//! The 32-byte master key is held by [`Vault`] in memory for the process
//! lifetime and sourced from OS secure storage (see [`crate::store::keys`]).
//! The key never persists to the database or the filesystem.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use getrandom;

/// A 32-byte AES-256 master key.
#[derive(Clone)]
pub struct MasterKey([u8; KEY_LEN]);

impl MasterKey {
    /// Expose raw bytes for keyring storage / comparison.
    pub fn to_raw_bytes(&self) -> Vec<u8> {
        self.0.to_vec()
    }

    /// Generate a fresh high-entropy key from the OS CSPRNG.
    pub fn generate() -> Result<Self, VaultError> {
        let mut bytes = [0u8; KEY_LEN];
        fill_random(&mut bytes)?;
        Ok(Self(bytes))
    }

    /// Wrap an existing 32-byte key. Used by [`crate::store::keys`] when the
    /// key already exists in OS secure storage.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// Expose the raw key bytes (only to [`Vault`]).
    fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

/// Errors from the encryption layer. Mapped to user-facing strings at the
/// command boundary; never carries secret material.
#[derive(Debug)]
pub enum VaultError {
    /// Random source failure (extremely rare). Treat as unrecoverable.
    Random,
    /// AEAD encrypt failed.
    Encrypt,
    /// AEAD decrypt failed — wrong key, corrupted ciphertext, or tamper.
    Decrypt,
}

/// The process-level AEAD primitive. Cheap to clone (shares the key).
#[derive(Clone)]
pub struct Vault {
    cipher: Aes256Gcm,
}

/// Length of the AES-256 key and the per-record GCM nonce.
pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;

/// A sealed payload: the (nonce, ciphertext) pair written to the database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

impl Vault {
    /// Build a vault from a master key.
    pub fn new(key: &MasterKey) -> Result<Self, VaultError> {
        let cipher = Aes256Gcm::new_from_slice(key.as_bytes()).map_err(|_| VaultError::Encrypt)?;
        Ok(Self { cipher })
    }

    /// Encrypt `plaintext`, binding it to `aad` (the row identity). Each call
    /// uses a fresh random nonce, so the same plaintext encrypts differently
    /// each time and provides semantic security.
    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Sealed, VaultError> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        fill_random(&mut nonce_bytes)?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| VaultError::Encrypt)?;
        Ok(Sealed {
            nonce: nonce_bytes.to_vec(),
            ciphertext,
        })
    }

    /// Decrypt a [`Sealed`] payload, re-checking the row-binding `aad`. Any
    /// failure (wrong key, corruption, tamper, or AAD mismatch) returns
    /// [`VaultError::Decrypt`]; the caller must fail closed and never surface
    /// partially decrypted data.
    pub fn open(&self, sealed: &Sealed, aad: &[u8]) -> Result<Vec<u8>, VaultError> {
        if sealed.nonce.len() != NONCE_LEN {
            return Err(VaultError::Decrypt);
        }
        let nonce = Nonce::from_slice(&sealed.nonce);
        self.cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &sealed.ciphertext,
                    aad,
                },
            )
            .map_err(|_| VaultError::Decrypt)
    }
}

/// Fill `out` from the OS CSPRNG (wraps `getrandom`).
fn fill_random(out: &mut [u8]) -> Result<(), VaultError> {
    getrandom::fill(out).map_err(|_| VaultError::Random)
}

/// Convert an [`OsError`] surface into a stable string. (Currently aes-gcm
/// surfaces encrypt/decrypt as unit errors; kept for future completeness.)
#[allow(dead_code)]
pub fn os_error_message() -> &'static str {
    "Fable could not use the encryption primitive."
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        Vault::new(&MasterKey::generate().unwrap()).unwrap()
    }

    #[test]
    fn round_trips_plaintext() {
        let v = vault();
        let sealed = v.seal(b"hello world", b"t:row1").unwrap();
        let pt = v.open(&sealed, b"t:row1").unwrap();
        assert_eq!(pt, b"hello world");
    }

    #[test]
    fn same_plaintext_produces_different_ciphertext() {
        let v = vault();
        let a = v.seal(b"same", b"t:r").unwrap();
        let b = v.seal(b"same", b"t:r").unwrap();
        // Fresh nonce per record → distinct ciphertexts.
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn aad_mismatch_is_rejected() {
        let v = vault();
        let sealed = v.seal(b"secret", b"t:row1").unwrap();
        // Swapping the AAD (row identity) must fail — prevents row-swapping.
        assert!(matches!(
            v.open(&sealed, b"t:row2"),
            Err(VaultError::Decrypt)
        ));
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let v = vault();
        let mut sealed = v.seal(b"secret", b"t:row1").unwrap();
        sealed.ciphertext[0] ^= 0xff;
        assert!(matches!(
            v.open(&sealed, b"t:row1"),
            Err(VaultError::Decrypt)
        ));
    }

    #[test]
    fn wrong_key_is_rejected() {
        let v1 = vault();
        let v2 = vault();
        let sealed = v1.seal(b"secret", b"t:row1").unwrap();
        assert!(matches!(
            v2.open(&sealed, b"t:row1"),
            Err(VaultError::Decrypt)
        ));
    }

    #[test]
    fn truncated_nonce_is_rejected() {
        let v = vault();
        let sealed = Sealed {
            nonce: vec![0u8; 5],
            ciphertext: vec![1, 2, 3],
        };
        assert!(matches!(
            v.open(&sealed, b"t:row1"),
            Err(VaultError::Decrypt)
        ));
    }
}
