//! Fixed, provider-free structured project brief mission.
//!
//! The renderer may request this one bounded producer, but the native boundary
//! owns its plan, wait schema, event chain, draft materialization, and transcript.

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

const MARKER: &str = "native:structured-intake:v1";
const OUTPUT_KEY: &str = "brief";
const REQUEST_KEY: &str = "structured-project-brief:v1";
const PROMPT: &str = "Add the details needed to create a structured project brief.";

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StructuredIntakeStartInput {
    source_thread_id: String,
    project_id: Option<String>,
    subject: String,
    start_key: String,
}

struct Authorized {
    scope: DataScope,
    internal_user_id: String,
    member_id: String,
    record_workspace_id: String,
}

#[derive(Clone)]
struct Binding {
    run_id: String,
    mission_id: String,
    plan_id: String,
    plan_revision_id: String,
    source_thread_id: String,
    project_id: Option<String>,
    start_hash: String,
}

fn authorized(tx: &rusqlite::Connection) -> crate::store::Result<Authorized> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member_id = context.member_id.clone().ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for structured intake.".into(),
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
pub fn mission_structured_intake_start(
    input: StructuredIntakeStartInput,
) -> Result<PendingHumanInput, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    start_with_store(store, input).map_err(|error| error.to_string())
}

fn start_with_store(
    store: &crate::store::Store,
    input: StructuredIntakeStartInput,
) -> crate::store::Result<PendingHumanInput> {
    validate_start(&input).map_err(crate::store::StoreError::Invalid)?;
    store.transaction(|tx| {
        let auth = authorized(tx)?;
        let source = thread::get(tx, store, &auth.scope, input.source_thread_id.trim())?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Structured intake source conversation is unavailable.".into(),
                )
            })?;
        if source.lifecycle != "active" || source.project_id != input.project_id {
            return Err(crate::store::StoreError::Invalid(
                "Structured intake source conversation changed.".into(),
            ));
        }
        let owns_source: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2
             AND authority='local' AND visibility='member-private' AND deleted_at IS NULL
             AND owner_member_id=?3)",
            rusqlite::params![auth.scope.workspace_id(), source.id, auth.member_id],
            |row| row.get(0),
        )?;
        if !owns_source {
            return Err(crate::store::StoreError::Invalid(
                "Structured intake source conversation is unavailable for this member.".into(),
            ));
        }
        if let Some(project_id) = source.project_id.as_deref() {
            let owns_project: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM project WHERE workspace_id=?1 AND id=?2
                 AND authority='local' AND visibility='member-private' AND lifecycle='active'
                 AND owner_member_id=?3)",
                rusqlite::params![auth.scope.workspace_id(), project_id, auth.member_id],
                |row| row.get(0),
            )?;
            if !owns_project {
                return Err(crate::store::StoreError::Invalid(
                    "Structured intake project is unavailable for this member.".into(),
                ));
            }
        }

        let start_hash = digest(&format!(
            "structured-intake-start:v1|{}|{}|{}|{}",
            auth.scope.workspace_id(),
            auth.member_id,
            source.id,
            input.start_key.trim()
        ));
        if let Some(binding) = binding_by_start(
            tx,
            auth.scope.workspace_id(),
            &auth.member_id,
            &source.id,
            &start_hash,
        )? {
            return validate_start_replay(
                tx,
                store,
                &auth,
                &binding,
                input.subject.trim(),
                source.project_id.as_deref(),
            );
        }

        let suffix = start_hash[..40].to_string();
        let binding = Binding {
            run_id: format!("structured-intake-run-{suffix}"),
            mission_id: format!("structured-intake-mission-{suffix}"),
            plan_id: format!("structured-intake-plan-{suffix}"),
            plan_revision_id: format!("structured-intake-revision-{suffix}"),
            source_thread_id: source.id.clone(),
            project_id: source.project_id.clone(),
            start_hash,
        };
        let at = now();
        let plan_input = fixed_plan_input(&binding, input.subject.trim());
        let records = build_initial_records(
            &plan_input,
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
            event_id: format!("structured-intake-created-{suffix}"),
            idempotency_key: format!("structured-intake-create:{suffix}"),
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
        mission_plan::mark_running(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &lifecycle,
            &at,
        )?;
        let started_id = format!("structured-intake-started-{suffix}");
        let started_key = format!("structured-intake-start:v1:{suffix}");
        let started_event = json!({
            "workspaceId":created.run.get("workspaceId"),"visibility":"member-private",
            "ownerMemberId":auth.member_id,"authority":"local","schemaVersion":1,"revision":1,
            "createdByInternalUserId":auth.internal_user_id,"createdAt":at,"updatedAt":at,
            "id":started_id,"runId":binding.run_id,"type":"status-transitioned","sequence":2,
            "previousEventId":create_input.event_id,"occurredAt":at,
            "actor":{"kind":"system"},"idempotencyKey":started_key,
            "payload":{"from":"created","to":"running","reason":"Structured intake is ready for authenticated input."}
        });
        let mut started_run = object(created.run)?;
        started_run.insert("status".into(), json!("running"));
        started_run.insert("revision".into(), json!(3));
        started_run.insert("updatedAt".into(), json!(at));
        started_run.insert(
            "eventHead".into(),
            json!({"lastSequence":2,"lastEventId":started_id}),
        );
        let running = mission_run::append(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &binding.run_id,
            2,
            1,
            &started_id,
            "status-transitioned",
            &started_key,
            &started_event,
            &Value::Object(started_run),
            &at,
        )?;
        insert_binding(tx, &auth, &binding, &at)?;
        crate::mission_human_input::request_in_tx(
            tx,
            store,
            &auth.scope,
            &auth.internal_user_id,
            &auth.member_id,
            &HumanInputRequestInput {
                run_id: binding.run_id,
                request_key: REQUEST_KEY.into(),
                expected_run_revision: running
                    .run
                    .get("revision")
                    .and_then(Value::as_i64)
                    .unwrap_or(3),
                expected_last_sequence: 2,
                prompt: PROMPT.into(),
                fields: fixed_fields(),
            },
        )
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_if_structured_in_tx(
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
    let run_id = required(&received_journal.run, "id")?;
    let Some(binding) = binding_by_run(tx, scope.workspace_id(), owner_member_id, run_id)? else {
        return Ok(false);
    };
    validate_binding_shape(
        received_journal,
        lifecycle_before_resume,
        &binding,
        received_event_id,
    )?;
    let received = received_journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(received_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake response is unavailable.".into())
        })?;
    validate_fixed_request(
        tx,
        store,
        scope,
        owner_member_id,
        received_journal,
        received,
    )?;
    let values = structured_values(received)?;
    let markdown = render_markdown(&values);
    let title = flatten(&values.title);
    if title.is_empty() || title.chars().count() > 400 {
        return Err(crate::store::StoreError::Invalid(
            "Structured brief title must be between 1 and 400 characters.".into(),
        ));
    }
    let content_hash = digest(&markdown);
    let artifact_binding = artifact::direct_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        received_event_id,
        OUTPUT_KEY,
        &content_hash,
    );
    let result_event_id = format!("structured-intake-completed-{}", &binding.start_hash[..40]);
    let result_key = format!(
        "structured-intake-complete:v1:{}",
        &binding.start_hash[..40]
    );
    let output = json!({
        "key":OUTPUT_KEY,"summary":"Structured project brief draft",
        "valueReference":format!("sha256:{content_hash}"),
        "artifactId":artifact_binding.artifact_id,
        "artifactVersionId":artifact_binding.artifact_version_id
    });
    let result = json!({
        "outcome":"succeeded","summary":"The structured project brief draft is complete.",
        "outputs":[output.clone()],"acceptance":[],"evaluations":[],"usage":[],"completedAt":at
    });
    let revision = required_i64(&received_journal.run, "revision")?;
    let sequence = received_journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake event head is invalid.".into())
        })?;
    let result_event = json!({
        "workspaceId":received_journal.run.get("workspaceId"),"visibility":"member-private",
        "ownerMemberId":owner_member_id,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":result_event_id,"runId":run_id,"type":"run-completed","sequence":sequence + 1,
        "previousEventId":received_event_id,"attemptNumber":received_journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
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
        run_id,
        revision,
        sequence,
        &result_event_id,
        "run-completed",
        &result_key,
        &result_event,
        &Value::Object(projected),
        at,
    )?;
    let private = PrivateDataScope::for_authenticated_user(
        scope.clone(),
        internal_user_id,
        Some(owner_member_id),
    )?;
    artifact::create_direct_mission_output(
        tx,
        store,
        &private,
        owner_member_id,
        run_id,
        received_event_id,
        &result_event_id,
        OUTPUT_KEY,
        &title,
        &markdown,
        &artifact_binding,
    )?;
    append_transcript(
        tx,
        store,
        scope,
        &binding,
        &terminal,
        lifecycle_before_resume
            .current_revision
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("the requested project"),
        &markdown,
        &artifact_binding,
        &result_event_id,
        at,
    )?;
    let resumed = mission_plan::get(tx, store, scope, owner_member_id, &binding.mission_id)?
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake mission is unavailable.".into())
        })?;
    let mission_result = json!({
        "outcome":"succeeded","summary":"The structured project brief draft is complete.",
        "producingRunIds":[run_id],"outputs":[output],"acceptance":[],"completedAt":at
    });
    mission_plan::mark_completed(
        tx,
        store,
        scope,
        owner_member_id,
        &resumed,
        &mission_result,
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
    received_event: &Value,
) -> crate::store::Result<()> {
    let run_id = required(&journal.run, "id")?;
    let Some(binding) = binding_by_run(tx, scope.workspace_id(), owner_member_id, run_id)? else {
        return Ok(());
    };
    let received_event_id = required(received_event, "id")?;
    let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, &binding.mission_id)?
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake mission is unavailable.".into())
        })?;
    validate_fixed_lifecycle(journal, &lifecycle, &binding)?;
    validate_fixed_request(tx, store, scope, owner_member_id, journal, received_event)?;
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("completed")
        || journal.run.get("status").and_then(Value::as_str) != Some("completed")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(format!("structured-intake-completed-{}", &binding.start_hash[..40]).as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake terminal replay is incomplete.".into(),
        ));
    }
    let values = structured_values(received_event)?;
    let markdown = render_markdown(&values);
    let content_hash = digest(&markdown);
    let artifact_binding = artifact::direct_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        run_id,
        received_event_id,
        OUTPUT_KEY,
        &content_hash,
    );
    let result_event_id = format!("structured-intake-completed-{}", &binding.start_hash[..40]);
    let result_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id.as_str()))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Structured intake terminal event is unavailable.".into(),
            )
        })?;
    let output = result_event.pointer("/payload/result/outputs/0");
    if result_event.get("type").and_then(Value::as_str) != Some("run-completed")
        || result_event.get("previousEventId").and_then(Value::as_str) != Some(received_event_id)
        || result_event
            .pointer("/payload/result/outcome")
            .and_then(Value::as_str)
            != Some("succeeded")
        || result_event.pointer("/payload/result") != journal.run.get("terminalResult")
        || output
            .and_then(|value| value.get("key"))
            .and_then(Value::as_str)
            != Some(OUTPUT_KEY)
        || output
            .and_then(|value| value.get("artifactId"))
            .and_then(Value::as_str)
            != Some(artifact_binding.artifact_id.as_str())
        || output
            .and_then(|value| value.get("artifactVersionId"))
            .and_then(Value::as_str)
            != Some(artifact_binding.artifact_version_id.as_str())
        || output
            .and_then(|value| value.get("valueReference"))
            .and_then(Value::as_str)
            != Some(format!("sha256:{content_hash}").as_str())
        || lifecycle
            .mission
            .pointer("/terminalResult/producingRunIds/0")
            .and_then(Value::as_str)
            != Some(run_id)
        || lifecycle
            .mission
            .pointer("/terminalResult/outputs/0/artifactId")
            .and_then(Value::as_str)
            != Some(artifact_binding.artifact_id.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake terminal result no longer matches its response.".into(),
        ));
    }
    let normalized_binding = artifact::get_direct_mission_source_binding(
        tx,
        &PrivateDataScope::for_authenticated_user(
            scope.clone(),
            internal_user_id,
            Some(owner_member_id),
        )?,
        owner_member_id,
        run_id,
        OUTPUT_KEY,
        received_event_id,
        &result_event_id,
        &content_hash,
    )?;
    if normalized_binding.as_ref() != Some(&artifact_binding) {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake direct artifact provenance is incomplete.".into(),
        ));
    }
    artifact::validate_direct_mission_artifact_bundle(
        tx,
        store,
        &PrivateDataScope::for_authenticated_user(
            scope.clone(),
            internal_user_id,
            Some(owner_member_id),
        )?,
        &artifact_binding,
        &content_hash,
    )?;
    validate_transcript(
        tx,
        store,
        scope,
        &binding,
        lifecycle
            .current_revision
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("the requested project"),
        &markdown,
        &artifact_binding,
        &result_event_id,
        result_event
            .get("occurredAt")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
}

fn fixed_plan_input(binding: &Binding, subject: &str) -> MissionPlanCreateInput {
    MissionPlanCreateInput {
        mission_id: binding.mission_id.clone(),
        plan_id: binding.plan_id.clone(),
        plan_revision_id: binding.plan_revision_id.clone(),
        execution_depth: "delegated".into(),
        outcome: json!({
            "title":"Structured project brief",
            "desiredOutcome":format!("Create a structured project brief for {subject}"),
            "deliverables":[{"key":OUTPUT_KEY,"description":"A structured Markdown project brief draft.","required":true}]
        }),
        mission_scope: json!({
            "sourceThreadId":binding.source_thread_id,
            "projectId":binding.project_id,
            "departmentIds":[],"context":[]
        }),
        constraints: json!([{
            "key":MARKER,"description":"Use only the fixed native structured-intake continuation.",
            "severity":"required","source":"orchestrator"
        }]),
        time_constraint: None,
        data_boundary: None,
        acceptance: json!({"requiresHumanAcceptance":false,"criteria":[]}),
        budget: Some(json!({"maxWorkers":1,"maxAttempts":1})),
        summary: subject.into(),
        bounds: json!({"maxSteps":1,"maxDependenciesPerStep":0,"maxParallelSteps":1,"maxRevisions":1}),
        steps: json!([{
            "key":"compose","kind":"produce","title":"Compose structured brief",
            "objective":"Transform authenticated structured fields into a deterministic Markdown draft.",
            "dependsOnStepKeys":[],"requiredCapabilities":[],
            "expectedOutputs":[{"key":OUTPUT_KEY,"description":"A structured Markdown project brief draft.","required":true,"format":"text/markdown"}],
            "acceptanceCriterionKeys":[],"optional":false
        }]),
    }
}

fn fixed_fields() -> Vec<HumanInputField> {
    vec![
        field(
            "title",
            "Brief title",
            Some("A short working title."),
            "text",
            true,
            None,
        ),
        field(
            "objective",
            "Objective",
            Some("What should this project achieve?"),
            "text",
            true,
            None,
        ),
        field(
            "audience",
            "Primary audience",
            None,
            "choice",
            true,
            Some(vec!["Team", "Leadership", "Customers", "Personal"]),
        ),
        field(
            "success",
            "Success criteria",
            Some("How will success be recognised?"),
            "text",
            true,
            None,
        ),
        field(
            "constraints",
            "Constraints",
            Some("Optional limits, dependencies, or non-goals."),
            "text",
            false,
            None,
        ),
        field(
            "targetAt",
            "Target date",
            Some("Optional target date and time."),
            "date-time",
            false,
            None,
        ),
    ]
}

fn field(
    key: &str,
    label: &str,
    help: Option<&str>,
    kind: &str,
    required: bool,
    choices: Option<Vec<&str>>,
) -> HumanInputField {
    HumanInputField {
        key: key.into(),
        label: label.into(),
        help: help.map(str::to_string),
        kind: kind.into(),
        required,
        sensitive: false,
        choices: choices.map(|values| values.into_iter().map(str::to_string).collect()),
    }
}

fn validate_start(input: &StructuredIntakeStartInput) -> Result<(), String> {
    bounded(&input.source_thread_id, "Source conversation", 128)?;
    if let Some(project_id) = input.project_id.as_deref() {
        bounded(project_id, "Project", 128)?;
    }
    bounded(&input.subject, "Structured brief subject", 500)?;
    bounded(&input.start_key, "Structured intake start key", 200)
}

fn insert_binding(
    tx: &rusqlite::Connection,
    auth: &Authorized,
    binding: &Binding,
    at: &str,
) -> crate::store::Result<()> {
    tx.execute(
        "INSERT INTO mission_structured_intake_binding
         (workspace_id,owner_member_id,run_id,mission_id,plan_id,plan_revision_id,
          source_thread_id,project_id,start_hash,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            auth.scope.workspace_id(),
            auth.member_id,
            binding.run_id,
            binding.mission_id,
            binding.plan_id,
            binding.plan_revision_id,
            binding.source_thread_id,
            binding.project_id,
            binding.start_hash,
            at
        ],
    )?;
    Ok(())
}

fn binding_by_start(
    tx: &rusqlite::Connection,
    workspace_id: &str,
    member_id: &str,
    source_thread_id: &str,
    start_hash: &str,
) -> crate::store::Result<Option<Binding>> {
    tx.query_row(
        "SELECT run_id,mission_id,plan_id,plan_revision_id,source_thread_id,project_id,start_hash
         FROM mission_structured_intake_binding
         WHERE workspace_id=?1 AND owner_member_id=?2 AND source_thread_id=?3 AND start_hash=?4",
        rusqlite::params![workspace_id, member_id, source_thread_id, start_hash],
        binding_row,
    )
    .optional()
    .map_err(Into::into)
}

fn binding_by_run(
    tx: &rusqlite::Connection,
    workspace_id: &str,
    member_id: &str,
    run_id: &str,
) -> crate::store::Result<Option<Binding>> {
    tx.query_row(
        "SELECT run_id,mission_id,plan_id,plan_revision_id,source_thread_id,project_id,start_hash
         FROM mission_structured_intake_binding
         WHERE workspace_id=?1 AND owner_member_id=?2 AND run_id=?3",
        rusqlite::params![workspace_id, member_id, run_id],
        binding_row,
    )
    .optional()
    .map_err(Into::into)
}

fn binding_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Binding> {
    Ok(Binding {
        run_id: row.get(0)?,
        mission_id: row.get(1)?,
        plan_id: row.get(2)?,
        plan_revision_id: row.get(3)?,
        source_thread_id: row.get(4)?,
        project_id: row.get(5)?,
        start_hash: row.get(6)?,
    })
}

fn validate_start_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    binding: &Binding,
    subject: &str,
    project_id: Option<&str>,
) -> crate::store::Result<PendingHumanInput> {
    let lifecycle =
        mission_plan::get(tx, store, &auth.scope, &auth.member_id, &binding.mission_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Structured intake mission is unavailable.".into(),
                )
            })?;
    let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &binding.run_id)?
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake run is unavailable.".into())
        })?;
    if binding.project_id.as_deref() != project_id
        || lifecycle
            .current_revision
            .get("summary")
            .and_then(Value::as_str)
            != Some(subject)
        || lifecycle.mission.get("status").and_then(Value::as_str) != Some("waiting")
        || journal.run.get("status").and_then(Value::as_str) != Some("waiting-human-input")
    {
        return Err(crate::store::StoreError::Invalid(
            "The structured intake start key represents different or terminal facts.".into(),
        ));
    }
    validate_fixed_lifecycle(&journal, &lifecycle, binding)?;
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
        return Err(crate::store::StoreError::Invalid(
            "Structured intake wait schema changed.".into(),
        ));
    }
    Ok(pending)
}

fn validate_binding_shape(
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &Binding,
    received_event_id: &str,
) -> crate::store::Result<()> {
    validate_fixed_lifecycle(journal, lifecycle, binding)?;
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
        return Err(crate::store::StoreError::Invalid(
            "Structured intake response is not at its exact continuation boundary.".into(),
        ));
    }
    Ok(())
}

fn validate_fixed_lifecycle(
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &Binding,
) -> crate::store::Result<()> {
    let fields = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array);
    let constraints = lifecycle
        .mission
        .get("constraints")
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
                || items[0].get("key").and_then(Value::as_str) != Some(MARKER)
                || items[0].get("severity").and_then(Value::as_str) != Some("required")
                || items[0].get("source").and_then(Value::as_str) != Some("orchestrator")
        })
        || fields.is_none_or(|steps| {
            steps.len() != 1
                || steps[0].get("key").and_then(Value::as_str) != Some("compose")
                || steps[0]
                    .get("requiredCapabilities")
                    .and_then(Value::as_array)
                    .is_none_or(|items| !items.is_empty())
        })
    {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake durable shape is invalid.".into(),
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
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake request link is invalid.".into())
        })?;
    let request = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake request is unavailable.".into())
        })?;
    let checkpoint_id = request
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Structured intake checkpoint link is invalid.".into(),
            )
        })?;
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Structured intake checkpoint is unavailable.".into(),
                )
            })?;
    let fields: Vec<HumanInputField> = serde_json::from_value(
        request
            .pointer("/payload/wait/fields")
            .cloned()
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Structured intake request schema is missing.".into(),
                )
            })?,
    )
    .map_err(|_| {
        crate::store::StoreError::Invalid("Structured intake request schema is invalid.".into())
    })?;
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
        return Err(crate::store::StoreError::Invalid(
            "Structured intake request no longer matches its fixed native schema.".into(),
        ));
    }
    Ok(())
}

struct StructuredValues {
    title: String,
    objective: String,
    audience: String,
    success: String,
    constraints: Option<String>,
    target_at: Option<String>,
}

fn structured_values(event: &Value) -> crate::store::Result<StructuredValues> {
    let values = event
        .pointer("/payload/resolution/values")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Structured intake values are invalid.".into())
        })?;
    let text = |key: &str, required_value: bool| -> crate::store::Result<Option<String>> {
        let value = values
            .iter()
            .find(|item| item.get("fieldKey").and_then(Value::as_str) == Some(key));
        match value
            .and_then(|item| item.get("value"))
            .and_then(Value::as_str)
        {
            Some(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_string())),
            _ if required_value => Err(crate::store::StoreError::Invalid(format!(
                "Structured intake field '{key}' is missing."
            ))),
            _ => Ok(None),
        }
    };
    let audience = text("audience", true)?.unwrap_or_default();
    if !["Team", "Leadership", "Customers", "Personal"].contains(&audience.as_str()) {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake audience is invalid.".into(),
        ));
    }
    Ok(StructuredValues {
        title: text("title", true)?.unwrap_or_default(),
        objective: text("objective", true)?.unwrap_or_default(),
        audience,
        success: text("success", true)?.unwrap_or_default(),
        constraints: text("constraints", false)?,
        target_at: text("targetAt", false)?,
    })
}

fn render_markdown(values: &StructuredValues) -> String {
    format!(
        "# {}\n\n## Objective\n\n{}\n\n## Audience\n\n{}\n\n## Success criteria\n\n{}\n\n## Constraints\n\n{}\n\n## Target date\n\n{}\n",
        escape(&flatten(&values.title)),
        escape(&values.objective),
        escape(&values.audience),
        escape(&values.success),
        values.constraints.as_deref().map(escape).unwrap_or_else(|| "None provided.".into()),
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
    subject: &str,
    markdown: &str,
    artifact_binding: &artifact::DirectMissionArtifactBinding,
    result_event_id: &str,
    at: &str,
) -> crate::store::Result<()> {
    let head = thread::get(tx, store, scope, &binding.source_thread_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "Structured intake source conversation is unavailable.".into(),
        )
    })?;
    let (user_id, user_revision, user_key) = transcript_identity(&binding.run_id, "user");
    let (assistant_id, assistant_revision, assistant_key) =
        transcript_identity(&binding.run_id, "assistant");
    required(&journal.run, "sourceThreadId")?;
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
        &json!(format!(
            "Structured brief details submitted for {}.",
            flatten(subject)
        )),
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
            "type":"mission-result","missionKind":"structured-intake",
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
        subject,
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
    subject: &str,
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
    let expected_user = json!(format!(
        "Structured brief details submitted for {}.",
        flatten(subject)
    ));
    let expected_detail = json!({
        "type":"mission-result","missionKind":"structured-intake",
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
            || item.content != expected_user
            || item.created_at != at
    }) || assistant.is_none_or(|item| {
        item.kind != "assistant"
            || item.run_id.as_deref() != Some(binding.run_id.as_str())
            || item.sequence != user.map(|message| message.sequence + 1).unwrap_or(-1)
            || item.current_revision_id != assistant_revision
            || item.current_revision_number != 1
            || item.current_revision_state != "terminal"
            || item.content != json!(markdown)
            || item.detail != expected_detail
            || item.created_at != at
    }) || stored_links.is_none_or(
        |(_, stored_user_key, assistant_previous, stored_assistant_key)| {
            stored_user_key != user_key
                || assistant_previous.as_deref() != Some(user_id.as_str())
                || stored_assistant_key != assistant_key
        },
    ) {
        return Err(crate::store::StoreError::Invalid(
            "Structured intake transcript is incomplete.".into(),
        ));
    }
    Ok(())
}

fn transcript_identity(run_id: &str, role: &str) -> (String, String, String) {
    let suffix = &digest(&format!("structured-intake-transcript:v1|{run_id}|{role}"))[..40];
    (
        format!("structured-intake-message-{suffix}"),
        format!("structured-intake-message-revision-{suffix}"),
        format!("structured-intake-message:v1:{suffix}"),
    )
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
        .chars()
        .map(|ch| match ch {
            '\\' => "\\\\".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '\r' => "".into(),
            ch if ch.is_control() && ch != '\n' && ch != '\t' => " ".into(),
            ch => ch.to_string(),
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn object(value: Value) -> crate::store::Result<Map<String, Value>> {
    value.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Structured intake record is invalid.".into())
    })
}

fn required<'a>(value: &'a Value, key: &str) -> crate::store::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(format!("Structured intake {key} is invalid."))
        })
}

fn required_i64(value: &Value, key: &str) -> crate::store::Result<i64> {
    value.get(key).and_then(Value::as_i64).ok_or_else(|| {
        crate::store::StoreError::Invalid(format!("Structured intake {key} is invalid."))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mission_human_input::{receive_with_store, HumanInputReceiveInput, HumanInputValue};
    use crate::store::repos::{artifact, message, workspace_directory};
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    struct Fixture {
        directory: tempfile::TempDir,
        key: MasterKey,
        workspace_id: String,
    }

    fn seed() -> Fixture {
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
        store
            .transaction(|tx| {
                thread::create(
                    tx,
                    &store,
                    &DataScope::workspace(local.clone())?,
                    "thread-1",
                    None,
                    "Planning",
                    "t0",
                    &json!({}),
                )?;
                tx.execute(
                    "UPDATE thread SET owner_member_id='member-1' WHERE id='thread-1'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        Fixture {
            directory,
            key,
            workspace_id: local,
        }
    }

    fn reopen(fixture: &Fixture) -> Store {
        Store::open(
            &fixture.directory.path().join("fable.db"),
            Vault::new(&fixture.key).unwrap(),
        )
        .unwrap()
    }

    fn start(subject: &str) -> StructuredIntakeStartInput {
        StructuredIntakeStartInput {
            source_thread_id: "thread-1".into(),
            project_id: None,
            subject: subject.into(),
            start_key: "start-1".into(),
        }
    }

    fn values(title: &str) -> Vec<HumanInputValue> {
        vec![
            HumanInputValue {
                field_key: "title".into(),
                value: json!(title),
            },
            HumanInputValue {
                field_key: "objective".into(),
                value: json!("Ship a dependable onboarding flow."),
            },
            HumanInputValue {
                field_key: "audience".into(),
                value: json!("Team"),
            },
            HumanInputValue {
                field_key: "success".into(),
                value: json!("New users complete setup without support."),
            },
            HumanInputValue {
                field_key: "constraints".into(),
                value: json!("Use the existing account model."),
            },
            HumanInputValue {
                field_key: "targetAt".into(),
                value: json!("2026-08-31T17:00:00Z"),
            },
        ]
    }

    #[test]
    fn start_wait_receive_and_exact_replay_survive_reopen_without_duplicates() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = start_with_store(&store, start("Improve onboarding")).unwrap();
        assert_eq!(pending.run_revision, 5);
        assert_eq!(pending.last_sequence, 4);
        assert_eq!(pending.fields, fixed_fields());
        let scope = DataScope::workspace(fixture.workspace_id.clone()).unwrap();
        let waiting = store
            .with_conn(|tx| mission_run::get(tx, &store, &scope, "member-1", &pending.run_id))
            .unwrap()
            .unwrap();
        assert_eq!(waiting.run["status"], "waiting-human-input");
        assert_eq!(waiting.events.len(), 4);
        assert_eq!(waiting.events[1]["type"], "status-transitioned");
        assert_eq!(waiting.events[2]["type"], "checkpoint-created");
        assert_eq!(waiting.events[3]["type"], "human-input-requested");
        drop(store);

        let reopened = reopen(&fixture);
        assert_eq!(
            start_with_store(&reopened, start("Improve onboarding")).unwrap(),
            pending
        );
        let response = HumanInputReceiveInput {
            run_id: pending.run_id.clone(),
            wait_key: pending.wait_key.clone(),
            expected_run_revision: pending.run_revision,
            expected_last_sequence: pending.last_sequence,
            values: values("Onboarding <refresh>"),
        };
        let receipt = receive_with_store(&reopened, response).unwrap();
        assert_eq!(receipt.run_revision, 6);
        assert_eq!(receipt.last_sequence, 5);
        let terminal = reopened
            .with_conn(|tx| mission_run::get(tx, &reopened, &scope, "member-1", &pending.run_id))
            .unwrap()
            .unwrap();
        assert_eq!(terminal.run["status"], "completed");
        assert_eq!(terminal.events.len(), 6);
        assert_eq!(terminal.events[5]["type"], "run-completed");
        assert_eq!(
            terminal.events[5]["previousEventId"],
            terminal.events[4]["id"]
        );
        let lifecycle = reopened
            .with_conn(|tx| {
                mission_plan::get(
                    tx,
                    &reopened,
                    &scope,
                    "member-1",
                    pending.mission_id.as_str(),
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.mission["status"], "completed");
        let messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, &scope, "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages[1]
            .content
            .as_str()
            .unwrap()
            .contains("# Onboarding &lt;refresh&gt;"));
        assert_eq!(messages[1].detail["missionKind"], "structured-intake");
        assert_eq!(messages[1].detail["outcome"], "completed");
        let artifact_id = messages[1].detail["artifactId"]
            .as_str()
            .unwrap()
            .to_string();
        let private =
            PrivateDataScope::for_authenticated_user(scope.clone(), "user-1", Some("member-1"))
                .unwrap();
        let bundle = reopened
            .with_conn(|tx| artifact::get_bundle(tx, &reopened, &private, &artifact_id))
            .unwrap()
            .unwrap();
        assert_eq!(bundle["artifact"]["status"], "draft");
        assert_eq!(bundle["currentVersion"]["citations"], json!([]));
        let reviewed = reopened
            .transaction(|tx| {
                artifact::review_action(
                    tx,
                    &reopened,
                    &private,
                    &artifact_id,
                    bundle["currentVersion"]["id"].as_str().unwrap(),
                    1,
                    "request-review",
                    "user-1",
                    None,
                    &[],
                    "2026-07-15T10:00:00Z",
                )
            })
            .unwrap();
        assert_eq!(reviewed["artifact"]["status"], "in-review");
        drop(reopened);

        let replayed = reopen(&fixture);
        let replay = receive_with_store(
            &replayed,
            HumanInputReceiveInput {
                run_id: pending.run_id.clone(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: values("Onboarding <refresh>"),
            },
        )
        .unwrap();
        assert_eq!(replay, receipt);
        let event_count: i64 = replayed
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT COUNT(*) FROM mission_run_event WHERE run_id=?1",
                    [&pending.run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        let message_count: i64 = replayed
            .with_conn(|tx| {
                tx.query_row("SELECT COUNT(*) FROM message", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        let artifact_count: i64 = replayed
            .with_conn(|tx| {
                tx.query_row("SELECT COUNT(*) FROM artifact", [], |row| row.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!((event_count, message_count, artifact_count), (6, 2, 1));
    }

    #[test]
    fn same_start_key_cannot_change_subject_and_failed_settlement_rolls_back() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = start_with_store(&store, start("Original subject")).unwrap();
        assert!(start_with_store(&store, start("Changed subject"))
            .unwrap_err()
            .to_string()
            .contains("different"));
        let too_long = "x".repeat(401);
        assert!(receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: pending.run_id.clone(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: values(&too_long),
            }
        )
        .is_err());
        let journal = store
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &store,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    "member-1",
                    &pending.run_id,
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(journal.run["status"], "waiting-human-input");
        assert_eq!(journal.events.len(), 4);
    }

    #[test]
    fn owned_source_thread_rejects_another_workspace_member() {
        let fixture = seed();
        let store = reopen(&fixture);
        start_with_store(&store, start("Member one brief")).unwrap();
        store
            .transaction(|tx| {
                workspace_directory::set_current_internal_user(tx, "user-2", "t1")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "t1",
                )?;
                Ok(())
            })
            .unwrap();
        let error = start_with_store(
            &store,
            StructuredIntakeStartInput {
                start_key: "member-2-start".into(),
                ..start("Member two brief")
            },
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("unavailable for this member"));
    }

    #[test]
    fn schema_upgrade_backfills_legacy_thread_owner_from_authoritative_link() {
        let fixture = seed();
        let store = reopen(&fixture);
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE thread SET owner_member_id=NULL WHERE id='thread-1'",
                    [],
                )?;
                tx.execute(
                    "UPDATE schema_meta SET value='31' WHERE key='schema_version'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        drop(store);
        let migrated = reopen(&fixture);
        let owner: Option<String> = migrated
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT owner_member_id FROM thread WHERE id='thread-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(owner.as_deref(), Some("member-1"));
    }

    #[test]
    fn terminal_replay_requires_exact_direct_provenance_and_transcript_links() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = start_with_store(&store, start("Replay integrity")).unwrap();
        let response = || HumanInputReceiveInput {
            run_id: pending.run_id.clone(),
            wait_key: pending.wait_key.clone(),
            expected_run_revision: pending.run_revision,
            expected_last_sequence: pending.last_sequence,
            values: values("Replay integrity"),
        };
        receive_with_store(&store, response()).unwrap();
        let (_, _, assistant_key) = transcript_identity(&pending.run_id, "assistant");
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE message SET idempotency_key='tampered-transcript-key'
                     WHERE run_id=?1 AND kind='assistant'",
                    [&pending.run_id],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(receive_with_store(&store, response())
            .unwrap_err()
            .to_string()
            .contains("transcript"));
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE message SET idempotency_key=?1 WHERE run_id=?2 AND kind='assistant'",
                    rusqlite::params![assistant_key, pending.run_id],
                )?;
                Ok(())
            })
            .unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "DELETE FROM mission_direct_artifact_source WHERE mission_run_id=?1",
                    [&pending.run_id],
                )?;
                Ok(())
            })
            .unwrap();
        assert!(receive_with_store(&store, response())
            .unwrap_err()
            .to_string()
            .contains("provenance"));
    }
}
