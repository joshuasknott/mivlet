//! Secret-free local support diagnostics.
//!
//! This surface returns only bounded category names, health states, and counts
//! from plaintext control columns. It never decrypts or returns payloads,
//! prompts, citations, provider responses, credentials, paths, or external
//! account identifiers.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};

use crate::authorized_scope::{self, ScopeAccess};
use crate::store::{self, Result, StoreError};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCategory {
    id: &'static str,
    label: &'static str,
    status: &'static str,
    summary: String,
    metrics: BTreeMap<&'static str, u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDiagnosticsSnapshot {
    generated_at: String,
    schema_version: u32,
    categories: Vec<DiagnosticCategory>,
}

fn count(conn: &Connection, sql: &str, parameters: impl rusqlite::Params) -> Result<u64> {
    let value = conn.query_row(sql, parameters, |row| row.get::<_, i64>(0))?;
    u64::try_from(value)
        .map_err(|_| StoreError::Invalid("A local diagnostic count was invalid.".into()))
}

fn category(
    id: &'static str,
    label: &'static str,
    status: &'static str,
    summary: impl Into<String>,
    metrics: impl IntoIterator<Item = (&'static str, u64)>,
) -> DiagnosticCategory {
    DiagnosticCategory {
        id,
        label,
        status,
        summary: summary.into(),
        metrics: metrics.into_iter().collect(),
    }
}

fn collect(
    conn: &Connection,
    scope: &authorized_scope::AuthorizedCommandScope,
    database_bytes: u64,
    restore_pending: bool,
) -> Result<LocalDiagnosticsSnapshot> {
    store::Store::verify_integrity(conn)?;
    let workspace = scope.data.workspace_id();
    let owner_subject = scope.private.owner_subject();
    let owner_member = scope.member_id.as_deref().unwrap_or("");
    let internal_user = scope.internal_user_id.as_str();
    let schema_version = store::read_schema_version(conn)?;

    let providers = count(
        conn,
        "SELECT COUNT(*) FROM backend_connection WHERE internal_user_id=?1",
        [internal_user],
    )?;
    let provider_observations = count(
        conn,
        "SELECT COUNT(*) FROM provider_route_observation WHERE internal_user_id=?1",
        [internal_user],
    )?;
    let connections = count(
        conn,
        "SELECT COUNT(*) FROM connection_record
         WHERE workspace_id=?1 AND deleted_at IS NULL
           AND (visibility='workspace-shared' OR owner_member_id=?2)",
        params![workspace, owner_member],
    )?;
    let connections_attention = count(
        conn,
        "SELECT COUNT(*) FROM connection_record
         WHERE workspace_id=?1 AND deleted_at IS NULL
           AND (visibility='workspace-shared' OR owner_member_id=?2)
           AND (lifecycle='refresh-required'
             OR authorization_state IN ('expired','denied','revoked','unavailable')
             OR health_state IN ('unhealthy','offline')
             OR credential_state IN ('refresh-required','unavailable','revoked'))",
        params![workspace, owner_member],
    )?;
    let mcp_servers = count(
        conn,
        "SELECT COUNT(*) FROM mcp_local_server_config
         WHERE workspace_id=?1 AND owner_subject=?2",
        params![workspace, owner_subject],
    )?;
    let mcp_enabled = count(
        conn,
        "SELECT COUNT(*) FROM mcp_local_server_config
         WHERE workspace_id=?1 AND owner_subject=?2 AND disabled=0",
        params![workspace, owner_subject],
    )?;
    let migration_failures = count(
        conn,
        "SELECT COUNT(*) FROM migration_log WHERE status NOT IN ('completed','skipped')",
        [],
    )?;
    let migration_quarantine = count(
        conn,
        "SELECT COUNT(*) FROM connection_legacy_unattributed WHERE workspace_id=?1",
        [workspace],
    )?;
    let sync_links = count(
        conn,
        "SELECT COUNT(*) FROM cloud_workspace_link WHERE local_workspace_id=?1",
        [workspace],
    )?;
    let sync_pending = count(
        conn,
        "SELECT COUNT(*) FROM cloud_mutation_outbox
         WHERE local_workspace_id=?1 AND status IN ('pending','retrying','in-flight')",
        [workspace],
    )?;
    let sync_attention = count(
        conn,
        "SELECT COUNT(*) FROM cloud_mutation_outbox
         WHERE local_workspace_id=?1 AND status IN ('failed','blocked')",
        [workspace],
    )? + count(
        conn,
        "SELECT COUNT(*) FROM cloud_conflict WHERE local_workspace_id=?1",
        [workspace],
    )?;

    Ok(LocalDiagnosticsSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        schema_version,
        categories: vec![
            category(
                "storage",
                "Local storage",
                if restore_pending {
                    "attention"
                } else {
                    "healthy"
                },
                if restore_pending {
                    "A verified restore is waiting for restart."
                } else {
                    "The encrypted database passed its integrity check."
                },
                [
                    ("databaseBytes", database_bytes),
                    ("restorePending", u64::from(restore_pending)),
                ],
            ),
            category(
                "providers",
                "Providers",
                if providers == 0 {
                    "unavailable"
                } else {
                    "healthy"
                },
                if providers == 0 {
                    "No model provider is connected for this account."
                } else {
                    "Connected provider runtime records are available."
                },
                [
                    ("connected", providers),
                    ("routeObservations", provider_observations),
                ],
            ),
            category(
                "connections",
                "Connections",
                if connections_attention > 0 {
                    "attention"
                } else if connections == 0 {
                    "unavailable"
                } else {
                    "healthy"
                },
                if connections_attention > 0 {
                    "One or more Connections need attention."
                } else if connections == 0 {
                    "No Connections are configured in this workspace."
                } else {
                    "Configured Connections have no recorded blocking state."
                },
                [
                    ("configured", connections),
                    ("needsAttention", connections_attention),
                ],
            ),
            category(
                "mcp",
                "MCP",
                if mcp_servers == 0 {
                    "unavailable"
                } else {
                    "healthy"
                },
                if mcp_servers == 0 {
                    "No MCP server is configured."
                } else {
                    "MCP configuration is present; live sessions are checked per use."
                },
                [("configured", mcp_servers), ("enabled", mcp_enabled)],
            ),
            category(
                "migrations",
                "Migrations",
                if migration_failures > 0 || migration_quarantine > 0 {
                    "attention"
                } else {
                    "healthy"
                },
                if migration_failures > 0 || migration_quarantine > 0 {
                    "Migration failures or unattributed records remain visible."
                } else {
                    "No failed migration or unattributed record is recorded."
                },
                [
                    ("failed", migration_failures),
                    ("quarantined", migration_quarantine),
                ],
            ),
            category(
                "sync",
                "Workspace sync",
                if sync_attention > 0 {
                    "attention"
                } else if sync_links == 0 {
                    "unavailable"
                } else {
                    "healthy"
                },
                if sync_attention > 0 {
                    "Workspace sync has a failed mutation or conflict."
                } else if sync_links == 0 {
                    "This workspace is not linked for hosted sync."
                } else {
                    "No failed sync mutation or conflict is recorded."
                },
                [
                    ("links", sync_links),
                    ("pending", sync_pending),
                    ("needsAttention", sync_attention),
                ],
            ),
        ],
    })
}

#[tauri::command]
pub fn local_diagnostics(
    app: tauri::AppHandle,
    workspace_id: String,
) -> std::result::Result<LocalDiagnosticsSnapshot, String> {
    let store = store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let app_data = crate::paths::app_data_dir(&app)?;
    let database_bytes = std::fs::metadata(app_data.join(store::DB_FILENAME))
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let restore_pending = app_data.join("fable-vault.restore-pending.db").exists();
    store
        .with_conn(|conn| {
            let scope =
                authorized_scope::resolve(conn, Some(&workspace_id), None, ScopeAccess::Read)?;
            collect(conn, &scope, database_bytes, restore_pending)
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        vault::{MasterKey, Vault},
        Store,
    };

    fn scope(store: &Store) -> authorized_scope::AuthorizedCommandScope {
        store
            .transaction(|tx| authorized_scope::resolve(tx, None, None, ScopeAccess::Read))
            .unwrap()
    }

    #[test]
    fn diagnostics_return_only_bounded_counts_and_attention_states() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let scope = scope(&store);
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO connection_legacy_unattributed(
                       workspace_id,connector_id,proposed_connection_id,quarantined_at,reason
                     ) VALUES(?1,'legacy',NULL,'now','unattributed')",
                    [scope.data.workspace_id()],
                )?;
                Ok(())
            })
            .unwrap();
        let snapshot = store
            .with_conn(|conn| collect(conn, &scope, 4096, true))
            .unwrap();
        let encoded = serde_json::to_value(snapshot).unwrap();
        assert_eq!(encoded["categories"][0]["status"], "attention");
        let migrations = encoded["categories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|category| category["id"] == "migrations")
            .unwrap();
        assert_eq!(migrations["status"], "attention");
        assert_eq!(migrations["metrics"]["quarantined"], 1);
        let text = encoded.to_string();
        assert!(!text.contains("member-1"));
        assert!(!text.contains("user-1"));
        assert!(!text.contains("workspace-1"));
        assert!(!text.contains("legacy"));
    }
}
