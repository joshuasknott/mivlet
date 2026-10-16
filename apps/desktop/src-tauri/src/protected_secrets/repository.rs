//! Nonsecret lifecycle records in the canonical encrypted account store. No SQL
//! migration, replacement conversation store, plaintext file, or credential value.
use serde::{Deserialize, Serialize};

use super::{Failure, Fence, Record, SigningKey};
use crate::store::{
    repos::{preferences, scope::DataScope},
    Store, StoreError,
};

const KEY: &str = "protectedSecretRequests.v1";

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Records {
    pub requests: Vec<Record>,
    pub signing_keys: Vec<SigningKey>,
}

pub(super) fn update<T>(
    store: &Store,
    operation: impl FnOnce(&mut Records) -> Result<T, Failure>,
) -> Result<T, Failure> {
    store
        .transaction(|tx| update_records(tx, store, operation))
        .map_err(|_| Failure::History)?
}

pub(super) fn update_fenced<T>(
    store: &Store,
    fence: &impl Fence,
    operation: impl FnOnce(&mut Records) -> Result<T, Failure>,
) -> Result<T, Failure> {
    fence.check()?;
    store.transaction_with_commit_fence(
        |tx| {
            crate::execution_control::ensure_active_execution_allowed_in(tx, store)
                .map_err(|_| Failure::Stopped)?;
            update_records(tx, store, operation).map_err(Failure::from)
        },
        |tx| fence.commit(|| tx.commit().map_err(|_| Failure::History)),
    )?
}

fn update_records<T>(
    tx: &rusqlite::Transaction<'_>,
    store: &Store,
    operation: impl FnOnce(&mut Records) -> Result<T, Failure>,
) -> crate::store::Result<Result<T, Failure>> {
    let scope = DataScope::legacy_default();
    let mut records: Records = preferences::get_scoped(tx, store, &scope, KEY)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| StoreError::Invalid("Protected request history is unavailable.".into()))?
        .unwrap_or_default();
    // Persist terminal transitions even when the requested operation fails.
    let before = records.clone();
    let result = operation(&mut records);
    if records != before {
        preferences::upsert_scoped(
            tx,
            store,
            &scope,
            KEY,
            &serde_json::to_value(records).map_err(|_| {
                StoreError::Invalid("Protected request history is unavailable.".into())
            })?,
            &chrono::Utc::now().to_rfc3339(),
        )?;
    }
    Ok(result)
}
