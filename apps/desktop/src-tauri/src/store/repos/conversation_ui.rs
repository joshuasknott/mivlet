//! Encrypted conversation-owned UI state, never credentials or execution authority.
//! Thread/workspace deletion cascades, native backups include records, and no
//! plaintext export or remote-sync allowlist includes them.
use super::{open_json, payload_of, scope::PrivateDataScope, seal_json};
use crate::store::{Result, Store};
use rusqlite::{Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

fn aad(scope: &PrivateDataScope, conversation: &str, key: &str) -> String {
    format!(
        "conversation-ui:{}:{}:{conversation}:{key}",
        scope.workspace_id(),
        scope.owner_subject()
    )
}
pub fn get<T: DeserializeOwned>(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    conversation: &str,
    key: &str,
) -> Result<Option<T>> {
    scope.ensure_exists(conn)?;
    let sealed = conn.query_row("SELECT payload,payload_nonce FROM conversation_ui WHERE workspace_id=?1 AND owner_subject=?2 AND conversation_id=?3 AND id=?4", rusqlite::params![scope.workspace_id(),scope.owner_subject(),conversation,key], payload_of).optional()?;
    sealed
        .map(|sealed| {
            serde_json::from_value(open_json(store, &sealed, &aad(scope, conversation, key))?)
                .map_err(|_| {
                    crate::store::StoreError::Invalid(
                        "Invalid conversation interface state.".into(),
                    )
                })
        })
        .transpose()
}
pub fn put<T: Serialize>(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    conversation: &str,
    key: &str,
    value: &T,
) -> Result<()> {
    scope.ensure_exists(conn)?;
    let value = serde_json::to_value(value).map_err(|_| {
        crate::store::StoreError::Invalid("Invalid conversation interface state.".into())
    })?;
    let sealed = seal_json(store, &value, &aad(scope, conversation, key))?;
    conn.execute("INSERT INTO conversation_ui(workspace_id,owner_subject,conversation_id,id,payload,payload_nonce) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(workspace_id,owner_subject,conversation_id,id) DO UPDATE SET payload=excluded.payload,payload_nonce=excluded.payload_nonce", rusqlite::params![scope.workspace_id(),scope.owner_subject(),conversation,key,sealed.ciphertext,sealed.nonce])?;
    Ok(())
}
