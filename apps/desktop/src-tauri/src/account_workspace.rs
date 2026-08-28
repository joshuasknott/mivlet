//! Optional hosted-account adapter.
//!
//! The installation-local workspace is always authoritative for conversations,
//! provider credentials, and local execution. This module mirrors only the
//! account inventory needed by configured hosted-computer capabilities.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::de::IntoDeserializer;
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::store::repos::workspace_directory as directory;

const DEVICE_KEYRING_SERVICE: &str = "com.fable.workspace.account-device";
const DEVICE_KEYRING_ENTRY: &str = "install-device-id";
const ACCOUNT_CHANGED_ERROR: &str = "Fable account changed during the request. Please try again.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceStatus {
    configured: bool,
    state: String,
    message: String,
    account_bound: bool,
    workspaces: Vec<directory::WorkspaceDirectorySummary>,
    active_workspace: directory::ActiveWorkspaceSelection,
    active_context_owner: ActiveContextOwner,
    devices: Vec<directory::AccountDeviceSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveContextOwner {
    internal_user_id: String,
    member_id: String,
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
    #[serde(deserialize_with = "deserialize_convex_i64")]
    revision: i64,
    #[serde(deserialize_with = "deserialize_convex_i64")]
    policy_revision: i64,
    member_id: String,
    role: String,
    #[serde(deserialize_with = "deserialize_convex_i64")]
    membership_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedDevice {
    device_id: String,
    kind: String,
    label: String,
    status: String,
    #[serde(deserialize_with = "deserialize_convex_i64")]
    registered_at: i64,
    #[serde(default, deserialize_with = "deserialize_optional_convex_i64")]
    last_seen_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_convex_i64")]
    revoked_at: Option<i64>,
}

type HostedFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;
type HostedStringFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct AccountIdentitySnapshot {
    account_binding: String,
    generation: u64,
}

trait AccountGenerationLock {}
impl AccountGenerationLock for clerk_identity::NativeIdentityGenerationGuard {}

trait HostedAccountTransport: Send + Sync {
    fn account_binding<'a>(&'a self) -> HostedStringFuture<'a>;
    fn identity_snapshot(&self) -> Result<AccountIdentitySnapshot, String>;
    fn lock_identity_generation(
        &self,
        expected: &AccountIdentitySnapshot,
    ) -> Result<Box<dyn AccountGenerationLock>, String>;
    fn call<'a>(
        &'a self,
        function_type: ConvexFunctionType,
        path: &'a str,
        args: Value,
    ) -> HostedFuture<'a>;
}

struct NativeHostedAccountTransport;

impl HostedAccountTransport for NativeHostedAccountTransport {
    fn account_binding<'a>(&'a self) -> HostedStringFuture<'a> {
        Box::pin(async {
            clerk_identity::native_identity_generation_snapshot()
                .map(|snapshot| snapshot.account_binding)
        })
    }

    fn identity_snapshot(&self) -> Result<AccountIdentitySnapshot, String> {
        clerk_identity::native_identity_generation_snapshot().map(|snapshot| {
            AccountIdentitySnapshot {
                account_binding: snapshot.account_binding,
                generation: snapshot.generation,
            }
        })
    }

    fn lock_identity_generation(
        &self,
        expected: &AccountIdentitySnapshot,
    ) -> Result<Box<dyn AccountGenerationLock>, String> {
        clerk_identity::lock_native_identity_generation(
            &clerk_identity::NativeIdentityGenerationSnapshot {
                account_binding: expected.account_binding.clone(),
                generation: expected.generation,
            },
        )
        .map(|guard| Box::new(guard) as Box<dyn AccountGenerationLock>)
    }

    fn call<'a>(
        &'a self,
        function_type: ConvexFunctionType,
        path: &'a str,
        args: Value,
    ) -> HostedFuture<'a> {
        Box::pin(hosted_call(function_type, path, args))
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn opaque_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a secure installation identity.".to_string())?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/// A stable installation identifier held in OS secure storage.
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

pub(crate) fn local_install_principals() -> (String, String) {
    let install_id = ensure_install_device_id().unwrap_or_else(|| "device-local".into());
    (
        format!("local-user-{install_id}"),
        format!("local-member-{install_id}"),
    )
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn deserialize_convex_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite()
        || value.fract() != 0.0
        || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value)
    {
        return Err(de::Error::custom(
            "expected an integral Convex number within JavaScript's safe integer range",
        ));
    }
    Ok(value as i64)
}

fn deserialize_optional_convex_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer)?
        .map(|value| {
            deserialize_convex_i64(value.into_deserializer())
                .map_err(|error: de::value::Error| de::Error::custom(error.to_string()))
        })
        .transpose()
}

fn unwrap_convex_success(envelope: Value) -> Result<Value, String> {
    let object = envelope.as_object().ok_or_else(|| {
        "The hosted account service returned a malformed response envelope.".to_string()
    })?;
    if object.len() != 2 || !object.contains_key("status") || !object.contains_key("value") {
        return Err("The hosted account service returned an ambiguous response envelope.".into());
    }
    if object.get("status").and_then(Value::as_str) != Some("success") {
        return Err("The hosted account service rejected the request.".into());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(|| "The hosted account service omitted its response value.".into())
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

async fn bound_hosted_call(
    transport: &dyn HostedAccountTransport,
    expected_binding: &str,
    function_type: ConvexFunctionType,
    path: &str,
    args: Value,
) -> Result<Value, String> {
    let before = transport
        .account_binding()
        .await
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if before != expected_binding {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let response = transport.call(function_type, path, args).await;
    let after = transport
        .account_binding()
        .await
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != expected_binding {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    response
}

fn parse_bootstrap(value: Value, expected_key: &str) -> Result<BootstrapResult, String> {
    let result: BootstrapResult = serde_json::from_value(value)
        .map_err(|_| "The hosted account bootstrap response is malformed.".to_string())?;
    if !matches!(result.status.as_str(), "created" | "existing")
        || !valid_id(&result.internal_user_id)
        || !valid_id(&result.workspace_id)
        || !valid_id(&result.member_id)
        || result.idempotency.key != expected_key
        || result.device.is_some()
    {
        return Err("The hosted account bootstrap response failed validation.".into());
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
            return Err("The hosted workspace list contains an invalid entry.".into());
        }
    }
    Ok(entries)
}

fn epoch_millis_to_iso(value: i64) -> Result<String, String> {
    if value < 0 {
        return Err("The hosted device timestamp is invalid.".into());
    }
    Utc.timestamp_millis_opt(value)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| "The hosted device timestamp is invalid.".into())
}

fn parse_devices(value: Value) -> Result<Vec<directory::AccountDeviceMirrorUpsert>, String> {
    let entries: Vec<HostedDevice> = serde_json::from_value(value)
        .map_err(|_| "The hosted device list response is malformed.".to_string())?;
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
                return Err("The hosted device list contains an invalid entry.".into());
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

async fn reconcile_hosted_with_transport(
    transport: &dyn HostedAccountTransport,
    expected_identity: &AccountIdentitySnapshot,
    store: &crate::store::Store,
) -> Result<(), String> {
    let binding = &expected_identity.account_binding;
    let bootstrap = parse_bootstrap(
        bound_hosted_call(
            transport,
            binding,
            ConvexFunctionType::Mutation,
            "workspace:bootstrapAccount",
            json!({ "idempotencyKey": binding }),
        )
        .await?,
        binding,
    )?;
    let workspaces = parse_workspaces(
        bound_hosted_call(
            transport,
            binding,
            ConvexFunctionType::Query,
            "workspace:listMine",
            json!({}),
        )
        .await?,
    )?;
    let initial = workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == bootstrap.workspace_id)
        .ok_or_else(|| "The hosted workspace list omitted the account workspace.".to_string())?;
    if initial.member_id != bootstrap.member_id {
        return Err("The hosted workspace list did not match the account membership.".into());
    }
    let devices = parse_devices(
        bound_hosted_call(
            transport,
            binding,
            ConvexFunctionType::Query,
            "device:listMine",
            json!({}),
        )
        .await?,
    )?;

    let observed_at = now();
    let _identity_guard = transport.lock_identity_generation(expected_identity)?;
    store
        .transaction(|conn| {
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
            )
        })
        .map_err(|error| error.to_string())
}

async fn reconcile_hosted() -> Result<(), String> {
    let transport = NativeHostedAccountTransport;
    let identity = transport.identity_snapshot()?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    reconcile_hosted_with_transport(&transport, &identity, store).await
}

fn local_status(
    identity: &clerk_identity::IdentityStatus,
) -> Result<AccountWorkspaceStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (internal_user_id, member_id) = local_install_principals();
    let signed_in = matches!(identity.state.as_str(), "signed-in" | "offline");
    let (workspaces, devices) = if signed_in {
        store
            .with_conn(|conn| {
                Ok((
                    directory::list_authoritative_summaries_for_current_user(conn)?
                        .unwrap_or_default(),
                    directory::list_account_device_summaries_for_current_user(conn)?
                        .unwrap_or_default(),
                ))
            })
            .map_err(|error| error.to_string())?
    } else {
        (Vec::new(), Vec::new())
    };
    let message = match identity.state.as_str() {
        "signed-in" if !workspaces.is_empty() => {
            "Local workspace ready. Optional hosted computer access is connected."
        }
        "signed-in" => {
            "Local workspace ready. Refresh the optional account to use hosted features."
        }
        "offline" => "Local workspace ready. The optional account is currently offline.",
        "expired" | "revoked" => {
            "Local workspace ready. Recover the optional account to use hosted features."
        }
        "error" => "Local workspace ready. The optional account is unavailable.",
        "disabled" => "Local workspace ready. Optional account sign-in is not configured.",
        _ => "Local workspace ready. A Fable account is optional.",
    };
    Ok(AccountWorkspaceStatus {
        configured: identity.enabled,
        state: "ready".into(),
        message: message.into(),
        account_bound: true,
        workspaces,
        active_workspace: directory::ActiveWorkspaceSelection {
            local_workspace_id: crate::store::repos::scope::DEFAULT_WORKSPACE_ID.into(),
            fable_workspace_id: None,
            name: "On this PC".into(),
            source: "local".into(),
        },
        active_context_owner: ActiveContextOwner {
            internal_user_id,
            member_id,
        },
        devices,
    })
}

#[tauri::command]
pub async fn account_workspace_status() -> Result<AccountWorkspaceStatus, String> {
    let identity = clerk_identity::native_identity_status().await?;
    local_status(&identity)
}

#[tauri::command]
pub async fn account_workspace_reconcile() -> Result<AccountWorkspaceStatus, String> {
    let identity = clerk_identity::native_identity_status().await?;
    if identity.state == "signed-in" {
        reconcile_hosted().await?;
    }
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
    fn bootstrap_requires_exact_account_binding_and_no_unproven_device() {
        let valid = json!({
            "status": "created",
            "internalUserId": "usr_1",
            "workspaceId": "ws_1",
            "memberId": "member_1",
            "idempotency": { "key": "binding_1", "replayed": false }
        });
        assert!(parse_bootstrap(valid.clone(), "binding_1").is_ok());
        assert!(parse_bootstrap(valid.clone(), "binding_2").is_err());
        let mut with_device = valid;
        with_device["device"] = json!({ "deviceId": "dev_1" });
        assert!(parse_bootstrap(with_device, "binding_1").is_err());
    }

    #[test]
    fn hosted_inventory_rejects_duplicate_or_fractional_authority_records() {
        let workspace = json!({
            "workspaceId": "ws_1",
            "name": "Personal",
            "revision": 1,
            "policyRevision": 1,
            "memberId": "member_1",
            "role": "owner",
            "membershipRevision": 1
        });
        assert!(parse_workspaces(json!([workspace.clone()])).is_ok());
        assert!(parse_workspaces(json!([workspace.clone(), workspace])).is_err());
        assert!(parse_workspaces(json!([{
            "workspaceId": "ws_2",
            "name": "Personal",
            "revision": 1.5,
            "policyRevision": 1,
            "memberId": "member_2",
            "role": "owner",
            "membershipRevision": 1
        }]))
        .is_err());
    }

    #[test]
    fn hosted_devices_require_bounded_unique_ids_and_consistent_revocation() {
        let device = json!({
            "deviceId": "dev_1",
            "kind": "desktop",
            "label": "This PC",
            "status": "active",
            "registeredAt": 1,
            "lastSeenAt": 2
        });
        assert!(parse_devices(json!([device.clone()])).is_ok());
        assert!(parse_devices(json!([device.clone(), device])).is_err());
        assert!(parse_devices(json!([{
            "deviceId": "dev_2",
            "kind": "desktop",
            "label": "This PC",
            "status": "active",
            "registeredAt": 1,
            "revokedAt": 2
        }]))
        .is_err());
    }

    #[test]
    fn convex_envelope_is_exact_and_fail_closed() {
        assert_eq!(
            unwrap_convex_success(json!({ "status": "success", "value": 7 })).unwrap(),
            json!(7)
        );
        assert!(
            unwrap_convex_success(json!({ "status": "success", "value": 7, "extra": true }))
                .is_err()
        );
        assert!(unwrap_convex_success(json!({ "status": "error", "value": null })).is_err());
    }
}
