//! Focused native account/workspace lifecycle adapter.
//!
//! Renderer code can call only the commands in this module. Clerk bearer
//! credentials, Convex paths, internal-user IDs, idempotency keys, and the
//! per-install device identity remain native concerns.

use std::collections::BTreeSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::store::repos::workspace_directory as directory;

const DEVICE_KEYRING_SERVICE: &str = "com.fable.workspace.account-device";
const DEVICE_KEYRING_ENTRY: &str = "install-device-id";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceStatus {
    configured: bool,
    state: String,
    message: String,
    account_bound: bool,
    workspaces: Vec<directory::WorkspaceDirectorySummary>,
    active_workspace: directory::ActiveWorkspaceSelection,
    devices: Vec<directory::AccountDeviceSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapResult {
    status: String,
    internal_user_id: String,
    workspace_id: String,
    member_id: String,
    #[serde(default)]
    device: Option<Value>,
    idempotency: IdempotencyReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdempotencyReceipt {
    key: String,
    replayed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedWorkspace {
    workspace_id: String,
    name: String,
    revision: i64,
    policy_revision: i64,
    member_id: String,
    role: String,
    membership_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedDevice {
    device_id: String,
    kind: String,
    label: String,
    status: String,
    registered_at: i64,
    #[serde(default)]
    last_seen_at: Option<i64>,
    #[serde(default)]
    revoked_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWorkspaceResult {
    status: String,
    workspace: HostedWorkspace,
    idempotency: IdempotencyReceipt,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceRevokeResult {
    device_id: String,
    status: String,
    revoked_workspace_links: i64,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn opaque_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a secure account request.".to_string())?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/// A stable installation identifier is held in OS secure storage. The current
/// hosted schema requires a public key but defines neither an accepted key
/// algorithm nor proof-of-possession flow, so this ID is intentionally not
/// registered until that contract can accept a genuine device key.
fn ensure_install_device_id() -> Option<String> {
    let entry = keyring::Entry::new(DEVICE_KEYRING_SERVICE, DEVICE_KEYRING_ENTRY).ok()?;
    match entry.get_password() {
        Ok(value) if valid_id(&value) => Some(value),
        Ok(_) => None,
        Err(keyring::Error::NoEntry) => {
            let value = opaque_id("dev").ok()?;
            entry.set_password(&value).ok()?;
            Some(value)
        }
        Err(_) => None,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn unwrap_convex_success(envelope: Value) -> Result<Value, String> {
    let object = envelope.as_object().ok_or_else(|| {
        "The hosted workspace service returned a malformed response envelope.".to_string()
    })?;
    if object.len() != 2 || !object.contains_key("status") || !object.contains_key("value") {
        return Err("The hosted workspace service returned an ambiguous response envelope.".into());
    }
    if object.get("status").and_then(Value::as_str) != Some("success") {
        return Err("The hosted workspace service rejected the account request.".into());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(|| "The hosted workspace service omitted its response value.".into())
}

async fn hosted_call(
    function_type: ConvexFunctionType,
    path: &str,
    args: Value,
) -> Result<Value, String> {
    let envelope = clerk_identity::call_convex(ConvexIdentityCallRequest {
        function_type,
        function_path: path.to_string(),
        args,
    })
    .await?;
    unwrap_convex_success(envelope)
}

fn parse_bootstrap(value: Value, expected_key: &str) -> Result<BootstrapResult, String> {
    let result: BootstrapResult = serde_json::from_value(value)
        .map_err(|_| "The hosted workspace bootstrap response is malformed.".to_string())?;
    if !matches!(result.status.as_str(), "created" | "existing")
        || !valid_id(&result.internal_user_id)
        || !valid_id(&result.workspace_id)
        || !valid_id(&result.member_id)
        || result.idempotency.key != expected_key
        || result.device.is_some()
    {
        return Err("The hosted workspace bootstrap response failed validation.".into());
    }
    let _ = result.idempotency.replayed;
    Ok(result)
}

fn parse_workspaces(value: Value) -> Result<Vec<HostedWorkspace>, String> {
    let entries: Vec<HostedWorkspace> = serde_json::from_value(value)
        .map_err(|_| "The hosted workspace list response is malformed.".to_string())?;
    let mut workspace_ids = BTreeSet::new();
    let mut member_ids = BTreeSet::new();
    for entry in &entries {
        if !valid_id(&entry.workspace_id)
            || !valid_id(&entry.member_id)
            || entry.name.trim().is_empty()
            || entry.name.chars().count() > 200
            || entry.revision < 0
            || entry.policy_revision < 0
            || entry.membership_revision < 0
            || !["owner", "admin", "editor", "viewer"].contains(&entry.role.as_str())
            || !workspace_ids.insert(&entry.workspace_id)
            || !member_ids.insert(&entry.member_id)
        {
            return Err("The hosted workspace list contains an invalid or ambiguous entry.".into());
        }
    }
    Ok(entries)
}

fn epoch_millis_to_iso(value: i64) -> Result<String, String> {
    if value < 0 {
        return Err("The hosted account device timestamp is invalid.".into());
    }
    Utc.timestamp_millis_opt(value)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| "The hosted account device timestamp is invalid.".into())
}

fn parse_devices(value: Value) -> Result<Vec<directory::AccountDeviceMirrorUpsert>, String> {
    let entries: Vec<HostedDevice> = serde_json::from_value(value)
        .map_err(|_| "The hosted account device list response is malformed.".to_string())?;
    let mut ids = BTreeSet::new();
    entries
        .into_iter()
        .map(|entry| {
            if !valid_id(&entry.device_id)
                || entry.label.trim().is_empty()
                || !["desktop", "mobile", "web"].contains(&entry.kind.as_str())
                || !["pending", "active", "revoked"].contains(&entry.status.as_str())
                || !ids.insert(entry.device_id.clone())
                || (entry.status != "revoked" && entry.revoked_at.is_some())
            {
                return Err(
                    "The hosted account device list contains an invalid or ambiguous entry.".into(),
                );
            }
            Ok(directory::AccountDeviceMirrorUpsert {
                device_id: entry.device_id,
                kind: entry.kind,
                label: entry.label,
                status: entry.status,
                registered_at: epoch_millis_to_iso(entry.registered_at)?,
                last_seen_at: entry.last_seen_at.map(epoch_millis_to_iso).transpose()?,
                revoked_at: entry.revoked_at.map(epoch_millis_to_iso).transpose()?,
            })
        })
        .collect()
}

fn parse_device_revoke(value: Value, expected_device_id: &str) -> Result<(), String> {
    let result: DeviceRevokeResult = serde_json::from_value(value)
        .map_err(|_| "The hosted device revocation response is malformed.".to_string())?;
    if result.device_id != expected_device_id
        || result.status != "revoked"
        || result.revoked_workspace_links < 0
    {
        return Err("The hosted device revocation response failed validation.".into());
    }
    Ok(())
}

async fn reconcile_hosted() -> Result<(), String> {
    // Create the stable local ID now even though this version cannot honestly
    // register it with the hosted `publicKey`-requiring endpoint.
    let _install_device_id = ensure_install_device_id();
    let idempotency_key = clerk_identity::native_bootstrap_idempotency_key().await?;
    let bootstrap = parse_bootstrap(
        hosted_call(
            ConvexFunctionType::Mutation,
            "workspace:bootstrapAccount",
            json!({ "idempotencyKey": idempotency_key }),
        )
        .await?,
        &idempotency_key,
    )?;
    let workspaces = parse_workspaces(
        hosted_call(ConvexFunctionType::Query, "workspace:listMine", json!({})).await?,
    )?;
    let initial = workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == bootstrap.workspace_id)
        .ok_or_else(|| "The hosted workspace list omitted the bootstrap workspace.".to_string())?;
    if initial.member_id != bootstrap.member_id {
        return Err("The hosted workspace list did not match the bootstrap membership.".into());
    }
    let devices =
        parse_devices(hosted_call(ConvexFunctionType::Query, "device:listMine", json!({})).await?)?;
    let observed_at = now();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            // Preserve the locally observed timestamp for exact replayed
            // revisions; Convex's current list contract has no update time.
            let existing =
                directory::list_authoritative_summaries(conn, &bootstrap.internal_user_id)?;
            for workspace in &workspaces {
                let updated_at = existing
                    .iter()
                    .find(|current| {
                        current.fable_workspace_id == workspace.workspace_id
                            && current.workspace_revision == workspace.revision
                            && current.policy_revision == workspace.policy_revision
                            && current.membership_revision == workspace.membership_revision
                    })
                    .map(|current| current.updated_at.clone())
                    .unwrap_or_else(|| observed_at.clone());
                directory::upsert_authoritative_summary(
                    conn,
                    &directory::WorkspaceDirectoryUpsert {
                        internal_user_id: bootstrap.internal_user_id.clone(),
                        fable_workspace_id: workspace.workspace_id.clone(),
                        name: workspace.name.clone(),
                        workspace_status: "active".into(),
                        workspace_revision: workspace.revision,
                        policy_revision: workspace.policy_revision,
                        member_id: workspace.member_id.clone(),
                        role: workspace.role.clone(),
                        membership_status: "active".into(),
                        membership_revision: workspace.membership_revision,
                        updated_at,
                    },
                )?;
            }
            directory::reconcile_active_workspace_inventory(
                conn,
                &bootstrap.internal_user_id,
                &workspaces
                    .iter()
                    .map(|workspace| workspace.workspace_id.clone())
                    .collect::<Vec<_>>(),
                &observed_at,
            )?;
            directory::set_current_internal_user(conn, &bootstrap.internal_user_id, &observed_at)?;
            directory::upsert_account_device_summaries(
                conn,
                &bootstrap.internal_user_id,
                &devices,
                &observed_at,
            )?;
            // Only establish an initial selection. A later explicit choice is
            // remembered for this user and must not be overwritten by refresh.
            let active = directory::resolve_active_workspace_for_current_user(conn)?;
            if active
                .as_ref()
                .is_none_or(|selection| selection.source == "legacy-default")
            {
                directory::select_active_workspace_for_current_user(
                    conn,
                    &bootstrap.workspace_id,
                    &observed_at,
                )?;
            }
            Ok(())
        })
        .map_err(|error| error.to_string())
}

fn local_status(
    identity: &clerk_identity::IdentityStatus,
) -> Result<AccountWorkspaceStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (workspaces, active_workspace, devices) = store
        .with_conn(|conn| {
            let workspaces = directory::list_authoritative_summaries_for_current_user(conn)?;
            let devices = directory::list_account_device_summaries_for_current_user(conn)?;
            let active_workspace = directory::resolve_active_workspace_for_current_user(conn)?;
            Ok((workspaces, active_workspace, devices))
        })
        .map_err(|error| error.to_string())?;
    let account_bound = workspaces.is_some();
    let fallback = store
        .with_conn(directory::legacy_default_workspace)
        .map_err(|error| error.to_string())?;
    let state = match identity.state.as_str() {
        "disabled" => "disabled",
        "signed-out" => "signed-out",
        "offline" if account_bound => "offline",
        "expired" => "expired",
        "revoked" => "revoked",
        "signed-in" if account_bound => "ready",
        "signed-in" => "bootstrapping",
        _ => "error",
    };
    Ok(AccountWorkspaceStatus {
        configured: identity.enabled,
        state: state.into(),
        message: identity.message.clone(),
        account_bound,
        workspaces: workspaces.unwrap_or_default(),
        active_workspace: active_workspace.unwrap_or(fallback),
        devices: devices.unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn account_workspace_status() -> Result<AccountWorkspaceStatus, String> {
    let identity = clerk_identity::native_identity_status().await?;
    local_status(&identity)
}

#[tauri::command]
pub async fn account_workspace_reconcile() -> Result<AccountWorkspaceStatus, String> {
    reconcile_hosted().await?;
    account_workspace_status().await
}

#[tauri::command]
pub async fn account_workspace_create(name: String) -> Result<AccountWorkspaceStatus, String> {
    if name.trim().is_empty() || name.chars().count() > 160 {
        return Err("Workspace name must be between 1 and 160 characters.".into());
    }
    let idempotency_key = opaque_id("workspace")?;
    let value = hosted_call(
        ConvexFunctionType::Mutation,
        "workspace:create",
        json!({ "idempotencyKey": idempotency_key, "name": name.trim() }),
    )
    .await?;
    // Validate the acknowledged creation rather than accepting an arbitrary
    // successful mutation envelope before refreshing the authoritative list.
    let created: CreateWorkspaceResult = serde_json::from_value(value)
        .map_err(|_| "The hosted workspace creation response is malformed.".to_string())?;
    if created.status != "created"
        || created.idempotency.key != idempotency_key
        || !valid_id(&created.workspace.workspace_id)
        || !valid_id(&created.workspace.member_id)
        || created.workspace.name.trim() != name.trim()
        || created.workspace.revision < 0
        || created.workspace.policy_revision < 0
        || created.workspace.membership_revision < 0
        || created.workspace.role != "owner"
    {
        return Err("The hosted workspace creation was not accepted.".into());
    }
    let _ = created.idempotency.replayed;
    reconcile_hosted().await?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            directory::select_active_workspace_for_current_user(
                conn,
                &created.workspace.workspace_id,
                &now(),
            )
            .map(|_| ())
        })
        .map_err(|error| error.to_string())?;
    account_workspace_status().await
}

#[tauri::command]
pub async fn account_workspace_select(
    fable_workspace_id: String,
) -> Result<AccountWorkspaceStatus, String> {
    if !valid_id(&fable_workspace_id) {
        return Err("Hosted workspace id is invalid.".into());
    }
    // A fresh hosted bootstrap/list/device pass rechecks current access before
    // this local remembered selection can become active.
    reconcile_hosted().await?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            directory::select_active_workspace_for_current_user(conn, &fable_workspace_id, &now())
                .map(|_| ())
        })
        .map_err(|error| error.to_string())?;
    account_workspace_status().await
}

#[tauri::command]
pub async fn account_device_revoke(device_id: String) -> Result<AccountWorkspaceStatus, String> {
    if !valid_id(&device_id) {
        return Err("Device id is invalid.".into());
    }
    let value = hosted_call(
        ConvexFunctionType::Mutation,
        "device:revoke",
        json!({ "deviceId": device_id }),
    )
    .await?;
    parse_device_revoke(value, &device_id)?;
    reconcile_hosted().await?;
    account_workspace_status().await
}

#[tauri::command]
pub async fn account_workspace_clear_session() -> Result<AccountWorkspaceStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| directory::clear_current_internal_user(conn))
        .map_err(|error| error.to_string())?;
    account_workspace_status().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convex_envelopes_fail_closed() {
        assert_eq!(
            unwrap_convex_success(json!({ "status": "success", "value": 2 })).unwrap(),
            2
        );
        for envelope in [
            json!({ "value": 2 }),
            json!({ "status": "success", "value": 2, "extra": true }),
            json!({ "status": "error", "value": 2 }),
            json!({ "status": "success" }),
        ] {
            assert!(unwrap_convex_success(envelope).is_err());
        }
    }

    #[test]
    fn malformed_or_ambiguous_hosted_lists_are_rejected() {
        assert!(parse_workspaces(json!([{
            "workspaceId": "ws_a", "name": "A", "revision": 0, "policyRevision": 1,
            "memberId": "m_a", "role": "owner", "membershipRevision": 1
        }, {
            "workspaceId": "ws_a", "name": "B", "revision": 0, "policyRevision": 1,
            "memberId": "m_b", "role": "owner", "membershipRevision": 1
        }]))
        .is_err());
        assert!(parse_devices(json!([{
            "deviceId": "dev_a", "kind": "desktop", "label": "A", "status": "active",
            "registeredAt": 1, "revokedAt": 2
        }]))
        .is_err());
    }

    #[test]
    fn bootstrap_response_must_match_native_idempotency_key() {
        let response = json!({
            "status": "existing", "internalUserId": "usr_a", "workspaceId": "ws_a", "memberId": "m_a",
            "idempotency": { "key": "other", "replayed": false }
        });
        assert!(parse_bootstrap(response, "expected").is_err());
    }

    #[test]
    fn device_revocation_receipt_is_strictly_validated() {
        assert!(parse_device_revoke(
            json!({ "deviceId": "dev_a", "status": "revoked", "revokedWorkspaceLinks": 0 }),
            "dev_a",
        )
        .is_ok());
        assert!(parse_device_revoke(
            json!({ "deviceId": "dev_a", "status": "revoked", "revokedWorkspaceLinks": 0, "extra": true }),
            "dev_a",
        )
        .is_err());
    }
}
