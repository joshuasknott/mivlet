//! The bounded native surface used by agent chat to manage the local roster
//! and projects. Every request carries the exact executing Work fence; model
//! text never receives a general workspace mutation primitive.

use super::models::{Conversation, Participant, Snapshot, Team, Work};
use super::{commands, now, Context};
use crate::authorized_scope::{self, ScopeAccess};
use crate::local_projects::{self, CreateLocalProjectRequest, LocalProject};
use crate::models::{ApprovalResolutionRequest, MivletAgentProfile, RuntimeSnapshot};
use crate::store::repos::collaboration as repo;
use crate::store::repos::collaboration::Kind;
use crate::store::repos::local_project;
use crate::store::StoreError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

mod operations;
use operations::apply_operation;

const MAX_NAME: usize = 80;
const MAX_INSTRUCTIONS: usize = 8_000;

/// TS-facing contract (camelCase):
/// `{workspaceId, workId, generation, runId, callId, tool, arguments, approval,
/// expectedAgentRevision?}`. `arguments` is one of the
/// tagged operation shapes below. The renderer passes the same approval
/// envelope used by `execute_tool_call`.
/// Rust re-checks it before applying any mutation, then consumes the persisted
/// one-time permit exactly once.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceManageRequest {
    pub workspace_id: String,
    pub work_id: String,
    pub generation: u32,
    pub run_id: String,
    pub call_id: String,
    pub tool: String,
    /// JSON-encoded model arguments. Native parses and canonicalizes this
    /// value before approval binding and receipt fingerprinting.
    pub arguments: String,
    pub approval: ApprovalResolutionRequest,
    #[serde(default)]
    pub expected_agent_revision: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum WorkspaceOperation {
    Inspect,
    CreateAgent {
        name: String,
        #[serde(default)]
        instructions: String,
        #[serde(default)]
        model_agent_id: Option<String>,
    },
    UpdateAgent {
        agent_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        instructions: Option<String>,
        #[serde(default)]
        model_agent_id: Option<String>,
    },
    DeleteAgent {
        agent_id: String,
    },
    CreateProject {
        name: String,
        #[serde(default)]
        instructions: String,
        participant_ids: Vec<String>,
        #[serde(default)]
        lead_agent_id: Option<String>,
    },
    UpdateTeam {
        project_id: String,
        expected_revision: u32,
        participant_ids: Vec<String>,
        #[serde(default)]
        lead_agent_id: Option<String>,
        #[serde(default)]
        share_history: bool,
    },
}

impl WorkspaceOperation {
    fn agent_id(&self, receipt: &str) -> Option<String> {
        match self {
            Self::CreateAgent { .. } => Some(digest_id("agent-chat", receipt)),
            Self::UpdateAgent { agent_id, .. } | Self::DeleteAgent { agent_id } => {
                Some(agent_id.clone())
            }
            _ => None,
        }
    }

    fn project_id(&self, receipt: &str) -> Option<String> {
        match self {
            Self::CreateProject { .. } => Some(digest_id("project-chat", receipt)),
            Self::UpdateTeam { project_id, .. } => Some(project_id.clone()),
            _ => None,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::CreateAgent { .. } => "create-agent",
            Self::UpdateAgent { .. } => "update-agent",
            Self::DeleteAgent { .. } => "delete-agent",
            Self::CreateProject { .. } => "create-project",
            Self::UpdateTeam { .. } => "update-team",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManageReceipt {
    pub id: String,
    pub operation: String,
    pub summary: String,
    pub replayed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceManageResponse {
    pub agents: Vec<MivletAgentProfile>,
    pub agent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_agent_id: Option<String>,
    pub collaboration: Snapshot,
    pub projects: Vec<LocalProject>,
    pub receipt: WorkspaceManageReceipt,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SavedReceipt {
    work_id: String,
    generation: u32,
    operation: String,
    summary: String,
    arguments_digest: String,
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::Invalid(message.into())
}

fn bounded(value: &str, max: usize, label: &str) -> Result<String, StoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(invalid(format!("{label} must be 1-{max} characters.")));
    }
    Ok(value.to_string())
}

fn id(value: &str, label: &str) -> Result<(), StoreError> {
    bounded(value, 128, label)?;
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
    {
        return Err(invalid(format!("Invalid {label}.")));
    }
    Ok(())
}

fn digest_id(prefix: &str, call_id: &str) -> String {
    let digest = Sha256::digest(call_id.as_bytes());
    format!("{prefix}-{}", hex::encode(&digest[..10]))
}

fn mutating(operation: &WorkspaceOperation) -> bool {
    !matches!(operation, WorkspaceOperation::Inspect)
}

fn parse_operation(
    tool: &str,
    raw: &str,
) -> Result<(WorkspaceOperation, serde_json::Value), String> {
    if raw.len() > 65_536 {
        return Err("Workspace management arguments exceed the local size limit.".into());
    }
    let raw_value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "Workspace management arguments are invalid JSON.".to_string())?;
    let mut value = raw_value.clone();
    let operation = match tool {
        "workspace-inspect" => "inspect".to_string(),
        "agent-create" => "create-agent".to_string(),
        "agent-update" => "update-agent".to_string(),
        "agent-delete" => "delete-agent".to_string(),
        "project-create" => "create-project".to_string(),
        "project-team-update" => "update-team".to_string(),
        _ => return Err("Workspace management uses an exact registered tool.".into()),
    };
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Workspace management arguments must be a JSON object.".to_string())?;
    if object.contains_key("operation") {
        return Err("Workspace management uses the registered tool name as its operation.".into());
    }
    object.insert(
        "operation".into(),
        serde_json::Value::String(operation.clone()),
    );
    let parsed = serde_json::from_value(value)
        .map_err(|_| "Workspace management arguments are invalid or incomplete.".to_string())?;
    Ok((parsed, raw_value))
}

fn profile<'a>(
    profiles: &'a [MivletAgentProfile],
    agent_id: &str,
) -> Result<&'a MivletAgentProfile, StoreError> {
    profiles
        .iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| invalid("That agent profile is unavailable."))
}

fn participants(
    profiles: &[MivletAgentProfile],
    ids: &[String],
    lead: Option<&str>,
) -> Result<Vec<Participant>, StoreError> {
    if ids.is_empty() || ids.len() > 8 || lead.is_some_and(|lead| !ids.iter().any(|id| id == lead))
    {
        return Err(invalid(
            "Choose one to eight participants. A lead, when designated, must be one of them.",
        ));
    }
    let mut seen = HashSet::new();
    ids.iter()
        .map(|agent_id| {
            if !seen.insert(agent_id) {
                return Err(invalid("Each participant can be included only once."));
            }
            let agent = profile(profiles, agent_id)?;
            Ok(Participant {
                agent_id: agent.id.clone(),
                name: agent.name.clone(),
            })
        })
        .collect()
}

fn receipt_id(run_id: &str, call_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(run_id.len().to_be_bytes());
    hash.update(run_id.as_bytes());
    hash.update(call_id.as_bytes());
    let digest = hash.finalize();
    format!("workspace-manage-{}", hex::encode(&digest[..16]))
}

fn default_profile(
    id: String,
    name: String,
    instructions: String,
    model_id: String,
) -> MivletAgentProfile {
    MivletAgentProfile {
        id: id.clone(),
        name,
        instructions,
        model_id,
        reasoning_effort: None,
        fast_mode: None,
        notifications_enabled: Some(true),
        icon: "agent".into(),
        icon_color: "#6D5DF7".into(),
        avatar_seed: Some(format!("blob-v1:{id}")),
        icon_image_data_url: None,
        connector_ids: vec![],
        knowledge_source_ids: vec![],
        permission_label: "Ask Me".into(),
        thread_id: None,
        thread_ids: vec![],
        learned_tasks: vec![],
    }
}

fn validate_request_ids(request: &WorkspaceManageRequest) -> Result<(), StoreError> {
    id(&request.work_id, "Work ID")?;
    id(&request.run_id, "Run ID")?;
    id(&request.call_id, "Tool call ID")?;
    if request.approval.request.id != request.call_id {
        return Err(invalid("The approval belongs to a different tool call."));
    }
    Ok(())
}

fn fence(ctx: &Context<'_>, request: &WorkspaceManageRequest) -> Result<Work, StoreError> {
    validate_request_ids(request)?;
    let item = super::work::current(
        ctx,
        &request.work_id,
        request.generation,
        Some(&request.run_id),
    )?;
    if !item.status.executing() {
        return Err(invalid(
            "This workspace request is stale or the assignment is no longer executing.",
        ));
    }
    let root = ctx.item(&item.root_id)?;
    if [&item, &root].iter().any(|work| {
        work.execution_owner.is_some()
            || work.hosted_task.is_some()
            || work.external_client.is_some()
            || work.schedule.is_some()
            || work
                .origin
                .as_deref()
                .is_some_and(|origin| origin != "chat")
    }) {
        return Err(invalid(
            "Only a user chat turn can manage the local workspace.",
        ));
    }
    if !ctx
        .profiles
        .iter()
        .any(|profile| profile.id == item.agent_id)
    {
        return Err(invalid(
            "The executing agent is no longer available in this workspace.",
        ));
    }
    Ok(item)
}

fn mutation_allowed(ctx: &Context<'_>, item: &Work) -> Result<(), StoreError> {
    let caller = profile(ctx.profiles, &item.agent_id)?;
    if !matches!(
        item.permission_mode.as_str(),
        "trusted-scope" | "full-access"
    ) || !matches!(caller.permission_label.as_str(), "Ask Me" | "Work Freely")
    {
        return Err(invalid(
            "Read Only agents cannot change workspace structure.",
        ));
    }
    Ok(())
}

fn validate_replay(
    saved: &SavedReceipt,
    request: &WorkspaceManageRequest,
    operation: &str,
    digest: &str,
) -> Result<(), StoreError> {
    if saved.operation != operation
        || saved.arguments_digest != digest
        || saved.work_id != request.work_id
        || saved.generation != request.generation
    {
        return Err(invalid("A tool call ID was reused with different workspace instructions or execution ownership."));
    }
    Ok(())
}

fn save_receipt(
    ctx: &Context<'_>,
    item: &Work,
    id: &str,
    operation: &str,
    summary: &str,
    arguments_digest: &str,
) -> Result<(), StoreError> {
    ctx.put(
        Kind::Receipt,
        id,
        None,
        None,
        &SavedReceipt {
            work_id: item.id.clone(),
            generation: item.generation,
            operation: operation.into(),
            summary: summary.into(),
            arguments_digest: arguments_digest.into(),
        },
    )
}

fn projects(ctx: &Context<'_>) -> Result<Vec<LocalProject>, StoreError> {
    local_project::list_projects(ctx.conn, ctx.store, &ctx.scope.private, true, 128)?
        .into_iter()
        .map(|row| local_projects::project_from_row(ctx.scope, row))
        .collect()
}

fn response(
    ctx: &Context<'_>,
    snapshot: &RuntimeSnapshot,
    receipt: WorkspaceManageReceipt,
) -> Result<WorkspaceManageResponse, StoreError> {
    Ok(WorkspaceManageResponse {
        agents: snapshot.agents.clone(),
        agent_revision: snapshot.agent_revision,
        active_agent_id: snapshot.active_agent_id.clone(),
        collaboration: ctx.snapshot()?,
        projects: projects(ctx)?,
        receipt,
    })
}

fn project_conversation(
    ctx: &Context<'_>,
    project: &LocalProject,
    members: Vec<Participant>,
    lead: Option<String>,
    time: &str,
) -> Result<(), StoreError> {
    ctx.conversation(&Conversation {
        chat: Some(super::models::ChatBinding {
            role: "main".into(),
            owner_kind: "project".into(),
            owner_id: project.id.clone(),
        }),
        id: project.thread_id.clone(),
        workspace_id: ctx.scope.data.workspace_id().into(),
        kind: "group".into(),
        title: project.name.clone(),
        project_id: Some(project.id.clone()),
        facilitator_id: lead,
        participants: members,
        revision: 1,
        generation: 1,
        archived: false,
        created_at: time.into(),
        updated_at: time.into(),
    })
}

#[tauri::command]
pub async fn workspace_manage(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: WorkspaceManageRequest,
) -> Result<WorkspaceManageResponse, String> {
    if window.label() != "main" {
        return Err("Manage the workspace from the Mivlet window.".into());
    }
    if request.workspace_id.trim().is_empty() {
        return Err("Workspace management requires a workspace.".into());
    }
    let (operation, arguments_value) = parse_operation(&request.tool, &request.arguments)?;
    let operation_name = operation.name().to_string();
    let arguments_digest =
        crate::tools::tool_arguments_fingerprint(&request.tool, &arguments_value)
            .map_err(|error| format!("Workspace management arguments are invalid: {error}"))?;
    let operation_is_mutating = mutating(&operation);
    let operation_is_agent_mutation = matches!(
        &operation,
        WorkspaceOperation::CreateAgent { .. }
            | WorkspaceOperation::UpdateAgent { .. }
            | WorkspaceOperation::DeleteAgent { .. }
    );
    let store = crate::store::try_global().ok_or("Mivlet's encrypted store is unavailable.")?;
    let workspace_id = request.workspace_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Read the receipt in a short transaction before consuming a permit.
        // A replay is a durable result and must not burn the single-use
        // approval again.
        let replay = store
            .transaction(|conn| {
                let scope =
                    authorized_scope::resolve(conn, Some(&workspace_id), None, ScopeAccess::Write)?;
                let agent_snapshot = crate::snapshot::load_runtime_snapshot_in_transaction(
                    &app,
                    conn,
                    &workspace_id,
                )?
                .ok_or_else(|| invalid("Mivlet's persisted agent profiles are not available."))?;
                let profiles = agent_snapshot.agents.clone();
                let time = now();
                let ctx = Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: &time,
                };
                validate_request_ids(&request)?;
                let receipt_key = receipt_id(&request.run_id, &request.call_id);
                Ok(
                    if let Some(saved) = repo::get::<SavedReceipt>(
                        conn,
                        store,
                        &scope.private,
                        Kind::Receipt,
                        &receipt_key,
                    )? {
                        validate_replay(&saved, &request, &operation_name, &arguments_digest)?;
                        let receipt = WorkspaceManageReceipt {
                            agent_id: operation.agent_id(&receipt_key),
                            project_id: operation.project_id(&receipt_key),
                            id: receipt_key,
                            operation: saved.operation,
                            summary: saved.summary,
                            replayed: true,
                        };
                        Some(response(&ctx, &agent_snapshot, receipt)?)
                    } else {
                        let item = fence(&ctx, &request)?;
                        if operation_is_mutating {
                            mutation_allowed(&ctx, &item)?;
                        }
                        None
                    },
                )
            })
            .map_err(|e| e.to_string())?;
        if let Some(replay) = replay {
            return Ok(replay);
        }

        // Inspect is intentionally read-only and has no approval boundary.
        // Every mutating operation reuses the exact tool approval binding and
        // consumes the persisted one-time permit before opening the write
        // transaction below.
        if operation_is_mutating {
            if request.approval.decision != "once" || request.approval.modification.is_some() {
                return Err("Workspace changes require an exact one-time approval.".into());
            }
            crate::tools::validate_tool_approval_binding(
                &request.tool,
                &arguments_value,
                &request.approval.request,
            )?;
            crate::execution_approvals::verify_and_consume_execution_approval(
                &crate::paths::execution_approvals_path(&app)?,
                &request.approval.request,
                &crate::execution_approvals::wall_clock_consumed_at(),
            )?;
        }

        store
            .transaction(|conn| {
                let scope =
                    authorized_scope::resolve(conn, Some(&workspace_id), None, ScopeAccess::Write)?;
                let mut agent_snapshot = crate::snapshot::load_runtime_snapshot_in_transaction(
                    &app,
                    conn,
                    &workspace_id,
                )?
                .ok_or_else(|| invalid("Mivlet's persisted agent profiles are not available."))?;
                let profiles = agent_snapshot.agents.clone();
                let time = now();
                let ctx = Context {
                    conn,
                    store,
                    scope: &scope,
                    profiles: &profiles,
                    time: &time,
                };
                validate_request_ids(&request)?;
                let receipt_key = receipt_id(&request.run_id, &request.call_id);
                if let Some(saved) = repo::get::<SavedReceipt>(
                    conn,
                    store,
                    &scope.private,
                    Kind::Receipt,
                    &receipt_key,
                )? {
                    validate_replay(&saved, &request, &operation_name, &arguments_digest)?;
                    let receipt = WorkspaceManageReceipt {
                        agent_id: operation.agent_id(&receipt_key),
                        project_id: operation.project_id(&receipt_key),
                        id: receipt_key,
                        operation: saved.operation,
                        summary: saved.summary,
                        replayed: true,
                    };
                    return response(&ctx, &agent_snapshot, receipt);
                }
                let item = fence(&ctx, &request)?;
                if operation_is_mutating {
                    mutation_allowed(&ctx, &item)?;
                }
                let summary = apply_operation(
                    &ctx,
                    &item,
                    &operation,
                    request.expected_agent_revision,
                    &mut agent_snapshot,
                    &receipt_key,
                    &arguments_digest,
                )?;
                if operation_is_agent_mutation {
                    crate::snapshot::save_runtime_snapshot_in_transaction(
                        &app,
                        conn,
                        &workspace_id,
                        &agent_snapshot,
                    )?;
                }
                let receipt = WorkspaceManageReceipt {
                    agent_id: operation.agent_id(&receipt_key),
                    project_id: operation.project_id(&receipt_key),
                    id: receipt_key,
                    operation: operation_name.clone(),
                    summary,
                    replayed: false,
                };
                response(&ctx, &agent_snapshot, receipt)
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| {
        "Workspace management stopped unexpectedly; inspect the saved receipt before retrying."
            .to_string()
    })?
}

#[cfg(test)]
mod tests;
