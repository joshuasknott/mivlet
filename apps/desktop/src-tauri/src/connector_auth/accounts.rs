//! Native connector account metadata and compatibility storage.
//!
//! This module owns the non-secret connection list that predates the encrypted
//! Connection repository. Credentials never live here: the list contains only
//! provider account projections, scopes, status and the OS-store reference.

use std::{collections::BTreeMap, fs, path::Path};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::{ConnectorAccountOption, ConnectorAccountSummary};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectorConnection {
    pub connector_id: String,
    pub account: ConnectorAccountSummary,
    pub status: String,
    pub scopes: Vec<String>,
    pub expires_at: Option<u64>,
    pub credential_ref: String,
    pub connected_at: String,
    pub updated_at: String,
    /// Whether this account is the one reads/actions resolve by default.
    /// Exactly one connection per `connector_id` is active; the rest are kept
    /// so the user can switch between multiple Google accounts. Defaults to
    /// `false` for legacy entries; `read_connections` repairs the collection so
    /// exactly one account per connector is active before it is used.
    #[serde(default)]
    pub is_active: bool,
}

pub(crate) fn read_connections(path: &Path) -> Result<Vec<ConnectorConnection>, String> {
    if let Some(connections) = crate::store::read_document(path)? {
        return Ok(connections);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Mivlet could not read connector state.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut connections: Vec<ConnectorConnection> = serde_json::from_str(&contents)
        .map_err(|_| "Mivlet could not parse connector state.".to_string())?;
    normalize_active_accounts(&mut connections);
    Ok(connections)
}

pub(crate) fn write_connections(
    path: &Path,
    connections: &[ConnectorConnection],
) -> Result<(), String> {
    if crate::store::write_document(path, &connections)? {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(connections)
        .map_err(|_| "Mivlet could not encode connector state.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Mivlet could not save connector state.".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "Mivlet could not commit connector state.".to_string())
}

fn normalize_active_accounts(connections: &mut [ConnectorConnection]) {
    let mut selected = BTreeMap::<String, usize>::new();
    for (index, connection) in connections.iter().enumerate() {
        let current = selected.get(&connection.connector_id).copied();
        if let Some(preferred) = prefer_active_index(connections, current, index) {
            selected.insert(connection.connector_id.clone(), preferred);
        }
    }
    for (index, connection) in connections.iter_mut().enumerate() {
        connection.is_active = selected.get(&connection.connector_id) == Some(&index);
    }
}

fn prefer_active_index(
    connections: &[ConnectorConnection],
    current: Option<usize>,
    candidate: usize,
) -> Option<usize> {
    match current {
        None => Some(candidate),
        Some(index) if !connections[index].is_active && connections[candidate].is_active => {
            Some(candidate)
        }
        Some(index) => Some(index),
    }
}

pub(super) fn promote_single_active(connections: &mut [ConnectorConnection], connector_id: &str) {
    let mut selected = None;
    for (index, connection) in connections.iter().enumerate() {
        if connection.connector_id != connector_id {
            continue;
        }
        selected = prefer_active_index(connections, selected, index);
    }
    for (index, connection) in connections.iter_mut().enumerate() {
        if connection.connector_id == connector_id {
            connection.is_active = Some(index) == selected;
        }
    }
}

pub(crate) fn account_options_from_connections(
    connections: &[ConnectorConnection],
    connector_id: &str,
    workspace_id: &str,
) -> Vec<ConnectorAccountOption> {
    let mut matching: Vec<&ConnectorConnection> = connections
        .iter()
        .filter(|connection| connection.connector_id == connector_id)
        .collect();
    matching.sort_by_key(|connection| !connection.is_active);
    matching
        .into_iter()
        .map(|connection| {
            let connection_id =
                derive_native_connection_id(workspace_id, connector_id, &connection.account.id);
            ConnectorAccountOption {
                account: safe_account_projection(&connection.account, connector_id, workspace_id),
                connection_id,
                active: connection.is_active,
                lifecycle: match connection.status.as_str() {
                    "connected" => "authorized",
                    "expired" => "refresh-required",
                    _ => "pending-authorization",
                }
                .into(),
                authorization_state: match connection.status.as_str() {
                    "connected" => "authorized",
                    "expired" => "expired",
                    _ => "pending",
                }
                .into(),
                health_state: "unknown".into(),
                credential_custody: "os-secure-store".into(),
                credential_state: match connection.status.as_str() {
                    "connected" => "available",
                    "expired" => "refresh-required",
                    _ => "unknown",
                }
                .into(),
            }
        })
        .collect()
}

#[cfg(test)]
pub(super) fn accounts_for_connector(
    path: &Path,
    connector_id: &str,
    workspace_id: &str,
) -> Vec<ConnectorAccountOption> {
    let Ok(connections) = read_connections(path) else {
        return Vec::new();
    };
    account_options_from_connections(&connections, connector_id, workspace_id)
}

pub(crate) fn safe_account_projection(
    account: &ConnectorAccountSummary,
    connector_id: &str,
    workspace_id: &str,
) -> ConnectorAccountSummary {
    ConnectorAccountSummary {
        id: derive_native_connection_id(workspace_id, connector_id, &account.id),
        display_name: account.display_name.clone(),
        handle: account.handle.clone(),
        email: account.email.clone(),
        workspace: account.workspace.clone(),
        avatar_url: account.avatar_url.clone(),
    }
}

pub(crate) fn derive_native_connection_id(
    workspace_id: &str,
    connector_id: &str,
    account_id: &str,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.connection.native-connector.v1\0");
    for value in [workspace_id, connector_id, account_id] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!("connection_{}", URL_SAFE_NO_PAD.encode(digest.finalize()))
}
