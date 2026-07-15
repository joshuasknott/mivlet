//! Fixed, provider-free artifact revision-brief mission.
//!
//! The native boundary owns this bounded producer end to end. The selected
//! artifact version is attested by the durable human-input boundary and only
//! its immutable identity and hash are carried into the generated brief.

use chrono::{SecondsFormat, Utc};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::mission_human_input::{HumanInputField, HumanInputRequestInput, PendingHumanInput};
use crate::mission_plans::{build_initial_records, MissionPlanCreateInput};
use crate::mission_runs::{build_run_created, MissionRunCreateInput};
use crate::store::repos::{
    artifact, message, mission_checkpoint, mission_plan, mission_run,
    scope::{DataScope, PrivateDataScope},
    thread, workspace_directory,
};

pub(crate) const CONTINUATION_ID: &str = "native:artifact-revision-brief:v1";
const OUTPUT_KEY: &str = "revisionBrief";
const REQUEST_KEY: &str = "artifact-revision-brief:v1";
const PROMPT: &str = "Choose an artifact version and describe the revision it needs.";
const DEFAULT_FOCUS: &str = "Prepare a revision brief for the selected artifact.";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRevisionBriefStartInput {
    source_thread_id: String,
    project_id: Option<String>,
    start_key: String,
    focus: Option<String>,
}

struct Authorized {
    scope: DataScope,
    internal_user_id: String,
    member_id: String,
    record_workspace_id: String,
}

#[derive(Clone)]
struct Binding {
    suffix: String,
    run_id: String,
    mission_id: String,
    plan_id: String,
    plan_revision_id: String,
    source_thread_id: String,
    project_id: Option<String>,
}

impl Binding {
    fn new(suffix: String, source_thread_id: String, project_id: Option<String>) -> Self {
        Self {
            run_id: format!("artifact-revision-brief-run-{suffix}"),
            mission_id: format!("artifact-revision-brief-mission-{suffix}"),
            plan_id: format!("artifact-revision-brief-plan-{suffix}"),
            plan_revision_id: format!("artifact-revision-brief-revision-{suffix}"),
            source_thread_id,
            project_id,
            suffix,
        }
    }

    fn from_journal(journal: &mission_run::MissionRunJournalRow) -> crate::store::Result<Self> {
        let run_id = required(&journal.run, "id")?;
        let suffix = run_id
            .strip_prefix("artifact-revision-brief-run-")
            .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| invalid_error("Artifact revision-brief run identity is invalid."))?;
        Ok(Self::new(
            suffix.into(),
            required(&journal.run, "sourceThreadId")?.into(),
            journal
                .run
                .get("projectId")
                .and_then(Value::as_str)
                .map(str::to_string),
        ))
    }
}

fn authorized(tx: &rusqlite::Connection) -> crate::store::Result<Authorized> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member_id = context.member_id.clone().ok_or_else(|| {
        invalid_error(
            "An active Fable workspace membership is required for artifact revision briefs.",
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id.clone())?;
    let record_workspace_id = context
        .active_workspace
        .fable_workspace_id
        .unwrap_or_else(|| scope.workspace_id().to_string());
    Ok(Authorized {
        scope,
        internal_user_id: context.internal_user_id,
        member_id,
        record_workspace_id,
    })
}

#[tauri::command]
pub fn mission_artifact_revision_brief_start(
    input: ArtifactRevisionBriefStartInput,
) -> Result<PendingHumanInput, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    start_with_store(store, input).map_err(|error| error.to_string())
}

fn start_with_store(
    store: &crate::store::Store,
    input: ArtifactRevisionBriefStartInput,
) -> crate::store::Result<PendingHumanInput> {
    validate_start(&input).map_err(crate::store::StoreError::Invalid)?;
    store.transaction(|tx| {
        let auth = authorized(tx)?;
        let source = thread::get(tx, store, &auth.scope, input.source_thread_id.trim())?
            .ok_or_else(|| invalid_error("Artifact revision-brief source conversation is unavailable."))?;
        if source.lifecycle != "active" || source.project_id != normalized_optional(input.project_id.as_deref()) {
            return Err(invalid_error("Artifact revision-brief source conversation changed."));
        }
        require_owned_source(tx, &auth, &source.id, source.project_id.as_deref())?;

        let start_hash = digest(&format!(
            "artifact-revision-brief-start:v1|{}|{}|{}",
            auth.scope.workspace_id(),
            auth.member_id,
            input.start_key.trim()
        ));
        let binding = Binding::new(
            start_hash[..40].into(),
            source.id.clone(),
            source.project_id.clone(),
        );
        let focus = normalized_focus(input.focus.as_deref());
        if let Some(lifecycle) = mission_plan::get(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &binding.mission_id,
        )? {
            return validate_start_replay(tx, store, &auth, &binding, &lifecycle, &focus);
        }

        require_readable_artifact(tx, store, &auth, &binding)?;
        let at = now();
        let records = build_initial_records(
            &fixed_plan_input(&binding, &focus),
            &auth.record_workspace_id,
            &auth.member_id,
            &auth.internal_user_id,
            &at,
        )
        .map_err(crate::store::StoreError::Invalid)?;
        let lifecycle = mission_plan::create(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &auth.internal_user_id,
            &binding.mission_id,
            &binding.plan_id,
            &binding.plan_revision_id,
            "delegated",
            &records.mission,
            &records.plan,
            &records.revision,
            &at,
        )?;
        let create_input = MissionRunCreateInput {
            mission_id: binding.mission_id.clone(),
            run_id: binding.run_id.clone(),
            event_id: format!("artifact-revision-brief-created-{}", binding.suffix),
            idempotency_key: format!("artifact-revision-brief-create:{}", binding.suffix),
        };
        let (run, event) = build_run_created(
            &lifecycle,
            &create_input,
            &auth.internal_user_id,
            &auth.member_id,
            &at,
        )
        .map_err(crate::store::StoreError::Invalid)?;
        let created = mission_run::create(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &auth.internal_user_id,
            &binding.run_id,
            &create_input.event_id,
            &format!("create:{}", create_input.idempotency_key),
            &run,
            &event,
            &at,
        )?;
        mission_plan::mark_running(tx, store, &auth.scope, &auth.member_id, &lifecycle, &at)?;
        let started_id = format!("artifact-revision-brief-started-{}", binding.suffix);
        let started_key = format!("artifact-revision-brief-start:v1:{}", binding.suffix);
        let started_event = json!({
            "workspaceId":created.run.get("workspaceId"),"visibility":"member-private",
            "ownerMemberId":auth.member_id,"authority":"local","schemaVersion":1,"revision":1,
            "createdByInternalUserId":auth.internal_user_id,"createdAt":at,"updatedAt":at,
            "id":started_id,"runId":binding.run_id,"type":"status-transitioned","sequence":2,
            "previousEventId":create_input.event_id,"occurredAt":at,"actor":{"kind":"system"},
            "idempotencyKey":started_key,
            "payload":{"from":"created","to":"running","reason":"Artifact revision-brief input is ready."}
        });
        let mut started_run = object(created.run)?;
        started_run.insert("status".into(), json!("running"));
        started_run.insert("revision".into(), json!(3));
        started_run.insert("updatedAt".into(), json!(at));
        started_run.insert("eventHead".into(), json!({"lastSequence":2,"lastEventId":started_id}));
        let running = mission_run::append(
            tx, store, &auth.scope, &auth.member_id, &binding.run_id, 2, 1, &started_id,
            "status-transitioned", &started_key, &started_event, &Value::Object(started_run), &at,
        )?;
        crate::mission_human_input::request_in_tx(
            tx,
            store,
            &auth.scope,
            &auth.internal_user_id,
            &auth.member_id,
            Some(CONTINUATION_ID),
            &HumanInputRequestInput {
                run_id: binding.run_id,
                request_key: REQUEST_KEY.into(),
                expected_run_revision: running.run.get("revision").and_then(Value::as_i64).unwrap_or(3),
                expected_last_sequence: 2,
                prompt: PROMPT.into(),
                fields: fixed_fields(),
            },
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_if_artifact_revision_brief_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    internal_user_id: &str,
    owner_member_id: &str,
    received_journal: &mission_run::MissionRunJournalRow,
    lifecycle_before_resume: &mission_plan::MissionPlanLifecycleRow,
    received_event_id: &str,
    at: &str,
) -> crate::store::Result<bool> {
    if lifecycle_before_resume
        .mission
        .get("constraints")
        .and_then(Value::as_array)
        .is_none_or(|items| {
            items
                .iter()
                .all(|item| item.get("key").and_then(Value::as_str) != Some(CONTINUATION_ID))
        })
    {
        return Ok(false);
    }
    let binding = Binding::from_journal(received_journal)?;
    validate_continuation_boundary(
        tx,
        store,
        scope,
        owner_member_id,
        received_journal,
        lifecycle_before_resume,
        &binding,
        received_event_id,
    )?;
    require_unchanged_source(tx, store, scope, owner_member_id, &binding)?;
    let received = received_journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(received_event_id))
        .ok_or_else(|| invalid_error("Artifact revision-brief response is unavailable."))?;
    let values = revision_values(received)?;
    let private = PrivateDataScope::for_authenticated_user(
        scope.clone(),
        internal_user_id,
        Some(owner_member_id),
    )?;
    let reference = immutable_reference(tx, store, &private, &values.source)?;
    let markdown = render_markdown(&values, &reference);
    let content_hash = digest(&markdown);
    let output_binding = artifact::direct_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        &binding.run_id,
        received_event_id,
        OUTPUT_KEY,
        &content_hash,
    );
    let result_event_id = format!("artifact-revision-brief-completed-{}", binding.suffix);
    let result_key = format!("artifact-revision-brief-complete:v1:{}", binding.suffix);
    let output = json!({
        "key":OUTPUT_KEY,"summary":"Artifact revision brief draft",
        "valueReference":format!("sha256:{content_hash}"),
        "artifactId":output_binding.artifact_id,
        "artifactVersionId":output_binding.artifact_version_id
    });
    let result = json!({
        "outcome":"succeeded","summary":"The artifact revision brief draft is complete.",
        "outputs":[output.clone()],"acceptance":[],"evaluations":[],"usage":[],"completedAt":at
    });
    let revision = required_i64(&received_journal.run, "revision")?;
    let sequence = received_journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_error("Artifact revision-brief event head is invalid."))?;
    let result_event = json!({
        "workspaceId":received_journal.run.get("workspaceId"),"visibility":"member-private",
        "ownerMemberId":owner_member_id,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":result_event_id,"runId":binding.run_id,"type":"run-completed","sequence":sequence + 1,
        "previousEventId":received_event_id,
        "attemptNumber":received_journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":result_key,
        "payload":{"result":result}
    });
    let mut projected = object(received_journal.run.clone())?;
    projected.insert("status".into(), json!("completed"));
    projected.insert("terminalResult".into(), result.clone());
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence + 1,"lastEventId":result_event_id}),
    );
    let terminal = mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        revision,
        sequence,
        &result_event_id,
        "run-completed",
        &result_key,
        &result_event,
        &Value::Object(projected),
        at,
    )?;
    artifact::create_direct_mission_output_with_artifact_reference(
        tx,
        store,
        &private,
        owner_member_id,
        &binding.run_id,
        received_event_id,
        &result_event_id,
        OUTPUT_KEY,
        "Artifact revision brief",
        &markdown,
        &output_binding,
        "Authenticated artifact revision instructions",
        artifact::DirectMissionArtifactReference {
            field_key: "sourceArtifact",
            reference: &reference,
        },
    )?;
    append_transcript(
        tx,
        store,
        scope,
        &binding,
        &terminal,
        &markdown,
        &output_binding,
        &result_event_id,
        at,
    )?;
    let resumed = mission_plan::get(tx, store, scope, owner_member_id, &binding.mission_id)?
        .ok_or_else(|| invalid_error("Artifact revision-brief mission is unavailable."))?;
    mission_plan::mark_completed(
        tx,
        store,
        scope,
        owner_member_id,
        &resumed,
        &json!({
            "outcome":"succeeded","summary":"The artifact revision brief draft is complete.",
            "producingRunIds":[binding.run_id],"outputs":[output],"acceptance":[],"completedAt":at
        }),
        at,
    )?;
    Ok(true)
}

pub(crate) fn validate_terminal_replay_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    internal_user_id: &str,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    received: &Value,
) -> crate::store::Result<()> {
    let binding = Binding::from_journal(journal)?;
    let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, &binding.mission_id)?
        .ok_or_else(|| invalid_error("Artifact revision-brief mission is unavailable."))?;
    validate_fixed_lifecycle(journal, &lifecycle, &binding)?;
    validate_fixed_request(tx, store, scope, owner_member_id, journal, received)?;
    let received_event_id = required(received, "id")?;
    let values = revision_values(received)?;
    let private = PrivateDataScope::for_authenticated_user(
        scope.clone(),
        internal_user_id,
        Some(owner_member_id),
    )?;
    let reference = immutable_reference(tx, store, &private, &values.source)?;
    let markdown = render_markdown(&values, &reference);
    let content_hash = digest(&markdown);
    let output_binding = artifact::direct_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        &binding.run_id,
        received_event_id,
        OUTPUT_KEY,
        &content_hash,
    );
    let result_event_id = format!("artifact-revision-brief-completed-{}", binding.suffix);
    let result_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id.as_str()))
        .ok_or_else(|| invalid_error("Artifact revision-brief terminal event is unavailable."))?;
    let output = result_event.pointer("/payload/result/outputs/0");
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("completed")
        || journal.run.get("status").and_then(Value::as_str) != Some("completed")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id.as_str())
        || result_event.get("type").and_then(Value::as_str) != Some("run-completed")
        || result_event.get("previousEventId").and_then(Value::as_str) != Some(received_event_id)
        || result_event.pointer("/payload/result") != journal.run.get("terminalResult")
        || output
            .and_then(|value| value.get("key"))
            .and_then(Value::as_str)
            != Some(OUTPUT_KEY)
        || output
            .and_then(|value| value.get("artifactId"))
            .and_then(Value::as_str)
            != Some(output_binding.artifact_id.as_str())
        || output
            .and_then(|value| value.get("artifactVersionId"))
            .and_then(Value::as_str)
            != Some(output_binding.artifact_version_id.as_str())
        || output
            .and_then(|value| value.get("valueReference"))
            .and_then(Value::as_str)
            != Some(format!("sha256:{content_hash}").as_str())
        || lifecycle
            .mission
            .pointer("/terminalResult/producingRunIds/0")
            .and_then(Value::as_str)
            != Some(binding.run_id.as_str())
        || lifecycle.mission.pointer("/terminalResult/outputs/0") != output
    {
        return Err(invalid_error(
            "Artifact revision-brief terminal result no longer matches its response.",
        ));
    }
    let normalized = artifact::get_direct_mission_source_binding(
        tx,
        &private,
        owner_member_id,
        &binding.run_id,
        OUTPUT_KEY,
        received_event_id,
        &result_event_id,
        &content_hash,
    )?;
    if normalized.as_ref() != Some(&output_binding) {
        return Err(invalid_error(
            "Artifact revision-brief direct provenance is incomplete.",
        ));
    }
    artifact::validate_direct_mission_artifact_bundle(
        tx,
        store,
        &private,
        &output_binding,
        &content_hash,
    )?;
    // Re-run the reference-aware creator in its validation-only idempotent path.
    artifact::create_direct_mission_output_with_artifact_reference(
        tx,
        store,
        &private,
        owner_member_id,
        &binding.run_id,
        received_event_id,
        &result_event_id,
        OUTPUT_KEY,
        "Artifact revision brief",
        &markdown,
        &output_binding,
        "Authenticated artifact revision instructions",
        artifact::DirectMissionArtifactReference {
            field_key: "sourceArtifact",
            reference: &reference,
        },
    )?;
    validate_transcript(
        tx,
        store,
        scope,
        &binding,
        &markdown,
        &output_binding,
        &result_event_id,
        result_event
            .get("occurredAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
}

fn fixed_plan_input(binding: &Binding, focus: &str) -> MissionPlanCreateInput {
    MissionPlanCreateInput {
        mission_id: binding.mission_id.clone(),
        plan_id: binding.plan_id.clone(),
        plan_revision_id: binding.plan_revision_id.clone(),
        execution_depth: "delegated".into(),
        outcome: json!({
            "title":"Artifact revision brief","desiredOutcome":focus,
            "deliverables":[{"key":OUTPUT_KEY,"description":"A deterministic Markdown revision brief draft.","required":true}]
        }),
        mission_scope: json!({
            "sourceThreadId":binding.source_thread_id,"projectId":binding.project_id,
            "departmentIds":[],"context":[]
        }),
        constraints: json!([{
            "key":CONTINUATION_ID,"description":"Use only the fixed native artifact revision-brief continuation.",
            "severity":"required","source":"orchestrator"
        }]),
        time_constraint: None,
        data_boundary: None,
        acceptance: json!({"requiresHumanAcceptance":false,"criteria":[]}),
        budget: Some(json!({"maxWorkers":1,"maxAttempts":1})),
        summary: focus.into(),
        bounds: json!({"maxSteps":1,"maxDependenciesPerStep":0,"maxParallelSteps":1,"maxRevisions":1}),
        steps: json!([{
            "key":"compose","kind":"produce","title":"Compose artifact revision brief",
            "objective":"Transform authenticated revision instructions and an attested artifact-version identity into a deterministic Markdown draft.",
            "dependsOnStepKeys":[],"requiredCapabilities":[],
            "expectedOutputs":[{"key":OUTPUT_KEY,"description":"A deterministic Markdown revision brief draft.","required":true,"format":"text/markdown"}],
            "acceptanceCriterionKeys":[],"optional":false
        }]),
    }
}

fn fixed_fields() -> Vec<HumanInputField> {
    vec![
        field(
            "sourceArtifact",
            "Source artifact",
            Some("Choose the exact artifact version to revise."),
            "artifact",
            true,
        ),
        field(
            "objective",
            "Revision objective",
            Some("What should the revision achieve?"),
            "text",
            true,
        ),
        field(
            "changes",
            "Requested changes",
            Some("Describe the changes to make."),
            "text",
            true,
        ),
        field(
            "preserve",
            "Preserve",
            Some("Optional qualities or details that should remain unchanged."),
            "text",
            false,
        ),
        field(
            "reviewBeforeUse",
            "Review before use",
            Some("Require review before using the revised artifact."),
            "boolean",
            true,
        ),
        field(
            "targetAt",
            "Target date",
            Some("Optional target date and time."),
            "date-time",
            false,
        ),
    ]
}

fn field(
    key: &str,
    label: &str,
    help: Option<&str>,
    kind: &str,
    required: bool,
) -> HumanInputField {
    HumanInputField {
        key: key.into(),
        label: label.into(),
        help: help.map(str::to_string),
        kind: kind.into(),
        required,
        sensitive: false,
        choices: None,
    }
}

fn validate_start(input: &ArtifactRevisionBriefStartInput) -> Result<(), String> {
    bounded(&input.source_thread_id, "Source conversation", 128)?;
    if let Some(project_id) = input.project_id.as_deref() {
        bounded(project_id, "Project", 128)?;
    }
    bounded(&input.start_key, "Artifact revision-brief start key", 200)?;
    if let Some(focus) = input.focus.as_deref() {
        bounded(focus, "Artifact revision focus", 500)?;
    }
    Ok(())
}

fn normalized_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalized_focus(value: Option<&str>) -> String {
    value
        .map(flatten)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FOCUS.into())
}

fn require_owned_source(
    tx: &rusqlite::Connection,
    auth: &Authorized,
    thread_id: &str,
    project_id: Option<&str>,
) -> crate::store::Result<()> {
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2
         AND authority='local' AND visibility='member-private' AND lifecycle='active'
         AND deleted_at IS NULL AND owner_member_id=?3)",
        rusqlite::params![auth.scope.workspace_id(), thread_id, auth.member_id],
        |row| row.get(0),
    )?;
    if !owns_thread {
        return Err(invalid_error(
            "Artifact revision-brief source conversation is unavailable for this member.",
        ));
    }
    if let Some(project_id) = project_id {
        let owns_project: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM project WHERE workspace_id=?1 AND id=?2
             AND authority='local' AND visibility='member-private' AND lifecycle='active'
             AND deleted_at IS NULL AND owner_member_id=?3)",
            rusqlite::params![auth.scope.workspace_id(), project_id, auth.member_id],
            |row| row.get(0),
        )?;
        if !owns_project {
            return Err(invalid_error(
                "Artifact revision-brief project is unavailable for this member.",
            ));
        }
    }
    Ok(())
}

fn require_unchanged_source(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    binding: &Binding,
) -> crate::store::Result<()> {
    let source = thread::get(tx, store, scope, &binding.source_thread_id)?.ok_or_else(|| {
        invalid_error("Artifact revision-brief source conversation is unavailable.")
    })?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2
         AND authority='local' AND visibility='member-private' AND lifecycle='active'
         AND deleted_at IS NULL AND owner_member_id=?3)",
        rusqlite::params![
            scope.workspace_id(),
            binding.source_thread_id,
            owner_member_id
        ],
        |row| row.get(0),
    )?;
    if !owns_thread
        || source.lifecycle != "active"
        || source.project_id.as_deref() != binding.project_id.as_deref()
    {
        return Err(invalid_error(
            "Artifact revision-brief source conversation changed while input was pending.",
        ));
    }
    if let Some(project_id) = binding.project_id.as_deref() {
        let owns_project: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM project WHERE workspace_id=?1 AND id=?2
             AND authority='local' AND visibility='member-private' AND lifecycle='active'
             AND deleted_at IS NULL AND owner_member_id=?3)",
            rusqlite::params![scope.workspace_id(), project_id, owner_member_id],
            |row| row.get(0),
        )?;
        if !owns_project {
            return Err(invalid_error(
                "Artifact revision-brief project changed while input was pending.",
            ));
        }
    }
    Ok(())
}

fn require_readable_artifact(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    binding: &Binding,
) -> crate::store::Result<()> {
    let private = PrivateDataScope::for_authenticated_user(
        auth.scope.clone(),
        &auth.internal_user_id,
        Some(&auth.member_id),
    )?;
    let artifacts = artifact::search(
        tx,
        store,
        &private,
        &artifact::ArtifactSearchFilter {
            query: None,
            thread_id: None,
            project_id: binding.project_id.as_deref(),
            kinds: &[],
            statuses: &[],
            limit: 1,
        },
    )?;
    if artifacts.is_empty() {
        Err(invalid_error(
            "Create or import an artifact in this scope before starting a revision brief.",
        ))
    } else {
        Ok(())
    }
}

fn validate_start_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    binding: &Binding,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    focus: &str,
) -> crate::store::Result<PendingHumanInput> {
    let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &binding.run_id)?
        .ok_or_else(|| invalid_error("Artifact revision-brief run is unavailable."))?;
    if lifecycle
        .current_revision
        .get("summary")
        .and_then(Value::as_str)
        != Some(focus)
        || lifecycle.mission.get("status").and_then(Value::as_str) != Some("waiting")
        || journal.run.get("status").and_then(Value::as_str) != Some("waiting-human-input")
    {
        return Err(invalid_error(
            "The artifact revision-brief start key represents different or terminal facts.",
        ));
    }
    validate_fixed_lifecycle(&journal, lifecycle, binding)?;
    let pending = crate::mission_human_input::pending_for_run_in_tx(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &journal,
    )?;
    if pending.request_key != REQUEST_KEY
        || pending.prompt != PROMPT
        || pending.fields != fixed_fields()
    {
        return Err(invalid_error(
            "Artifact revision-brief wait schema changed.",
        ));
    }
    Ok(pending)
}

#[allow(clippy::too_many_arguments)]
fn validate_continuation_boundary(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &Binding,
    received_event_id: &str,
) -> crate::store::Result<()> {
    validate_fixed_lifecycle(journal, lifecycle, binding)?;
    let received = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(received_event_id))
        .ok_or_else(|| invalid_error("Artifact revision-brief response is unavailable."))?;
    validate_fixed_request(tx, store, scope, owner_member_id, journal, received)?;
    if journal.run.get("status").and_then(Value::as_str) != Some("running")
        || lifecycle.mission.get("status").and_then(Value::as_str) != Some("waiting")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(received_event_id)
        || journal
            .events
            .last()
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str)
            != Some("human-input-received")
    {
        return Err(invalid_error(
            "Artifact revision-brief response is not at its exact continuation boundary.",
        ));
    }
    Ok(())
}

fn validate_fixed_lifecycle(
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &Binding,
) -> crate::store::Result<()> {
    let constraints = lifecycle
        .mission
        .get("constraints")
        .and_then(Value::as_array);
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array);
    if journal.run.get("id").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || journal
            .run
            .pointer("/initiator/missionId")
            .and_then(Value::as_str)
            != Some(binding.mission_id.as_str())
        || journal.run.get("planRevisionId").and_then(Value::as_str)
            != Some(binding.plan_revision_id.as_str())
        || journal.run.get("sourceThreadId").and_then(Value::as_str)
            != Some(binding.source_thread_id.as_str())
        || journal.run.get("projectId").and_then(Value::as_str) != binding.project_id.as_deref()
        || lifecycle.plan.get("id").and_then(Value::as_str) != Some(binding.plan_id.as_str())
        || lifecycle.current_revision.get("id").and_then(Value::as_str)
            != Some(binding.plan_revision_id.as_str())
        || constraints.is_none_or(|items| {
            items.len() != 1
                || items[0].get("key").and_then(Value::as_str) != Some(CONTINUATION_ID)
                || items[0].get("severity").and_then(Value::as_str) != Some("required")
                || items[0].get("source").and_then(Value::as_str) != Some("orchestrator")
        })
        || steps.is_none_or(|items| {
            items.len() != 1
                || items[0].get("key").and_then(Value::as_str) != Some("compose")
                || items[0]
                    .get("requiredCapabilities")
                    .and_then(Value::as_array)
                    .is_none_or(|items| !items.is_empty())
        })
    {
        return Err(invalid_error(
            "Artifact revision-brief durable shape is invalid.",
        ));
    }
    Ok(())
}

fn validate_fixed_request(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    received: &Value,
) -> crate::store::Result<()> {
    let request_id = received
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_error("Artifact revision-brief request link is invalid."))?;
    let request = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_id))
        .ok_or_else(|| invalid_error("Artifact revision-brief request is unavailable."))?;
    let checkpoint_id = request
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_error("Artifact revision-brief checkpoint link is invalid."))?;
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_id)?
            .ok_or_else(|| invalid_error("Artifact revision-brief checkpoint is unavailable."))?;
    let fields: Vec<HumanInputField> = serde_json::from_value(
        request
            .pointer("/payload/wait/fields")
            .cloned()
            .ok_or_else(|| invalid_error("Artifact revision-brief request schema is missing."))?,
    )
    .map_err(|_| invalid_error("Artifact revision-brief request schema is invalid."))?;
    if request.get("type").and_then(Value::as_str) != Some("human-input-requested")
        || request
            .pointer("/payload/wait/prompt")
            .and_then(Value::as_str)
            != Some(PROMPT)
        || fields != fixed_fields()
        || checkpoint
            .state
            .pointer("/humanInputWait/requestKey")
            .and_then(Value::as_str)
            != Some(REQUEST_KEY)
        || checkpoint
            .state
            .pointer("/humanInputWait/prompt")
            .and_then(Value::as_str)
            != Some(PROMPT)
        || checkpoint.state.pointer("/humanInputWait/fields") != Some(&json!(fixed_fields()))
    {
        return Err(invalid_error(
            "Artifact revision-brief request no longer matches its fixed native schema.",
        ));
    }
    Ok(())
}

struct SourceValue {
    artifact_id: String,
    artifact_version_id: String,
    content_hash: String,
}

struct RevisionValues {
    source: SourceValue,
    objective: String,
    changes: String,
    preserve: Option<String>,
    review_before_use: bool,
    target_at: Option<String>,
}

fn revision_values(event: &Value) -> crate::store::Result<RevisionValues> {
    let values = event
        .pointer("/payload/resolution/values")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_error("Artifact revision-brief values are invalid."))?;
    let find = |key: &str| {
        values
            .iter()
            .find(|item| item.get("fieldKey").and_then(Value::as_str) == Some(key))
            .and_then(|item| item.get("value"))
    };
    let text = |key: &str, required_value: bool| -> crate::store::Result<Option<String>> {
        match find(key).and_then(Value::as_str) {
            Some(value) if !value.trim().is_empty() => Ok(Some(value.trim().into())),
            _ if required_value => Err(invalid_error(&format!(
                "Artifact revision-brief field '{key}' is missing."
            ))),
            _ => Ok(None),
        }
    };
    let source = find("sourceArtifact")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid_error("Artifact revision-brief source reference is invalid."))?;
    if source.len() != 3
        || source
            .get("contentHash")
            .and_then(|value| value.get("algorithm"))
            .and_then(Value::as_str)
            != Some("sha-256")
    {
        return Err(invalid_error(
            "Artifact revision-brief source attestation is invalid.",
        ));
    }
    let artifact_id = source
        .get("artifactId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_error("Artifact revision-brief source artifact is invalid."))?;
    let artifact_version_id = source
        .get("artifactVersionId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_error("Artifact revision-brief source version is invalid."))?;
    let content_hash = source
        .get("contentHash")
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
        .filter(|hash| valid_hash(hash))
        .ok_or_else(|| invalid_error("Artifact revision-brief source hash is invalid."))?;
    let review_before_use = find("reviewBeforeUse")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_error("Artifact revision-brief review choice is invalid."))?;
    Ok(RevisionValues {
        source: SourceValue {
            artifact_id: artifact_id.into(),
            artifact_version_id: artifact_version_id.into(),
            content_hash: content_hash.into(),
        },
        objective: text("objective", true)?.unwrap_or_default(),
        changes: text("changes", true)?.unwrap_or_default(),
        preserve: text("preserve", false)?,
        review_before_use,
        target_at: text("targetAt", false)?,
    })
}

fn immutable_reference(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &PrivateDataScope,
    source: &SourceValue,
) -> crate::store::Result<artifact::AttestedArtifactVersionReference> {
    let existing = artifact::attest_existing_artifact_version(
        tx,
        store,
        scope,
        &source.artifact_id,
        &source.artifact_version_id,
    )?;
    if existing.content_hash != source.content_hash {
        return Err(invalid_error(
            "Artifact revision-brief source hash no longer matches its immutable version.",
        ));
    }
    // Artifact titles are mutable. Use an identity-derived label so later
    // rename/review/current-version changes cannot invalidate exact replay.
    Ok(artifact::AttestedArtifactVersionReference {
        artifact_id: existing.artifact_id,
        artifact_version_id: existing.artifact_version_id,
        title: format!("Artifact {}", source.artifact_id),
        content_hash: existing.content_hash,
    })
}

fn render_markdown(
    values: &RevisionValues,
    source: &artifact::AttestedArtifactVersionReference,
) -> String {
    format!(
        "# Artifact revision brief\n\n## Source version\n\n- Artifact: `{}`\n- Version: `{}`\n- SHA-256: `{}`\n\n## Revision objective\n\n{}\n\n## Requested changes\n\n{}\n\n## Preserve\n\n{}\n\n## Review before use\n\n{}\n\n## Target date\n\n{}\n",
        inline_code(&source.artifact_id), inline_code(&source.artifact_version_id), source.content_hash,
        escape(&values.objective), escape(&values.changes),
        values.preserve.as_deref().map(escape).unwrap_or_else(|| "Nothing specified.".into()),
        if values.review_before_use { "Required." } else { "Not required." },
        values.target_at.as_deref().map(escape).unwrap_or_else(|| "Not set.".into()),
    )
}

#[allow(clippy::too_many_arguments)]
fn append_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    binding: &Binding,
    journal: &mission_run::MissionRunJournalRow,
    markdown: &str,
    artifact_binding: &artifact::DirectMissionArtifactBinding,
    result_event_id: &str,
    at: &str,
) -> crate::store::Result<()> {
    if journal.run.get("status").and_then(Value::as_str) != Some("completed")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id)
    {
        return Err(invalid_error(
            "Artifact revision-brief terminal run is unavailable for transcript projection.",
        ));
    }
    let head = thread::get(tx, store, scope, &binding.source_thread_id)?.ok_or_else(|| {
        invalid_error("Artifact revision-brief source conversation is unavailable.")
    })?;
    let (user_id, user_revision, user_key) = transcript_identity(&binding.run_id, "user");
    let (assistant_id, assistant_revision, assistant_key) =
        transcript_identity(&binding.run_id, "assistant");
    message::append(
        tx,
        store,
        scope,
        &binding.source_thread_id,
        &user_id,
        "user",
        &Value::Null,
        Some(&binding.run_id),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &user_key,
        &user_revision,
        "terminal",
        "initial",
        &json!("Artifact revision details submitted."),
        at,
    )?;
    message::append(
        tx,
        store,
        scope,
        &binding.source_thread_id,
        &assistant_id,
        "assistant",
        &json!({
            "type":"mission-result","missionKind":"artifact-revision-brief",
            "missionId":binding.mission_id,"resultEventId":result_event_id,"outcome":"completed",
            "artifactId":artifact_binding.artifact_id,"artifactVersionId":artifact_binding.artifact_version_id
        }),
        Some(&binding.run_id),
        head.last_sequence + 2,
        head.last_sequence + 1,
        Some(&user_id),
        &assistant_key,
        &assistant_revision,
        "terminal",
        "initial",
        &json!(markdown),
        at,
    )?;
    validate_transcript(
        tx,
        store,
        scope,
        binding,
        markdown,
        artifact_binding,
        result_event_id,
        at,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    binding: &Binding,
    markdown: &str,
    artifact_binding: &artifact::DirectMissionArtifactBinding,
    result_event_id: &str,
    at: &str,
) -> crate::store::Result<()> {
    let messages = message::list(tx, store, scope, &binding.source_thread_id)?;
    let (user_id, user_revision, user_key) = transcript_identity(&binding.run_id, "user");
    let (assistant_id, assistant_revision, assistant_key) =
        transcript_identity(&binding.run_id, "assistant");
    let user = messages.iter().find(|item| item.id == user_id);
    let assistant = messages.iter().find(|item| item.id == assistant_id);
    let expected_user_previous = user.and_then(|item| {
        messages
            .iter()
            .find(|candidate| candidate.sequence + 1 == item.sequence)
            .map(|candidate| candidate.id.as_str())
    });
    let detail = json!({
        "type":"mission-result","missionKind":"artifact-revision-brief",
        "missionId":binding.mission_id,"resultEventId":result_event_id,"outcome":"completed",
        "artifactId":artifact_binding.artifact_id,"artifactVersionId":artifact_binding.artifact_version_id
    });
    let stored_links: Option<(Option<String>, String, Option<String>, String)> = tx
        .query_row(
            "SELECT u.previous_message_id,u.idempotency_key,a.previous_message_id,a.idempotency_key
         FROM message u JOIN message a ON a.workspace_id=u.workspace_id AND a.thread_id=u.thread_id
         WHERE u.workspace_id=?1 AND u.thread_id=?2 AND u.id=?3 AND a.id=?4",
            rusqlite::params![
                scope.workspace_id(),
                binding.source_thread_id,
                user_id,
                assistant_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    if user.is_none_or(|item| {
        item.kind != "user"
            || item.run_id.as_deref() != Some(binding.run_id.as_str())
            || !item.detail.is_null()
            || item.current_revision_id != user_revision
            || item.current_revision_number != 1
            || item.current_revision_state != "terminal"
            || item.content != json!("Artifact revision details submitted.")
            || item.created_at != at
    }) || assistant.is_none_or(|item| {
        item.kind != "assistant"
            || item.run_id.as_deref() != Some(binding.run_id.as_str())
            || item.sequence != user.map(|message| message.sequence + 1).unwrap_or(-1)
            || item.current_revision_id != assistant_revision
            || item.current_revision_number != 1
            || item.current_revision_state != "terminal"
            || item.content != json!(markdown)
            || item.detail != detail
            || item.created_at != at
    }) || stored_links.is_none_or(
        |(stored_user_previous, stored_user_key, assistant_previous, stored_assistant_key)| {
            stored_user_previous.as_deref() != expected_user_previous
                || stored_user_key != user_key
                || assistant_previous.as_deref() != Some(user_id.as_str())
                || stored_assistant_key != assistant_key
        },
    ) {
        return Err(invalid_error(
            "Artifact revision-brief transcript is incomplete.",
        ));
    }
    Ok(())
}

fn transcript_identity(run_id: &str, role: &str) -> (String, String, String) {
    let suffix = &digest(&format!(
        "artifact-revision-brief-transcript:v1|{run_id}|{role}"
    ))[..40];
    (
        format!("artifact-revision-brief-message-{suffix}"),
        format!("artifact-revision-brief-message-revision-{suffix}"),
        format!("artifact-revision-brief-message:v1:{suffix}"),
    )
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded(value: &str, label: &str, max: usize) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        Err(format!("{label} must be between 1 and {max} characters."))
    } else {
        Ok(())
    }
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn flatten(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn inline_code(value: &str) -> String {
    value.replace('`', "'").replace(['\r', '\n'], " ")
}

fn object(value: Value) -> crate::store::Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_error("Artifact revision-brief run record is invalid."))
}

fn required<'a>(value: &'a Value, key: &str) -> crate::store::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid_error(&format!("Artifact revision-brief {key} is invalid.")))
}

fn required_i64(value: &Value, key: &str) -> crate::store::Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid_error(&format!("Artifact revision-brief {key} is invalid.")))
}

fn invalid_error(message: &str) -> crate::store::StoreError {
    crate::store::StoreError::Invalid(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mission_human_input::{receive_with_store, HumanInputReceiveInput, HumanInputValue};
    use crate::mission_runs::{request_cancellation_with_store, MissionRunCancelInput};
    use crate::store::repos::{seal_json, workspace_directory};
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    struct Fixture {
        directory: tempfile::TempDir,
        key: MasterKey,
        workspace_id: String,
        source_hash: String,
    }

    fn seed(with_artifact: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let key = MasterKey::generate().unwrap();
        let store = Store::open(
            &directory.path().join("fable.db"),
            Vault::new(&key).unwrap(),
        )
        .unwrap();
        let summary = workspace_directory::WorkspaceDirectoryUpsert {
            internal_user_id: "user-1".into(),
            fable_workspace_id: "workspace-hosted-1".into(),
            name: "One".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: "member-1".into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "2026-07-15T09:00:00Z".into(),
        };
        let local = store
            .transaction(|tx| {
                let local = workspace_directory::upsert_authoritative_summary(tx, &summary)?;
                workspace_directory::upsert_authoritative_summary(
                    tx,
                    &workspace_directory::WorkspaceDirectoryUpsert {
                        internal_user_id: "user-2".into(),
                        member_id: "member-2".into(),
                        ..summary.clone()
                    },
                )?;
                workspace_directory::set_current_internal_user(tx, "user-1", "t0")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "t0",
                )?;
                Ok(local.local_workspace_id)
            })
            .unwrap();
        let source_text = "Private source body that must never be copied into the revision brief.";
        let source_hash = digest(source_text);
        store
            .transaction(|tx| {
                let scope = DataScope::workspace(local.clone())?;
                for (id, title) in [("thread-1", "Planning"), ("thread-2", "Other")] {
                    thread::create(tx, &store, &scope, id, None, title, "t0", &json!({}))?;
                    tx.execute(
                        "UPDATE thread SET owner_member_id='member-1' WHERE id=?1",
                        [id],
                    )?;
                }
                message::append(
                    tx,
                    &store,
                    &scope,
                    "thread-1",
                    "initial-message",
                    "user",
                    &Value::Null,
                    None,
                    1,
                    0,
                    None,
                    "initial-message:v1",
                    "initial-message-revision",
                    "terminal",
                    "initial",
                    &json!("Please prepare a revision brief."),
                    "t0",
                )?;
                if with_artifact {
                    let private = PrivateDataScope::for_authenticated_user(
                        scope,
                        "user-1",
                        Some("member-1"),
                    )?;
                    insert_source_artifact(
                        tx,
                        &store,
                        &private,
                        "artifact-source",
                        "source-v1",
                        "Original source title",
                        source_text,
                        "t0",
                    )?;
                    insert_source_artifact(
                        tx,
                        &store,
                        &private,
                        "artifact-other",
                        "other-v1",
                        "Other source",
                        "A different readable source artifact.",
                        "t0",
                    )?;
                }
                Ok(())
            })
            .unwrap();
        Fixture {
            directory,
            key,
            workspace_id: local,
            source_hash,
        }
    }

    fn reopen(fixture: &Fixture) -> Store {
        Store::open(
            &fixture.directory.path().join("fable.db"),
            Vault::new(&fixture.key).unwrap(),
        )
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_source_artifact(
        tx: &rusqlite::Connection,
        store: &Store,
        scope: &PrivateDataScope,
        artifact_id: &str,
        version_id: &str,
        title: &str,
        text: &str,
        at: &str,
    ) -> crate::store::Result<()> {
        let content_hash = digest(text);
        let media = json!({"mediaType":"text/markdown","byteLength":text.len(),"encoding":"utf-8"});
        let hash = json!({"algorithm":"sha-256","value":content_hash});
        let artifact_value = json!({
            "id":artifact_id,"workspaceId":scope.workspace_id(),"authority":"local",
            "visibility":"member-private","ownerMemberId":"member-1","schemaVersion":1,
            "revision":1,"createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
            "kind":"document","status":"draft","title":title,"currentVersionId":version_id,
            "context":{"threadId":"thread-1"},"sourceProvenance":[],"reviews":[],
            "retention":{"status":"active"}
        });
        let version_value = json!({
            "id":version_id,"artifactId":artifact_id,"version":1,"status":"available",
            "createdAt":at,"createdByInternalUserId":"user-1",
            "content":{"kind":"inline","text":text,"media":media,"contentHash":hash},
            "media":media,"contentHash":hash,"provenance":{"kind":"user-input","observedAt":at},
            "citations":[],"inputs":[],"decisions":[],"lineage":[]
        });
        let sealed_artifact = seal_json(
            store,
            &artifact_value,
            &format!(
                "artifact:{}:{}:{artifact_id}",
                scope.workspace_id(),
                scope.owner_subject()
            ),
        )?;
        let sealed_version = seal_json(
            store,
            &version_value,
            &format!(
                "artifact_version:{}:{}:{artifact_id}:{version_id}",
                scope.workspace_id(),
                scope.owner_subject()
            ),
        )?;
        tx.execute(
            "INSERT INTO artifact
             (workspace_id,owner_subject,authority,visibility,owner_member_id,owner_internal_user_id,
              id,thread_id,kind,status,revision,current_version_id,title_fingerprint,content_fingerprint,
              size_bytes,created_at,updated_at,payload,payload_nonce)
             VALUES (?1,?2,'local','member-private','member-1',NULL,?3,'thread-1','document',
              'draft',1,?4,?5,?6,?7,?8,?8,?9,?10)",
            rusqlite::params![
                scope.workspace_id(), scope.owner_subject(), artifact_id, version_id, digest(title),
                content_hash, text.len() as i64, at, sealed_artifact.ciphertext, sealed_artifact.nonce
            ],
        )?;
        tx.execute(
            "INSERT INTO artifact_version
             (workspace_id,owner_subject,artifact_id,id,version,status,content_fingerprint,size_bytes,
              created_at,payload,payload_nonce)
             VALUES (?1,?2,?3,?4,1,'available',?5,?6,?7,?8,?9)",
            rusqlite::params![
                scope.workspace_id(), scope.owner_subject(), artifact_id, version_id, content_hash,
                text.len() as i64, at, sealed_version.ciphertext, sealed_version.nonce
            ],
        )?;
        Ok(())
    }

    fn start(
        thread_id: &str,
        start_key: &str,
        focus: Option<&str>,
    ) -> ArtifactRevisionBriefStartInput {
        ArtifactRevisionBriefStartInput {
            source_thread_id: thread_id.into(),
            project_id: None,
            start_key: start_key.into(),
            focus: focus.map(str::to_string),
        }
    }

    fn values(artifact_id: &str, version_id: &str, objective: &str) -> Vec<HumanInputValue> {
        vec![
            HumanInputValue {
                field_key: "sourceArtifact".into(),
                value: json!({"artifactId":artifact_id,"artifactVersionId":version_id}),
            },
            HumanInputValue {
                field_key: "objective".into(),
                value: json!(objective),
            },
            HumanInputValue {
                field_key: "changes".into(),
                value: json!("Reorder the opening and make the next action explicit."),
            },
            HumanInputValue {
                field_key: "preserve".into(),
                value: json!("Keep the existing evidence and measured tone."),
            },
            HumanInputValue {
                field_key: "reviewBeforeUse".into(),
                value: json!(true),
            },
            HumanInputValue {
                field_key: "targetAt".into(),
                value: json!("2026-08-31T17:00:00Z"),
            },
        ]
    }

    fn response(
        pending: &PendingHumanInput,
        values: Vec<HumanInputValue>,
    ) -> HumanInputReceiveInput {
        HumanInputReceiveInput {
            run_id: pending.run_id.clone(),
            wait_key: pending.wait_key.clone(),
            expected_run_revision: pending.run_revision,
            expected_last_sequence: pending.last_sequence,
            values,
        }
    }

    #[test]
    fn end_to_end_attested_revision_brief_reopens_replays_and_survives_source_changes() {
        let fixture = seed(true);
        let store = reopen(&fixture);
        let pending = start_with_store(
            &store,
            start(
                "thread-1",
                "revision-start",
                Some("Clarify the customer handoff."),
            ),
        )
        .unwrap();
        assert_eq!(pending.fields, fixed_fields());
        assert_eq!(pending.run_revision, 5);
        assert_eq!(pending.last_sequence, 4);
        drop(store);

        let reopened = reopen(&fixture);
        assert_eq!(
            start_with_store(
                &reopened,
                start(
                    "thread-1",
                    "revision-start",
                    Some("Clarify the customer handoff.")
                ),
            )
            .unwrap(),
            pending
        );
        let submitted = values(
            "artifact-source",
            "source-v1",
            "Make the handoff actionable.",
        );
        let receipt = receive_with_store(&reopened, response(&pending, submitted.clone())).unwrap();
        let scope = DataScope::workspace(fixture.workspace_id.clone()).unwrap();
        let journal = reopened
            .with_conn(|tx| mission_run::get(tx, &reopened, &scope, "member-1", &pending.run_id))
            .unwrap()
            .unwrap();
        assert_eq!(journal.run["status"], "completed");
        assert_eq!(journal.events.len(), 6);
        let received = &journal.events[4];
        assert_eq!(received["type"], "human-input-received");
        assert_eq!(
            received["payload"]["resolution"]["values"][0]["value"]["contentHash"]["value"],
            fixture.source_hash
        );
        assert_eq!(journal.events[5]["type"], "run-completed");
        assert_eq!(journal.events[5]["previousEventId"], received["id"]);
        let lifecycle = reopened
            .with_conn(|tx| {
                mission_plan::get(tx, &reopened, &scope, "member-1", &pending.mission_id)
            })
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.mission["status"], "completed");
        let messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, &scope, "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[1].content,
            json!("Artifact revision details submitted.")
        );
        assert_eq!(messages[2].detail["missionKind"], "artifact-revision-brief");
        let previous: Option<String> = reopened
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT previous_message_id FROM message WHERE id=?1",
                    [&messages[1].id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(previous.as_deref(), Some("initial-message"));
        let output_id = messages[2].detail["artifactId"].as_str().unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-1", Some("member-1"))
                .unwrap();
        let output = reopened
            .with_conn(|tx| artifact::get_bundle(tx, &reopened, &private, output_id))
            .unwrap()
            .unwrap();
        let markdown = output["currentVersion"]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(markdown.contains("Make the handoff actionable."));
        assert!(!markdown.contains("Private source body"));
        assert_eq!(
            output["currentVersion"]["lineage"][0]["artifactId"],
            "artifact-source"
        );
        assert_eq!(
            output["currentVersion"]["lineage"][0]["artifactVersionId"],
            "source-v1"
        );
        assert_eq!(
            output["currentVersion"]["inputs"][1]["contentHash"]["value"],
            fixture.source_hash
        );

        // Rename the source, advance its current version, then request review.
        // Exact replay remains bound to the still-available immutable v1.
        reopened.transaction(|tx| {
            let bundle = artifact::get_bundle(tx, &reopened, &private, "artifact-source")?.unwrap();
            let next_text = "A newly edited current source version.";
            let next_hash = digest(next_text);
            let media = json!({"mediaType":"text/markdown","byteLength":next_text.len(),"encoding":"utf-8"});
            let hash = json!({"algorithm":"sha-256","value":next_hash});
            let mut artifact_value = bundle["artifact"].clone();
            artifact_value["title"] = json!("Renamed after selection");
            artifact_value["currentVersionId"] = json!("source-v2");
            artifact_value["revision"] = json!(2);
            artifact_value["updatedAt"] = json!("t2");
            let version_value = json!({
                "id":"source-v2","artifactId":"artifact-source","version":2,"status":"available",
                "createdAt":"t2","createdByInternalUserId":"user-1",
                "content":{"kind":"inline","text":next_text,"media":media,"contentHash":hash},
                "media":media,"contentHash":hash,"provenance":{"kind":"user-input","observedAt":"t2"},
                "citations":[],"inputs":[],"decisions":[],"lineage":[]
            });
            artifact::append_version(
                tx, &reopened, &private, "artifact-source", 1, "source-v1",
                &digest("Renamed after selection"), &next_hash, next_text.len(), "t2",
                &artifact_value, &version_value,
            )?;
            artifact::review_action(
                tx, &reopened, &private, "artifact-source", "source-v2", 2,
                "request-review", "user-1", None, &[], "t3",
            )?;
            Ok(())
        }).unwrap();
        let replay = receive_with_store(&reopened, response(&pending, submitted)).unwrap();
        assert_eq!(replay, receipt);
        let counts: (i64, i64, i64) = reopened.with_conn(|tx| Ok((
            tx.query_row("SELECT COUNT(*) FROM mission_run_event WHERE run_id=?1", [&pending.run_id], |row| row.get(0))?,
            tx.query_row("SELECT COUNT(*) FROM message WHERE run_id=?1", [&pending.run_id], |row| row.get(0))?,
            tx.query_row("SELECT COUNT(*) FROM mission_direct_artifact_source WHERE mission_run_id=?1", [&pending.run_id], |row| row.get(0))?,
        ))).unwrap();
        assert_eq!(counts, (6, 2, 1));
    }

    #[test]
    fn start_scope_ownership_and_artifact_preconditions_fail_without_partial_records() {
        let empty_fixture = seed(false);
        let empty = reopen(&empty_fixture);
        assert!(start_with_store(&empty, start("thread-1", "empty", None))
            .unwrap_err()
            .to_string()
            .contains("artifact"));
        let counts: (i64, i64) = empty
            .with_conn(|tx| {
                Ok((
                    tx.query_row("SELECT COUNT(*) FROM mission_record", [], |row| row.get(0))?,
                    tx.query_row("SELECT COUNT(*) FROM mission_run_record", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .unwrap();
        assert_eq!(counts, (0, 0));

        let fixture = seed(true);
        let store = reopen(&fixture);
        start_with_store(
            &store,
            start("thread-1", "bound-start", Some("Original focus")),
        )
        .unwrap();
        assert!(start_with_store(
            &store,
            start("thread-1", "bound-start", Some("Changed focus"))
        )
        .is_err());
        assert!(start_with_store(
            &store,
            start("thread-2", "bound-start", Some("Original focus"))
        )
        .is_err());
        let mut changed_project = start("thread-1", "bound-start", Some("Original focus"));
        changed_project.project_id = Some("project-other".into());
        assert!(start_with_store(&store, changed_project).is_err());
        store
            .transaction(|tx| {
                workspace_directory::set_current_internal_user(tx, "user-2", "t2")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "t2",
                )?;
                Ok(())
            })
            .unwrap();
        assert!(
            start_with_store(&store, start("thread-1", "member-2", None))
                .unwrap_err()
                .to_string()
                .contains("unavailable for this member")
        );
    }

    #[test]
    fn settlement_rolls_back_when_the_source_thread_changes_while_waiting() {
        for changed_project in [false, true] {
            let fixture = seed(true);
            let store = reopen(&fixture);
            let pending = start_with_store(
                &store,
                start(
                    "thread-1",
                    if changed_project { "moved" } else { "archived" },
                    None,
                ),
            )
            .unwrap();
            store
                .transaction(|tx| {
                    if changed_project {
                        let payload = seal_json(
                            &store,
                            &json!({"id":"project-moved"}),
                            "project:project-moved",
                        )?;
                        tx.execute(
                            "INSERT INTO project(id,workspace_id,title_fingerprint,authority,visibility,
                             owner_member_id,created_by_internal_user_id,lifecycle,created_at,updated_at,payload,payload_nonce)
                             VALUES ('project-moved',?1,'title','local','member-private','member-1','user-1','active','t','t',?2,?3)",
                            rusqlite::params![fixture.workspace_id, payload.ciphertext, payload.nonce],
                        )?;
                        tx.execute(
                            "UPDATE thread SET project_id='project-moved' WHERE id='thread-1'",
                            [],
                        )?;
                    } else {
                        tx.execute(
                            "UPDATE thread SET lifecycle='archived' WHERE id='thread-1'",
                            [],
                        )?;
                    }
                    Ok(())
                })
                .unwrap();

            assert!(receive_with_store(
                &store,
                response(
                    &pending,
                    values("artifact-source", "source-v1", "Clarify ownership.")
                )
            )
            .unwrap_err()
            .to_string()
            .contains("changed while input was pending"));
            let scope = DataScope::workspace(fixture.workspace_id.clone()).unwrap();
            let journal = store
                .with_conn(|tx| mission_run::get(tx, &store, &scope, "member-1", &pending.run_id))
                .unwrap()
                .unwrap();
            assert_eq!(journal.run["status"], "waiting-human-input");
            assert_eq!(journal.events.len(), 4);
            let downstream: (i64, i64) = store
                .with_conn(|tx| {
                    Ok((
                        tx.query_row(
                            "SELECT COUNT(*) FROM mission_direct_artifact_source WHERE mission_run_id=?1",
                            [&pending.run_id],
                            |row| row.get(0),
                        )?,
                        tx.query_row(
                            "SELECT COUNT(*) FROM message WHERE run_id=?1",
                            [&pending.run_id],
                            |row| row.get(0),
                        )?,
                    ))
                })
                .unwrap();
            assert_eq!(downstream, (0, 0));
        }
    }

    #[test]
    fn alternate_replay_tampered_source_and_cancellation_fail_closed() {
        let fixture = seed(true);
        let store = reopen(&fixture);
        let pending = start_with_store(&store, start("thread-1", "integrity", None)).unwrap();
        let submitted = values("artifact-source", "source-v1", "Improve navigation.");
        receive_with_store(&store, response(&pending, submitted.clone())).unwrap();
        let mut alternate = submitted.clone();
        alternate[0].value = json!({"artifactId":"artifact-other","artifactVersionId":"other-v1"});
        assert!(receive_with_store(&store, response(&pending, alternate)).is_err());
        store.transaction(|tx| {
            tx.execute(
                "UPDATE artifact_version SET content_fingerprint=?1 WHERE artifact_id='artifact-source' AND id='source-v1'",
                ["b".repeat(64)],
            )?;
            Ok(())
        }).unwrap();
        assert!(receive_with_store(&store, response(&pending, submitted))
            .unwrap_err()
            .to_string()
            .contains("unavailable"));

        let resealed_fixture = seed(true);
        let resealed_store = reopen(&resealed_fixture);
        let pending =
            start_with_store(&resealed_store, start("thread-1", "resealed", None)).unwrap();
        let submitted = values("artifact-source", "source-v1", "Improve navigation.");
        receive_with_store(&resealed_store, response(&pending, submitted.clone())).unwrap();
        let scope = DataScope::workspace(resealed_fixture.workspace_id.clone()).unwrap();
        let private =
            PrivateDataScope::for_authenticated_user(scope, "user-1", Some("member-1")).unwrap();
        resealed_store
            .transaction(|tx| {
                let bundle = artifact::get_bundle(
                    tx,
                    &resealed_store,
                    &private,
                    "artifact-source",
                )?
                .unwrap();
                let mut version = bundle["versions"]
                    .as_array()
                    .and_then(|versions| {
                        versions.iter().find(|version| version["id"] == "source-v1")
                    })
                    .cloned()
                    .unwrap();
                version["content"]["text"] = json!("Resealed substitute bytes.");
                let sealed = seal_json(
                    &resealed_store,
                    &version,
                    &format!(
                        "artifact_version:{}:{}:artifact-source:source-v1",
                        private.workspace_id(),
                        private.owner_subject()
                    ),
                )?;
                tx.execute(
                    "UPDATE artifact_version SET payload=?1,payload_nonce=?2
                     WHERE workspace_id=?3 AND owner_subject=?4 AND artifact_id='artifact-source' AND id='source-v1'",
                    rusqlite::params![
                        sealed.ciphertext,
                        sealed.nonce,
                        private.workspace_id(),
                        private.owner_subject()
                    ],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(
            receive_with_store(&resealed_store, response(&pending, submitted))
                .unwrap_err()
                .to_string()
                .contains("unavailable")
        );

        let cancel_fixture = seed(true);
        let cancel_store = reopen(&cancel_fixture);
        let pending = start_with_store(&cancel_store, start("thread-1", "cancel", None)).unwrap();
        let cancelled = request_cancellation_with_store(
            &cancel_store,
            MissionRunCancelInput {
                run_id: pending.run_id.clone(),
                event_id: "artifact-revision-cancel-requested".into(),
                request_key: "artifact-revision-cancel:v1".into(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                mode: "cooperative".into(),
                reason: Some("No revision brief is needed.".into()),
            },
        )
        .unwrap();
        assert_eq!(cancelled.run["status"], "cancelled");
        let downstream: (i64, i64) = cancel_store.with_conn(|tx| Ok((
            tx.query_row("SELECT COUNT(*) FROM mission_direct_artifact_source WHERE mission_run_id=?1", [&pending.run_id], |row| row.get(0))?,
            tx.query_row("SELECT COUNT(*) FROM message WHERE run_id=?1", [&pending.run_id], |row| row.get(0))?,
        ))).unwrap();
        assert_eq!(downstream, (0, 0));
    }

    #[test]
    fn fixed_schema_and_markdown_are_bounded_and_content_free() {
        assert_eq!(fixed_fields().len(), 6);
        assert_eq!(fixed_fields()[0].kind, "artifact");
        let source = artifact::AttestedArtifactVersionReference {
            artifact_id: "artifact-1".into(),
            artifact_version_id: "version-1".into(),
            title: "A mutable source title".into(),
            content_hash: "a".repeat(64),
        };
        let markdown = render_markdown(
            &RevisionValues {
                source: SourceValue {
                    artifact_id: source.artifact_id.clone(),
                    artifact_version_id: source.artifact_version_id.clone(),
                    content_hash: source.content_hash.clone(),
                },
                objective: "Make <this> clearer".into(),
                changes: "Restructure the opening".into(),
                preserve: None,
                review_before_use: true,
                target_at: None,
            },
            &source,
        );
        assert!(markdown.contains("Make &lt;this&gt; clearer"));
        assert!(markdown.contains("artifact-1"));
        assert!(!markdown.contains("mutable source title"));
    }

    #[test]
    fn identity_and_input_validation_fail_closed() {
        let hash = digest("same");
        let binding = Binding::new(hash[..40].into(), "thread-1".into(), None);
        assert!(binding.run_id.ends_with(&hash[..40]));
        assert!(validate_start(&ArtifactRevisionBriefStartInput {
            source_thread_id: "thread-1".into(),
            project_id: None,
            start_key: "start-1".into(),
            focus: Some(" ".into()),
        })
        .is_err());
        assert!(valid_hash(&"a".repeat(64)));
        assert!(!valid_hash(&"A".repeat(64)));
    }
}
