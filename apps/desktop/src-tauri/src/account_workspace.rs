//! Focused native account/workspace lifecycle adapter.
//!
//! Renderer code can call only the commands in this module. Clerk bearer
//! credentials, Convex paths, internal-user IDs, idempotency keys, and the
//! per-install device identity remain native concerns.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    active_context_owner: Option<ActiveContextOwner>,
    devices: Vec<directory::AccountDeviceSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveContextOwner {
    internal_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    member_id: Option<String>,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedInvitation {
    invitation_id: String,
    workspace_id: String,
    authority: String,
    schema_version: i64,
    revision: i64,
    created_by_internal_user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_by_device_id: Option<String>,
    created_at: String,
    updated_at: String,
    status: String,
    role: String,
    inviter_member_id: String,
    recipient_constraint: InvitationRecipientConstraint,
    expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_by_internal_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_membership_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accepted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revoked_by_member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revoked_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum InvitationRecipientConstraint {
    InternalUser {
        internal_user_id: String,
    },
    VerifiedIdentityAttribute {
        attribute_kind: String,
        normalized_value_hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_hint: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectInboxSelection {
    kind: String,
    invitation_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedPendingInvitation {
    invitation: HostedInvitation,
    selection: DirectInboxSelection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPendingInvitationList {
    invitations: Vec<HostedPendingInvitation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedMembership {
    workspace_id: String,
    authority: String,
    schema_version: i64,
    revision: i64,
    created_by_internal_user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_by_device_id: Option<String>,
    created_at: String,
    updated_at: String,
    member_id: String,
    internal_user_id: String,
    role: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    joined_from_invitation_id: Option<String>,
    activated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    suspended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    removed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LifecycleIdempotencyReceipt {
    key: String,
    replayed: bool,
    recorded_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FailClosedAuthorizationError {
    r#type: String,
    code: String,
    message: String,
    retryable: bool,
    disclosure: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum HostedAcceptanceResult {
    Accepted {
        invitation: HostedInvitation,
        membership: HostedMembership,
        idempotency: LifecycleIdempotencyReceipt,
    },
    Conflict {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        invitation_status: Option<String>,
        error: FailClosedAuthorizationError,
    },
    Rejected {
        error: FailClosedAuthorizationError,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInvitationAcceptanceOutcome {
    result: HostedAcceptanceResult,
    account_workspace: AccountWorkspaceStatus,
    reconciliation: InvitationReconciliation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationReconciliation {
    status: String,
    message: String,
}

struct AcceptanceWithReconciliation {
    result: HostedAcceptanceResult,
    reconciliation: InvitationReconciliation,
}

type HostedFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

trait HostedAccountTransport: Send + Sync {
    fn call<'a>(
        &'a self,
        function_type: ConvexFunctionType,
        path: &'a str,
        args: Value,
    ) -> HostedFuture<'a>;
}

struct NativeHostedAccountTransport;

impl HostedAccountTransport for NativeHostedAccountTransport {
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

fn valid_iso(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_role(value: &str) -> bool {
    ["owner", "admin", "editor", "viewer"].contains(&value)
}

fn validate_invitation(record: &HostedInvitation) -> Result<(), String> {
    let recipient_is_valid = match &record.recipient_constraint {
        InvitationRecipientConstraint::InternalUser { internal_user_id } => {
            valid_id(internal_user_id)
        }
        InvitationRecipientConstraint::VerifiedIdentityAttribute {
            attribute_kind,
            normalized_value_hash,
            display_hint,
        } => {
            ["email", "phone"].contains(&attribute_kind.as_str())
                && !normalized_value_hash.trim().is_empty()
                && display_hint
                    .as_ref()
                    .is_none_or(|hint| !hint.trim().is_empty())
        }
    };
    if !valid_id(&record.invitation_id)
        || !valid_id(&record.workspace_id)
        || record.authority != "convex"
        || record.schema_version != 1
        || record.revision < 1
        || !valid_id(&record.created_by_internal_user_id)
        || record
            .created_by_device_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || !valid_iso(&record.created_at)
        || !valid_iso(&record.updated_at)
        || !valid_iso(&record.expires_at)
        || !valid_role(&record.role)
        || !valid_id(&record.inviter_member_id)
        || !["pending", "accepted", "revoked", "expired"].contains(&record.status.as_str())
        || !recipient_is_valid
        || record
            .accepted_by_internal_user_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || record
            .accepted_membership_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || record
            .accepted_at
            .as_ref()
            .is_some_and(|value| !valid_iso(value))
        || record
            .revoked_by_member_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || record
            .revoked_at
            .as_ref()
            .is_some_and(|value| !valid_iso(value))
    {
        return Err("The hosted invitation record failed validation.".into());
    }
    Ok(())
}

fn validate_membership(record: &HostedMembership) -> Result<(), String> {
    if !valid_id(&record.workspace_id)
        || record.authority != "convex"
        || record.schema_version != 1
        || record.revision < 1
        || !valid_id(&record.created_by_internal_user_id)
        || record
            .created_by_device_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || !valid_iso(&record.created_at)
        || !valid_iso(&record.updated_at)
        || !valid_id(&record.member_id)
        || !valid_id(&record.internal_user_id)
        || !valid_role(&record.role)
        || !["active", "suspended", "removed"].contains(&record.status.as_str())
        || record
            .joined_from_invitation_id
            .as_ref()
            .is_some_and(|value| !valid_id(value))
        || !valid_iso(&record.activated_at)
        || record
            .suspended_at
            .as_ref()
            .is_some_and(|value| !valid_iso(value))
        || record
            .removed_at
            .as_ref()
            .is_some_and(|value| !valid_iso(value))
    {
        return Err("The hosted membership record failed validation.".into());
    }
    Ok(())
}

fn validate_authorization_error(error: &FailClosedAuthorizationError) -> Result<(), String> {
    const CODES: &[&str] = &[
        "unauthenticated",
        "invalid-authentication",
        "authentication-expired",
        "authentication-revoked",
        "identity-link-not-found",
        "identity-link-inactive",
        "identity-link-conflict",
        "internal-user-inactive",
        "workspace-unavailable",
        "membership-required",
        "membership-inactive",
        "permission-denied",
        "role-assignment-denied",
        "last-active-owner",
        "invitation-unavailable",
        "invitation-expired",
        "invitation-recipient-mismatch",
        "invitation-already-consumed",
        "device-required",
        "device-unavailable",
        "device-inactive",
        "session-ineligible",
        "online-reauthentication-required",
        "stale-policy",
        "stale-revision",
        "idempotency-conflict",
        "conflict",
    ];
    if error.r#type != "authorization-error"
        || !CODES.contains(&error.code.as_str())
        || error.message.trim().is_empty()
        || !["opaque", "safe"].contains(&error.disclosure.as_str())
    {
        return Err("The hosted authorization outcome failed validation.".into());
    }
    let _ = error.retryable;
    Ok(())
}

fn parse_pending_invitations(value: Value) -> Result<AccountPendingInvitationList, String> {
    let invitations: Vec<HostedPendingInvitation> = serde_json::from_value(value)
        .map_err(|_| "The hosted invitation inbox response is malformed.".to_string())?;
    let mut ids = BTreeSet::new();
    for item in &invitations {
        validate_invitation(&item.invitation)?;
        if item.invitation.status != "pending"
            || item.selection.kind != "direct-inbox"
            || item.selection.invitation_id != item.invitation.invitation_id
            || !matches!(
                item.invitation.recipient_constraint,
                InvitationRecipientConstraint::InternalUser { .. }
            )
            || item.invitation.accepted_by_internal_user_id.is_some()
            || item.invitation.accepted_membership_id.is_some()
            || item.invitation.accepted_at.is_some()
            || item.invitation.revoked_by_member_id.is_some()
            || item.invitation.revoked_at.is_some()
            || !ids.insert(item.invitation.invitation_id.clone())
        {
            return Err(
                "The hosted invitation inbox contains an invalid or ambiguous entry.".into(),
            );
        }
    }
    Ok(AccountPendingInvitationList { invitations })
}

fn parse_acceptance_result(
    value: Value,
    expected_invitation_id: &str,
    expected_idempotency_key: &str,
) -> Result<HostedAcceptanceResult, String> {
    let result: HostedAcceptanceResult = serde_json::from_value(value)
        .map_err(|_| "The hosted invitation acceptance response is malformed.".to_string())?;
    match &result {
        HostedAcceptanceResult::Accepted {
            invitation,
            membership,
            idempotency,
        } => {
            validate_invitation(invitation)?;
            validate_membership(membership)?;
            if invitation.invitation_id != expected_invitation_id
                || invitation.status != "accepted"
                || membership.status != "active"
                || invitation.workspace_id != membership.workspace_id
                || invitation.role != membership.role
                || invitation.accepted_by_internal_user_id.as_deref()
                    != Some(membership.internal_user_id.as_str())
                || invitation.accepted_membership_id.as_deref()
                    != Some(membership.member_id.as_str())
                || invitation.accepted_at.is_none()
                || idempotency.key != expected_idempotency_key
                || !valid_iso(&idempotency.recorded_at)
            {
                return Err("The hosted invitation acceptance failed validation.".into());
            }
            let _ = idempotency.replayed;
        }
        HostedAcceptanceResult::Conflict {
            invitation_status,
            error,
        } => {
            validate_authorization_error(error)?;
            if invitation_status.as_ref().is_some_and(|status| {
                !["pending", "accepted", "revoked", "expired"].contains(&status.as_str())
            }) {
                return Err("The hosted invitation conflict failed validation.".into());
            }
        }
        HostedAcceptanceResult::Rejected { error } => validate_authorization_error(error)?,
    }
    Ok(result)
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

async fn reconcile_hosted_with_transport(
    transport: &dyn HostedAccountTransport,
    idempotency_key: &str,
    store: &crate::store::Store,
) -> Result<(), String> {
    // Create the stable local ID now even though this version cannot honestly
    // register it with the hosted `publicKey`-requiring endpoint.
    let _install_device_id = ensure_install_device_id();
    let bootstrap = parse_bootstrap(
        transport
            .call(
                ConvexFunctionType::Mutation,
                "workspace:bootstrapAccount",
                json!({ "idempotencyKey": idempotency_key }),
            )
            .await?,
        idempotency_key,
    )?;
    let workspaces = parse_workspaces(
        transport
            .call(ConvexFunctionType::Query, "workspace:listMine", json!({}))
            .await?,
    )?;
    let initial = workspaces
        .iter()
        .find(|workspace| workspace.workspace_id == bootstrap.workspace_id)
        .ok_or_else(|| "The hosted workspace list omitted the bootstrap workspace.".to_string())?;
    if initial.member_id != bootstrap.member_id {
        return Err("The hosted workspace list did not match the bootstrap membership.".into());
    }
    let devices = parse_devices(
        transport
            .call(ConvexFunctionType::Query, "device:listMine", json!({}))
            .await?,
    )?;
    let observed_at = now();
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

async fn reconcile_hosted() -> Result<(), String> {
    let idempotency_key = clerk_identity::native_bootstrap_idempotency_key().await?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    reconcile_hosted_with_transport(&NativeHostedAccountTransport, &idempotency_key, store).await
}

async fn pending_invitations_with_transport(
    transport: &dyn HostedAccountTransport,
) -> Result<AccountPendingInvitationList, String> {
    parse_pending_invitations(
        transport
            .call(
                ConvexFunctionType::Query,
                "membership:listRecipientPending",
                json!({}),
            )
            .await?,
    )
}

async fn accept_invitation_with_transport(
    transport: &dyn HostedAccountTransport,
    invitation_id: &str,
    idempotency_key: &str,
    bootstrap_idempotency_key: &str,
    store: &crate::store::Store,
) -> Result<AcceptanceWithReconciliation, String> {
    let result = parse_acceptance_result(
        transport
            .call(
                ConvexFunctionType::Mutation,
                "membership:acceptInvitation",
                json!({
                    "invitationId": invitation_id,
                    "presentation": { "kind": "direct-inbox", "invitationId": invitation_id },
                    "idempotencyKey": idempotency_key,
                }),
            )
            .await?,
        invitation_id,
        idempotency_key,
    )?;
    let reconciliation = if matches!(result, HostedAcceptanceResult::Accepted { .. }) {
        match reconcile_hosted_with_transport(transport, bootstrap_idempotency_key, store).await {
            Ok(()) => InvitationReconciliation {
                status: "refreshed".into(),
                message: "Workspace list is up to date.".into(),
            },
            Err(_message) => InvitationReconciliation {
                status: "refresh-needed".into(),
                message: "Invitation accepted, but Fable could not refresh the workspace list yet."
                    .into(),
            },
        }
    } else {
        InvitationReconciliation {
            status: "not-needed".into(),
            message: "Workspace list did not need to change.".into(),
        }
    };
    Ok(AcceptanceWithReconciliation {
        result,
        reconciliation,
    })
}

fn local_status(
    identity: &clerk_identity::IdentityStatus,
) -> Result<AccountWorkspaceStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (workspaces, active_workspace, active_context_owner, devices) = store
        .with_conn(|conn| {
            let workspaces = directory::list_authoritative_summaries_for_current_user(conn)?;
            let devices = directory::list_account_device_summaries_for_current_user(conn)?;
            let active_workspace = directory::resolve_active_workspace_for_current_user(conn)?;
            let active_context_owner =
                directory::require_active_workspace_context_for_current_user(conn)
                    .ok()
                    .map(|context| ActiveContextOwner {
                        internal_user_id: context.internal_user_id,
                        member_id: context.member_id,
                    });
            Ok((workspaces, active_workspace, active_context_owner, devices))
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
        active_context_owner,
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
pub async fn account_membership_pending_invitations() -> Result<AccountPendingInvitationList, String>
{
    pending_invitations_with_transport(&NativeHostedAccountTransport).await
}

#[tauri::command]
pub async fn account_membership_accept_invitation(
    invitation_id: String,
) -> Result<AccountInvitationAcceptanceOutcome, String> {
    if !valid_id(&invitation_id) {
        return Err("Invitation id is invalid.".into());
    }
    let idempotency_key = opaque_id("invitation_accept")?;
    let bootstrap_idempotency_key = clerk_identity::native_bootstrap_idempotency_key().await?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let accepted = accept_invitation_with_transport(
        &NativeHostedAccountTransport,
        &invitation_id,
        &idempotency_key,
        &bootstrap_idempotency_key,
        store,
    )
    .await?;
    let account_workspace = account_workspace_status().await?;
    Ok(AccountInvitationAcceptanceOutcome {
        result: accepted.result,
        account_workspace,
        reconciliation: accepted.reconciliation,
    })
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
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct ScriptStep {
        mutation: bool,
        path: &'static str,
        args: Value,
        result: Value,
    }

    struct ScriptedTransport {
        steps: Mutex<VecDeque<ScriptStep>>,
    }

    impl ScriptedTransport {
        fn new(steps: Vec<ScriptStep>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
            }
        }

        fn finished(&self) -> bool {
            self.steps.lock().unwrap().is_empty()
        }
    }

    impl HostedAccountTransport for ScriptedTransport {
        fn call<'a>(
            &'a self,
            function_type: ConvexFunctionType,
            path: &'a str,
            args: Value,
        ) -> HostedFuture<'a> {
            let step = self.steps.lock().unwrap().pop_front().unwrap();
            let is_mutation = matches!(function_type, ConvexFunctionType::Mutation);
            Box::pin(async move {
                assert_eq!(is_mutation, step.mutation);
                assert_eq!(path, step.path);
                assert_eq!(args, step.args);
                if let Some(message) = step.result.get("__error").and_then(Value::as_str) {
                    return Err(message.to_string());
                }
                Ok(step.result)
            })
        }
    }

    fn invitation(id: &str, status: &str) -> Value {
        json!({
            "invitationId": id, "workspaceId": "ws_shared", "authority": "convex",
            "schemaVersion": 1, "revision": if status == "pending" { 1 } else { 2 },
            "createdByInternalUserId": "usr_owner", "createdAt": "2026-07-11T08:00:00.000Z",
            "updatedAt": "2026-07-11T08:01:00.000Z", "status": status, "role": "editor",
            "inviterMemberId": "member_owner", "recipientConstraint": { "kind": "internal-user", "internalUserId": "usr_recipient" },
            "expiresAt": "2026-07-12T08:00:00.000Z"
        })
    }

    fn accepted_invitation(id: &str) -> Value {
        let mut value = invitation(id, "accepted");
        let object = value.as_object_mut().unwrap();
        object.insert("acceptedByInternalUserId".into(), json!("usr_recipient"));
        object.insert("acceptedMembershipId".into(), json!("member_shared"));
        object.insert("acceptedAt".into(), json!("2026-07-11T08:01:00.000Z"));
        value
    }

    fn membership(invitation_id: &str) -> Value {
        json!({
            "workspaceId": "ws_shared", "authority": "convex", "schemaVersion": 1,
            "revision": 1, "createdByInternalUserId": "usr_owner",
            "createdAt": "2026-07-11T08:01:00.000Z", "updatedAt": "2026-07-11T08:01:00.000Z",
            "memberId": "member_shared", "internalUserId": "usr_recipient", "role": "editor",
            "status": "active", "joinedFromInvitationId": invitation_id,
            "activatedAt": "2026-07-11T08:01:00.000Z"
        })
    }

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

    #[test]
    fn pending_invitation_parser_rejects_malformed_duplicate_and_nonpending_entries() {
        let pending = json!({
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" }
        });
        assert!(parse_pending_invitations(json!([pending.clone()])).is_ok());
        assert!(parse_pending_invitations(json!([pending.clone(), pending])).is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "accepted"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" }
        }]))
        .is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "other" }
        }]))
        .is_err());
    }

    #[test]
    fn acceptance_parser_preserves_validated_rejection_and_fails_closed() {
        let rejected = json!({
            "status": "rejected",
            "error": { "type": "authorization-error", "code": "invitation-recipient-mismatch", "message": "Unavailable.", "retryable": false, "disclosure": "opaque" }
        });
        assert!(matches!(
            parse_acceptance_result(rejected, "inv_a", "native_key").unwrap(),
            HostedAcceptanceResult::Rejected { .. }
        ));
        let mut mismatched_membership = membership("historical_invitation");
        mismatched_membership
            .as_object_mut()
            .unwrap()
            .insert("internalUserId".into(), json!("usr_other"));
        let malformed = json!({
            "status": "accepted", "invitation": accepted_invitation("inv_a"),
            "membership": mismatched_membership,
            "idempotency": { "key": "native_key", "replayed": false, "recordedAt": "2026-07-11T08:01:00.000Z" }
        });
        assert!(parse_acceptance_result(malformed, "inv_a", "native_key").is_err());
    }

    #[tokio::test]
    async fn scripted_pending_accept_reconcile_survives_store_reopen() {
        let pending = json!({
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" }
        });
        let transport = ScriptedTransport::new(vec![
            ScriptStep {
                mutation: false,
                path: "membership:listRecipientPending",
                args: json!({}),
                result: json!([pending]),
            },
            ScriptStep {
                mutation: true,
                path: "membership:acceptInvitation",
                args: json!({
                    "invitationId": "inv_a",
                    "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                    "idempotencyKey": "native_accept_key"
                }),
                result: json!({
                    "status": "accepted", "invitation": accepted_invitation("inv_a"),
                    "membership": membership("inv_a"),
                    "idempotency": { "key": "native_accept_key", "replayed": false, "recordedAt": "2026-07-11T08:01:00.000Z" }
                }),
            },
            ScriptStep {
                mutation: true,
                path: "workspace:bootstrapAccount",
                args: json!({ "idempotencyKey": "bootstrap_key" }),
                result: json!({
                    "status": "existing", "internalUserId": "usr_recipient", "workspaceId": "ws_home", "memberId": "member_home",
                    "idempotency": { "key": "bootstrap_key", "replayed": true }
                }),
            },
            ScriptStep {
                mutation: false,
                path: "workspace:listMine",
                args: json!({}),
                result: json!([
                    { "workspaceId": "ws_home", "name": "Home", "revision": 0, "policyRevision": 1, "memberId": "member_home", "role": "owner", "membershipRevision": 1 },
                    { "workspaceId": "ws_shared", "name": "Shared", "revision": 2, "policyRevision": 1, "memberId": "member_shared", "role": "editor", "membershipRevision": 1 }
                ]),
            },
            ScriptStep {
                mutation: false,
                path: "device:listMine",
                args: json!({}),
                result: json!([]),
            },
        ]);
        let inbox = pending_invitations_with_transport(&transport)
            .await
            .unwrap();
        assert_eq!(inbox.invitations.len(), 1);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("invitation-native.db");
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open(&path, crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        let accepted = accept_invitation_with_transport(
            &transport,
            "inv_a",
            "native_accept_key",
            "bootstrap_key",
            &store,
        )
        .await
        .unwrap();
        assert!(matches!(
            &accepted.result,
            HostedAcceptanceResult::Accepted { .. }
        ));
        assert_eq!(accepted.reconciliation.status, "refreshed");
        assert!(transport.finished());
        drop(store);

        let reopened =
            crate::store::Store::open(&path, crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        let summaries = reopened
            .with_conn(|conn| directory::list_authoritative_summaries(conn, "usr_recipient"))
            .unwrap();
        assert_eq!(summaries.len(), 2);
        assert!(summaries.iter().any(|entry| {
            entry.fable_workspace_id == "ws_shared"
                && entry.member_id == "member_shared"
                && entry.role == "editor"
        }));
        let serialized = serde_json::to_string(&accepted.result).unwrap();
        assert!(!serialized.contains("token"));
    }

    #[tokio::test]
    async fn accepted_outcome_survives_reconciliation_failure() {
        let transport = ScriptedTransport::new(vec![
            ScriptStep {
                mutation: true,
                path: "membership:acceptInvitation",
                args: json!({
                    "invitationId": "inv_a",
                    "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                    "idempotencyKey": "native_accept_key"
                }),
                result: json!({
                    "status": "accepted", "invitation": accepted_invitation("inv_a"),
                    "membership": membership("inv_a"),
                    "idempotency": { "key": "native_accept_key", "replayed": false, "recordedAt": "2026-07-11T08:01:00.000Z" }
                }),
            },
            ScriptStep {
                mutation: true,
                path: "workspace:bootstrapAccount",
                args: json!({ "idempotencyKey": "bootstrap_key" }),
                result: json!({ "__error": "refresh unavailable" }),
            },
        ]);
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open_in_memory(crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        let accepted = accept_invitation_with_transport(
            &transport,
            "inv_a",
            "native_accept_key",
            "bootstrap_key",
            &store,
        )
        .await
        .unwrap();
        assert!(matches!(
            &accepted.result,
            HostedAcceptanceResult::Accepted { .. }
        ));
        assert_eq!(accepted.reconciliation.status, "refresh-needed");
        assert_eq!(
            accepted.reconciliation.message,
            "Invitation accepted, but Fable could not refresh the workspace list yet."
        );
        assert!(!serde_json::to_string(&accepted.reconciliation)
            .unwrap()
            .contains("refresh unavailable"));
        assert!(transport.finished());
    }
}
