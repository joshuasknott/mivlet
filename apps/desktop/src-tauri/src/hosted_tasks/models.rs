use crate::models::{ApprovalRequest, ApprovalResolutionRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Budget {
    pub max_model_calls: u8,
    pub max_output_tokens: u32,
    pub max_elapsed_ms: u64,
    pub max_result_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_page_reads: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_source_bytes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u8>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_scope: Option<PublicWebScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<CodingRepository>,
    pub task_id: String,
    pub admission_id: String,
    pub run_id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub work_generation: u32,
    pub conversation_id: String,
    pub conversation_generation: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head_id: Option<String>,
    pub expected_sequence: i64,
    pub input_sha256: String,
    pub provider_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub credential_id: String,
    pub credential_revision: u32,
    pub budget: Budget,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextMessage {
    pub role: String,
    pub content: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextInput {
    pub messages: Vec<TextMessage>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Admission {
    pub binding: Binding,
    pub input: TextInput,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskSnapshot {
    pub binding: Binding,
    pub generation: u32,
    pub status: String,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_sha256: Option<String>,
    pub result_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub retained_until: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<PublicWebProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coding: Option<CodingProgress>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskResult {
    pub snapshot: TaskSnapshot,
    pub text: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Execution {
    pub version: u8,
    pub binding: Binding,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub originally_held: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<TaskSnapshot>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub expected_generation: u32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub expected_generation: u32,
    pub credential_id: String,
    pub credential_revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_scope: Option<PublicWebScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writable_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<CodingCheck>>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingCheck {
    pub id: String,
    pub argv: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingScope {
    pub writable_paths: Vec<String>,
    pub checks: Vec<CodingCheck>,
    pub image: String,
    pub network: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingRepository {
    pub snapshot: crate::local_computer::coding::hosted_repository::Snapshot,
    pub scope: CodingScope,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingProposal {
    pub tool: String,
    pub arguments: String,
    pub arguments_sha256: String,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingCheckReceipt {
    pub id: String,
    pub candidate_sha256: String,
    pub exit_code: i32,
    pub output_sha256: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CodingProgress {
    pub model_calls: u8,
    pub tool_calls: u8,
    pub allocated_output_tokens: u32,
    pub completed_checks: Vec<CodingCheckReceipt>,
    pub output: crate::local_computer::coding::hosted_repository::OutputManifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<CodingProposal>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublicWebScope {
    pub allowed_domains: Vec<String>,
    pub initial_urls: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublicWebProgress {
    pub model_calls: u8,
    pub page_reads: u8,
    pub source_bytes: usize,
    pub sources: Vec<PublicWebSource>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublicWebSource {
    pub citation_id: String,
    pub title: String,
    pub final_uri: String,
    pub fetched_at: String,
    pub content_sha256: String,
    pub content_bytes: usize,
    pub truncated: bool,
}
impl Prepare {
    pub(crate) fn target(&self) -> Target {
        Target {
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            work_id: self.work_id.clone(),
            expected_generation: self.expected_generation,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewTarget {
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub expected_generation: u32,
    pub review_id: String,
}
impl ReviewTarget {
    pub(crate) fn target(&self) -> Target {
        Target {
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            work_id: self.work_id.clone(),
            expected_generation: self.expected_generation,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Commit {
    pub workspace_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub expected_generation: u32,
    pub review_id: String,
    pub resolution: ApprovalResolutionRequest,
}
impl Commit {
    pub(crate) fn target(&self) -> Target {
        Target {
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            work_id: self.work_id.clone(),
            expected_generation: self.expected_generation,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Offer {
    pub runner_url: String,
    pub review_id: String,
    pub work_id: String,
    pub work_generation: u32,
    pub admission: Admission,
    pub input_bytes: usize,
    pub expires_at: i64,
    pub originally_held: bool,
    pub approval: ApprovalRequest,
    pub previous_head_id: Option<String>,
    pub previous_sequence: i64,
    pub device_id: String,
    pub computer_generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<TaskResult>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Review {
    pub runner_url: String,
    pub collaboration: crate::collaboration::models::Snapshot,
    pub review_id: String,
    pub work_id: String,
    pub work_generation: u32,
    pub admission: Admission,
    pub input_bytes: usize,
    pub expires_at: i64,
    pub originally_held: bool,
    pub approval: ApprovalRequest,
}
impl Offer {
    pub(crate) fn public(&self, collaboration: crate::collaboration::models::Snapshot) -> Review {
        Review {
            runner_url: self.runner_url.clone(),
            collaboration,
            review_id: self.review_id.clone(),
            work_id: self.work_id.clone(),
            work_generation: self.work_generation,
            admission: self.admission.clone(),
            input_bytes: self.input_bytes,
            expires_at: self.expires_at,
            originally_held: self.originally_held,
            approval: self.approval.clone(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlResult {
    pub collaboration: crate::collaboration::models::Snapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_result: Option<TaskResult>,
    pub reconcile_required: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderScope {
    pub workspace_id: String,
    pub agent_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderEnroll {
    pub workspace_id: String,
    pub agent_id: String,
    pub provider_id: String,
    pub credential_id: Option<String>,
    pub expected_revision: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderRevoke {
    pub workspace_id: String,
    pub agent_id: String,
    pub credential_id: String,
    pub revision: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Enrollment {
    pub credential_id: String,
    pub provider_id: String,
    pub revision: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderConnection {
    pub credential_id: String,
    pub provider_id: String,
    pub revision: u32,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
}
