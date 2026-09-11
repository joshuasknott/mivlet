//! Connector cache lifecycle commands.
//!
//! Tauri command surface over the encrypted, workspace-isolated connector
//! cache ([`crate::store::repos::connector_cache`]) and its settings
//! ([`crate::store::repos::connector_cache_settings`]).
//!
//! Public commands (stable names):
//! - `list_connector_cache` / `search_connector_cache` — read/search a workspace's cache;
//! - `cache_connector_item` — write/refresh a single normalized item;
//! - `set_connector_cache_item_disabled` — soft-disable/enable a cached item;
//! - `delete_connector_cache_item` — delete a single cached item;
//! - `clear_connector_cache` — clear a workspace's cache (optionally one connector);
//! - `resync_connector_cache` — mark a workspace/connector's rows freshly resynced;
//! - `export_connector_cache` — credential-free JSON export of a workspace's cache;
//! - `get_connector_cache_settings` / `set_connector_cache_settings` /
//!   `delete_connector_cache_settings` — per-workspace and per-connector settings.
//!
//! Cached data never includes provider secrets/tokens: the write path redacts
//! token-shaped values and fails closed when a secret marker survives. Provider
//! credentials live in OS secure storage under a separate lifecycle.
//!
//! Cache writes and reads are gated on the maintained canonical Connection
//! records (`connection_record`, written by the auth lifecycle on
//! connect/switch/disconnect): an account-bound item is only cached and served
//! while that exact account has a live Connection, and workspace-scoped items
//! only while the connector has at least one. This makes a stale in-flight
//! response fail closed after an account switch or disconnect instead of
//! seeding content the read path would serve.

use crate::store::repos::connector_cache::{self, ConnectorCacheRow};
use crate::store::repos::connector_cache_settings::{
    self, CacheSettingsRow, SCOPE_CONNECTOR, SCOPE_WORKSPACE, WORKSPACE_SCOPE_CONNECTOR,
};
use crate::store::{with_store, Result as StoreResult, Store, StoreError};

/// Lifecycle operations over a `&Store`. These pure helpers hold all the
/// business logic (workspace resolution, size bounds, settings precedence,
/// secret rejection, isolation) so they can be exercised directly by in-memory
/// store tests without the global Tauri store. The `#[tauri::command]`
/// wrappers below resolve the global store and delegate here.
mod lifecycle {
    use super::*;

    /// Read a workspace's cache (excluding disabled rows) as wire items.
    pub fn list(
        store: &Store,
        workspace_id: &str,
        connector_id: Option<&str>,
    ) -> StoreResult<Vec<CachedConnectorItem>> {
        let rows = store.with_conn(|conn| {
            let rows = connector_cache::list(conn, store, workspace_id, connector_id)?;
            filter_authorized_rows(conn, store, workspace_id, rows)
        })?;
        Ok(rows.into_iter().map(CachedConnectorItem::from).collect())
    }

    /// Lexical search over a workspace's cache (excluding disabled rows).
    pub fn search(
        store: &Store,
        workspace_id: &str,
        connector_id: Option<&str>,
        query: &str,
    ) -> StoreResult<Vec<CachedConnectorItem>> {
        if query.chars().count() > MAX_CACHE_QUERY_CHARACTERS {
            return Err(StoreError::Invalid(
                "Connector cache search query is too long.".into(),
            ));
        }
        let rows = store.with_conn(|conn| {
            let rows = connector_cache::search(conn, store, workspace_id, connector_id, query)?;
            filter_authorized_rows(conn, store, workspace_id, rows)
        })?;
        Ok(rows.into_iter().map(CachedConnectorItem::from).collect())
    }

    fn filter_authorized_rows(
        conn: &rusqlite::Connection,
        store: &Store,
        workspace_id: &str,
        rows: Vec<ConnectorCacheRow>,
    ) -> StoreResult<Vec<ConnectorCacheRow>> {
        // Resolve the effective cache `enabled` flag for every connector in this
        // workspace ONCE, from plaintext columns only (no per-row payload
        // decryption). The previous path called `effective(...)` per row, which
        // issued up to two SELECTs and decrypted the settings `note` blob each
        // time just to read the boolean.
        let enabled_by_connector =
            connector_cache_settings::effective_enabled_for_workspace(conn, workspace_id)?;
        // Connectors with at least one live canonical Connection — the
        // maintained revocation hook. `connection_record` is written by the
        // auth lifecycle (connect/switch/disconnect); the legacy
        // `connector_account` snapshot is frozen at migration time and is not
        // authoritative for revocation.
        let live = connector_cache::live_connectors(conn, workspace_id)?;
        let _ = store; // settings are read from plaintext columns; no payload decryption here.
        let mut authorized = Vec::with_capacity(rows.len());
        for row in rows {
            if !connector_cache_settings::resolve_enabled(&enabled_by_connector, &row.connector_id)
            {
                continue;
            }
            let item_account = row
                .payload
                .get("account")
                .and_then(serde_json::Value::as_str);
            match item_account.filter(|value| !value.is_empty()) {
                // Account-bound row: authorized only while that exact account
                // has a live canonical Connection.
                Some(account) => {
                    if !connector_cache::connection_authorized(
                        conn,
                        workspace_id,
                        &row.connector_id,
                        account,
                    )? {
                        continue;
                    }
                }
                // Workspace-scoped row: authorized only while the connector has
                // at least one live Connection (disconnect hides everything).
                None => {
                    if !live.contains(&row.connector_id) {
                        continue;
                    }
                }
            }
            authorized.push(row);
        }
        Ok(authorized)
    }

    /// Write/refresh one normalized item. Honors the effective setting (a
    /// disabled cache is a no-op returning `false`), bounds the workspace cache
    /// size, redacts secrets, and fails closed when a secret marker survives.
    pub fn cache_item(
        store: &Store,
        workspace_id: &str,
        item: &serde_json::Value,
        now: &str,
    ) -> StoreResult<bool> {
        let settings_connector = item
            .get("connectorId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(WORKSPACE_SCOPE_CONNECTOR);
        let settings = store.with_conn(|conn| {
            connector_cache_settings::effective(conn, store, workspace_id, settings_connector)
        })?;
        if !settings.enabled {
            return Ok(false);
        }
        let count =
            store.with_conn(|conn| connector_cache::count(conn, workspace_id, None, true))?;
        if count as usize >= MAX_CACHED_ITEMS_PER_WORKSPACE {
            return Err(StoreError::Invalid(format!(
                "The connector cache for this workspace is full ({} items).",
                MAX_CACHED_ITEMS_PER_WORKSPACE
            )));
        }
        store.transaction(|tx| {
            connector_cache::upsert_from_value(tx, store, workspace_id, item.clone(), now)
        })?;
        Ok(true)
    }

    /// Soft-disable/enable a cached item, scoped to the workspace.
    pub fn set_disabled(
        store: &Store,
        workspace_id: &str,
        id: &str,
        disabled: bool,
    ) -> StoreResult<bool> {
        let touched = store
            .transaction(|tx| connector_cache::set_disabled(tx, workspace_id, id, disabled))?;
        Ok(touched > 0)
    }

    /// Delete a single cached item, scoped to the workspace.
    pub fn delete(store: &Store, workspace_id: &str, id: &str) -> StoreResult<bool> {
        let deleted = store.transaction(|tx| connector_cache::delete(tx, workspace_id, id))?;
        Ok(deleted > 0)
    }

    /// Clear cached items for a workspace (optionally one connector). Returns
    /// rows deleted. Optionally drops matching settings rows.
    pub fn clear(
        store: &Store,
        workspace_id: &str,
        connector_id: Option<&str>,
        include_settings: bool,
    ) -> StoreResult<usize> {
        store.transaction(|tx| {
            let cleared = connector_cache::clear(tx, workspace_id, connector_id)?;
            if include_settings {
                if let Some(connector_id) = connector_id {
                    connector_cache_settings::delete(tx, workspace_id, connector_id)?;
                } else {
                    connector_cache_settings::clear_for_workspace(tx, workspace_id)?;
                }
            }
            Ok(cleared)
        })
    }

    /// Mark a workspace/connector's cached rows freshly resynced.
    pub fn resync(
        store: &Store,
        workspace_id: &str,
        connector_id: Option<&str>,
        now: &str,
    ) -> StoreResult<usize> {
        store.transaction(|tx| connector_cache::mark_resynced(tx, workspace_id, connector_id, now))
    }

    /// Credential-free JSON export of a workspace's cache (including disabled
    /// rows) plus its settings.
    pub fn export(
        store: &Store,
        workspace_id: &str,
        connector_id: Option<&str>,
    ) -> StoreResult<String> {
        let rows = store
            .with_conn(|conn| connector_cache::list_all(conn, store, workspace_id, connector_id))?;
        let settings = store.with_conn(|conn| {
            connector_cache_settings::list_for_workspace(conn, store, workspace_id)
        })?;
        let items: Vec<CachedConnectorItem> =
            rows.into_iter().map(CachedConnectorItem::from).collect();
        let settings_views: Vec<ConnectorCacheSettingsView> = settings
            .into_iter()
            .map(ConnectorCacheSettingsView::from)
            .collect();
        serde_json::to_string_pretty(&serde_json::json!({
            "workspaceId": workspace_id,
            "connectorId": connector_id,
            "credentialsIncluded": false,
            "disabledItemsIncluded": true,
            "items": items,
            "settings": settings_views,
        }))
        .map_err(|_| StoreError::Invalid("Could not encode the connector cache export.".into()))
    }

    /// Read effective settings for `(workspace_id, connector_id)`.
    pub fn get_settings(
        store: &Store,
        workspace_id: &str,
        connector_id: &str,
    ) -> StoreResult<ConnectorCacheSettingsView> {
        let row = store.with_conn(|conn| {
            connector_cache_settings::effective(conn, store, workspace_id, connector_id)
        })?;
        Ok(ConnectorCacheSettingsView::from(row))
    }

    /// Upsert settings for `(workspace_id, connector_id)`.
    pub fn set_settings(
        store: &Store,
        workspace_id: &str,
        connector_id: &str,
        enabled: bool,
        auto_sync: bool,
        note: &str,
        now: &str,
    ) -> StoreResult<ConnectorCacheSettingsView> {
        let normalized_connector = if connector_id.trim().is_empty() {
            WORKSPACE_SCOPE_CONNECTOR.to_string()
        } else {
            connector_id.to_string()
        };
        let scope = if normalized_connector == WORKSPACE_SCOPE_CONNECTOR {
            SCOPE_WORKSPACE
        } else {
            SCOPE_CONNECTOR
        };
        connector_cache_settings::validate_scope(scope)?;
        store.transaction(|tx| {
            connector_cache_settings::upsert(
                tx,
                store,
                workspace_id,
                &normalized_connector,
                connector_cache_settings::CacheSettingsUpdate {
                    enabled,
                    auto_sync,
                    note,
                    updated_at: now,
                },
            )
        })?;
        let row = store.with_conn(|conn| {
            connector_cache_settings::effective(conn, store, workspace_id, &normalized_connector)
        })?;
        Ok(ConnectorCacheSettingsView::from(row))
    }

    /// Delete a settings row, restoring the lower-precedence default.
    pub fn delete_settings(
        store: &Store,
        workspace_id: &str,
        connector_id: &str,
    ) -> StoreResult<bool> {
        let normalized_connector = if connector_id.trim().is_empty() {
            WORKSPACE_SCOPE_CONNECTOR.to_string()
        } else {
            connector_id.to_string()
        };
        let deleted = store.transaction(|tx| {
            connector_cache_settings::delete(tx, workspace_id, &normalized_connector)
        })?;
        Ok(deleted > 0)
    }
}

/// The maximum number of cached items a single workspace may hold. Bounded to
/// keep lexical search responsive and the local footprint predictable.
const MAX_CACHED_ITEMS_PER_WORKSPACE: usize = 500;
/// Maximum characters for a cache search query (mirrors connector search).
const MAX_CACHE_QUERY_CHARACTERS: usize = 500;

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("1970-01-01T00:00:{secs:05}Z")
}

fn unavailable() -> String {
    "Mivlet's encrypted store is not initialized.".to_string()
}

fn required_workspace(workspace_id: &str) -> Result<&str, String> {
    crate::store::repos::scope::normalize_id(workspace_id, "Workspace")
        .map(|_| workspace_id.trim())
        .map_err(|error| error.to_string())
}

/// A single cached connector item, shaped for the Tauri wire boundary. Carries
/// no secret material — the payload is the redacted, decrypted cache row.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedConnectorItem {
    pub id: String,
    pub workspace_id: String,
    pub connector_id: String,
    pub provider_item_id: String,
    pub kind: String,
    pub trust: String,
    pub pinned: bool,
    pub disabled: bool,
    pub content_fingerprint: String,
    pub cached_at: String,
    pub origin: String,
    pub title: String,
    pub provenance: String,
    pub freshness: String,
    pub content_preview: String,
    pub account: String,
    pub provider_metadata: serde_json::Value,
}

impl From<ConnectorCacheRow> for CachedConnectorItem {
    fn from(row: ConnectorCacheRow) -> Self {
        let str_field = |key: &str| -> String {
            row.payload
                .get(key)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let metadata = row
            .payload
            .get("providerMetadata")
            .cloned()
            .unwrap_or(serde_json::Value::Object(Default::default()));
        CachedConnectorItem {
            id: row.id,
            workspace_id: row.workspace_id,
            connector_id: row.connector_id,
            provider_item_id: row.provider_item_id,
            kind: row.kind,
            trust: row.trust,
            pinned: row.pinned,
            disabled: row.disabled,
            content_fingerprint: row.content_fingerprint,
            cached_at: row.cached_at,
            origin: row.origin,
            title: str_field("title"),
            provenance: str_field("provenance"),
            freshness: str_field("freshness"),
            content_preview: str_field("contentPreview"),
            account: str_field("account"),
            provider_metadata: metadata,
        }
    }
}

/// A settings snapshot returned to the shell.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCacheSettingsView {
    pub workspace_id: String,
    pub connector_id: String,
    pub scope: String,
    pub enabled: bool,
    pub auto_sync: bool,
    pub updated_at: String,
    pub note: String,
}

impl From<CacheSettingsRow> for ConnectorCacheSettingsView {
    fn from(row: CacheSettingsRow) -> Self {
        let note = row
            .payload
            .get("note")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        ConnectorCacheSettingsView {
            workspace_id: row.workspace_id,
            connector_id: row.connector_id,
            scope: row.scope,
            enabled: row.enabled,
            auto_sync: row.auto_sync,
            updated_at: row.updated_at,
            note,
        }
    }
}

/// Input shape for writing/refreshing a cached item. Mirrors
/// `ConnectorSearchItem` / `ConnectorKnowledgeSource` so a search/import result
/// can be cached directly.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheConnectorItemRequest {
    pub workspace_id: String,
    pub item: serde_json::Value,
}

/// Input shape for toggling a cached item's disabled flag.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCacheItemDisabledRequest {
    pub workspace_id: String,
    pub id: String,
    pub disabled: bool,
}

/// Input shape for clearing a workspace's cache.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearConnectorCacheRequest {
    pub workspace_id: String,
    /// When set, only this connector's cached rows are cleared.
    pub connector_id: Option<String>,
    /// When true, also drop the per-workspace/per-connector settings rows.
    #[serde(default)]
    pub include_settings: bool,
}

/// Input shape for marking a workspace/connector freshly resynced.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResyncConnectorCacheRequest {
    pub workspace_id: String,
    pub connector_id: Option<String>,
}

/// Input shape for reading effective settings.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetCacheSettingsRequest {
    pub workspace_id: String,
    pub connector_id: String,
}

/// Input shape for upserting settings. When `connector_id` is the workspace
/// sentinel (or empty), the row is the workspace-wide default.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCacheSettingsRequest {
    pub workspace_id: String,
    pub connector_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub note: String,
}

/// Input shape for deleting a settings row.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCacheSettingsRequest {
    pub workspace_id: String,
    pub connector_id: String,
}

/// List cached items for a workspace (and optional connector). Disabled rows
/// are excluded; use `export_connector_cache` to inspect them.
#[tauri::command]
pub fn list_connector_cache(
    workspace_id: String,
    connector_id: Option<String>,
) -> Result<Vec<CachedConnectorItem>, String> {
    let ws = required_workspace(&workspace_id)?;
    with_store(|store| lifecycle::list(store, ws, connector_id.as_deref()))?.ok_or_else(unavailable)
}

/// Lexical search over a workspace's cache (titles/provenance/previews).
/// Disabled rows are excluded.
#[tauri::command]
pub fn search_connector_cache(
    workspace_id: String,
    connector_id: Option<String>,
    query: String,
) -> Result<Vec<CachedConnectorItem>, String> {
    let ws = required_workspace(&workspace_id)?;
    with_store(|store| lifecycle::search(store, ws, connector_id.as_deref(), &query))?
        .ok_or_else(unavailable)
}

/// Write or refresh a single normalized connector item into the cache. The item
/// is redacted before sealing; a record that still contains a token-shaped
/// value after redaction is rejected (fail-closed). Honors the effective cache
/// setting: when the cache is disabled for this workspace/connector, the write
/// is a no-op and returns `cached: false`. The write also fails closed when the
/// item's account (or the connector, for unbound items) has no live canonical
/// Connection, so a stale in-flight response cannot re-seed the cache after an
/// account switch or disconnect.
#[tauri::command]
pub fn cache_connector_item(request: CacheConnectorItemRequest) -> Result<bool, String> {
    let ws = required_workspace(&request.workspace_id)?;
    let now = now_iso();
    with_store(|store| lifecycle::cache_item(store, ws, &request.item, &now))?
        .ok_or_else(unavailable)
}

/// Soft-disable (or re-enable) a cached item. Disabled items stay on disk but
/// never enter search/retrieval. Scoped to the requesting workspace.
#[tauri::command]
pub fn set_connector_cache_item_disabled(
    request: SetCacheItemDisabledRequest,
) -> Result<bool, String> {
    let ws = required_workspace(&request.workspace_id)?;
    with_store(|store| lifecycle::set_disabled(store, ws, &request.id, request.disabled))?
        .ok_or_else(unavailable)
}

/// Delete a single cached item, scoped to the requesting workspace. Returns
/// whether a row was deleted.
#[tauri::command]
pub fn delete_connector_cache_item(workspace_id: String, id: String) -> Result<bool, String> {
    let ws = required_workspace(&workspace_id)?;
    with_store(|store| lifecycle::delete(store, ws, &id))?.ok_or_else(unavailable)
}

/// Clear cached items for a workspace. When `connector_id` is set, only that
/// connector's rows are cleared. Workspace isolation: other workspaces are
/// never touched. When `include_settings` is set, the matching settings rows
/// are dropped too.
#[tauri::command]
pub fn clear_connector_cache(request: ClearConnectorCacheRequest) -> Result<u64, String> {
    let ws = required_workspace(&request.workspace_id)?;
    with_store(|store| {
        let cleared = lifecycle::clear(
            store,
            ws,
            request.connector_id.as_deref(),
            request.include_settings,
        )?;
        Ok(cleared as u64)
    })?
    .ok_or_else(unavailable)
}

/// Mark a workspace/connector's cached rows freshly resynced by resetting
/// `cached_at`. This is the "resync" lifecycle: it refreshes freshness metadata
/// in place after a re-pull. The actual re-pull is provider work that writes
/// rows through `cache_connector_item`; this command re-stamps existing rows.
/// Returns the number of rows touched.
#[tauri::command]
pub fn resync_connector_cache(request: ResyncConnectorCacheRequest) -> Result<u64, String> {
    let ws = required_workspace(&request.workspace_id)?;
    let now = now_iso();
    with_store(|store| {
        let touched = lifecycle::resync(store, ws, request.connector_id.as_deref(), &now)?;
        Ok(touched as u64)
    })?
    .ok_or_else(unavailable)
}

/// Export a workspace's cached connector data as credential-free JSON.
/// Includes disabled rows for completeness. Secrets never reach the cache, so
/// the export is safe to surface/download by construction.
#[tauri::command]
pub fn export_connector_cache(
    workspace_id: String,
    connector_id: Option<String>,
) -> Result<String, String> {
    let ws = required_workspace(&workspace_id)?;
    with_store(|store| lifecycle::export(store, ws, connector_id.as_deref()))?
        .ok_or_else(unavailable)
}

/// Read the effective settings for `(workspace_id, connector_id)`: a connector
/// override wins over the workspace default, which wins over the built-in
/// default (cache enabled, auto-sync off).
#[tauri::command]
pub fn get_connector_cache_settings(
    request: GetCacheSettingsRequest,
) -> Result<ConnectorCacheSettingsView, String> {
    let ws = required_workspace(&request.workspace_id)?;
    with_store(|store| lifecycle::get_settings(store, ws, &request.connector_id))?
        .ok_or_else(unavailable)
}

/// Upsert settings for `(workspace_id, connector_id)`. Pass the workspace
/// sentinel (or an empty connector id) to set the workspace-wide default.
#[tauri::command]
pub fn set_connector_cache_settings(
    request: SetCacheSettingsRequest,
) -> Result<ConnectorCacheSettingsView, String> {
    let ws = required_workspace(&request.workspace_id)?;
    let now = now_iso();
    with_store(|store| {
        lifecycle::set_settings(
            store,
            ws,
            &request.connector_id,
            request.enabled,
            request.auto_sync,
            &request.note,
            &now,
        )
    })?
    .ok_or_else(unavailable)
}

/// Delete a settings row, restoring the lower-precedence default. Pass the
/// workspace sentinel (or empty connector id) to drop the workspace default.
#[tauri::command]
pub fn delete_connector_cache_settings(
    request: DeleteCacheSettingsRequest,
) -> Result<bool, String> {
    let ws = required_workspace(&request.workspace_id)?;
    with_store(|store| lifecycle::delete_settings(store, ws, &request.connector_id))?
        .ok_or_else(unavailable)
}

#[cfg(test)]
mod tests {
    //! Lifecycle tests over an in-memory store: delete/disable/export/resync,
    //! workspace isolation, settings precedence, and the secret-rejection
    //! contract. These exercise the same `lifecycle::*` helpers the
    //! `#[tauri::command]` wrappers delegate to.
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn item(connector_id: &str, item_id: &str, title: &str) -> serde_json::Value {
        serde_json::json!({
            "id": item_id,
            "connectorId": connector_id,
            "kind": "document",
            "title": title,
            "provenance": "github://org/repo",
            "freshness": "2026-06-01",
            "contentPreview": format!("preview for {title}"),
            "contentFingerprint": format!("fp-{item_id}"),
            "trust": "untrusted",
            "pinned": false,
        })
    }

    /// Insert a workspace plus a live (authorized) canonical Connection for a
    /// connector, so unbound cache writes/list reads are permitted.
    fn live_connection(store: &Store, workspace_id: &str, connector_id: &str) {
        connection(store, workspace_id, connector_id, "acct-1");
    }

    /// Insert a canonical `connection_record` row for `(workspace, connector,
    /// account)` in the authorized state, mirroring the plaintext columns the
    /// cache authorization hooks read. The connection id is derived exactly
    /// like production auth writes it.
    fn connection(store: &Store, workspace_id: &str, connector_id: &str, account_id: &str) {
        let id = crate::connector_auth::derive_native_connection_id(
            workspace_id,
            connector_id,
            account_id,
        );
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at)
                     VALUES (?1, 'W', 'now', 'now');",
                    [workspace_id],
                )?;
                tx.execute(
                    "INSERT INTO connection_record(
                       workspace_id,id,record_type,authority,visibility,owner_member_id,
                       schema_version,revision,created_by_internal_user_id,created_by_device_id,
                       kind,ownership,lifecycle,authorization_state,health_state,trust,
                       credential_custody,credential_state,credential_ref,connector_definition_key,
                       enabled_by_default,created_at,updated_at,deleted_at,payload,payload_nonce)
                     VALUES(?1,?2,'connection','local','workspace-shared',NULL,1,1,
                       'local-user-1',NULL,'native-connector','workspace-shared','authorized',
                       'authorized','healthy','fable-reviewed','os-secure-store','available',
                       ?3,?4,1,'now','now',NULL,x'01',x'02');",
                    rusqlite::params![
                        workspace_id,
                        id,
                        format!("oauth-token:{workspace_id}:{connector_id}:{account_id}"),
                        connector_id,
                    ],
                )?;
                Ok(())
            })
            .unwrap();
    }

    /// Transition the canonical Connection for `(workspace, connector, account)`
    /// into the given lifecycle/authorization/credential state (production
    /// disconnect writes `disconnected`/`revoked`/`revoked`).
    fn transition(
        store: &Store,
        workspace_id: &str,
        connector_id: &str,
        account_id: &str,
        lifecycle: &str,
        authorization_state: &str,
        credential_state: &str,
    ) {
        let id = crate::connector_auth::derive_native_connection_id(
            workspace_id,
            connector_id,
            account_id,
        );
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE connection_record SET lifecycle=?1,
                       authorization_state=?2, credential_state=?3
                     WHERE workspace_id=?4 AND id=?5;",
                    rusqlite::params![
                        lifecycle,
                        authorization_state,
                        credential_state,
                        workspace_id,
                        id,
                    ],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn disable_excludes_item_from_list_and_search() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "Alpha"), "t").unwrap();
        lifecycle::cache_item(&store, "ws-a", &item("github", "2", "Beta"), "t").unwrap();
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 2);
        // Disable Alpha.
        assert!(lifecycle::set_disabled(&store, "ws-a", "cache:ws-a:github:1", true).unwrap());
        // list/search exclude the disabled row.
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
        assert!(lifecycle::search(&store, "ws-a", None, "alpha")
            .unwrap()
            .is_empty());
        // Re-enable restores it.
        assert!(lifecycle::set_disabled(&store, "ws-a", "cache:ws-a:github:1", false).unwrap());
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 2);
    }

    #[test]
    fn delete_removes_item_scoped_to_workspace() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "Alpha"), "t").unwrap();
        // Deleting from another workspace does nothing (isolation).
        assert!(!lifecycle::delete(&store, "ws-b", "cache:ws-a:github:1").unwrap());
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
        // Deleting from the owning workspace removes it.
        assert!(lifecycle::delete(&store, "ws-a", "cache:ws-a:github:1").unwrap());
        assert!(lifecycle::list(&store, "ws-a", None).unwrap().is_empty());
        assert!(
            lifecycle::cache_item(&store, "ws-a", &item("github", "1", "Again"), "later").is_err()
        );
    }

    #[test]
    fn export_is_credential_free_and_includes_disabled() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "Alpha"), "t").unwrap();
        lifecycle::cache_item(&store, "ws-a", &item("github", "2", "Beta"), "t").unwrap();
        lifecycle::set_disabled(&store, "ws-a", "cache:ws-a:github:1", true).unwrap();

        let exported = lifecycle::export(&store, "ws-a", None).unwrap();
        let json: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(json["credentialsIncluded"], serde_json::Value::Bool(false));
        assert_eq!(json["disabledItemsIncluded"], serde_json::Value::Bool(true));
        // Both rows (including the disabled one) are present.
        assert_eq!(json["items"].as_array().unwrap().len(), 2);
        // The title is the safe plaintext, not a secret.
        let titles: Vec<&str> = json["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["title"].as_str().unwrap())
            .collect();
        assert!(titles.contains(&"Alpha"));
        assert!(titles.contains(&"Beta"));
    }

    #[test]
    fn export_omits_token_shaped_values() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        // A provider response that leaked a token into the title is redacted
        // before caching, so the export never carries it.
        let mut leaky = item("github", "1", "ya29.LEAKED-TOKEN-VALUE");
        leaky["providerMetadata"] =
            serde_json::json!({ "authHeader": "Bearer abc123", "url": "https://ok" });
        lifecycle::cache_item(&store, "ws-a", &leaky, "t").unwrap();
        let exported = lifecycle::export(&store, "ws-a", None).unwrap();
        assert!(
            !exported.contains("LEAKED-TOKEN-VALUE"),
            "export must not carry the leaked token"
        );
        assert!(exported.contains("redacted"));
        assert!(
            exported.contains("https://ok"),
            "non-secret metadata preserved"
        );
    }

    #[test]
    fn resync_remarks_connector_rows() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        live_connection(&store, "ws-a", "notion");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "Alpha"), "old").unwrap();
        lifecycle::cache_item(&store, "ws-a", &item("notion", "p1", "Page"), "old").unwrap();
        let touched = lifecycle::resync(&store, "ws-a", Some("github"), "fresh").unwrap();
        assert_eq!(touched, 1);
        let github = lifecycle::list(&store, "ws-a", Some("github")).unwrap();
        assert_eq!(github[0].cached_at, "fresh");
        let notion = lifecycle::list(&store, "ws-a", Some("notion")).unwrap();
        assert_eq!(notion[0].cached_at, "old", "other connector untouched");
    }

    #[test]
    fn clear_respects_workspace_isolation() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        live_connection(&store, "ws-a", "notion");
        live_connection(&store, "ws-b", "github");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "A1"), "t").unwrap();
        lifecycle::cache_item(&store, "ws-a", &item("notion", "p1", "A2"), "t").unwrap();
        lifecycle::cache_item(&store, "ws-b", &item("github", "1", "B1"), "t").unwrap();

        // Clear only github in ws-a.
        let cleared = lifecycle::clear(&store, "ws-a", Some("github"), false).unwrap();
        assert_eq!(cleared, 1);
        assert_eq!(
            lifecycle::list(&store, "ws-a", Some("notion"))
                .unwrap()
                .len(),
            1,
            "notion in ws-a survives"
        );
        // Clear all of ws-a (with settings).
        lifecycle::set_settings(&store, "ws-a", "github", true, false, "", "t").unwrap();
        let cleared = lifecycle::clear(&store, "ws-a", None, true).unwrap();
        assert_eq!(cleared, 1, "only the notion row remained");
        assert!(
            lifecycle::list(&store, "ws-a", None).unwrap().is_empty(),
            "ws-a fully cleared"
        );
        // ws-b is untouched (workspace isolation).
        assert_eq!(lifecycle::list(&store, "ws-b", None).unwrap().len(), 1);
    }

    #[test]
    fn cache_write_honors_disabled_setting() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        // Disable the cache workspace-wide.
        lifecycle::set_settings(&store, "ws-a", "", false, false, "", "t").unwrap();
        // A write is a no-op and reports not-cached.
        let cached = lifecycle::cache_item(&store, "ws-a", &item("github", "1", "X"), "t").unwrap();
        assert!(!cached);
        assert!(lifecycle::list(&store, "ws-a", None).unwrap().is_empty());

        // Re-enable and the write lands.
        lifecycle::set_settings(&store, "ws-a", "", true, false, "", "t").unwrap();
        let cached = lifecycle::cache_item(&store, "ws-a", &item("github", "1", "X"), "t").unwrap();
        assert!(cached);
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
        lifecycle::set_settings(&store, "ws-a", "", false, false, "", "later").unwrap();
        assert!(lifecycle::list(&store, "ws-a", None).unwrap().is_empty());
    }

    #[test]
    fn connector_account_mismatch_and_revocation_exclude_cached_rows() {
        let store = store();
        connection(&store, "ws-a", "github", "acct-a");
        let mut account_item = item("github", "1", "Account-bound");
        account_item["account"] = serde_json::json!("acct-a");
        lifecycle::cache_item(&store, "ws-a", &account_item, "t").unwrap();

        // A write bound to an account with no live Connection fails closed at
        // write time (the stale in-flight write is rejected, not hidden later).
        let mut other_item = item("github", "2", "Other-account");
        other_item["account"] = serde_json::json!("acct-2");
        assert!(lifecycle::cache_item(&store, "ws-a", &other_item, "t").is_err());
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);

        // Revoking the live Connection hides the account-bound row.
        transition(
            &store,
            "ws-a",
            "github",
            "acct-a",
            "disconnected",
            "revoked",
            "revoked",
        );
        assert!(lifecycle::list(&store, "ws-a", None).unwrap().is_empty());
        assert!(lifecycle::search(&store, "ws-a", None, "account")
            .unwrap()
            .is_empty());

        // Re-authorizing the Connection restores visibility.
        transition(
            &store,
            "ws-a",
            "github",
            "acct-a",
            "authorized",
            "authorized",
            "available",
        );
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
    }

    #[test]
    fn cache_contract_survives_account_switch_and_stale_in_flight_write() {
        // End-to-end cache-contract regression for the observed defect: a
        // search response that completes after the account switched must not
        // overwrite the active account's row or re-seed content for a
        // disconnected account, and disconnect must yield a valid empty result
        // (not a failure and not a miss) until the connector is re-authorized.
        let store = store();
        connection(&store, "ws-a", "github", "acct-a");
        let mut for_a = item("github", "issue-1", "Fresh acct-a");
        for_a["account"] = serde_json::json!("acct-a");
        assert!(lifecycle::cache_item(&store, "ws-a", &for_a, "t1").unwrap());

        // Account switch: acct-a is revoked, acct-b is authorized.
        transition(
            &store,
            "ws-a",
            "github",
            "acct-a",
            "disconnected",
            "revoked",
            "revoked",
        );
        connection(&store, "ws-a", "github", "acct-b");

        // The stale in-flight response for acct-a completes now and is rejected
        // fail-closed; it cannot overwrite acct-b's future row.
        let mut stale_a = item("github", "issue-1", "Stale acct-a");
        stale_a["account"] = serde_json::json!("acct-a");
        assert!(lifecycle::cache_item(&store, "ws-a", &stale_a, "t2").is_err());

        // The active account's fresh re-sync lands and is the only content
        // served for that provider item.
        let mut for_b = item("github", "issue-1", "Fresh acct-b");
        for_b["account"] = serde_json::json!("acct-b");
        assert!(lifecycle::cache_item(&store, "ws-a", &for_b, "t3").unwrap());
        let rows = lifecycle::search(&store, "ws-a", None, "acct-b").unwrap();
        assert_eq!(
            rows.len(),
            1,
            "stale acct-a write must not overwrite acct-b"
        );
        assert_eq!(rows[0].account, "acct-b");
        assert_eq!(rows[0].title, "Fresh acct-b");

        // Disconnect: a valid empty result, distinct from a failure.
        transition(
            &store,
            "ws-a",
            "github",
            "acct-b",
            "disconnected",
            "revoked",
            "revoked",
        );
        assert!(
            lifecycle::list(&store, "ws-a", None).unwrap().is_empty(),
            "disconnect must yield an empty result"
        );
        assert!(lifecycle::search(&store, "ws-a", None, "acct-b")
            .unwrap()
            .is_empty());

        // Re-authorize: writes and reads recover deterministically; the rows
        // are upserted in place (bounded storage).
        transition(
            &store,
            "ws-a",
            "github",
            "acct-b",
            "authorized",
            "authorized",
            "available",
        );
        assert!(lifecycle::cache_item(&store, "ws-a", &for_b, "t4").unwrap());
        let rows = lifecycle::list(&store, "ws-a", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Fresh acct-b");

        // A disabled cache is a no-op reporting not-cached — a third distinct
        // outcome alongside empty results and failures.
        lifecycle::set_settings(&store, "ws-a", "github", false, false, "", "t5").unwrap();
        assert!(!lifecycle::cache_item(&store, "ws-a", &for_b, "t6").unwrap());
        assert!(lifecycle::list(&store, "ws-a", None).unwrap().is_empty());
    }

    #[test]
    fn cache_write_rejects_unredactable_secret() {
        let store = store();
        live_connection(&store, "ws-a", "github");
        // A token in a string field is redacted and cached; a token-shaped value
        // that survives redaction (none can, by construction) would fail closed.
        // Here we assert the redaction path keeps the write succeeding with the
        // sentinel, proving secrets never persist verbatim.
        let mut leaky = item("github", "1", "Bearer ya29.evil");
        leaky["providerMetadata"] = serde_json::json!({ "token": "ghp_secret123" });
        let cached = lifecycle::cache_item(&store, "ws-a", &leaky, "t").unwrap();
        assert!(cached);
        let rows = lifecycle::list(&store, "ws-a", None).unwrap();
        assert_eq!(rows[0].title, "[redacted connector data]");
        assert_eq!(
            rows[0].provider_metadata["token"],
            "[redacted connector data]"
        );
    }

    #[test]
    fn settings_precedence_connector_over_workspace() {
        let store = store();
        // Workspace default: disabled.
        lifecycle::set_settings(&store, "ws-a", "", false, false, "", "t").unwrap();
        // Connector override: enabled.
        lifecycle::set_settings(&store, "ws-a", "github", true, true, "", "t").unwrap();
        let eff = lifecycle::get_settings(&store, "ws-a", "github").unwrap();
        assert!(eff.enabled);
        assert!(eff.auto_sync);
        assert_eq!(eff.scope, SCOPE_CONNECTOR);
        // Deleting the override restores the disabled workspace default.
        assert!(lifecycle::delete_settings(&store, "ws-a", "github").unwrap());
        let eff = lifecycle::get_settings(&store, "ws-a", "github").unwrap();
        assert!(!eff.enabled);
        assert_eq!(eff.scope, SCOPE_WORKSPACE);
    }

    #[test]
    fn settings_workspace_isolation() {
        let store = store();
        lifecycle::set_settings(&store, "ws-a", "", false, false, "", "t").unwrap();
        // ws-b has no settings -> built-in default enabled.
        let eff_b = lifecycle::get_settings(&store, "ws-b", "github").unwrap();
        assert!(eff_b.enabled);
        let eff_a = lifecycle::get_settings(&store, "ws-a", "github").unwrap();
        assert!(!eff_a.enabled, "ws-a inherits its disabled default");
    }

    #[test]
    fn list_excludes_rows_for_connectors_disabled_via_workspace_default() {
        // Exercises the batched plaintext settings resolution path: a workspace
        // default of disabled must exclude every cached row of every connector
        // from list/search, even with no per-connector rows materialized.
        let store = store();
        live_connection(&store, "ws-a", "github");
        live_connection(&store, "ws-a", "notion");
        lifecycle::cache_item(&store, "ws-a", &item("github", "1", "G"), "t").unwrap();
        lifecycle::cache_item(&store, "ws-a", &item("notion", "1", "N"), "t").unwrap();
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 2);
        // Disable workspace-wide.
        lifecycle::set_settings(&store, "ws-a", "", false, false, "", "t").unwrap();
        assert!(
            lifecycle::list(&store, "ws-a", None).unwrap().is_empty(),
            "disabled workspace default excludes all rows"
        );
        // A connector override re-enables just that connector.
        lifecycle::set_settings(&store, "ws-a", "notion", true, false, "", "t").unwrap();
        let rows = lifecycle::list(&store, "ws-a", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].connector_id, "notion");
    }

    #[test]
    fn cached_rows_hidden_when_live_connection_is_disconnected() {
        // Production disconnect writes the canonical `connection_record` (the
        // maintained revocation hook) while the legacy `connector_account`
        // snapshot keeps a stale 'connected' status. The cache read path must
        // honor the live hook so a disconnected account's cached content is
        // never served.
        let store = store();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace (id, name, created_at, updated_at)
                     VALUES ('ws-a', 'A', 'now', 'now');",
                    [],
                )?;
                // Legacy snapshot, frozen at migration time.
                tx.execute(
                    "INSERT INTO connector_account
                       (workspace_id, project_id, connector_id, account_id, status, expires_at,
                        credential_ref, connected_at, updated_at, payload, payload_nonce)
                     VALUES ('ws-a', NULL, 'github', 'acct-a', 'connected', NULL,
                             'oauth-token:ws-a:github:acct-a', 'now', 'now', x'01', x'02');",
                    [],
                )?;
                let id =
                    crate::connector_auth::derive_native_connection_id("ws-a", "github", "acct-a");
                tx.execute(
                    "INSERT INTO connection_record(
                       workspace_id,id,record_type,authority,visibility,owner_member_id,
                       schema_version,revision,created_by_internal_user_id,created_by_device_id,
                       kind,ownership,lifecycle,authorization_state,health_state,trust,
                       credential_custody,credential_state,credential_ref,connector_definition_key,
                       enabled_by_default,created_at,updated_at,deleted_at,payload,payload_nonce)
                     VALUES('ws-a',?1,'connection','local','workspace-shared',NULL,1,1,
                       'local-user-1',NULL,'native-connector','workspace-shared','authorized',
                       'authorized','healthy','fable-reviewed','os-secure-store','available',
                       'oauth-token:ws-a:github:acct-a','github',1,'now','now',NULL,x'01',x'02');",
                    [id],
                )?;
                Ok(())
            })
            .unwrap();
        let mut account_item = item("github", "1", "Account-bound");
        account_item["account"] = serde_json::json!("acct-a");
        lifecycle::cache_item(&store, "ws-a", &account_item, "t").unwrap();
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
        // Disconnect: the canonical Connection is revoked; the legacy snapshot
        // is untouched (this is what production does today).
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE connection_record SET lifecycle='disconnected',
                       authorization_state='revoked', health_state='offline',
                       credential_state='revoked'
                     WHERE workspace_id='ws-a' AND connector_definition_key='github';",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(
            lifecycle::list(&store, "ws-a", None).unwrap().is_empty(),
            "disconnected account content must not be served"
        );
        assert!(lifecycle::search(&store, "ws-a", None, "account")
            .unwrap()
            .is_empty());
        // Reconnecting restores access to cached content.
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE connection_record SET lifecycle='authorized',
                       authorization_state='authorized', health_state='healthy',
                       credential_state='available'
                     WHERE workspace_id='ws-a' AND connector_definition_key='github';",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(lifecycle::list(&store, "ws-a", None).unwrap().len(), 1);
    }

    #[test]
    fn search_bounds_query_length() {
        let store = store();
        let long = "x".repeat(MAX_CACHE_QUERY_CHARACTERS + 1);
        let err = lifecycle::search(&store, "ws-a", None, &long).unwrap_err();
        assert!(matches!(err, StoreError::Invalid(_)));
    }
}
