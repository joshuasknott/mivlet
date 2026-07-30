//! Durable provider-neutral dependency joins for general Mission plans.
//!
//! Join policy is declared before dependency outcomes are known. Resolution is
//! derived only from the encrypted run journal, so a renderer cannot reshape a
//! join after seeing which worker succeeded.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{
    artifact, mission_plan, mission_run, mission_worker_output,
    scope::{DataScope, PrivateDataScope},
    workspace_directory,
};

const GENERAL_DECLARED_GRAPH_MARKER: &str = "native:general-declared-graph:v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionJoinOpenInput {
    run_id: String,
    target_step_key: String,
    strategy: String,
    quorum: Option<usize>,
    allow_failed_workers: bool,
    deadline: Option<String>,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionJoinResolveInput {
    run_id: String,
    join_key: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionAggregationRecordInput {
    run_id: String,
    target_step_key: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionHumanEvaluationInput {
    run_id: String,
    criterion_key: String,
    passed: bool,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionWorkerObjectiveInput {
    run_id: String,
    worker_id: String,
}

struct AuthorizedRun {
    scope: DataScope,
    member: String,
    actor: String,
    journal: mission_run::MissionRunJournalRow,
    lifecycle: mission_plan::MissionPlanLifecycleRow,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_string())
}

pub(crate) fn coordination_join_key(plan_revision_id: &str, target_step_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission.coordination.join.v1\0");
    digest.update(plan_revision_id.as_bytes());
    digest.update(b"\0");
    digest.update(target_step_key.as_bytes());
    format!("mission_join_{:x}", digest.finalize())
}

include!("mission_coordination/run_authority.rs");
include!("mission_coordination/coordination.rs");
include!("mission_coordination/commands.rs");
include!("mission_coordination/tests.rs");
