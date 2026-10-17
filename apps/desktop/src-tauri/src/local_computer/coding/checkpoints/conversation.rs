//! Native-only bridge between immutable file checkpoints and conversation
//! recovery. Neither Work provenance nor a saved intent grants an operation.
use super::*;
use crate::collaboration::restore::{self, Point};
use crate::local_computer::coding::task_binding::TaskRepository;

pub(crate) fn capture_before_task_mutation(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    request_id: &str,
) -> Result<(), String> {
    let scope = ticket.execution_binding().scope_id;
    let Some((work, request, target)) = restore::capture_context(&scope, repo)? else {
        return Ok(());
    };
    let checkpoint = storage::capture(
        directory,
        repo,
        ticket,
        "Before task changes",
        request_id,
        "before-task",
    )?;
    ticket.check()?;
    restore::record_point(&work, request, target, scope, checkpoint)
}

pub(crate) fn restore_task_for_request(
    _directory: &Path,
    ticket: &OperationTicket,
    request_id: &str,
) -> Result<Option<TaskRepository>, String> {
    let Some(intent) =
        restore::intent_for_request(&ticket.execution_binding().scope_id, request_id)?
    else {
        return Ok(None);
    };
    if intent.state != "prepared" || intent.review.computer_generation != ticket.generation {
        return Err("This restore intent is stale or was already executed. Reconcile before reviewing a fresh action.".into());
    }
    let point = intent.review.point;
    TaskRepository::for_restore(point.repository, &point.workspace_id, &point.agent_id).map(Some)
}

pub(crate) fn preview(
    state: &super::super::super::LocalComputerState,
    point: &Point,
    checkpoint: &str,
) -> Result<(u64, Value), String> {
    let generation = state
        .authority_for(&point.workspace_id, &point.agent_id)?
        .snapshot()?
        .generation;
    let ticket = state.begin_agent_operation(&point.workspace_id, &point.agent_id, generation)?;
    let directory = super::super::directory(state, &point.workspace_id, &point.agent_id)?;
    let mutex = super::super::lock(&directory)?;
    let _guard = mutex.try_lock()?;
    if ticket.execution_binding().scope_id != point.scope_id {
        return Err("This recovery point belongs to another native computer scope.".into());
    }
    let task = TaskRepository::for_restore(
        point.repository.clone(),
        &point.workspace_id,
        &point.agent_id,
    )?;
    let repo = task.load(&directory)?;
    if repo.operation != "idle" {
        return Err(
            "Inspect and recover the interrupted repository operation before restoring.".into(),
        );
    }
    let manifest = storage::load(
        &storage::home(&directory, &repo)?,
        checkpoint,
        &repo,
        &ticket,
    )?;
    let prepared = super::preview::prepare(&directory, &repo, &ticket, &manifest)?;
    ticket.finish(Ok((generation, prepared.review)))
}

pub(crate) fn matches_scope(workspace: &str, agent: &str, scope_id: &str) -> Result<bool, String> {
    let root = crate::account_session::root()?.join("local-computers");
    let computer = crate::local_computer::computer_scope(&root, workspace, agent)?;
    Ok(crate::local_computer::authority::execution_scope_id(&computer.directory) == scope_id)
}

pub(crate) fn with_tree<T>(
    state: &super::super::super::LocalComputerState,
    point: &Point,
    action: impl FnOnce(String) -> Result<T, String>,
) -> Result<T, String> {
    let generation = state
        .authority_for(&point.workspace_id, &point.agent_id)?
        .snapshot()?
        .generation;
    let ticket = state.begin_agent_operation(&point.workspace_id, &point.agent_id, generation)?;
    let directory = super::super::directory(state, &point.workspace_id, &point.agent_id)?;
    let mutex = super::super::lock(&directory)?;
    let _guard = mutex.try_lock()?;
    let task = TaskRepository::for_restore(
        point.repository.clone(),
        &point.workspace_id,
        &point.agent_id,
    )?;
    let repo = task.load(&directory)?;
    if repo.operation != "idle" {
        return Err(
            "Recover the interrupted file import before finishing the conversation restore.".into(),
        );
    }
    let root = super::super::checkout(&directory, &repo)?;
    let tree = files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())?;
    let result = ticket.with_current(|| action(tree));
    ticket.finish(result)
}

pub(crate) fn inspect(
    state: &super::super::super::LocalComputerState,
    intent: &restore::Intent,
) -> Result<Value, String> {
    let point = &intent.review.point;
    let generation = state
        .authority_for(&point.workspace_id, &point.agent_id)?
        .snapshot()?
        .generation;
    let ticket = state.begin_agent_operation(&point.workspace_id, &point.agent_id, generation)?;
    let directory = super::super::directory(state, &point.workspace_id, &point.agent_id)?;
    let mutex = super::super::lock(&directory)?;
    let _guard = mutex.try_lock()?;
    let task = TaskRepository::for_restore(
        point.repository.clone(),
        &point.workspace_id,
        &point.agent_id,
    )?;
    let repo = task.load(&directory)?;
    if repo.operation != "idle" {
        return Err("Inspect and recover the interrupted file import in Files before reconciling this restore.".into());
    }
    let tree = files::tree_id(
        &super::super::checkout(&directory, &repo)?,
        Limits::CODING,
        || ticket.check().is_ok(),
    )?;
    // Reconciliation must not run list()'s approved-retirement cleanup.
    let home = storage::storage(&directory, &repo)?.join("checkpoints");
    let mut checkpoints = Vec::new();
    for entry in fs::read_dir(&home).map_err(|_| "Checkpoint receipts are unavailable.")? {
        if checkpoints.len() >= storage::MAX_CHECKPOINTS {
            return Err("Checkpoint receipts exceed their storage bound.".into());
        }
        let name = entry
            .map_err(|_| "Cannot inspect checkpoint receipt.")?
            .file_name()
            .into_string()
            .map_err(|_| "Invalid checkpoint receipt name.")?;
        checkpoints.push(storage::load(&home, &name, &repo, &ticket)?.checkpoint);
    }
    let before = checkpoints.iter().find(|checkpoint| {
        checkpoint.request_id == intent.approval_request_id && checkpoint.reason == "before-restore"
    });
    let kind = if tree
        == intent.review.checkpoint["outputTreeId"]
            .as_str()
            .unwrap_or("")
        && before.is_some()
    {
        "files-restored"
    } else if tree
        == intent.review.checkpoint["currentTreeId"]
            .as_str()
            .unwrap_or("")
        && before.is_none()
    {
        "unchanged"
    } else {
        "changed"
    };
    ticket.finish(Ok(json!({"intentId":intent.id,"kind":kind,"treeId":tree,"beforeRestoreCheckpointId":before.map(|checkpoint| &checkpoint.id)})))
}
