//! Recovery intent is durable; it never grants permission to restore files.
//! The existing one-use checkpoint approval executes the file step. Native
//! receipts then permit an exact conversation CAS. Partial outcomes stay visible.
use super::*;
use crate::local_computer::coding::{checkpoints::Checkpoint, task_binding::RepositoryWorkBinding};
use crate::store::repos::conversation_ui as ui_repo;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEY: &str = "conversation-restore-ledger-v1";
const MAX_POINTS: usize = 24;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Point {
    pub id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub work_id: String,
    pub work_generation: u32,
    pub run_id: String,
    pub target_head_id: Option<String>,
    pub request_message_id: String,
    pub label: String,
    pub created_at: String,
    pub scope_id: String,
    pub repository: RepositoryWorkBinding,
    pub checkpoint: Checkpoint,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Review {
    pub id: String,
    pub point: Point,
    pub expected_head_id: Option<String>,
    pub expected_last_sequence: i64,
    pub computer_generation: u64,
    pub checkpoint: Value,
    pub direction: String,
    pub reverts_intent_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Intent {
    pub id: String,
    pub review: Review,
    pub approval_request_id: String,
    pub state: String,
    pub before_restore_checkpoint_id: Option<String>,
    pub file_receipt_tree: Option<String>,
    pub selected_head_id: Option<String>,
    #[serde(default)]
    pub finish_expected_head_id: Option<String>,
    #[serde(default)]
    pub finish_expected_last_sequence: Option<i64>,
}
#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    points: Vec<Point>,
    intents: Vec<Intent>,
    review: Option<Review>,
}

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn ledger(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    room: &str,
) -> Result<Ledger> {
    Ok(ui_repo::get(conn, store, &scope.private, room, KEY)?.unwrap_or_default())
}
fn save(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    room: &str,
    ledger: &Ledger,
) -> Result<()> {
    ui_repo::put(conn, store, &scope.private, room, KEY, ledger)
}
fn head(row: &thread::ThreadRow) -> Option<String> {
    row.selected_head_id.clone().or(row.last_message_id.clone())
}
fn outstanding(ledger: &Ledger) -> bool {
    ledger
        .intents
        .iter()
        .any(|intent| !matches!(intent.state.as_str(), "complete" | "reverted" | "cancelled"))
}

/// Native canonical Work and computer scope, never a renderer association.
pub(crate) fn capture_context(
    scope_id: &str,
    repository: &crate::local_computer::coding::Repository,
) -> std::result::Result<Option<(Work, String, Option<String>)>, String> {
    #[cfg(test)]
    if crate::account_session::binding().is_err() {
        return Ok(None);
    }
    let store = crate::store::try_global().ok_or("The native Work store is unavailable.")?;
    store.with_conn(|conn| {
        let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
        let work: Vec<Work> = repo::list(conn, store, &scope.private, Kind::Work)?;
        let mut matches = Vec::new();
        for item in work.into_iter().filter(|item| item.status.executing()) {
            if !crate::local_computer::coding::checkpoints::conversation::matches_scope(&item.workspace_id, &item.agent_id, scope_id).map_err(|error| invalid(&error))? { continue; }
            matches.push(item);
        }
        if matches.len() > 1 { return Err(invalid("More than one task could own this recovery checkpoint. Stop or finish the other task.")); }
        let Some(item) = matches.pop() else { return Ok(None); };
        let binding = item.repository_binding.as_ref().ok_or_else(|| invalid("Start a fresh task with an attached repository before editing files."))?;
        if binding.repository_id != repository.id || binding.branch != repository.branch || binding.base_commit != repository.base {
            return Err(invalid("The task recovery checkpoint belongs to a different private copy."));
        }
        let run = item.current_run_id.as_deref().ok_or_else(|| invalid("The task has no current native run for recovery."))?;
        let saved = ledger(conn, store, &scope, &item.conversation_id)?;
        if saved.points.iter().any(|point| point.work_id == item.id && point.work_generation == item.generation && point.run_id == run) { return Ok(None); }
        if saved.points.len() >= MAX_POINTS || outstanding(&saved) { return Err(invalid("Recovery points are full or a restore needs reconciliation. Review recovery before changing files.")); }
        let rows = message::list_selected(conn, store, &scope.data, &item.conversation_id)?;
        let user = rows.iter().find(|row| row.kind == "user" && row.run_id.as_deref() == Some(run))
            .ok_or_else(|| invalid("Wait for the exact user request to be saved before changing repository files."))?;
        Ok(Some((item, user.id.clone(), user.parent_message_id.clone())))
    }).map_err(|error| error.to_string())
}

pub(crate) fn record_point(
    item: &Work,
    request_message_id: String,
    target_head_id: Option<String>,
    scope_id: String,
    checkpoint: Checkpoint,
) -> std::result::Result<(), String> {
    let store = crate::store::try_global().ok_or("The native recovery store is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(
                conn,
                Some(&item.workspace_id),
                None,
                ScopeAccess::Write,
            )?;
            let current: Work = repo::get(conn, store, &scope.private, Kind::Work, &item.id)?
                .ok_or_else(|| {
                    invalid("The task changed before its recovery checkpoint was saved.")
                })?;
            if !current.status.executing()
                || current.generation != item.generation
                || current.current_run_id != item.current_run_id
                || current.repository_binding != item.repository_binding
            {
                return Err(invalid(
                    "The task changed before its recovery checkpoint was saved.",
                ));
            }
            let run = current
                .current_run_id
                .clone()
                .ok_or_else(|| invalid("The current task run is unavailable."))?;
            let mut saved = ledger(conn, store, &scope, &item.conversation_id)?;
            if saved.points.iter().any(|point| {
                point.work_id == item.id
                    && point.work_generation == item.generation
                    && point.run_id == run
            }) {
                return Ok(());
            }
            if saved.points.len() >= MAX_POINTS {
                return Err(invalid(
                    "24 recovery points are retained. Review recovery storage before continuing.",
                ));
            }
            saved.points.push(Point {
                id: format!(
                    "restore-point-{}",
                    digest(&format!("{}:{}:{run}", item.id, item.generation))
                ),
                workspace_id: item.workspace_id.clone(),
                conversation_id: item.conversation_id.clone(),
                agent_id: item.agent_id.clone(),
                work_id: item.id.clone(),
                work_generation: item.generation,
                run_id: run,
                target_head_id,
                request_message_id,
                label: crate::secret_redaction::redact_secret_text_or_omit(&item.user_request)
                    .chars()
                    .take(100)
                    .collect(),
                created_at: now(),
                scope_id,
                repository: current
                    .repository_binding
                    .ok_or_else(|| invalid("The task copy binding is unavailable."))?,
                checkpoint,
            });
            save(conn, store, &scope, &item.conversation_id, &saved)
        })
        .map_err(|error| error.to_string())
}

/// Find by native scope plus exact consumed approval request, bounded by the
/// canonical account-owned conversations. This record alone grants no action.
pub(crate) fn intent_for_request(
    scope_id: &str,
    request_id: &str,
) -> std::result::Result<Option<Intent>, String> {
    #[cfg(test)]
    if crate::account_session::binding().is_err() {
        return Ok(None);
    }
    let store = crate::store::try_global().ok_or("The native recovery store is unavailable.")?;
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
            let rooms: Vec<Conversation> =
                repo::list(conn, store, &scope.private, Kind::Conversation)?;
            let mut found = None;
            for room in rooms {
                for intent in ledger(conn, store, &scope, &room.id)?.intents {
                    if intent.approval_request_id == request_id
                        && intent.review.point.scope_id == scope_id
                    {
                        if found.is_some() {
                            return Err(invalid(
                                "Ambiguous recovery request; inspect recovery before continuing.",
                            ));
                        }
                        found = Some(intent);
                    }
                }
            }
            Ok(found)
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn record_restore_receipt(
    scope_id: &str,
    request_id: &str,
    repository_id: &str,
    checkpoint_id: &str,
    before_restore_id: &str,
    after_tree: &str,
) -> std::result::Result<(), String> {
    let Some(found) = intent_for_request(scope_id, request_id)? else {
        return Ok(());
    };
    let store = crate::store::try_global().ok_or("The native recovery store is unavailable.")?;
    store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, Some(&found.review.point.workspace_id), None, ScopeAccess::Write)?;
        let mut saved = ledger(conn, store, &scope, &found.review.point.conversation_id)?;
        let intent = saved.intents.iter_mut().find(|intent| intent.id == found.id).ok_or_else(|| invalid("The recovery intent is unavailable."))?;
        let review = &intent.review;
        if intent.state != "prepared" || review.point.repository.repository_id != repository_id || review.checkpoint["checkpoint"]["id"].as_str() != Some(checkpoint_id) || review.checkpoint["outputTreeId"].as_str() != Some(after_tree) { return Err(invalid("The file restore receipt does not match its exact recovery intent. Reconcile before continuing.")); }
        intent.before_restore_checkpoint_id = Some(before_restore_id.into());
        intent.file_receipt_tree = Some(after_tree.into());
        intent.state = if review.direction == "revert-files" { "reverted" } else { "files-restored" }.into();
        let reverted = intent.review.reverts_intent_id.clone();
        if let Some(reverted) = reverted {
            let original = saved.intents.iter_mut().find(|intent| intent.id == reverted).ok_or_else(|| invalid("The original restore intent is unavailable."))?;
            original.state = "reverted".into();
        }
        save(conn, store, &scope, &found.review.point.conversation_id, &saved)
    }).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    workspace_id: String,
    conversation_id: String,
    agent_id: String,
    action: String,
    point_id: Option<String>,
    intent_id: Option<String>,
    preview_id: Option<String>,
    approval_request_id: Option<String>,
    expected_head_id: Option<String>,
    expected_last_sequence: Option<i64>,
}
fn owner(conn: &Connection, store: &Store, request: &Request) -> Result<AuthorizedCommandScope> {
    let scope =
        authorized_scope::resolve(conn, Some(&request.workspace_id), None, ScopeAccess::Write)?;
    let room: Conversation = repo::get(
        conn,
        store,
        &scope.private,
        Kind::Conversation,
        &request.conversation_id,
    )?
    .ok_or_else(|| invalid("This conversation is unavailable."))?;
    if !room
        .participants
        .iter()
        .any(|member| member.agent_id == request.agent_id)
    {
        let work: Vec<Work> = repo::list(conn, store, &scope.private, Kind::Work)?;
        if !work
            .iter()
            .any(|item| item.conversation_id == room.id && item.agent_id == request.agent_id)
        {
            return Err(invalid(
                "This agent does not own recovery in this conversation.",
            ));
        }
    }
    Ok(scope)
}

fn select_target(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    room: &str,
    intent: &Intent,
) -> Result<String> {
    if intent.state != "files-restored"
        || intent.file_receipt_tree.as_deref() != intent.review.checkpoint["outputTreeId"].as_str()
    {
        return Err(invalid(
            "An authoritative restored file receipt is required before changing the conversation.",
        ));
    }
    let current = thread::get(conn, store, &scope.data, room)?
        .ok_or_else(|| invalid("Conversation unavailable."))?;
    if head(&current) != intent.review.expected_head_id
        || current.last_sequence != intent.review.expected_last_sequence
    {
        return Err(invalid("Files were restored, but the conversation changed. Reconcile this restore before choosing Finish conversation or Revert files."));
    }
    if let Some(target) = &intent.review.point.target_head_id {
        thread::select_head(conn, store, &scope.data, room, Some(target), &now())?;
        return Ok(target.clone());
    }
    // A real root checkpoint avoids overloading null, which means latest.
    // It carries no provider context and preserves every prior branch.
    let marker = format!("restore-empty-{}", intent.id);
    message::append_with_parent(
        conn,
        store,
        &scope.data,
        room,
        &marker,
        "interruption",
        &json!({"restorePointId":intent.review.point.id,"emptyConversation":true}),
        None,
        current.last_sequence + 1,
        current.last_sequence,
        current.last_message_id.as_deref(),
        Some(None),
        &marker,
        &format!("{marker}-revision"),
        "terminal",
        "restore",
        &json!("Conversation restored to the beginning. Earlier messages remain in history."),
        &now(),
    )?;
    Ok(marker)
}

fn apply(
    state: &crate::local_computer::LocalComputerState,
    request: Request,
) -> std::result::Result<Value, String> {
    let store = crate::store::try_global().ok_or("The native recovery store is unavailable.")?;
    let (point, mut previous_intent) = store
        .with_conn(|conn| {
            let scope = owner(conn, store, &request)?;
            let saved = ledger(conn, store, &scope, &request.conversation_id)?;
            let point = request
                .point_id
                .as_ref()
                .and_then(|id| saved.points.iter().find(|point| &point.id == id))
                .cloned();
            let intent = request
                .intent_id
                .as_ref()
                .and_then(|id| {
                    saved.intents.iter().find(|intent| {
                        &intent.id == id && intent.review.point.agent_id == request.agent_id
                    })
                })
                .cloned();
            Ok((point, intent))
        })
        .map_err(|error| error.to_string())?;
    let observed = if matches!(
        request.action.as_str(),
        "reconcile" | "finish" | "preview-revert" | "cancel"
    ) {
        previous_intent
            .as_ref()
            .map(|intent| {
                crate::local_computer::coding::checkpoints::conversation::inspect(state, intent)
            })
            .transpose()?
    } else {
        None
    };
    if matches!(request.action.as_str(), "finish" | "preview-revert") {
        if let (Some(intent), Some(observed)) = (previous_intent.as_ref(), observed.as_ref()) {
            if intent.state == "prepared" && observed["kind"] == "files-restored" {
                record_restore_receipt(
                    &intent.review.point.scope_id,
                    &intent.approval_request_id,
                    &intent.review.point.repository.repository_id,
                    intent.review.checkpoint["checkpoint"]["id"]
                        .as_str()
                        .ok_or("The checkpoint identity is unavailable.")?,
                    observed["beforeRestoreCheckpointId"]
                        .as_str()
                        .ok_or("The before-restore receipt is unavailable.")?,
                    observed["treeId"]
                        .as_str()
                        .ok_or("The restored tree is unavailable.")?,
                )?;
                let mut adopted = intent.clone();
                adopted.state = "files-restored".into();
                adopted.before_restore_checkpoint_id = observed["beforeRestoreCheckpointId"]
                    .as_str()
                    .map(Into::into);
                adopted.file_receipt_tree = observed["treeId"].as_str().map(Into::into);
                previous_intent = Some(adopted);
            }
        }
    }
    if matches!(request.action.as_str(), "preview" | "preview-revert") {
        let (point, checkpoint, direction) = if request.action == "preview-revert" {
            let intent = previous_intent
                .as_ref()
                .filter(|intent| intent.state == "files-restored")
                .ok_or("Only an incomplete file restore can be reverted here.")?;
            (
                intent.review.point.clone(),
                intent
                    .before_restore_checkpoint_id
                    .clone()
                    .ok_or("The before-restore checkpoint is unavailable.")?,
                "revert-files",
            )
        } else {
            let point = point.ok_or("Choose a retained native recovery point.")?;
            let checkpoint = point.checkpoint.id.clone();
            (point, checkpoint, "restore")
        };
        if point.agent_id != request.agent_id {
            return Err("This recovery point belongs to another agent.".into());
        }
        let (generation, checkpoint) =
            crate::local_computer::coding::checkpoints::conversation::preview(
                state,
                &point,
                &checkpoint,
            )?;
        return store
            .transaction(|conn| {
                let scope = owner(conn, store, &request)?;
                super::ensure_conversation_idle(conn, store, &request.conversation_id)?;
                let current = thread::get(conn, store, &scope.data, &request.conversation_id)?
                    .ok_or_else(|| invalid("Conversation unavailable."))?;
                let mut saved = ledger(conn, store, &scope, &request.conversation_id)?;
                if direction == "restore" && outstanding(&saved) {
                    return Err(invalid(
                        "Reconcile the pending restore before starting another.",
                    ));
                }
                let review = Review {
                    id: format!(
                        "restore-preview-{}",
                        digest(&format!(
                            "{}:{}:{}:{}",
                            point.id, generation, current.last_sequence, checkpoint
                        ))
                    ),
                    point,
                    expected_head_id: head(&current),
                    expected_last_sequence: current.last_sequence,
                    computer_generation: generation,
                    checkpoint,
                    direction: direction.into(),
                    reverts_intent_id: (direction == "revert-files")
                        .then(|| previous_intent.as_ref().unwrap().id.clone()),
                };
                saved.review = Some(review.clone());
                save(conn, store, &scope, &request.conversation_id, &saved)?;
                Ok(json!(review))
            })
            .map_err(|error| error.to_string());
    }
    if request.action == "finish" {
        let intent = previous_intent
            .as_ref()
            .filter(|intent| intent.state == "files-restored")
            .ok_or("Reconcile the file step before finishing this conversation restore.")?;
        return crate::local_computer::coding::checkpoints::conversation::with_tree(
            state,
            &intent.review.point,
            |actual| {
                if intent.file_receipt_tree.as_deref() != Some(&actual) {
                    return Err("Files changed after restoration. Inspect and reconcile; the conversation was not changed.".into());
                }
                store
                    .transaction(|conn| {
                        let scope = owner(conn, store, &request)?;
                        super::ensure_conversation_idle(conn, store, &request.conversation_id)?;
                        let mut saved = ledger(conn, store, &scope, &request.conversation_id)?;
                        let index = saved
                            .intents
                            .iter()
                            .position(|candidate| {
                                candidate.id == intent.id && candidate.state == "files-restored"
                            })
                            .ok_or_else(|| invalid("The restored file receipt is unavailable."))?;
                        let mut confirmed = saved.intents[index].clone();
                        if let Some(sequence) = request.expected_last_sequence {
                            confirmed.review.expected_head_id = request.expected_head_id.clone();
                            confirmed.review.expected_last_sequence = sequence;
                            saved.intents[index].finish_expected_head_id =
                                request.expected_head_id.clone();
                            saved.intents[index].finish_expected_last_sequence = Some(sequence);
                        }
                        let target = select_target(
                            conn,
                            store,
                            &scope,
                            &request.conversation_id,
                            &confirmed,
                        )?;
                        saved.intents[index].selected_head_id = Some(target);
                        saved.intents[index].state = "complete".into();
                        save(conn, store, &scope, &request.conversation_id, &saved)?;
                        Ok(json!(saved.intents[index]))
                    })
                    .map_err(|error| error.to_string())
            },
        );
    }
    store.transaction(|conn| {
        let scope = owner(conn, store, &request)?;
        let mut saved = ledger(conn, store, &scope, &request.conversation_id)?;
        match request.action.as_str() {
            "forget-point" => {
                let point_id = request.point_id.as_deref().ok_or_else(|| invalid("Choose a linked recovery point."))?;
                if saved.intents.iter().any(|intent| intent.review.point.id == point_id && !matches!(intent.state.as_str(), "complete" | "reverted" | "cancelled")) { return Err(invalid("Reconcile this restore before removing its linked point.")); }
                saved.points.retain(|point| !(point.id == point_id && point.agent_id == request.agent_id));
                save(conn, store, &scope, &request.conversation_id, &saved)?;
                Ok(json!({"removed":point_id,"fileCheckpointRetained":true}))
            }
            "clear-completed" => {
                saved.intents.retain(|intent| intent.review.point.agent_id != request.agent_id || !matches!(intent.state.as_str(), "complete" | "reverted" | "cancelled"));
                save(conn, store, &scope, &request.conversation_id, &saved)?;
                Ok(json!({"completedRecordsCleared":true,"fileCheckpointsRetained":true}))
            }
            "list" | "reconcile" => {
                let mut observed = observed;
                if let Some(value) = observed.as_mut() {
                    let current = thread::get(conn, store, &scope.data, &request.conversation_id)?.ok_or_else(|| invalid("Conversation unavailable."))?;
                    value["currentHeadId"] = json!(head(&current)); value["currentLastSequence"] = json!(current.last_sequence);
                    value["conversationChanged"] = json!(previous_intent.as_ref().is_some_and(|intent| intent.review.expected_head_id != head(&current) || intent.review.expected_last_sequence != current.last_sequence));
                }
                Ok(json!({"points":saved.points.into_iter().filter(|point| point.agent_id == request.agent_id).collect::<Vec<_>>(),"intents":saved.intents.into_iter().filter(|intent| intent.review.point.agent_id == request.agent_id).collect::<Vec<_>>(),"observed":observed}))
            },
            "cancel" => {
                if observed.as_ref().is_none_or(|value| value["kind"] != "unchanged") { return Err(invalid("The file outcome is not unchanged. Reconcile before cancelling.")); }
                let intent = saved.intents.iter_mut().find(|intent| Some(&intent.id) == request.intent_id.as_ref() && intent.state == "prepared").ok_or_else(|| invalid("This pending restore cannot be cancelled."))?;
                intent.state = "cancelled".into();
                save(conn, store, &scope, &request.conversation_id, &saved)?;
                Ok(json!({"state":"cancelled"}))
            }
            "stage" => {
                super::ensure_conversation_idle(conn, store, &request.conversation_id)?;
                let review = saved.review.clone().filter(|review| Some(&review.id) == request.preview_id.as_ref() && review.point.agent_id == request.agent_id).ok_or_else(|| invalid("Preview this exact recovery point again before approving."))?;
                let current = thread::get(conn, store, &scope.data, &request.conversation_id)?.ok_or_else(|| invalid("Conversation unavailable."))?;
                if head(&current) != review.expected_head_id || current.last_sequence != review.expected_last_sequence { return Err(invalid("The conversation changed after preview. Review again.")); }
                if saved.intents.len() >= MAX_POINTS { return Err(invalid("24 restore intents are retained. Inspect recovery history before continuing.")); }
                let approval = request.approval_request_id.as_ref().ok_or_else(|| invalid("The exact checkpoint approval request is required."))?;
                id(approval)?;
                if saved.intents.iter().any(|intent| intent.approval_request_id == *approval) { return Err(invalid("This recovery approval request was already staged.")); }
                let intent = Intent { id: format!("restore-intent-{}", digest(approval)), review, approval_request_id: approval.clone(), state: "prepared".into(), before_restore_checkpoint_id: None, file_receipt_tree: None, selected_head_id: None, finish_expected_head_id: None, finish_expected_last_sequence: None };
                saved.intents.push(intent.clone()); saved.review = None;
                save(conn, store, &scope, &request.conversation_id, &saved)?;
                Ok(json!(intent))
            }
            _ => Err(invalid("Unsupported conversation recovery action.")),
        }
    }).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn conversation_restore(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<crate::local_computer::LocalComputerState>>,
    request: Request,
) -> std::result::Result<Value, String> {
    if window.label() != "main" {
        return Err("Restore conversations from the Mivlet window.".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || apply(&state, request))
        .await
        .map_err(|_| {
            "Recovery stopped. Reconcile the recorded outcome before continuing.".to_string()
        })?
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod restore_tests;
