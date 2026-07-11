//! Focused native account/workspace lifecycle adapter.
//!
//! Renderer code can call only the commands in this module. Clerk bearer
//! credentials, Convex paths, internal-user IDs, idempotency keys, and the
//! per-install device identity remain native concerns.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::store::repos::workspace_directory as directory;

const DEVICE_KEYRING_SERVICE: &str = "com.fable.workspace.account-device";
const DEVICE_KEYRING_ENTRY: &str = "install-device-id";
const ACCOUNT_CHANGED_ERROR: &str = "Fable account changed during the request. Please try again.";
const MEMBER_ACTION_REF_LIMIT: usize = 2_000;
const WORKSPACE_CONTEXT_CHANGED_ERROR: &str =
    "The active workspace changed during the request. Please try again.";

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
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
    workspace_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPendingInvitationList {
    invitations: Vec<HostedPendingInvitation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedWorkspaceMemberManagement {
    allowed_roles: Vec<String>,
    allowed_actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedAccountWorkspaceMemberSummary {
    member_id: String,
    role: String,
    status: String,
    revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email_hint: Option<String>,
    is_current_user: bool,
    management: HostedWorkspaceMemberManagement,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedAccountWorkspaceMemberList {
    workspace_id: String,
    actor_role: String,
    members: Vec<HostedAccountWorkspaceMemberSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountWorkspaceMemberManagement {
    allowed_roles: Vec<String>,
    allowed_actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountWorkspaceMemberSummary {
    member_action_ref: String,
    role: String,
    status: String,
    revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email_hint: Option<String>,
    is_current_user: bool,
    management: AccountWorkspaceMemberManagement,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountWorkspaceMemberList {
    workspace_id: String,
    actor_role: String,
    members: Vec<AccountWorkspaceMemberSummary>,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountWorkspaceMemberChangeRequest {
    member_action_ref: String,
    action: String,
    expected_revision: i64,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AccountWorkspaceMemberChangeOutcome {
    Accepted { message: String },
    Conflict { code: String, message: String },
    Rejected { code: String, message: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LastOwnerSafety {
    Safe {
        remaining_active_owner_count: i64,
    },
    Blocked {
        remaining_active_owner_count: i64,
        error: FailClosedAuthorizationError,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum HostedMemberChangeResult {
    Accepted {
        membership: HostedMembership,
        last_owner_safety: LastOwnerSafety,
        idempotency: LifecycleIdempotencyReceipt,
    },
    Conflict {
        #[serde(default)]
        current_membership: Option<HostedMembership>,
        #[serde(default)]
        last_owner_safety: Option<LastOwnerSafety>,
        error: FailClosedAuthorizationError,
    },
    Rejected {
        #[serde(default)]
        current_membership: Option<HostedMembership>,
        #[serde(default)]
        last_owner_safety: Option<LastOwnerSafety>,
        error: FailClosedAuthorizationError,
    },
}

#[derive(Clone, Debug)]
struct MemberActionGrant {
    identity: AccountIdentitySnapshot,
    internal_user_id: String,
    workspace_id: String,
    current_member_id: String,
    target_member_id: String,
    target_role: String,
    target_status: String,
    target_revision: i64,
    allowed_roles: BTreeSet<String>,
    allowed_actions: BTreeSet<String>,
}

#[derive(Default)]
struct MemberActionRegistry {
    grants: BTreeMap<String, MemberActionGrant>,
    order: VecDeque<String>,
}

impl MemberActionRegistry {
    fn replace_context(
        &mut self,
        identity: &AccountIdentitySnapshot,
        context: &directory::AuthorizedWorkspaceContext,
        roster: HostedAccountWorkspaceMemberList,
    ) -> Result<AccountWorkspaceMemberList, String> {
        let workspace_id = context
            .active_workspace
            .fable_workspace_id
            .as_deref()
            .ok_or_else(|| "The active hosted workspace is unavailable.".to_string())?;
        let current_member_id = context
            .member_id
            .as_deref()
            .ok_or_else(|| "The active workspace membership is unavailable.".to_string())?;
        // The desktop exposes one active account/workspace context. A roster
        // refresh or context switch invalidates every previously issued ref.
        self.grants.clear();
        self.order.clear();

        let mut members = Vec::with_capacity(roster.members.len());
        for member in roster.members {
            let member_action_ref = opaque_id("member_action")?;
            let grant = MemberActionGrant {
                identity: identity.clone(),
                internal_user_id: context.internal_user_id.clone(),
                workspace_id: workspace_id.to_string(),
                current_member_id: current_member_id.to_string(),
                target_member_id: member.member_id,
                target_role: member.role.clone(),
                target_status: member.status.clone(),
                target_revision: member.revision,
                allowed_roles: member.management.allowed_roles.iter().cloned().collect(),
                allowed_actions: member.management.allowed_actions.iter().cloned().collect(),
            };
            self.order.push_back(member_action_ref.clone());
            self.grants.insert(member_action_ref.clone(), grant);
            members.push(AccountWorkspaceMemberSummary {
                member_action_ref,
                role: member.role,
                status: member.status,
                revision: member.revision,
                display_name: member.display_name,
                email_hint: member.email_hint,
                is_current_user: member.is_current_user,
                management: AccountWorkspaceMemberManagement {
                    allowed_roles: member.management.allowed_roles,
                    allowed_actions: member.management.allowed_actions,
                    blocked_reason: member.management.blocked_reason,
                },
            });
        }
        while self.grants.len() > MEMBER_ACTION_REF_LIMIT {
            if let Some(reference) = self.order.pop_front() {
                self.grants.remove(&reference);
            }
        }
        Ok(AccountWorkspaceMemberList {
            workspace_id: roster.workspace_id,
            actor_role: roster.actor_role,
            members,
        })
    }

    fn resolve(&self, reference: &str) -> Result<MemberActionGrant, String> {
        self.grants
            .get(reference)
            .cloned()
            .ok_or_else(|| "Refresh the member list before changing access.".to_string())
    }
}

fn member_action_registry() -> &'static Mutex<MemberActionRegistry> {
    static REGISTRY: OnceLock<Mutex<MemberActionRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(MemberActionRegistry::default()))
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
    result: AccountInvitationAcceptanceDecision,
    account_workspace: AccountWorkspaceStatus,
    reconciliation: InvitationReconciliation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationReconciliation {
    status: String,
    message: String,
}

#[derive(Debug)]
struct AcceptanceWithReconciliation {
    result: HostedAcceptanceResult,
    reconciliation: InvitationReconciliation,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum AccountInvitationAcceptanceDecision {
    Accepted {
        invitation_id: String,
        workspace_id: String,
        role: String,
    },
    Conflict {
        code: String,
        message: String,
    },
    Rejected {
        code: String,
        message: String,
    },
}

type HostedFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

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

trait ActiveContextSource: Send + Sync {
    fn active_context(&self) -> Result<directory::AuthorizedWorkspaceContext, String>;
}

struct NativeActiveContextSource;

impl ActiveContextSource for NativeActiveContextSource {
    fn active_context(&self) -> Result<directory::AuthorizedWorkspaceContext, String> {
        crate::store::try_global()
            .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?
            .with_conn(directory::require_active_workspace_context_for_current_user)
            .map_err(|error| error.to_string())
    }
}

type HostedStringFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

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
        let native = clerk_identity::NativeIdentityGenerationSnapshot {
            account_binding: expected.account_binding.clone(),
            generation: expected.generation,
        };
        clerk_identity::lock_native_identity_generation(&native)
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
        .map_err(|_| "Fable could not create a secure account request.".to_string())?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn invitation_acceptance_idempotency_key(
    account_binding: &str,
    invitation_id: &str,
) -> Result<String, String> {
    if !valid_id(account_binding) || !valid_id(invitation_id) {
        return Err("Fable could not bind the invitation request.".into());
    }
    let mut digest = Sha256::new();
    digest.update(b"fable.account-invitation.accept.v1\0");
    digest.update(account_binding.as_bytes());
    digest.update(b"\0");
    digest.update(invitation_id.as_bytes());
    Ok(format!(
        "invitation_accept_{}",
        URL_SAFE_NO_PAD.encode(digest.finalize())
    ))
}

fn member_change_idempotency_key(
    account_binding: &str,
    request: &AccountWorkspaceMemberChangeRequest,
) -> Result<String, String> {
    if !valid_id(account_binding)
        || !valid_id(&request.member_action_ref)
        || request.expected_revision < 0
    {
        return Err("Fable could not bind the member access request.".into());
    }
    let mut digest = Sha256::new();
    digest.update(b"fable.account-membership.change.v1\0");
    for value in [
        account_binding,
        request.member_action_ref.as_str(),
        request.action.as_str(),
        request.role.as_deref().unwrap_or("-"),
    ] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    digest.update(request.expected_revision.to_be_bytes());
    Ok(format!(
        "member_change_{}",
        URL_SAFE_NO_PAD.encode(digest.finalize())
    ))
}

fn context_matches_grant(
    context: &directory::AuthorizedWorkspaceContext,
    grant: &MemberActionGrant,
) -> bool {
    context.internal_user_id == grant.internal_user_id
        && context.active_workspace.fable_workspace_id.as_deref()
            == Some(grant.workspace_id.as_str())
        && context.member_id.as_deref() == Some(grant.current_member_id.as_str())
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

fn is_control_or_format(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{00ad}'
                | '\u{061c}'
                | '\u{06dd}'
                | '\u{070f}'
                | '\u{08e2}'
                | '\u{180e}'
                | '\u{feff}'
                | '\u{110bd}'
                | '\u{110cd}'
                | '\u{e0001}'
        )
        || ('\u{0600}'..='\u{0605}').contains(&value)
        || ('\u{0890}'..='\u{0891}').contains(&value)
        || ('\u{200b}'..='\u{200f}').contains(&value)
        || ('\u{202a}'..='\u{202e}').contains(&value)
        || ('\u{2060}'..='\u{2064}').contains(&value)
        || ('\u{2066}'..='\u{206f}').contains(&value)
        || ('\u{fff9}'..='\u{fffb}').contains(&value)
        || ('\u{13430}'..='\u{1343f}').contains(&value)
        || ('\u{1bca0}'..='\u{1bca3}').contains(&value)
        || ('\u{1d173}'..='\u{1d17a}').contains(&value)
        || ('\u{e0020}'..='\u{e007f}').contains(&value)
}

fn valid_display_name(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.chars().count() <= 120
        && !value.chars().any(is_control_or_format)
}

fn valid_email_hint(value: &str) -> bool {
    if value.is_empty() || value != value.trim() || value.len() > 254 {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 8
        || !(bytes[0].is_ascii_alphanumeric() || bytes[0] == b'*')
        || &bytes[1..5] != b"***@"
    {
        return false;
    }
    let domain = &value[5..];
    if domain.is_empty()
        || domain.len() > 253
        || domain != domain.to_ascii_lowercase()
        || !domain.is_ascii()
    {
        return false;
    }
    let labels = domain.split('.').collect::<Vec<_>>();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
        })
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
        || error.message != error.message.trim()
        || error.message.chars().count() > 500
        || error.message.chars().any(is_control_or_format)
        || !["opaque", "safe"].contains(&error.disclosure.as_str())
    {
        return Err("The hosted authorization outcome failed validation.".into());
    }
    let _ = error.retryable;
    Ok(())
}

fn validate_member_change_request(
    grant: &MemberActionGrant,
    request: &AccountWorkspaceMemberChangeRequest,
) -> Result<(), String> {
    if request.expected_revision < 0 || request.expected_revision != grant.target_revision {
        return Err("The member list is out of date. Refresh it and try again.".into());
    }
    match request.action.as_str() {
        "change-role" => {
            let role = request
                .role
                .as_deref()
                .filter(|role| valid_role(role))
                .ok_or_else(|| "Choose a valid workspace role.".to_string())?;
            if !grant.allowed_roles.contains(role) || role == grant.target_role {
                return Err("This role change is unavailable. Refresh the member list.".into());
            }
        }
        "suspend" | "reactivate" | "remove" => {
            if request.role.is_some() || !grant.allowed_actions.contains(&request.action) {
                return Err("This access change is unavailable. Refresh the member list.".into());
            }
        }
        _ => return Err("The member access action is invalid.".into()),
    }
    Ok(())
}

fn validate_member_transition(
    membership: &HostedMembership,
    grant: &MemberActionGrant,
    request: &AccountWorkspaceMemberChangeRequest,
) -> bool {
    if membership.workspace_id != grant.workspace_id
        || membership.member_id != grant.target_member_id
        || membership.revision != grant.target_revision + 1
    {
        return false;
    }
    match request.action.as_str() {
        "change-role" => {
            membership.role == request.role.as_deref().unwrap_or_default()
                && membership.status == grant.target_status
        }
        "suspend" => membership.role == grant.target_role && membership.status == "suspended",
        "reactivate" => membership.role == grant.target_role && membership.status == "active",
        "remove" => membership.role == grant.target_role && membership.status == "removed",
        _ => false,
    }
}

fn validate_blocked_last_owner(
    safety: Option<&LastOwnerSafety>,
    error: &FailClosedAuthorizationError,
) -> Result<(), String> {
    if error.code != "last-active-owner" {
        if safety.is_some() {
            return Err("The hosted member access safety response is ambiguous.".into());
        }
        return Ok(());
    }
    match safety {
        Some(LastOwnerSafety::Blocked {
            remaining_active_owner_count,
            error: safety_error,
        }) if *remaining_active_owner_count == 0 => {
            validate_authorization_error(safety_error)?;
            if safety_error.code != error.code || safety_error.message != error.message {
                return Err("The hosted member access safety response did not match.".into());
            }
            Ok(())
        }
        _ => Err("The hosted member access safety response failed validation.".into()),
    }
}

fn parse_member_change_result(
    value: Value,
    grant: &MemberActionGrant,
    request: &AccountWorkspaceMemberChangeRequest,
    expected_idempotency_key: &str,
) -> Result<AccountWorkspaceMemberChangeOutcome, String> {
    let result: HostedMemberChangeResult = serde_json::from_value(value)
        .map_err(|_| "The hosted member access response is malformed.".to_string())?;
    match result {
        HostedMemberChangeResult::Accepted {
            membership,
            last_owner_safety,
            idempotency,
        } => {
            validate_membership(&membership)?;
            if !validate_member_transition(&membership, grant, request)
                || idempotency.key != expected_idempotency_key
                || !valid_iso(&idempotency.recorded_at)
                || !matches!(
                    last_owner_safety,
                    LastOwnerSafety::Safe {
                        remaining_active_owner_count: 1..
                    }
                )
            {
                return Err("The hosted member access response failed validation.".into());
            }
            let _ = idempotency.replayed;
            Ok(AccountWorkspaceMemberChangeOutcome::Accepted {
                message: "Workspace access updated.".into(),
            })
        }
        HostedMemberChangeResult::Conflict {
            current_membership,
            last_owner_safety,
            error,
        } => {
            validate_authorization_error(&error)?;
            validate_blocked_last_owner(last_owner_safety.as_ref(), &error)?;
            if let Some(membership) = &current_membership {
                validate_membership(membership)?;
                if membership.workspace_id != grant.workspace_id
                    || membership.member_id != grant.target_member_id
                {
                    return Err(
                        "The hosted member access conflict did not match the target.".into(),
                    );
                }
            }
            Ok(AccountWorkspaceMemberChangeOutcome::Conflict {
                code: error.code,
                message: error.message,
            })
        }
        HostedMemberChangeResult::Rejected {
            current_membership,
            last_owner_safety,
            error,
        } => {
            validate_authorization_error(&error)?;
            validate_blocked_last_owner(last_owner_safety.as_ref(), &error)?;
            if let Some(membership) = &current_membership {
                validate_membership(membership)?;
                if membership.workspace_id != grant.workspace_id
                    || membership.member_id != grant.target_member_id
                {
                    return Err(
                        "The hosted member access rejection did not match the target.".into(),
                    );
                }
            }
            Ok(AccountWorkspaceMemberChangeOutcome::Rejected {
                code: error.code,
                message: error.message,
            })
        }
    }
}

fn parse_pending_invitations(value: Value) -> Result<AccountPendingInvitationList, String> {
    let invitations: Vec<HostedPendingInvitation> = serde_json::from_value(value)
        .map_err(|_| "The hosted invitation inbox response is malformed.".to_string())?;
    let mut ids = BTreeSet::new();
    for item in &invitations {
        validate_invitation(&item.invitation)?;
        if item.invitation.status != "pending"
            || item.workspace_name.trim().is_empty()
            || item.workspace_name.chars().count() > 160
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

fn parse_workspace_members(
    value: Value,
    expected_workspace_id: &str,
    expected_current_member_id: &str,
) -> Result<HostedAccountWorkspaceMemberList, String> {
    let roster: HostedAccountWorkspaceMemberList = serde_json::from_value(value)
        .map_err(|_| "The hosted workspace member response is malformed.".to_string())?;
    if roster.workspace_id != expected_workspace_id
        || !valid_role(&roster.actor_role)
        || roster.members.len() > 500
    {
        return Err("The hosted workspace member response failed validation.".into());
    }

    let mut member_ids = BTreeSet::new();
    let mut current_members = 0;
    for member in &roster.members {
        let allowed_roles = member
            .management
            .allowed_roles
            .iter()
            .collect::<BTreeSet<_>>();
        let allowed_actions = member
            .management
            .allowed_actions
            .iter()
            .collect::<BTreeSet<_>>();
        let valid_blocked_reason =
            member
                .management
                .blocked_reason
                .as_deref()
                .is_none_or(|reason| {
                    [
                        "current-member",
                        "last-active-owner",
                        "owner-protected",
                        "permission-denied",
                        "unavailable",
                    ]
                    .contains(&reason)
                });
        let valid_role_projection = allowed_roles.len() == member.management.allowed_roles.len()
            && allowed_roles.iter().all(|role| {
                valid_role(role)
                    && role.as_str() != member.role
                    && (roster.actor_role == "owner" || role.as_str() != "owner")
            });
        let valid_action_projection = allowed_actions.len()
            == member.management.allowed_actions.len()
            && allowed_actions.iter().all(|action| {
                matches!(
                    (member.status.as_str(), action.as_str()),
                    ("active", "suspend" | "remove") | ("suspended", "reactivate" | "remove")
                )
            });
        let has_capabilities = !allowed_roles.is_empty() || !allowed_actions.is_empty();
        let projection_shape_is_valid = if member.is_current_user {
            !has_capabilities
                && matches!(
                    member.management.blocked_reason.as_deref(),
                    Some("current-member" | "last-active-owner")
                )
        } else if matches!(roster.actor_role.as_str(), "editor" | "viewer") {
            !has_capabilities
                && member.management.blocked_reason.as_deref() == Some("permission-denied")
        } else if roster.actor_role == "admin" && member.role == "owner" {
            !has_capabilities
                && member.management.blocked_reason.as_deref() == Some("owner-protected")
        } else {
            has_capabilities == member.management.blocked_reason.is_none()
        };
        if !valid_id(&member.member_id)
            || !member_ids.insert(member.member_id.clone())
            || !valid_role(&member.role)
            || !["active", "suspended"].contains(&member.status.as_str())
            || member.revision < 0
            || member
                .display_name
                .as_ref()
                .is_some_and(|value| !valid_display_name(value))
            || member
                .email_hint
                .as_ref()
                .is_some_and(|value| !valid_email_hint(value))
            || !valid_blocked_reason
            || !valid_role_projection
            || !valid_action_projection
            || !projection_shape_is_valid
        {
            return Err("The hosted workspace member list contains an invalid entry.".into());
        }
        if member.is_current_user {
            current_members += 1;
            if member.member_id != expected_current_member_id
                || member.status != "active"
                || member.role != roster.actor_role
            {
                return Err(
                    "The hosted workspace member list does not match the active membership.".into(),
                );
            }
        }
    }
    if current_members != 1 {
        return Err(
            "The hosted workspace member list does not identify the active membership.".into(),
        );
    }
    Ok(roster)
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
    expected_identity: &AccountIdentitySnapshot,
    idempotency_key: &str,
    store: &crate::store::Store,
) -> Result<(), String> {
    // Create the stable local ID now even though this version cannot honestly
    // register it with the hosted `publicKey`-requiring endpoint.
    let _install_device_id = ensure_install_device_id();
    let bootstrap = parse_bootstrap(
        bound_hosted_call(
            transport,
            idempotency_key,
            ConvexFunctionType::Mutation,
            "workspace:bootstrapAccount",
            json!({ "idempotencyKey": idempotency_key }),
        )
        .await?,
        idempotency_key,
    )?;
    let workspaces = parse_workspaces(
        bound_hosted_call(
            transport,
            idempotency_key,
            ConvexFunctionType::Query,
            "workspace:listMine",
            json!({}),
        )
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
        bound_hosted_call(
            transport,
            idempotency_key,
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
    let transport = NativeHostedAccountTransport;
    let identity = transport.identity_snapshot()?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    reconcile_hosted_with_transport(&transport, &identity, &identity.account_binding, store).await
}

async fn pending_invitations_with_transport(
    transport: &dyn HostedAccountTransport,
) -> Result<AccountPendingInvitationList, String> {
    let account_binding = transport
        .account_binding()
        .await
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    parse_pending_invitations(
        bound_hosted_call(
            transport,
            &account_binding,
            ConvexFunctionType::Query,
            "membership:listRecipientPending",
            json!({}),
        )
        .await?,
    )
}

async fn workspace_members_with_transport(
    transport: &dyn HostedAccountTransport,
    contexts: &dyn ActiveContextSource,
    registry: &Mutex<MemberActionRegistry>,
    expected_identity: &AccountIdentitySnapshot,
    workspace_id: &str,
) -> Result<AccountWorkspaceMemberList, String> {
    let before = contexts.active_context()?;
    if before.active_workspace.fable_workspace_id.as_deref() != Some(workspace_id)
        || before.member_id.is_none()
    {
        return Err("Select this workspace before loading its members.".into());
    }
    let response = bound_hosted_call(
        transport,
        &expected_identity.account_binding,
        ConvexFunctionType::Query,
        "membership:listRoster",
        json!({ "workspaceId": workspace_id }),
    )
    .await?;
    let _identity_guard = transport.lock_identity_generation(expected_identity)?;
    let after = contexts.active_context()?;
    if after != before {
        return Err(WORKSPACE_CONTEXT_CHANGED_ERROR.into());
    }
    let hosted = parse_workspace_members(
        response,
        workspace_id,
        before.member_id.as_deref().unwrap_or_default(),
    )?;
    registry
        .lock()
        .map_err(|_| "Fable could not protect member action references.".to_string())?
        .replace_context(expected_identity, &after, hosted)
}

async fn change_workspace_member_with_transport(
    transport: &dyn HostedAccountTransport,
    contexts: &dyn ActiveContextSource,
    registry: &Mutex<MemberActionRegistry>,
    request: &AccountWorkspaceMemberChangeRequest,
) -> Result<AccountWorkspaceMemberChangeOutcome, String> {
    if !valid_id(&request.member_action_ref) {
        return Err("Refresh the member list before changing access.".into());
    }
    let grant = registry
        .lock()
        .map_err(|_| "Fable could not protect member action references.".to_string())?
        .resolve(&request.member_action_ref)?;
    let identity = transport.identity_snapshot()?;
    if identity != grant.identity {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let before = contexts.active_context()?;
    if !context_matches_grant(&before, &grant) {
        return Err(WORKSPACE_CONTEXT_CHANGED_ERROR.into());
    }
    validate_member_change_request(&grant, request)?;
    let idempotency_key = member_change_idempotency_key(&identity.account_binding, request)?;
    let mut args = json!({
        "workspaceId": grant.workspace_id,
        "memberId": grant.target_member_id,
        "action": request.action,
        "baseRevision": request.expected_revision,
        "idempotencyKey": idempotency_key,
    });
    if let Some(role) = &request.role {
        args.as_object_mut()
            .expect("member change arguments are an object")
            .insert("role".into(), json!(role));
    }
    let response = bound_hosted_call(
        transport,
        &identity.account_binding,
        ConvexFunctionType::Mutation,
        "membership:change",
        args,
    )
    .await?;
    let _identity_guard = transport.lock_identity_generation(&identity)?;
    let after = contexts.active_context()?;
    if !context_matches_grant(&after, &grant) || after != before {
        return Err(WORKSPACE_CONTEXT_CHANGED_ERROR.into());
    }
    parse_member_change_result(response, &grant, request, &idempotency_key)
}

async fn accept_invitation_with_transport(
    transport: &dyn HostedAccountTransport,
    expected_identity: &AccountIdentitySnapshot,
    invitation_id: &str,
    idempotency_key: &str,
    bootstrap_idempotency_key: &str,
    store: &crate::store::Store,
) -> Result<AcceptanceWithReconciliation, String> {
    let result = parse_acceptance_result(
        bound_hosted_call(
            transport,
            &expected_identity.account_binding,
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
        match reconcile_hosted_with_transport(
            transport,
            expected_identity,
            bootstrap_idempotency_key,
            store,
        )
        .await
        {
            Ok(()) => InvitationReconciliation {
                status: "refreshed".into(),
                message: "Workspace list is up to date.".into(),
            },
            Err(message) if message == ACCOUNT_CHANGED_ERROR => return Err(message),
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

fn project_acceptance_decision(
    result: &HostedAcceptanceResult,
) -> AccountInvitationAcceptanceDecision {
    match result {
        HostedAcceptanceResult::Accepted { invitation, .. } => {
            AccountInvitationAcceptanceDecision::Accepted {
                invitation_id: invitation.invitation_id.clone(),
                workspace_id: invitation.workspace_id.clone(),
                role: invitation.role.clone(),
            }
        }
        HostedAcceptanceResult::Conflict { error, .. } => {
            AccountInvitationAcceptanceDecision::Conflict {
                code: error.code.clone(),
                message: "Invitation could not be accepted because it changed.".into(),
            }
        }
        HostedAcceptanceResult::Rejected { error } => {
            AccountInvitationAcceptanceDecision::Rejected {
                code: error.code.clone(),
                message: "Invitation could not be accepted.".into(),
            }
        }
    }
}

fn finalize_acceptance_outcome(
    accepted: AcceptanceWithReconciliation,
    preflight_status: AccountWorkspaceStatus,
    final_status: Result<AccountWorkspaceStatus, String>,
) -> Result<AccountInvitationAcceptanceOutcome, String> {
    let was_accepted = matches!(&accepted.result, HostedAcceptanceResult::Accepted { .. });
    let (account_workspace, reconciliation) = match final_status {
        Ok(status) => (status, accepted.reconciliation),
        Err(message) if message == ACCOUNT_CHANGED_ERROR => return Err(message),
        Err(_message) if was_accepted => (
            preflight_status,
            InvitationReconciliation {
                status: "refresh-needed".into(),
                message: "Invitation accepted, but Fable could not refresh the workspace list yet."
                    .into(),
            },
        ),
        Err(_message) => (preflight_status, accepted.reconciliation),
    };
    Ok(AccountInvitationAcceptanceOutcome {
        result: project_acceptance_decision(&accepted.result),
        account_workspace,
        reconciliation,
    })
}

async fn bound_account_workspace_status(
    transport: &dyn HostedAccountTransport,
    expected_binding: &str,
) -> Result<AccountWorkspaceStatus, String> {
    let before = transport
        .account_binding()
        .await
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if before != expected_binding {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    let status = account_workspace_status().await;
    let after = transport
        .account_binding()
        .await
        .map_err(|_| ACCOUNT_CHANGED_ERROR.to_string())?;
    if after != expected_binding {
        return Err(ACCOUNT_CHANGED_ERROR.into());
    }
    status
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
pub async fn account_workspace_members(
    fable_workspace_id: String,
) -> Result<AccountWorkspaceMemberList, String> {
    if !valid_id(&fable_workspace_id) {
        return Err("Workspace id is invalid.".into());
    }
    let transport = NativeHostedAccountTransport;
    let identity = transport.identity_snapshot()?;
    workspace_members_with_transport(
        &transport,
        &NativeActiveContextSource,
        member_action_registry(),
        &identity,
        &fable_workspace_id,
    )
    .await
}

#[tauri::command]
pub async fn account_workspace_member_change(
    request: AccountWorkspaceMemberChangeRequest,
) -> Result<AccountWorkspaceMemberChangeOutcome, String> {
    change_workspace_member_with_transport(
        &NativeHostedAccountTransport,
        &NativeActiveContextSource,
        member_action_registry(),
        &request,
    )
    .await
}

#[tauri::command]
pub async fn account_membership_accept_invitation(
    invitation_id: String,
) -> Result<AccountInvitationAcceptanceOutcome, String> {
    if !valid_id(&invitation_id) {
        return Err("Invitation id is invalid.".into());
    }
    let transport = NativeHostedAccountTransport;
    let identity = transport.identity_snapshot()?;
    let preflight_status =
        bound_account_workspace_status(&transport, &identity.account_binding).await?;
    let idempotency_key =
        invitation_acceptance_idempotency_key(&identity.account_binding, &invitation_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let accepted = accept_invitation_with_transport(
        &transport,
        &identity,
        &invitation_id,
        &idempotency_key,
        &identity.account_binding,
        store,
    )
    .await?;
    let final_status = if matches!(&accepted.result, HostedAcceptanceResult::Accepted { .. }) {
        bound_account_workspace_status(&transport, &identity.account_binding).await
    } else {
        Ok(preflight_status.clone())
    };
    finalize_acceptance_outcome(accepted, preflight_status, final_status)
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

    struct ScriptStep {
        mutation: bool,
        path: &'static str,
        args: Value,
        result: Value,
    }

    struct ScriptedTransport {
        steps: Mutex<VecDeque<ScriptStep>>,
        bindings: Mutex<VecDeque<String>>,
        commit_identity: Mutex<AccountIdentitySnapshot>,
        switch_generation_on_lock: Mutex<bool>,
    }

    struct ScriptGenerationLock;
    impl AccountGenerationLock for ScriptGenerationLock {}

    struct ScriptedContextSource {
        contexts: Mutex<VecDeque<directory::AuthorizedWorkspaceContext>>,
    }

    impl ScriptedContextSource {
        fn stable(context: directory::AuthorizedWorkspaceContext) -> Self {
            Self {
                contexts: Mutex::new(VecDeque::from([context.clone(), context])),
            }
        }

        fn sequence(contexts: Vec<directory::AuthorizedWorkspaceContext>) -> Self {
            Self {
                contexts: Mutex::new(contexts.into()),
            }
        }
    }

    impl ActiveContextSource for ScriptedContextSource {
        fn active_context(&self) -> Result<directory::AuthorizedWorkspaceContext, String> {
            self.contexts
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "No scripted workspace context remains.".into())
        }
    }

    impl ScriptedTransport {
        fn new(steps: Vec<ScriptStep>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                bindings: Mutex::new(VecDeque::new()),
                commit_identity: Mutex::new(AccountIdentitySnapshot {
                    account_binding: "bootstrap_key".into(),
                    generation: 1,
                }),
                switch_generation_on_lock: Mutex::new(false),
            }
        }

        fn with_bindings(steps: Vec<ScriptStep>, bindings: Vec<&str>) -> Self {
            Self {
                steps: Mutex::new(steps.into()),
                bindings: Mutex::new(bindings.into_iter().map(str::to_string).collect()),
                commit_identity: Mutex::new(AccountIdentitySnapshot {
                    account_binding: "bootstrap_key".into(),
                    generation: 1,
                }),
                switch_generation_on_lock: Mutex::new(false),
            }
        }

        fn switch_generation_at_commit(&self) {
            *self.switch_generation_on_lock.lock().unwrap() = true;
        }

        fn finished(&self) -> bool {
            self.steps.lock().unwrap().is_empty()
        }
    }

    impl HostedAccountTransport for ScriptedTransport {
        fn account_binding<'a>(&'a self) -> HostedStringFuture<'a> {
            let binding = self
                .bindings
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| "bootstrap_key".into());
            Box::pin(async move { Ok(binding) })
        }

        fn identity_snapshot(&self) -> Result<AccountIdentitySnapshot, String> {
            Ok(self.commit_identity.lock().unwrap().clone())
        }

        fn lock_identity_generation(
            &self,
            expected: &AccountIdentitySnapshot,
        ) -> Result<Box<dyn AccountGenerationLock>, String> {
            if *self.switch_generation_on_lock.lock().unwrap() {
                let mut identity = self.commit_identity.lock().unwrap();
                identity.generation = identity.generation.wrapping_add(1);
            }
            if &*self.commit_identity.lock().unwrap() != expected {
                return Err(ACCOUNT_CHANGED_ERROR.into());
            }
            Ok(Box::new(ScriptGenerationLock))
        }

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

    fn accepted_result(invitation_id: &str, idempotency_key: &str, replayed: bool) -> Value {
        json!({
            "status": "accepted", "invitation": accepted_invitation(invitation_id),
            "membership": membership(invitation_id),
            "idempotency": { "key": idempotency_key, "replayed": replayed, "recordedAt": "2026-07-11T08:01:00.000Z" }
        })
    }

    fn test_account_status() -> AccountWorkspaceStatus {
        AccountWorkspaceStatus {
            configured: true,
            state: "ready".into(),
            message: "Ready.".into(),
            account_bound: true,
            workspaces: Vec::new(),
            active_workspace: directory::ActiveWorkspaceSelection {
                local_workspace_id: "local_home".into(),
                fable_workspace_id: Some("ws_home".into()),
                name: "Home".into(),
                source: "hosted".into(),
            },
            active_context_owner: None,
            devices: Vec::new(),
        }
    }

    fn identity(account_binding: &str) -> AccountIdentitySnapshot {
        AccountIdentitySnapshot {
            account_binding: account_binding.into(),
            generation: 1,
        }
    }

    fn active_context(
        internal_user_id: &str,
        workspace_id: &str,
        member_id: &str,
    ) -> directory::AuthorizedWorkspaceContext {
        directory::AuthorizedWorkspaceContext {
            active_workspace: directory::ActiveWorkspaceSelection {
                local_workspace_id: format!("hosted_{workspace_id}"),
                fable_workspace_id: Some(workspace_id.into()),
                name: "Workspace".into(),
                source: "hosted".into(),
            },
            internal_user_id: internal_user_id.into(),
            member_id: Some(member_id.into()),
        }
    }

    fn roster_member(member_id: &str, is_current_user: bool) -> Value {
        json!({
            "memberId": member_id,
            "role": "owner",
            "status": "active",
            "revision": 1,
            "displayName": "Workspace member",
            "emailHint": "m***@example.com",
            "isCurrentUser": is_current_user,
            "management": if is_current_user {
                json!({ "allowedRoles": [], "allowedActions": [], "blockedReason": "last-active-owner" })
            } else {
                json!({ "allowedRoles": ["viewer"], "allowedActions": ["suspend", "remove"] })
            }
        })
    }

    fn roster(workspace_id: &str) -> Value {
        json!({
            "workspaceId": workspace_id,
            "actorRole": "owner",
            "members": [roster_member("member_current", true)]
        })
    }

    fn manageable_roster(workspace_id: &str, current_member_id: &str) -> Value {
        json!({
            "workspaceId": workspace_id,
            "actorRole": "owner",
            "members": [
                {
                    "memberId": current_member_id, "role": "owner", "status": "active",
                    "revision": 1, "displayName": "Current", "isCurrentUser": true,
                    "management": { "allowedRoles": [], "allowedActions": [], "blockedReason": "last-active-owner" }
                },
                {
                    "memberId": "member_target", "role": "editor", "status": "active",
                    "revision": 2, "displayName": "Target", "isCurrentUser": false,
                    "management": { "allowedRoles": ["owner", "admin", "viewer"], "allowedActions": ["suspend", "remove"] }
                }
            ]
        })
    }

    fn member_change_grant(reference: &str) -> (Mutex<MemberActionRegistry>, MemberActionGrant) {
        let grant = MemberActionGrant {
            identity: identity("bootstrap_key"),
            internal_user_id: "usr_current".into(),
            workspace_id: "ws_home".into(),
            current_member_id: "member_current".into(),
            target_member_id: "member_target".into(),
            target_role: "editor".into(),
            target_status: "active".into(),
            target_revision: 2,
            allowed_roles: BTreeSet::from(["owner".into(), "admin".into(), "viewer".into()]),
            allowed_actions: BTreeSet::from(["suspend".into(), "remove".into()]),
        };
        let mut registry = MemberActionRegistry::default();
        registry.grants.insert(reference.into(), grant.clone());
        registry.order.push_back(reference.into());
        (Mutex::new(registry), grant)
    }

    fn changed_membership(role: &str, status: &str, revision: i64) -> Value {
        json!({
            "workspaceId": "ws_home", "authority": "convex", "schemaVersion": 1,
            "revision": revision, "createdByInternalUserId": "usr_owner",
            "createdAt": "2026-07-11T08:00:00.000Z", "updatedAt": "2026-07-11T09:00:00.000Z",
            "memberId": "member_target", "internalUserId": "usr_target", "role": role,
            "status": status, "activatedAt": "2026-07-11T08:00:00.000Z"
        })
    }

    fn accepted_member_change(role: &str, status: &str, key: &str) -> Value {
        json!({
            "status": "accepted",
            "membership": changed_membership(role, status, 3),
            "lastOwnerSafety": { "status": "safe", "remainingActiveOwnerCount": 1 },
            "idempotency": { "key": key, "replayed": false, "recordedAt": "2026-07-11T09:00:00.000Z" }
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
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" },
            "workspaceName": "Shared"
        });
        assert!(parse_pending_invitations(json!([pending.clone()])).is_ok());
        assert!(parse_pending_invitations(json!([pending.clone(), pending])).is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "accepted"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" },
            "workspaceName": "Shared"
        }]))
        .is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "other" },
            "workspaceName": "Shared"
        }]))
        .is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" },
            "workspaceName": ""
        }]))
        .is_err());
        assert!(parse_pending_invitations(json!([{
            "invitation": invitation("inv_a", "pending"),
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" },
            "workspaceName": "x".repeat(161)
        }]))
        .is_err());
    }

    #[test]
    fn workspace_member_parser_accepts_only_the_expected_bounded_roster() {
        let parsed = parse_workspace_members(roster("ws_home"), "ws_home", "member_current")
            .expect("valid roster");
        assert_eq!(parsed.workspace_id, "ws_home");
        assert_eq!(parsed.members.len(), 1);

        assert!(parse_workspace_members(roster("ws_other"), "ws_home", "member_current").is_err());

        let duplicate = json!({
            "workspaceId": "ws_home",
            "actorRole": "owner",
            "members": [
                roster_member("member_current", true),
                roster_member("member_current", false)
            ]
        });
        assert!(parse_workspace_members(duplicate, "ws_home", "member_current").is_err());

        let oversized = json!({
            "workspaceId": "ws_home",
            "actorRole": "owner",
            "members": (0..501).map(|index| json!({
                "memberId": format!("member_{index}"),
                "role": "viewer",
                "status": "active",
                "revision": 0,
                "isCurrentUser": index == 0
            })).collect::<Vec<_>>()
        });
        assert!(parse_workspace_members(oversized, "ws_home", "member_0").is_err());
    }

    #[test]
    fn workspace_member_parser_rejects_current_user_mismatch_and_private_metadata() {
        for invalid in [
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [roster_member("member_other", true)]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [roster_member("member_current", false)]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [
                    roster_member("member_current", true),
                    roster_member("member_other", true)
                ]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "active",
                    "revision": 1, "isCurrentUser": true,
                    "internalUserId": "user_private"
                }]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "active",
                    "revision": 1, "isCurrentUser": true,
                    "displayName": "x".repeat(121)
                }]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "active",
                    "revision": 1, "isCurrentUser": true,
                    "displayName": "Hidden\u{202e}name"
                }]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "active",
                    "revision": 1, "isCurrentUser": true,
                    "emailHint": "member@example.com"
                }]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "active",
                    "revision": 1, "isCurrentUser": true,
                    "emailHint": "m***@Example.com"
                }]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "admin",
                "members": [roster_member("member_current", true)]
            }),
            json!({
                "workspaceId": "ws_home", "actorRole": "owner",
                "members": [{
                    "memberId": "member_current", "role": "owner", "status": "removed",
                    "revision": 1, "isCurrentUser": true
                }]
            }),
        ] {
            assert!(parse_workspace_members(invalid, "ws_home", "member_current").is_err());
        }
    }

    #[tokio::test]
    async fn workspace_member_request_uses_only_the_fixed_query_and_payload() {
        let transport = ScriptedTransport::new(vec![ScriptStep {
            mutation: false,
            path: "membership:listRoster",
            args: json!({ "workspaceId": "ws_home" }),
            result: roster("ws_home"),
        }]);
        let contexts = ScriptedContextSource::stable(active_context(
            "usr_current",
            "ws_home",
            "member_current",
        ));
        let registry = Mutex::new(MemberActionRegistry::default());
        let result = workspace_members_with_transport(
            &transport,
            &contexts,
            &registry,
            &identity("bootstrap_key"),
            "ws_home",
        )
        .await
        .expect("valid roster");
        assert_eq!(result.members.len(), 1);
        assert!(transport.finished());
    }

    #[tokio::test]
    async fn workspace_member_request_rejects_account_switches() {
        let transport = ScriptedTransport::with_bindings(
            vec![ScriptStep {
                mutation: false,
                path: "membership:listRoster",
                args: json!({ "workspaceId": "ws_home" }),
                result: roster("ws_home"),
            }],
            vec!["bootstrap_key", "changed_account"],
        );
        let contexts = ScriptedContextSource::stable(active_context(
            "usr_current",
            "ws_home",
            "member_current",
        ));
        let registry = Mutex::new(MemberActionRegistry::default());
        let error = workspace_members_with_transport(
            &transport,
            &contexts,
            &registry,
            &identity("bootstrap_key"),
            "ws_home",
        )
        .await
        .expect_err("account switch must fail");
        assert_eq!(error, ACCOUNT_CHANGED_ERROR);
    }

    #[test]
    fn member_action_refs_hide_hosted_ids_and_refresh_invalidates_every_prior_ref() {
        let identity = identity("bootstrap_key");
        let first_context = active_context("usr_current", "ws_home", "member_current");
        let first_hosted = parse_workspace_members(
            manageable_roster("ws_home", "member_current"),
            "ws_home",
            "member_current",
        )
        .unwrap();
        let mut registry = MemberActionRegistry::default();
        let first = registry
            .replace_context(&identity, &first_context, first_hosted)
            .unwrap();
        let old_refs = first
            .members
            .iter()
            .map(|member| member.member_action_ref.clone())
            .collect::<Vec<_>>();
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("member_current"));
        assert!(!serialized.contains("member_target"));
        assert!(serialized.contains("memberActionRef"));

        let second_context = active_context("usr_other", "ws_other", "member_other");
        let second_hosted = parse_workspace_members(
            manageable_roster("ws_other", "member_other"),
            "ws_other",
            "member_other",
        )
        .unwrap();
        registry
            .replace_context(&identity, &second_context, second_hosted)
            .unwrap();
        assert!(old_refs
            .iter()
            .all(|reference| registry.resolve(reference).is_err()));
    }

    #[tokio::test]
    async fn member_change_uses_only_native_resolved_ids_and_preserves_retry_ref() {
        let reference = "member_action_test";
        let request = AccountWorkspaceMemberChangeRequest {
            member_action_ref: reference.into(),
            action: "change-role".into(),
            expected_revision: 2,
            role: Some("viewer".into()),
        };
        let key = member_change_idempotency_key("bootstrap_key", &request).unwrap();
        let transport = ScriptedTransport::new(vec![ScriptStep {
            mutation: true,
            path: "membership:change",
            args: json!({
                "workspaceId": "ws_home", "memberId": "member_target",
                "action": "change-role", "role": "viewer", "baseRevision": 2,
                "idempotencyKey": key
            }),
            result: accepted_member_change("viewer", "active", &key),
        }]);
        let contexts = ScriptedContextSource::stable(active_context(
            "usr_current",
            "ws_home",
            "member_current",
        ));
        let (registry, _) = member_change_grant(reference);
        let outcome =
            change_workspace_member_with_transport(&transport, &contexts, &registry, &request)
                .await
                .unwrap();
        assert!(matches!(
            outcome,
            AccountWorkspaceMemberChangeOutcome::Accepted { .. }
        ));
        assert!(registry.lock().unwrap().resolve(reference).is_ok());
        assert!(transport.finished());
        let serialized = serde_json::to_string(&outcome).unwrap();
        assert!(!serialized.contains("member_target"));
        assert!(!serialized.contains("idempotency"));
    }

    #[tokio::test]
    async fn member_change_rejects_unprojected_intent_and_post_await_context_switch() {
        let reference = "member_action_test";
        let stale = AccountWorkspaceMemberChangeRequest {
            member_action_ref: reference.into(),
            action: "reactivate".into(),
            expected_revision: 2,
            role: None,
        };
        let (empty_registry, _) = member_change_grant(reference);
        let empty_transport = ScriptedTransport::new(Vec::new());
        let contexts = ScriptedContextSource::sequence(vec![active_context(
            "usr_current",
            "ws_home",
            "member_current",
        )]);
        assert!(change_workspace_member_with_transport(
            &empty_transport,
            &contexts,
            &empty_registry,
            &stale,
        )
        .await
        .is_err());
        assert!(empty_transport.finished());

        let request = AccountWorkspaceMemberChangeRequest {
            member_action_ref: reference.into(),
            action: "suspend".into(),
            expected_revision: 2,
            role: None,
        };
        let key = member_change_idempotency_key("bootstrap_key", &request).unwrap();
        let transport = ScriptedTransport::new(vec![ScriptStep {
            mutation: true,
            path: "membership:change",
            args: json!({
                "workspaceId": "ws_home", "memberId": "member_target",
                "action": "suspend", "baseRevision": 2, "idempotencyKey": key
            }),
            result: accepted_member_change("editor", "suspended", &key),
        }]);
        let contexts = ScriptedContextSource::sequence(vec![
            active_context("usr_current", "ws_home", "member_current"),
            active_context("usr_current", "ws_other", "member_other"),
        ]);
        let (registry, _) = member_change_grant(reference);
        assert_eq!(
            change_workspace_member_with_transport(&transport, &contexts, &registry, &request)
                .await
                .unwrap_err(),
            WORKSPACE_CONTEXT_CHANGED_ERROR
        );

        let generation_transport = ScriptedTransport::new(vec![ScriptStep {
            mutation: true,
            path: "membership:change",
            args: json!({
                "workspaceId": "ws_home", "memberId": "member_target",
                "action": "suspend", "baseRevision": 2, "idempotencyKey": key
            }),
            result: accepted_member_change("editor", "suspended", &key),
        }]);
        generation_transport.switch_generation_at_commit();
        let stable_contexts = ScriptedContextSource::stable(active_context(
            "usr_current",
            "ws_home",
            "member_current",
        ));
        let (generation_registry, _) = member_change_grant(reference);
        assert_eq!(
            change_workspace_member_with_transport(
                &generation_transport,
                &stable_contexts,
                &generation_registry,
                &request,
            )
            .await
            .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
    }

    #[test]
    fn acceptance_idempotency_is_stable_and_account_scoped() {
        let first = invitation_acceptance_idempotency_key("bootstrap_account_a", "inv_a").unwrap();
        assert_eq!(
            first,
            invitation_acceptance_idempotency_key("bootstrap_account_a", "inv_a").unwrap()
        );
        assert_ne!(
            first,
            invitation_acceptance_idempotency_key("bootstrap_account_a", "inv_b").unwrap()
        );
        assert_ne!(
            first,
            invitation_acceptance_idempotency_key("bootstrap_account_b", "inv_a").unwrap()
        );
        assert!(!first.contains("bootstrap_account_a"));
        assert!(!first.contains("inv_a"));
    }

    #[tokio::test]
    async fn account_change_before_or_after_inbox_call_fails_generically() {
        let step = || ScriptStep {
            mutation: false,
            path: "membership:listRecipientPending",
            args: json!({}),
            result: json!([]),
        };
        let before = ScriptedTransport::with_bindings(vec![step()], vec!["account_a", "account_b"]);
        assert_eq!(
            pending_invitations_with_transport(&before)
                .await
                .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
        let after = ScriptedTransport::with_bindings(
            vec![step()],
            vec!["account_a", "account_a", "account_b"],
        );
        assert_eq!(
            pending_invitations_with_transport(&after)
                .await
                .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
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
            "selection": { "kind": "direct-inbox", "invitationId": "inv_a" },
            "workspaceName": "Shared"
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
            &identity("bootstrap_key"),
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
        let serialized =
            serde_json::to_string(&project_acceptance_decision(&accepted.result)).unwrap();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("native_accept_key"));
        assert!(!serialized.contains("usr_recipient"));
        assert!(!serialized.contains("member_shared"));
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
            &identity("bootstrap_key"),
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

    #[tokio::test]
    async fn lost_acceptance_response_retries_same_key_and_reconciles_replay() {
        let binding = "bootstrap_key";
        let stable_key = invitation_acceptance_idempotency_key(binding, "inv_a").unwrap();
        let transport = ScriptedTransport::new(vec![
            ScriptStep {
                mutation: true,
                path: "membership:acceptInvitation",
                args: json!({
                    "invitationId": "inv_a",
                    "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                    "idempotencyKey": stable_key.clone()
                }),
                result: json!({ "__error": "response lost" }),
            },
            ScriptStep {
                mutation: true,
                path: "membership:acceptInvitation",
                args: json!({
                    "invitationId": "inv_a",
                    "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                    "idempotencyKey": stable_key.clone()
                }),
                result: accepted_result("inv_a", &stable_key, true),
            },
            ScriptStep {
                mutation: true,
                path: "workspace:bootstrapAccount",
                args: json!({ "idempotencyKey": binding }),
                result: json!({
                    "status": "existing", "internalUserId": "usr_recipient", "workspaceId": "ws_home", "memberId": "member_home",
                    "idempotency": { "key": binding, "replayed": true }
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
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open_in_memory(crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        assert!(accept_invitation_with_transport(
            &transport,
            &identity(binding),
            "inv_a",
            &stable_key,
            binding,
            &store,
        )
        .await
        .is_err());
        let replay = accept_invitation_with_transport(
            &transport,
            &identity(binding),
            "inv_a",
            &stable_key,
            binding,
            &store,
        )
        .await
        .unwrap();
        assert!(matches!(
            replay.result,
            HostedAcceptanceResult::Accepted { .. }
        ));
        assert_eq!(replay.reconciliation.status, "refreshed");
        assert!(transport.finished());
    }

    #[test]
    fn accepted_status_failure_uses_preflight_and_secret_free_projection() {
        let stable_key = invitation_acceptance_idempotency_key("bootstrap_a", "inv_a").unwrap();
        let hosted = parse_acceptance_result(
            accepted_result("inv_a", &stable_key, false),
            "inv_a",
            &stable_key,
        )
        .unwrap();
        let outcome = finalize_acceptance_outcome(
            AcceptanceWithReconciliation {
                result: hosted,
                reconciliation: InvitationReconciliation {
                    status: "refreshed".into(),
                    message: "Workspace list is up to date.".into(),
                },
            },
            test_account_status(),
            Err("local status failed".into()),
        )
        .unwrap();
        assert_eq!(outcome.reconciliation.status, "refresh-needed");
        let serialized = serde_json::to_string(&outcome).unwrap();
        assert!(serialized.contains("\"status\":\"accepted\""));
        for forbidden in [
            stable_key.as_str(),
            "usr_recipient",
            "member_shared",
            "authorization-error",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[tokio::test]
    async fn account_switch_during_reconciliation_returns_no_accepted_dto() {
        let transport = ScriptedTransport::with_bindings(
            vec![
                ScriptStep {
                    mutation: true,
                    path: "membership:acceptInvitation",
                    args: json!({
                        "invitationId": "inv_a",
                        "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                        "idempotencyKey": "native_key"
                    }),
                    result: accepted_result("inv_a", "native_key", false),
                },
                ScriptStep {
                    mutation: true,
                    path: "workspace:bootstrapAccount",
                    args: json!({ "idempotencyKey": "account_a" }),
                    result: json!({ "status": "existing" }),
                },
            ],
            vec!["account_a", "account_a", "account_a", "account_b"],
        );
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open_in_memory(crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        assert_eq!(
            accept_invitation_with_transport(
                &transport,
                &identity("account_a"),
                "inv_a",
                "native_key",
                "account_a",
                &store,
            )
            .await
            .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
    }

    #[tokio::test]
    async fn account_switch_after_accept_call_returns_no_hosted_dto() {
        let transport = ScriptedTransport::with_bindings(
            vec![ScriptStep {
                mutation: true,
                path: "membership:acceptInvitation",
                args: json!({
                    "invitationId": "inv_a",
                    "presentation": { "kind": "direct-inbox", "invitationId": "inv_a" },
                    "idempotencyKey": "native_key"
                }),
                result: accepted_result("inv_a", "native_key", false),
            }],
            vec!["account_a", "account_b"],
        );
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open_in_memory(crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        assert_eq!(
            accept_invitation_with_transport(
                &transport,
                &identity("account_a"),
                "inv_a",
                "native_key",
                "account_a",
                &store,
            )
            .await
            .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
    }

    #[tokio::test]
    async fn generation_switch_after_last_response_prevents_directory_commit() {
        let transport = ScriptedTransport::new(vec![
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
                    { "workspaceId": "ws_home", "name": "Home", "revision": 0, "policyRevision": 1, "memberId": "member_home", "role": "owner", "membershipRevision": 1 }
                ]),
            },
            ScriptStep {
                mutation: false,
                path: "device:listMine",
                args: json!({}),
                result: json!([]),
            },
        ]);
        transport.switch_generation_at_commit();
        let key = crate::store::vault::MasterKey::generate().unwrap();
        let store =
            crate::store::Store::open_in_memory(crate::store::vault::Vault::new(&key).unwrap())
                .unwrap();
        assert_eq!(
            reconcile_hosted_with_transport(
                &transport,
                &identity("bootstrap_key"),
                "bootstrap_key",
                &store,
            )
            .await
            .unwrap_err(),
            ACCOUNT_CHANGED_ERROR
        );
        store
            .with_conn(|conn| {
                assert!(directory::list_authoritative_summaries(conn, "usr_recipient")?.is_empty());
                assert!(directory::list_authoritative_summaries_for_current_user(conn)?.is_none());
                Ok(())
            })
            .unwrap();
    }
}
