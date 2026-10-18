//! Wire contracts shared by hosted computer commands.

use crate::models::{ApprovalRequest, ApprovalResolutionRequest};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedExecutionNodeSnapshot {
    pub(super) execution_node_id: String,
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) locality: String,
    pub(super) status: String,
    pub(super) runtime_active: bool,
    pub(super) keep_alive: bool,
    pub(super) runner_generation: i64,
    pub(super) revision: i64,
    pub(super) updated_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedComputerProvisionReceipt {
    pub(super) request_key: String,
    pub(super) execution_node_id: String,
    pub(super) computer_id: String,
    pub(super) status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessDraft {
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) run_id: String,
    pub(super) argv: Vec<String>,
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    pub(super) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessLaunchProposal {
    pub(super) request_key: String,
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) run_id: String,
    pub(super) argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedProcessLaunch {
    pub(super) proposal: HostedProcessLaunchProposal,
    pub(super) proposal_fingerprint: String,
    pub(super) approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedProcessLaunchRequest {
    pub(super) proposal: HostedProcessLaunchProposal,
    pub(super) resolution: ApprovalResolutionRequest,
    pub(super) source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessTarget {
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) process_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostedExecutionCapabilityReceipt {
    pub(super) runner_url: String,
    pub(super) token: String,
    pub(super) computer_id: String,
    pub(super) generation: i64,
    pub(super) expires_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedProcessSnapshot {
    pub(super) request_key: String,
    pub(super) run_id: String,
    pub(super) lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) process_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pid: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) output_truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigateDraft {
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigateProposal {
    pub(super) request_key: String,
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedBrowserNavigation {
    pub(super) proposal: HostedBrowserNavigateProposal,
    pub(super) proposal_fingerprint: String,
    pub(super) approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedBrowserNavigationRequest {
    pub(super) proposal: HostedBrowserNavigateProposal,
    pub(super) resolution: ApprovalResolutionRequest,
    #[serde(default)]
    pub(super) source_resolution: Option<ApprovalResolutionRequest>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserActionDraft {
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) observation_id: String,
    pub(super) element_ref: String,
    pub(super) control_role: String,
    pub(super) control_name: String,
    pub(super) action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserActionProposal {
    pub(super) request_key: String,
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
    pub(super) observation_id: String,
    pub(super) element_ref: String,
    pub(super) control_role: String,
    pub(super) control_name: String,
    pub(super) action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHostedBrowserAction {
    pub(super) proposal: HostedBrowserActionProposal,
    pub(super) proposal_fingerprint: String,
    pub(super) approval: ApprovalRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitHostedBrowserActionRequest {
    pub(super) proposal: HostedBrowserActionProposal,
    pub(super) resolution: ApprovalResolutionRequest,
    pub(super) source_resolution: ApprovalResolutionRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserTarget {
    pub(super) workspace_id: String,
    pub(super) agent_id: String,
    pub(super) device_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserSnapshot {
    pub(super) current_url: String,
    pub(super) title: String,
    pub(super) observation_id: String,
    pub(super) viewport: HostedBrowserViewportSnapshot,
    pub(super) navigation: HostedBrowserNavigationSnapshot,
    pub(super) controls: Vec<HostedBrowserControl>,
    pub(super) preview_data_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) live_view_url: Option<String>,
    #[serde(default)]
    pub(super) takeover_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) last_download: Option<HostedBrowserDownloadSnapshot>,
    pub(super) updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserDownloadSnapshot {
    pub(super) file_name: String,
    pub(super) workspace_path: String,
    pub(super) bytes_written: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserNavigationSnapshot {
    pub(super) can_go_back: bool,
    pub(super) can_go_forward: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserViewportSnapshot {
    pub(super) scroll_x: u64,
    pub(super) scroll_y: u64,
    pub(super) width: u64,
    pub(super) height: u64,
    pub(super) document_width: u64,
    pub(super) document_height: u64,
    pub(super) can_scroll_up: bool,
    pub(super) can_scroll_down: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostedBrowserControl {
    pub(super) r#ref: String,
    pub(super) role: String,
    pub(super) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) options: Option<Vec<String>>,
}
