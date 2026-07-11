//! Typed repository modules over the encrypted store.
//!
//! Each submodule owns one domain and exposes parameterized, bounded query
//! helpers used by the migration and the Tauri commands. Sensitive free-text is
//! encrypted into a `payload` BLOB via [`Store::seal_payload`]; plaintext
//! columns hold only non-secret ids/enums/timestamps/fingerprints.
//!
//! These modules are the stable interface the knowledge-retrieval and scheduler
//! branches (Goal 8) integrate against.

use rusqlite::Row;
use serde_json::Value;

use crate::store::{Result, Store};

pub mod action_history;
pub mod approval;
pub mod artifact;
pub mod audit_event;
pub mod backend_connection;
pub mod cloud_sync;
pub mod connection_record;
pub mod connector_account;
pub mod connector_cache;
pub mod connector_cache_settings;
pub mod draft;
pub mod goal;
pub mod knowledge_source;
pub mod memory_record;
pub mod message;
pub mod preferences;
pub mod project;
pub mod run;
pub mod run_state;
pub mod schedule;
pub mod scheduled_job;
pub mod scheduler_queue;
pub mod scope;
pub mod thread;
pub mod workflow;
pub mod workspace;
pub mod workspace_directory;

/// Helper: encrypt a JSON value into a sealed payload bound to `aad`.
pub(crate) fn seal_json(
    store: &Store,
    value: &Value,
    aad: &str,
) -> Result<crate::store::vault::Sealed> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| crate::store::StoreError::Invalid("Could not encode record.".into()))?;
    store.seal_payload(&bytes, aad)
}

/// Helper: decrypt a sealed payload back into a JSON value.
pub(crate) fn open_json(
    store: &Store,
    sealed: &crate::store::vault::Sealed,
    aad: &str,
) -> Result<Value> {
    let bytes = store.open_payload(sealed, aad)?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| crate::store::StoreError::Invalid("Could not decode record.".into()))
}

/// Read a single `payload`+`payload_nonce` pair from the current row.
pub(crate) fn payload_of(row: &Row<'_>) -> rusqlite::Result<crate::store::vault::Sealed> {
    Ok(crate::store::vault::Sealed {
        ciphertext: row.get::<_, Vec<u8>>("payload")?,
        nonce: row.get::<_, Vec<u8>>("payload_nonce")?,
    })
}
