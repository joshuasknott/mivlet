//! Passphrase-protected, cross-platform transfer envelopes.
//!
//! This module deliberately owns only the cryptographic/file-format seam. The
//! caller builds an allow-listed, credential-free transfer payload from the
//! native store and performs the import in a destination `Store` transaction.
//! The passphrase never belongs in a Tauri argument or renderer value: callers
//! obtain it through a native masked prompt and pass it directly to these
//! functions.

use std::num::NonZeroU32;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ring::pbkdf2;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const TRANSFER_FORMAT: &str = "mivlet.portable-transfer";
pub const TRANSFER_FORMAT_VERSION: u32 = 1;
pub const PBKDF2_ITERATIONS: u32 = 600_000;
pub const SALT_BYTES: usize = 16;
pub const NONCE_BYTES: usize = 12;
pub const MAX_PASSPHRASE_CHARS: usize = 512;
pub const MIN_PASSPHRASE_CHARS: usize = 12;
pub const MAX_PLAINTEXT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferError {
    InvalidPassphrase,
    InvalidEnvelope,
    UnsupportedFormat,
    TooLarge,
    AuthenticationFailed,
    EncodingFailed,
    RandomnessFailed,
}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidPassphrase => {
                "Choose a passphrase of 12–512 characters without control characters."
            }
            Self::InvalidEnvelope => "The portable transfer file is malformed.",
            Self::UnsupportedFormat => {
                "This portable transfer file is not supported by this Mivlet version."
            }
            Self::TooLarge => "The portable transfer file is larger than Mivlet allows.",
            Self::AuthenticationFailed => {
                "The portable transfer passphrase is wrong or the file was modified."
            }
            Self::EncodingFailed => "Mivlet could not encode the portable transfer.",
            Self::RandomnessFailed => {
                "Mivlet could not create secure portable-transfer randomness."
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    format_version: u32,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    plaintext_bytes: usize,
    /// This flag is an invariant, not a security boundary. The caller must
    /// still build an allow-list and omit credentials/authority before sealing.
    credentials_included: bool,
    active_authority_included: bool,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Aad<'a> {
    format: &'a str,
    format_version: u32,
    kdf: &'a str,
    iterations: u32,
    salt: &'a str,
    nonce: &'a str,
    plaintext_bytes: usize,
    credentials_included: bool,
    active_authority_included: bool,
}

fn valid_passphrase(passphrase: &str) -> bool {
    let length = passphrase.chars().count();
    (MIN_PASSPHRASE_CHARS..=MAX_PASSPHRASE_CHARS).contains(&length)
        && !passphrase.chars().any(char::is_control)
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0_u8; 32]);
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PBKDF2_ITERATIONS).expect("constant is non-zero"),
        salt,
        passphrase.as_bytes(),
        key.as_mut_slice(),
    );
    key
}

fn aad_bytes(envelope: &Envelope) -> Result<Vec<u8>, TransferError> {
    serde_json::to_vec(&Aad {
        format: &envelope.format,
        format_version: envelope.format_version,
        kdf: &envelope.kdf,
        iterations: envelope.iterations,
        salt: &envelope.salt,
        nonce: &envelope.nonce,
        plaintext_bytes: envelope.plaintext_bytes,
        credentials_included: envelope.credentials_included,
        active_authority_included: envelope.active_authority_included,
    })
    .map_err(|_| TransferError::EncodingFailed)
}

fn random<const N: usize>() -> Result<[u8; N], TransferError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| TransferError::RandomnessFailed)?;
    Ok(bytes)
}

/// Encrypt a typed transfer payload. The payload is serialized once, bounded,
/// and authenticated together with the non-secret envelope metadata.
pub fn seal<T: Serialize>(payload: &T, passphrase: &str) -> Result<Vec<u8>, TransferError> {
    if !valid_passphrase(passphrase) {
        return Err(TransferError::InvalidPassphrase);
    }
    let plaintext = serde_json::to_vec(payload).map_err(|_| TransferError::EncodingFailed)?;
    if plaintext.len() > MAX_PLAINTEXT_BYTES {
        return Err(TransferError::TooLarge);
    }
    let salt = random::<SALT_BYTES>()?;
    let nonce = random::<NONCE_BYTES>()?;
    let salt_b64 = BASE64.encode(salt);
    let nonce_b64 = BASE64.encode(nonce);
    let mut envelope = Envelope {
        format: TRANSFER_FORMAT.to_string(),
        format_version: TRANSFER_FORMAT_VERSION,
        kdf: "pbkdf2-hmac-sha256".to_string(),
        iterations: PBKDF2_ITERATIONS,
        salt: salt_b64,
        nonce: nonce_b64,
        plaintext_bytes: plaintext.len(),
        credentials_included: false,
        active_authority_included: false,
        ciphertext: String::new(),
    };
    let aad = aad_bytes(&envelope)?;
    let key = derive_key(passphrase, &salt);
    let cipher =
        Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| TransferError::EncodingFailed)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| TransferError::EncodingFailed)?;
    envelope.ciphertext = BASE64.encode(ciphertext);
    serde_json::to_vec_pretty(&envelope).map_err(|_| TransferError::EncodingFailed)
}

/// Authenticate and decrypt a transfer payload. No plaintext is returned when
/// the header, passphrase, or ciphertext is invalid.
pub fn open<T: DeserializeOwned>(archive: &[u8], passphrase: &str) -> Result<T, TransferError> {
    if !valid_passphrase(passphrase) {
        return Err(TransferError::InvalidPassphrase);
    }
    if archive.len() > MAX_PLAINTEXT_BYTES.saturating_mul(2) {
        return Err(TransferError::TooLarge);
    }
    let envelope: Envelope =
        serde_json::from_slice(archive).map_err(|_| TransferError::InvalidEnvelope)?;
    if envelope.format != TRANSFER_FORMAT
        || envelope.format_version != TRANSFER_FORMAT_VERSION
        || envelope.kdf != "pbkdf2-hmac-sha256"
        || envelope.iterations != PBKDF2_ITERATIONS
        || envelope.credentials_included
        || envelope.active_authority_included
    {
        return Err(TransferError::UnsupportedFormat);
    }
    if envelope.plaintext_bytes > MAX_PLAINTEXT_BYTES {
        return Err(TransferError::TooLarge);
    }
    let salt = BASE64
        .decode(&envelope.salt)
        .map_err(|_| TransferError::InvalidEnvelope)?;
    let nonce = BASE64
        .decode(&envelope.nonce)
        .map_err(|_| TransferError::InvalidEnvelope)?;
    let ciphertext = BASE64
        .decode(&envelope.ciphertext)
        .map_err(|_| TransferError::InvalidEnvelope)?;
    if salt.len() != SALT_BYTES || nonce.len() != NONCE_BYTES || ciphertext.len() < 16 {
        return Err(TransferError::InvalidEnvelope);
    }
    let aad = aad_bytes(&envelope)?;
    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new_from_slice(key.as_slice())
        .map_err(|_| TransferError::AuthenticationFailed)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| TransferError::AuthenticationFailed)?;
    if plaintext.len() != envelope.plaintext_bytes {
        return Err(TransferError::AuthenticationFailed);
    }
    serde_json::from_slice(&plaintext).map_err(|_| TransferError::InvalidEnvelope)
}

/// A stable digest for account/member binding metadata. The raw account id is
/// not included in the transfer header; callers may compare this digest before
/// importing and still keep the archive free of bearer identity material.
pub fn binding_digest(account_binding: &str) -> String {
    format!("{:x}", Sha256::digest(account_binding.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PASSWORD: &str = "correct horse battery staple";

    #[test]
    fn round_trip_uses_a_new_salt_and_nonce() {
        let value = json!({"version": 1, "history": [{"id": "m1", "text": "hello"}]});
        let first = seal(&value, PASSWORD).unwrap();
        let second = seal(&value, PASSWORD).unwrap();
        assert_ne!(first, second);
        assert_eq!(open::<serde_json::Value>(&first, PASSWORD).unwrap(), value);
    }

    #[test]
    fn wrong_passphrase_and_tampering_fail_closed() {
        let archive = seal(&json!({"safe": true}), PASSWORD).unwrap();
        assert_eq!(
            open::<serde_json::Value>(&archive, "wrong password").unwrap_err(),
            TransferError::AuthenticationFailed
        );
        let mut tampered = archive.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(matches!(
            open::<serde_json::Value>(&tampered, PASSWORD),
            Err(TransferError::AuthenticationFailed | TransferError::InvalidEnvelope)
        ));
    }

    #[test]
    fn rejects_authority_flags_even_with_a_valid_passphrase() {
        let mut archive: serde_json::Value =
            serde_json::from_slice(&seal(&json!({"safe": true}), PASSWORD).unwrap()).unwrap();
        archive["activeAuthorityIncluded"] = json!(true);
        let encoded = serde_json::to_vec(&archive).unwrap();
        assert_eq!(
            open::<serde_json::Value>(&encoded, PASSWORD).unwrap_err(),
            TransferError::UnsupportedFormat
        );
    }

    #[test]
    fn rejects_bad_passphrases_and_oversized_declarations() {
        assert_eq!(
            seal(&json!({}), "short").unwrap_err(),
            TransferError::InvalidPassphrase
        );
        assert_eq!(
            open::<serde_json::Value>(b"{}", PASSWORD).unwrap_err(),
            TransferError::InvalidEnvelope
        );
        let mut archive: serde_json::Value =
            serde_json::from_slice(&seal(&json!({}), PASSWORD).unwrap()).unwrap();
        archive["plaintextBytes"] = json!(MAX_PLAINTEXT_BYTES + 1);
        let encoded = serde_json::to_vec(&archive).unwrap();
        assert_eq!(
            open::<serde_json::Value>(&encoded, PASSWORD).unwrap_err(),
            TransferError::TooLarge
        );
    }

    #[test]
    fn binding_digest_is_stable_without_exposing_binding() {
        assert_eq!(
            binding_digest("account-alpha"),
            binding_digest("account-alpha")
        );
        assert_ne!(
            binding_digest("account-alpha"),
            binding_digest("account-beta")
        );
        assert!(!binding_digest("account-alpha").contains("account-alpha"));
    }
}
