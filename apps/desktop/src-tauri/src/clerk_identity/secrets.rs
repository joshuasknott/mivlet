//! OS-secure storage for the Clerk identity session.

use super::*;
pub(super) trait IdentitySecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, secret: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

pub(super) struct NativeIdentitySecretStore;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct KeyringChunkManifest {
    generation: String,
    chunks: usize,
    digest: String,
}

pub(super) fn split_keyring_secret(secret: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_units = 0;
    for character in secret.chars() {
        let units = character.len_utf16();
        if current_units > 0 && current_units + units > KEYRING_CHUNK_UTF16_UNITS {
            chunks.push(std::mem::take(&mut current));
            current_units = 0;
        }
        current.push(character);
        current_units += units;
    }
    if !current.is_empty() || secret.is_empty() {
        chunks.push(current);
    }
    chunks
}

pub(super) fn keyring_manifest(value: &str) -> Option<KeyringChunkManifest> {
    let encoded = value.strip_prefix(KEYRING_CHUNK_MANIFEST_PREFIX)?;
    let manifest = serde_json::from_str::<KeyringChunkManifest>(encoded).ok()?;
    let generation_valid = !manifest.generation.is_empty()
        && manifest.generation.len() <= 64
        && manifest
            .generation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    (generation_valid && (1..=KEYRING_MAX_CHUNKS).contains(&manifest.chunks)).then_some(manifest)
}

impl NativeIdentitySecretStore {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|_| "Mivlet could not open the OS secure store.".to_string())
    }

    fn chunk_key(key: &str, generation: &str, index: usize) -> String {
        format!("{key}:chunk:{generation}:{index}")
    }

    fn read_entry(key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Mivlet could not read cloud identity credentials.".to_string()),
        }
    }

    fn write_entry(key: &str, secret: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(secret)
            .map_err(|_| "Mivlet could not store cloud identity credentials.".to_string())
    }

    fn remove_entry(key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Mivlet could not remove cloud identity credentials.".to_string()),
        }
    }

    fn remove_manifest_chunks(key: &str, manifest: &KeyringChunkManifest) -> Result<(), String> {
        for index in 0..manifest.chunks {
            Self::remove_entry(&Self::chunk_key(key, &manifest.generation, index))?;
        }
        Ok(())
    }
}

impl IdentitySecretStore for NativeIdentitySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let Some(value) = Self::read_entry(key)? else {
            return Ok(None);
        };
        let Some(manifest) = keyring_manifest(&value) else {
            return Ok(Some(value));
        };
        let mut secret = String::new();
        for index in 0..manifest.chunks {
            let chunk = Self::read_entry(&Self::chunk_key(key, &manifest.generation, index))?
                .ok_or_else(|| "Mivlet cloud identity credentials were incomplete.".to_string())?;
            secret.push_str(&chunk);
        }
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()));
        if digest != manifest.digest {
            return Err("Mivlet cloud identity credentials failed integrity checking.".to_string());
        }
        Ok(Some(secret))
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), String> {
        let previous_manifest = Self::read_entry(key)?.as_deref().and_then(keyring_manifest);
        let chunks = split_keyring_secret(secret);
        if chunks.len() == 1 {
            Self::write_entry(key, &chunks[0])?;
        } else {
            if chunks.len() > KEYRING_MAX_CHUNKS {
                return Err(
                    "Mivlet cloud identity credentials were unexpectedly large.".to_string()
                );
            }
            let generation = random_urlsafe(12).map_err(|error| error.message)?;
            let manifest = KeyringChunkManifest {
                generation: generation.clone(),
                chunks: chunks.len(),
                digest: URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes())),
            };
            for (index, chunk) in chunks.iter().enumerate() {
                if let Err(error) =
                    Self::write_entry(&Self::chunk_key(key, &generation, index), chunk)
                {
                    for cleanup_index in 0..index {
                        let _ =
                            Self::remove_entry(&Self::chunk_key(key, &generation, cleanup_index));
                    }
                    return Err(error);
                }
            }
            let encoded = serde_json::to_string(&manifest)
                .map_err(|_| "Mivlet could not encode cloud identity storage.".to_string())?;
            if let Err(error) =
                Self::write_entry(key, &format!("{KEYRING_CHUNK_MANIFEST_PREFIX}{encoded}"))
            {
                let _ = Self::remove_manifest_chunks(key, &manifest);
                return Err(error);
            }
        }
        if let Some(previous) = previous_manifest {
            let _ = Self::remove_manifest_chunks(key, &previous);
        }
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        let manifest = Self::read_entry(key)?.as_deref().and_then(keyring_manifest);
        if let Some(manifest) = manifest {
            Self::remove_manifest_chunks(key, &manifest)?;
        }
        Self::remove_entry(key)
    }
}
