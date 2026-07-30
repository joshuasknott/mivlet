//! Authenticated native construction of bounded mission worker assignments.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{
    capability_grant, message, mission_checkpoint, mission_plan, mission_run, thread,
    workspace_directory,
};

const MAX_CONTEXT: usize = 32;
const MAX_TOOLS: usize = 32;
const CITED_PARTIAL_ACCEPTANCE_SUMMARY: &str =
    "The cited draft was preserved, but it did not satisfy the required evidence policy.";
const CITED_HUMAN_DENIAL_SUMMARY: &str =
    "The policy-passed cited draft was preserved without being accepted as an artifact.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkerExecutionBinding {
    pub run_id: String,
    pub worker_id: String,
    pub worker_started_event_id: String,
    pub route_selected_event_id: String,
    pub usage_event_id: String,
    pub completion_event_id: String,
    pub evaluation_event_id: String,
    pub result_event_id: String,
    pub failure_event_id: String,
    pub idempotency_key: String,
    pub expected_run_revision: i64,
    pub expected_last_sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_restore_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_evidence: Option<NativeWorkerToolEvidenceBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkerToolEvidenceBinding {
    pub tool_event_id: String,
    pub output_reference: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkerToolExecutionBinding {
    pub run_id: String,
    pub worker_id: String,
    pub worker_started_event_id: String,
    pub route_selected_event_id: String,
    pub tool_event_id: String,
    pub call_key: String,
    pub idempotency_key: String,
    pub expected_run_revision: i64,
    pub expected_last_sequence: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct NativeWorkerToolAuthority {
    binding: NativeWorkerToolExecutionBinding,
    identity: crate::clerk_identity::NativeIdentityGenerationSnapshot,
    local_workspace_id: String,
    project_id: Option<String>,
    member_id: String,
    internal_user_id: String,
    capability_grant_id: String,
    query: String,
}

impl NativeWorkerToolAuthority {
    pub(crate) fn capability_grant_id(&self) -> &str {
        &self.capability_grant_id
    }
}

pub(crate) enum NativeWorkerToolPreflight {
    Execute(NativeWorkerToolAuthority),
    AlreadyRecorded(Value),
}

#[derive(Clone, Debug)]
pub(crate) struct NativeWorkerCompletionAuthority {
    binding: NativeWorkerExecutionBinding,
    identity: crate::clerk_identity::NativeIdentityGenerationSnapshot,
    local_workspace_id: String,
    member_id: String,
    internal_user_id: String,
    provider_id: String,
    requested_model: String,
    provider_route_id: String,
    output: Option<NativeWorkerOutputSpec>,
    max_input_tokens: Option<i64>,
    max_output_tokens: i64,
    max_duration_ms: i64,
    attempt_number: i64,
    max_attempts: i64,
    evidence: Option<Value>,
    cited_policy_shape: bool,
    parallel_evidence_free: bool,
    general_concurrent_provider: bool,
    reviewed_parallel_context: Option<crate::mission_parallel_approaches::ReviewedWorkerContext>,
}

#[derive(Clone, Debug)]
struct NativeWorkerOutputSpec {
    key: String,
    description: String,
    include_uncertainty: bool,
    include_evidence: bool,
}

impl NativeWorkerCompletionAuthority {
    pub(crate) fn expects_output(&self) -> bool {
        self.output.is_some()
    }

    pub(crate) fn usage_exceeds_budget(&self, input_tokens: i64, output_tokens: i64) -> bool {
        input_tokens < 0
            || output_tokens < 0
            || output_tokens > self.max_output_tokens
            || self
                .max_input_tokens
                .is_some_and(|maximum| input_tokens > maximum)
    }

    pub(crate) fn observation_owner(&self) -> &str {
        &self.internal_user_id
    }

    pub(crate) fn provider_route_id(&self) -> &str {
        &self.provider_route_id
    }

    pub(crate) fn max_duration_ms(&self) -> i64 {
        self.max_duration_ms
    }

    pub(crate) fn attempt_number(&self) -> i64 {
        self.attempt_number
    }
}

pub(crate) enum NativeWorkerCompletionPreflight {
    Execute(NativeWorkerCompletionAuthority),
    AlreadyCompleted,
}

pub(crate) enum NativeWorkerTerminalOutcome {
    Completed {
        text: Option<String>,
        input_tokens: i64,
        output_tokens: i64,
        duration_ms: i64,
        attempt_number: i64,
    },
    Failed {
        code: &'static str,
        message: &'static str,
        retryable: bool,
        usage: Option<(i64, i64)>,
        duration_ms: i64,
        attempt_number: i64,
    },
    Cancelled,
}

fn enforce_reviewed_parallel_output_contract(
    reviewed_context: Option<&crate::mission_parallel_approaches::ReviewedWorkerContext>,
    outcome: NativeWorkerTerminalOutcome,
) -> NativeWorkerTerminalOutcome {
    if !reviewed_context.is_some_and(|context| context.is_reviewer) {
        return outcome;
    }
    match outcome {
        NativeWorkerTerminalOutcome::Completed {
            text,
            input_tokens,
            output_tokens,
            duration_ms,
            attempt_number,
        } if text.as_deref().is_none_or(|text| {
            crate::mission_parallel_approaches::validate_review_markdown(text).is_err()
        }) =>
        {
            NativeWorkerTerminalOutcome::Failed {
                code: "native-worker-output-contract-invalid",
                message:
                    "The reviewer output did not match its required bounded Markdown contract.",
                retryable: false,
                usage: Some((input_tokens, output_tokens)),
                duration_ms,
                attempt_number,
            }
        }
        outcome => outcome,
    }
}

#[derive(Clone, Copy, Debug)]
struct ObservedNativeUsage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    duration_ms: i64,
    attempt_number: i64,
}

impl ObservedNativeUsage {
    fn tokens(self) -> Option<(i64, i64)> {
        self.input_tokens.zip(self.output_tokens)
    }
}

fn validate_native_usage_timing(
    max_duration_ms: i64,
    expected_attempt_number: i64,
    duration_ms: i64,
    attempt_number: i64,
    duration_budget_exceeded: bool,
) -> Result<(), String> {
    if duration_ms < 0
        || duration_ms > max_duration_ms
        || attempt_number != expected_attempt_number
        || (duration_budget_exceeded && duration_ms != max_duration_ms)
    {
        return Err("Native provider duration or attempt usage is invalid.".into());
    }
    Ok(())
}

fn validate_native_attempt_budget(max_attempts: i64, attempt_number: i64) -> Result<(), String> {
    if max_attempts < 1 || attempt_number < 1 || attempt_number > max_attempts {
        return Err("Mission run attempt is outside its persisted budget.".into());
    }
    Ok(())
}

fn retryable_cited_provider_failure(
    authority: &NativeWorkerCompletionAuthority,
    code: &str,
    retryable: bool,
) -> bool {
    retryable
        && authority.attempt_number == 1
        && authority.max_attempts == 2
        && authority
            .output
            .as_ref()
            .is_some_and(|output| output.include_evidence)
        && authority.evidence.is_some()
        && authority.binding.checkpoint_event_id.is_some()
        && authority.binding.checkpoint_restore_event_id.is_none()
        && matches!(
            code,
            "native-provider-transport-failed"
                | "native-provider-temporarily-unavailable"
                | "native-provider-stream-interrupted"
        )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionWorkerCreateInput {
    run_id: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    worker_id: String,
    step_key: String,
    context: Vec<Value>,
    grants: Vec<WorkerGrantInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionWorkerStartInput {
    run_id: String,
    worker_id: String,
    run_start_event_id: Option<String>,
    worker_started_event_id: String,
    route_selected_event_id: String,
    provider_id: String,
    model_reference: String,
    route_selection: crate::models::ProviderRouteSelection,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerGrantInput {
    capability_id: String,
    capability_grant_id: String,
}

const MAX_CITED_RECEIPT_MESSAGES: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitedReceiptReadInput {
    thread_id: String,
    message_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitedApprovalResolveInput {
    run_id: String,
    decision: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

include!("mission_workers/approvals.rs");
include!("mission_workers/native_execution.rs");
include!("mission_workers/lifecycle.rs");
include!("mission_workers/tests.rs");
