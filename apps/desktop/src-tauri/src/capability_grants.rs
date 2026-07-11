//! Native first-use confirmation for durable capability grants.
//!
//! The preview names the exact capability, Connection, consequence, scope,
//! optional budget, and optional expiry. Commit re-resolves every field and
//! consumes a separately persisted one-time approval before creating authority.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::models::{ApprovalRequest, ApprovalResolutionRequest};
use crate::store::repos::capability_grant::{CreateCapabilityGrant, SafeCapabilityGrant};

const CONFIRMATION_PHRASE: &str = "allow connected source search";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrantProposal {
    workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    capability_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_uses: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PreparedCapabilityGrant {
    Granted {
        grant: SafeCapabilityGrant,
    },
    ConfirmationRequired {
        proposal_fingerprint: String,
        target: crate::capability_registry::CapabilityGrantTarget,
        approval: ApprovalRequest,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCapabilityGrantRequest {
    proposal: CapabilityGrantProposal,
    resolution: ApprovalResolutionRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityGrantScopeRequest {
    workspace_id: String,
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeCapabilityGrantRequest {
    workspace_id: String,
    #[serde(default)]
    project_id: Option<String>,
    grant_id: String,
    expected_revision: i64,
}

struct ProposalContext {
    scope: crate::authorized_scope::AuthorizedCommandScope,
    target: crate::capability_registry::CapabilityGrantTarget,
    fingerprint: String,
}

fn approval_for(
    proposal: &CapabilityGrantProposal,
    context: &ProposalContext,
    id: String,
    requested_at: String,
) -> ApprovalRequest {
    let scope = proposal.project_id.as_deref().map_or_else(
        || format!("workspace: {}", proposal.workspace_id),
        |project| format!("project: {project}"),
    );
    let limit = proposal.max_uses.map_or_else(
        || "uses: no fixed limit".into(),
        |value| format!("uses: up to {value}"),
    );
    let expiry = proposal.expires_at.as_deref().map_or_else(
        || "expiry: until revoked".into(),
        |value| format!("expiry: {value}"),
    );
    ApprovalRequest {
        id,
        service: "Connected sources".into(),
        action: format!("capability-grant {}", context.target.capability_id),
        mode: "full-access".into(),
        risk_level: "high".into(),
        data_used: vec![
            format!("capability: Search connected work sources ({})", context.target.capability_id),
            format!(
                "Connection: {} ({})",
                context.target.connection_display_name, context.target.connection_id
            ),
            format!("consequence: {}", context.target.consequence),
            format!("scope: {scope}"),
            limit,
            expiry,
        ],
        consequence: "Allows Fable to search this Connection in the named scope. Every search still requires its own exact-action approval.".into(),
        requested_at,
        decisions: vec!["once".into(), "deny".into()],
        confirmation_phrase: Some(CONFIRMATION_PHRASE.into()),
    }
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 18];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a secure capability grant id.".to_string())?;
    Ok(format!(
        "{prefix}-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

#[tauri::command]
pub fn prepare_capability_grant(
    app: AppHandle,
    proposal: CapabilityGrantProposal,
) -> Result<PreparedCapabilityGrant, String> {
    let context = validate_proposal_with_app(&app, &proposal)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let current = store
        .with_conn(|tx| {
            crate::store::repos::capability_grant::check(
                tx,
                store,
                &context.scope,
                &context.target.capability_id,
                &context.target.connection_id,
                &context.target.consequence,
                &now,
            )
        })
        .map_err(|error| error.to_string())?;
    if let Ok(mut grants) = current {
        if let Some(grant) = grants.pop() {
            if grant.max_uses != proposal.max_uses || grant.expires_at != proposal.expires_at {
                return Err("An active capability grant already exists with different limits. Revoke it before replacing its authority.".into());
            }
            return Ok(PreparedCapabilityGrant::Granted { grant });
        }
    }
    let approval = approval_for(
        &proposal,
        &context,
        random_id("approval-capability-grant")?,
        now,
    );
    Ok(PreparedCapabilityGrant::ConfirmationRequired {
        proposal_fingerprint: context.fingerprint,
        target: context.target,
        approval,
    })
}

fn validate_proposal_with_app(
    app: &AppHandle,
    proposal: &CapabilityGrantProposal,
) -> Result<ProposalContext, String> {
    if proposal.max_uses.is_some_and(|value| value < 1) {
        return Err("Capability grant limits must be positive.".into());
    }
    if let Some(expires_at) = proposal.expires_at.as_deref() {
        let expiry = DateTime::parse_from_rfc3339(expires_at)
            .map_err(|_| "Capability grant expiry must be an RFC 3339 timestamp.".to_string())?
            .with_timezone(&Utc);
        if expiry <= Utc::now() {
            return Err("Capability grant expiry must be in the future.".into());
        }
    }
    let scope = crate::authorized_scope::command_scope(
        Some(proposal.workspace_id.clone()),
        proposal.project_id.clone(),
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let target = crate::capability_registry::native_grant_target(
        app,
        &proposal.workspace_id,
        proposal.project_id.as_deref(),
        &proposal.capability_id,
    )
    .map_err(|error| error.message)?;
    let normalized = serde_json::json!({
        "workspaceId": proposal.workspace_id,
        "projectId": proposal.project_id,
        "capabilityId": target.capability_id,
        "connectionId": target.connection_id,
        "connectionRevision": target.connection_revision,
        "consequence": target.consequence,
        "maxUses": proposal.max_uses,
        "expiresAt": proposal.expires_at,
        "ownerSubject": scope.private.owner_subject(),
    });
    let encoded = serde_json::to_vec(&normalized)
        .map_err(|_| "Capability grant proposal is invalid.".to_string())?;
    Ok(ProposalContext {
        scope,
        target,
        fingerprint: format!("{:x}", Sha256::digest(encoded)),
    })
}

#[tauri::command]
pub fn commit_capability_grant(
    app: AppHandle,
    request: CommitCapabilityGrantRequest,
) -> Result<SafeCapabilityGrant, String> {
    let context = validate_proposal_with_app(&app, &request.proposal)?;
    let expected = approval_for(
        &request.proposal,
        &context,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The capability grant changed after confirmation preview.".into());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let current = validate_proposal_with_app(&app, &request.proposal)?;
    if current.fingerprint != context.fingerprint {
        return Err("The capability grant target changed during confirmation.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let grant_id = random_id("capability-grant")?;
    store
        .transaction(|tx| {
            crate::store::repos::capability_grant::create(
                tx,
                store,
                &current.scope,
                CreateCapabilityGrant {
                    id: &grant_id,
                    capability_key: &current.target.capability_id,
                    connection_id: &current.target.connection_id,
                    connection_revision_at_grant: current.target.connection_revision,
                    consequence_class: &current.target.consequence,
                    max_uses: request.proposal.max_uses,
                    expires_at: request.proposal.expires_at.as_deref(),
                    granted_at: &resolution.audit_entry.decided_at,
                },
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_capability_grants(
    request: CapabilityGrantScopeRequest,
) -> Result<Vec<SafeCapabilityGrant>, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        request.project_id,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| crate::store::repos::capability_grant::list(tx, store, &scope))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn revoke_capability_grant(
    request: RevokeCapabilityGrantRequest,
) -> Result<SafeCapabilityGrant, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        request.project_id,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::capability_grant::revoke(
                tx,
                store,
                &scope,
                &request.grant_id,
                request.expected_revision,
                &Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}
