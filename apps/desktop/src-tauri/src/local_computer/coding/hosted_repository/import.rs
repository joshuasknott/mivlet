use super::*;
use crate::models::{ApprovalRequest, ApprovalResolutionRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportTarget {
    workspace_id: String,
    agent_id: String,
    work_id: String,
    expected_generation: u32,
    snapshot_id: String,
    output_manifest_sha256: String,
}
impl ImportTarget {
    fn target(&self) -> Target {
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
pub(crate) struct ImportCommit {
    workspace_id: String,
    agent_id: String,
    work_id: String,
    expected_generation: u32,
    snapshot_id: String,
    output_manifest_sha256: String,
    review_id: String,
    resolution: ApprovalResolutionRequest,
}
impl ImportCommit {
    fn target(&self) -> ImportTarget {
        ImportTarget {
            workspace_id: self.workspace_id.clone(),
            agent_id: self.agent_id.clone(),
            work_id: self.work_id.clone(),
            expected_generation: self.expected_generation,
            snapshot_id: self.snapshot_id.clone(),
            output_manifest_sha256: self.output_manifest_sha256.clone(),
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    review_id: String,
    snapshot: Snapshot,
    output: OutputManifest,
    current_tree_id: String,
    output_tree_id: String,
    head: String,
    computer_generation: u64,
    expires_at: i64,
    changes: Vec<Value>,
    diff: String,
    truncated: bool,
    approval: ApprovalRequest,
}
fn main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Review returned repository files in the main Mivlet window.".into());
    }
    crate::account_session::ensure_current()
}
fn task_for_target(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    target: &Target,
) -> Result<TaskIdentity, String> {
    crate::collaboration::hosted_repository::task_identity(app, ticket, target)
}
fn retained(
    app: &tauri::AppHandle,
    state: &crate::local_computer::LocalComputerState,
    ticket: &OperationTicket,
    target: &ImportTarget,
) -> Result<
    (
        TaskIdentity,
        PathBuf,
        Repository,
        PathBuf,
        models::Record,
        OutputManifest,
    ),
    String,
> {
    if !hex(&target.snapshot_id, 48) || !hex(&target.output_manifest_sha256, 64) {
        return Err("Invalid returned repository identity.".into());
    }
    let task = task_for_target(app, ticket, &target.target())?;
    let current = crate::collaboration::hosted_repository::current_for_import(app, ticket, &task)?;
    let (directory, repo) = storage::repository(state, &task, &current.repository)?;
    let (root, record) = storage::load(&directory, &repo, ticket, &target.snapshot_id)?;
    bound_context(&current, &record.snapshot)?;
    let output: output::SavedOutput =
        storage::read(&root.join("output/authenticated.json"), ticket)?;
    if record.task != task
        || output.version != 1
        || output.task != task
        || output.manifest.output_manifest_sha256 != target.output_manifest_sha256
    {
        return Err("Returned file custody does not match this exact authenticated task.".into());
    }
    output::validate_output(&record.snapshot, &output.manifest)?;
    if files::tree_id(&root.join("output/tree"), DATA_LIMITS, || {
        ticket.check().is_ok()
    })? != tree_id(&output.manifest.files)
    {
        return Err("Retained cloud output changed. No files were imported.".into());
    }
    Ok((task, directory, repo, root, record, output.manifest))
}
fn imported(
    directory: &Path,
    repo: &Repository,
    root: &Path,
    record: &models::Record,
    output: &OutputManifest,
    ticket: &OperationTicket,
) -> Result<Option<ImportReceipt>, String> {
    if !root
        .join("imported.json")
        .try_exists()
        .map_err(|_| "Cannot inspect the saved import outcome.")?
    {
        return Ok(None);
    }
    let receipt: ImportReceipt = storage::read(&root.join("imported.json"), ticket)?;
    receipt.validate()?;
    if receipt.snapshot_id != record.snapshot.snapshot_id
        || receipt.repository_id != repo.id
        || receipt.output_manifest_sha256 != output.output_manifest_sha256
    {
        return Err("The saved import outcome belongs to another exact file result.".into());
    }
    if directory
        .join(&repo.id)
        .join("native-import.json")
        .try_exists()
        .map_err(|_| "Cannot inspect file import recovery.")?
        || repo.operation != "idle"
        || files::tree_id(&checkout(directory, repo)?, COPY_LIMITS, || {
            ticket.check().is_ok()
        })? != receipt.output_tree_id
    {
        return Err(
            "The file import needs recovery or its copy changed. No import was replayed.".into(),
        );
    }
    Ok(Some(receipt))
}
/// Authenticated native cloud refresh calls this before opening its canonical
/// result transaction. A lost renderer response never authorizes another write.
pub(crate) fn reconcile_import_receipt(
    app: &tauri::AppHandle,
    state: &crate::local_computer::LocalComputerState,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    snapshot_id: &str,
    output_manifest_sha256: &str,
) -> Result<Option<ImportReceipt>, String> {
    let target = ImportTarget {
        workspace_id: task.local_workspace_id.clone(),
        agent_id: task.agent_id.clone(),
        work_id: task.work_id.clone(),
        expected_generation: task.work_generation,
        snapshot_id: snapshot_id.into(),
        output_manifest_sha256: output_manifest_sha256.into(),
    };
    let (_, directory, repo, root, record, output) = retained(app, state, ticket, &target)?;
    let receipt = {
        let mutex = lock(&directory)?;
        let _guard = mutex.try_lock()?;
        let _lease = files::lease(&directory)?;
        imported(&directory, &repo, &root, &record, &output, ticket)?
    };
    if let Some(receipt) = &receipt {
        crate::collaboration::hosted_repository::record_import(
            app,
            ticket,
            task,
            &record.snapshot,
            receipt,
        )?;
    }
    Ok(receipt)
}
fn changes(snapshot: &Snapshot, output: &OutputManifest) -> Vec<Value> {
    let before: BTreeMap<_, _> = snapshot
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let after: BTreeMap<_, _> = output
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let paths: BTreeSet<_> = before.keys().chain(after.keys()).copied().collect();
    paths.into_iter().filter_map(|path| {
        let old=before.get(path);let new=after.get(path);
        if old==new {None} else {
            let mut value=json!({"path":path,"status":if old.is_none(){"added"}else if new.is_none(){"deleted"}else{"modified"}});
            if let Some(old)=old {value["beforeSha256"]=json!(old.sha256);}
            if let Some(new)=new {value["afterSha256"]=json!(new.sha256);}
            Some(value)
        }
    }).collect()
}
pub(super) fn check_base(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    record: &models::Record,
) -> Result<PathBuf, String> {
    if repo.operation != "idle"
        || directory
            .join(&repo.id)
            .join("native-import.json")
            .try_exists()
            .map_err(|_| "Cannot inspect import recovery.")?
    {
        return Err("The repository needs recovery before another file import.".into());
    }
    let root = checkout(directory, repo)?;
    if git::run(directory, repo, &["rev-parse", "HEAD"], ticket)? != record.head
        || files::tree_id(&root, COPY_LIMITS, || ticket.check().is_ok())? != record.full_tree_id
    {
        return Err("The original task copy changed after export. Returned files remain separate; no local changes were overwritten.".into());
    }
    Ok(root)
}
pub(super) fn overlay(
    tree: &Path,
    output_root: &Path,
    record: &models::Record,
    output: &OutputManifest,
    ticket: &OperationTicket,
) -> Result<(), String> {
    let before: BTreeSet<_> = record
        .snapshot
        .files
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    for path in &output.deleted_paths {
        ticket.check()?;
        fs::remove_file(tree.join(path)).map_err(|_| "Cannot stage an exact reviewed deletion.")?;
    }
    for entry in &output.files {
        let bytes = files::read(
            &output_root.join("tree").join(&entry.path),
            FILE_BYTES,
            || ticket.check().is_ok(),
        )?;
        public_content(&bytes)?;
        if bytes.len() as u64 != entry.size_bytes || digest(&bytes) != entry.sha256 {
            return Err("Returned source bytes changed during import review.".into());
        }
        let path = tree.join(&entry.path);
        if before.contains(entry.path.as_str()) {
            fs::remove_file(&path).map_err(|_| "The original exported source path changed.")?;
        } else if path
            .try_exists()
            .map_err(|_| "Cannot inspect unexported local source.")?
        {
            return Err("A returned new path conflicts with an unexported local file or directory. Nothing was overwritten.".into());
        }
        storage::write_bytes(&path, &bytes)?;
    }
    Ok(())
}
fn diff(
    review_root: &Path,
    source: &Path,
    returned: &Path,
    changed: &[Value],
    ticket: &OperationTicket,
) -> Result<(String, bool), String> {
    let before = review_root.join("before");
    let after = review_root.join("after");
    fs::create_dir(&before)
        .and_then(|_| fs::create_dir(&after))
        .map_err(|_| "Cannot prepare bounded source diff.")?;
    for change in changed {
        let path = change["path"]
            .as_str()
            .ok_or("Invalid reviewed source path.")?;
        if change["status"] != "added" {
            storage::write_bytes(
                &before.join(path),
                &files::read(&source.join(path), FILE_BYTES, || ticket.check().is_ok())?,
            )?;
        }
        if change["status"] != "deleted" {
            storage::write_bytes(
                &after.join(path),
                &files::read(&returned.join(path), FILE_BYTES, || ticket.check().is_ok())?,
            )?;
        }
    }
    let mut command = super::super::process::command("git", review_root)?;
    command.args([
        "-c",
        "core.hooksPath=/dev/null",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--",
        "before",
        "after",
    ]);
    let result = super::super::process::run(command, ticket, 8)?;
    if result.interrupted || !matches!(result.exit_code, Some(0 | 1)) {
        return Err("The returned-file diff could not be prepared safely.".into());
    }
    if result.redacted {
        Ok((String::new(), true))
    } else {
        Ok((result.output, result.truncated))
    }
}
fn approval(review: &Review) -> Result<ApprovalRequest, String> {
    crate::approvals::normalize_approval_request(ApprovalRequest {
        id:format!("approval-hosted-import-{}",review.review_id),service:"Mivlet hosted repository import".into(),
        action:format!("Import {} exact returned file changes into its original task copy",review.changes.len()),mode:"trusted-scope".into(),risk_level:"high".into(),
        data_used:vec![format!("Repository copy: {}",review.snapshot.repository_id),format!("Input manifest SHA-256: {}",review.snapshot.manifest_sha256),format!("Output manifest SHA-256: {}",review.output.output_manifest_sha256),format!("Current tree: {}; returned tree: {}; HEAD: {}; computer generation: {}; review expires: {}",review.current_tree_id,review.output_tree_id,review.head,review.computer_generation,review.expires_at)],
        consequence:"Applies only the exact displayed returned source changes to the original Mivlet task copy. A local recovery checkpoint is captured first. Git HEAD and other copies stay unchanged; prior build verification is invalidated. This import never reruns the cloud task.".into(),
        requested_at:chrono::Utc::now().to_rfc3339(),decisions:vec!["once".into(),"deny".into()],confirmation_phrase:None,
    })
}
#[tauri::command]
pub(crate) async fn hosted_repository_import_review(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::local_computer::LocalComputerState>>,
    request: ImportTarget,
) -> Result<Value, String> {
    main(&window)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move|| {
        let ticket=crate::hosted_tasks::ticket(&state,&request.workspace_id,&request.agent_id)?;
        let (task,directory,repo,root,record,output)=retained(&app,&state,&ticket,&request)?;
        let mutex=lock(&directory)?;let _guard=mutex.try_lock()?;let _lease=files::lease(&directory)?;
        let source=check_base(&directory,&repo,&ticket,&record)?;
        let reviewed=root.join("import-review");let changed=changes(&record.snapshot,&output);
        let (output_tree_id,diff,truncated,pending)=if reviewed.try_exists().map_err(|_|"Cannot inspect saved import review.")? {
            let old:Review=storage::read(&reviewed.join("review.json"),&ticket)?;
            if old.snapshot!=record.snapshot||old.output!=output||old.current_tree_id!=record.full_tree_id||old.head!=record.head
                || files::tree_id(&reviewed.join("tree"),COPY_LIMITS,||ticket.check().is_ok())?!=old.output_tree_id
            {return Err("The saved import review changed. Keep the returned files separate and inspect recovery.".into());}
            (old.output_tree_id,old.diff,old.truncated,None)
        } else {
            let pending=tempfile::Builder::new().prefix("review-preparing-").tempdir_in(&root).map_err(|_|"Cannot stage file import review.")?;
            let tree=pending.path().join("tree");fs::create_dir(&tree).map_err(|_|"Cannot stage file import review.")?;
            if files::copy_tree(&source,&tree,COPY_LIMITS,||ticket.check().is_ok())?!=record.full_tree_id {return Err("The original copy changed during import review.".into());}
            overlay(&tree,&root.join("output"),&record,&output,&ticket)?;
            let output_tree_id=files::tree_id(&tree,COPY_LIMITS,||ticket.check().is_ok())?;
            let (diff,truncated)=diff(pending.path(),&root.join("input"),&root.join("output/tree"),&changed,&ticket)?;
            // A review directory is immutable after publication except its
            // fresh one-use approval metadata. No repository bytes move here.
            (output_tree_id,diff,truncated,Some(pending))
        };
        check_base(&directory,&repo,&ticket,&record)?;
        crate::collaboration::hosted_repository::current_for_import(&app,&ticket,&task)?;
        let mut review=Review {review_id:crate::local_computer::desktop_tools::opaque_id()?,snapshot:record.snapshot,output,current_tree_id:record.full_tree_id,output_tree_id,head:record.head,computer_generation:ticket.generation,expires_at:chrono::Utc::now().timestamp_millis()+120_000,changes:changed,diff,truncated,approval:ApprovalRequest {id:String::new(),service:String::new(),action:String::new(),mode:String::new(),risk_level:String::new(),data_used:vec![],consequence:String::new(),requested_at:String::new(),decisions:vec![],confirmation_phrase:None}};
        review.approval=approval(&review)?;
        let path=pending.as_ref().map_or_else(||reviewed.join("review.json"),|pending|pending.path().join("review.json"));
        if path.exists(){storage::replace(&path,&review)?;}else{storage::write_new(&path,&review)?;}
        if let Some(pending)=pending {
            ticket.with_current(||fs::rename(pending.path(),&reviewed).map_err(|_|"Cannot retain file import review.".into()))?;
            let _=pending.keep();
        }
        ticket.finish(serde_json::to_value(review).map_err(|_|"Invalid import review.".into()))
    }).await.map_err(|_|"File import review was interrupted.".to_string())?
}

#[tauri::command]
pub(crate) async fn hosted_repository_import_apply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::local_computer::LocalComputerState>>,
    request: ImportCommit,
) -> Result<ImportReceipt, String> {
    main(&window)?;
    crate::execution_control::ensure_active_execution_allowed()?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move|| {
        let ticket=crate::hosted_tasks::ticket(&state,&request.workspace_id,&request.agent_id)?;
        let account=crate::account_session::AccountDispatchFence::capture()?;
        let (task,directory,mut repo,root,record,output)=retained(&app,&state,&ticket,&request.target())?;
        let mutex=lock(&directory)?;let _guard=mutex.try_lock()?;let _lease=files::lease(&directory)?;
        if root.join("imported.json").try_exists().map_err(|_|"Cannot inspect the saved import outcome.")? {
            return Err("This returned file result already has a native import outcome. Refresh its receipt; no files were reapplied.".into());
        }
        let reviewed=root.join("import-review");
        let review:Review=storage::read(&reviewed.join("review.json"),&ticket)?;
        if review.review_id!=request.review_id||review.snapshot!=record.snapshot||review.output!=output
            || review.computer_generation!=ticket.generation||review.expires_at<=chrono::Utc::now().timestamp_millis()
            || review.current_tree_id!=record.full_tree_id||review.head!=record.head
            || request.resolution.request!=review.approval||request.resolution.decision!="once"||request.resolution.modification.is_some()
        {return Err("This exact file import review changed or expired. Request a fresh review and one-time approval.".into());}
        let resolution=crate::approvals::resolve_approval(request.resolution)?;
        if resolution.audit_entry.decision!="once"||resolution.effective_request!=review.approval {return Err("The exact one-time file import approval was not recorded.".into());}
        crate::execution_approvals::verify_and_consume_execution_approval(&crate::paths::execution_approvals_path(&app)?,&resolution.effective_request,&crate::execution_approvals::wall_clock_consumed_at())?;
        let destination=check_base(&directory,&repo,&ticket,&record)?;
        if files::tree_id(&reviewed.join("tree"),COPY_LIMITS,||ticket.check().is_ok())?!=review.output_tree_id {return Err("The reviewed output tree changed. No files were imported.".into());}
        crate::collaboration::hosted_repository::current_for_import(&app,&ticket,&task)?;
        let (binding,_import_gate)=crate::collaboration::hosted_repository::register_import(&app,&ticket,&task)?;
        let checkpoint=super::super::checkpoints::hosted::capture_before_import(&directory,&repo,&ticket,&review.approval.id)?;
        let provenance=mivlet_windows_executor::HostedRepositoryImportSource {snapshot_id:record.snapshot.snapshot_id.clone(),output_manifest_sha256:output.output_manifest_sha256.clone(),before_import_checkpoint_id:checkpoint.id.clone()};
        let prepared=files::prepare_hosted_import(&reviewed.join("tree"),&destination,COPY_LIMITS,&provenance,&record.full_tree_id,&review.output_tree_id,ticket.execution_binding(),||ticket.check().is_ok())?;
        // Re-read only native metadata/HEAD outside the short final gate.
        let owned=copy_manager::owned_repository(&directory,&repo.id,&task.local_workspace_id,&task.agent_id)?;
        record.repository.check(&owned)?;
        if git::run(&directory,&repo,&["rev-parse","HEAD"],&ticket)?!=record.head {return Err("The repository HEAD changed. Import recovery must be reviewed; no task was replayed.".into());}
        let receipt=ImportReceipt {snapshot_id:record.snapshot.snapshot_id.clone(),repository_id:repo.id.clone(),output_manifest_sha256:output.output_manifest_sha256,output_tree_id:review.output_tree_id,before_import_checkpoint_id:checkpoint.id,verification_invalidated:true};
        let committed=crate::hosted_tasks::dispatch::with_current(&binding,|| ticket.with_current(|| account.with_current(|| {
            repo.operation="hosted file import pending; inspect repository recovery".into();repo.command_diff_id=None;
            super::super::save_repository(&directory,&repo)?;
            let committed=prepared.commit()?;
            repo.operation="idle".into();repo.last_result=None;repo.last_command=None;
            super::super::save_repository(&directory,&repo)?;
            storage::write_new(&root.join("imported.json"),&receipt)?;
            Ok(committed)
        })))?;
        committed.acknowledge(||ticket.check().is_ok())?;
        // Canonical Work truth is recorded outside all file/generation gates.
        // If Stop wins here, file custody still retains the exact durable
        // receipt and no late conversation completion is fabricated.
        crate::collaboration::hosted_repository::record_import(&app,&ticket,&task,&record.snapshot,&receipt)?;
        Ok(receipt)
    }).await.map_err(|_|"File import outcome is uncertain. Inspect native recovery before trying another import.".to_string())?
}
