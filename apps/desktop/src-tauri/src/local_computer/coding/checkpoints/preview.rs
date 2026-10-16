use super::*;
use std::collections::BTreeSet;

pub(super) struct Prepared {
    pub tree: PathBuf,
    pub review: Value,
}

pub(super) fn prepare(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    manifest: &storage::Manifest,
) -> Result<Prepared, String> {
    let root = checkout(directory, repo)?;
    let home = storage::home(directory, repo)?;
    let snapshot = home.join(&manifest.checkpoint.id).join("tree");
    if files::tree_id(&snapshot, storage::LIMITS, || ticket.check().is_ok())?
        != manifest.checkpoint.tree_id
    {
        return Err("Checkpoint files changed or are incomplete; nothing restored.".into());
    }
    let current_paths = storage::candidates(directory, repo, ticket)?;
    let current = storage::inspect(&root, &current_paths, ticket)?;
    let current_id = files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())?;
    let staging = storage::storage(directory, repo)?.join("checkpoint-restore-staging");
    storage::remove_tree(&staging, Limits::CODING, ticket)?;
    fs::create_dir(&staging).map_err(|_| "Cannot prepare restore preview.")?;
    if files::copy_tree(&root, &staging, Limits::CODING, || ticket.check().is_ok())? != current_id {
        return Err("Repository changed during restore preview. Retry.".into());
    }
    let all_paths: BTreeSet<_> = current
        .keys()
        .chain(manifest.files.keys())
        .cloned()
        .collect();
    let mut changes = Vec::new();
    // Remove only managed code paths. Ignored/credential paths survive from the
    // current tree. Conflicts with such a file/directory fail closed below.
    for path in &current_paths {
        ticket.check()?;
        fs::remove_file(staging.join(path)).map_err(|_| "Cannot prepare file restore.")?;
        remove_empty_parents(&staging.join(path), &staging)?;
    }
    for (path, entry) in &manifest.files {
        let target = staging.join(path);
        if target.exists() {
            // A file has become ignored since capture: do not overwrite it.
            let bytes = files::read(&target, storage::LIMITS.file_bytes, || {
                ticket.check().is_ok()
            })?;
            if hex::encode(Sha256::digest(&bytes)) == entry.sha256 {
                continue;
            }
            return Err("A checkpoint path conflicts with a currently ignored file. Resolve it in the private copy and preview again.".into());
        }
        let bytes = files::read(&snapshot.join(path), storage::LIMITS.file_bytes, || {
            ticket.check().is_ok()
        })?;
        if hex::encode(Sha256::digest(&bytes)) != entry.sha256 {
            return Err("Checkpoint changed during restore preview.".into());
        }
        storage::write_new(&target, &bytes)?;
    }
    for path in all_paths {
        let before = current.get(&path);
        let after = manifest.files.get(&path);
        if before == after {
            continue;
        }
        changes.push(json!({"path": path, "status": if before.is_none() { "added" } else if after.is_none() { "deleted" } else { "modified" }, "beforeSha256": before.map(|e| &e.sha256), "afterSha256": after.map(|e| &e.sha256)}));
    }
    let output_id = files::tree_id(&staging, Limits::CODING, || ticket.check().is_ok())?;
    if files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())? != current_id {
        return Err("Repository changed during restore preview. Retry.".into());
    }
    let (diff, truncated) = diff(
        directory,
        repo,
        ticket,
        &current,
        &snapshot,
        &manifest.checkpoint.tree_id,
    )?;
    if files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())? != current_id {
        return Err("Repository changed while preparing the diff. Preview again.".into());
    }
    Ok(Prepared {
        tree: staging,
        review: json!({"checkpoint": manifest.checkpoint, "currentTreeId": current_id,
        "outputTreeId": output_id, "head": git::run(directory, repo, &["rev-parse", "HEAD"], ticket)?, "files": changes,
        "diff": diff, "truncated": truncated, "preservesIgnoredFiles": true, "verificationWillBeInvalidated": true}),
    })
}
fn remove_empty_parents(file: &Path, root: &Path) -> Result<(), String> {
    let mut parent = file.parent();
    while let Some(path) = parent.filter(|p| *p != root && p.starts_with(root)) {
        if fs::read_dir(path)
            .map_err(|_| "Cannot inspect restore directory.")?
            .next()
            .is_some()
        {
            break;
        }
        fs::remove_dir(path).map_err(|_| "Cannot stage directory replacement.")?;
        parent = path.parent();
    }
    Ok(())
}
fn diff(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    current: &std::collections::BTreeMap<String, storage::Entry>,
    snapshot: &Path,
    checkpoint_tree: &str,
) -> Result<(String, bool), String> {
    let preview = storage::storage(directory, repo)?.join("checkpoint-diff");
    storage::remove_tree(&preview, Limits::CODING, ticket)?;
    fs::create_dir(&preview).map_err(|_| "Cannot prepare checkpoint diff.")?;
    let before = preview.join("current");
    let after = preview.join("checkpoint");
    fs::create_dir(&before)
        .and_then(|_| fs::create_dir(&after))
        .map_err(|_| "Cannot prepare checkpoint diff.")?;
    let root = checkout(directory, repo)?;
    for path in current.keys() {
        let bytes = files::read(&root.join(path), storage::LIMITS.file_bytes, || {
            ticket.check().is_ok()
        })?;
        storage::write_new(&before.join(path), &bytes)?;
    }
    let current_tree = storage::tree_id(current);
    if files::tree_id(&before, storage::LIMITS, || ticket.check().is_ok())? != current_tree
        || files::copy_tree(snapshot, &after, storage::LIMITS, || ticket.check().is_ok())?
            != checkpoint_tree
    {
        return Err("Files changed while preparing the diff. Preview again.".into());
    }
    let mut command = super::super::process::command("git", &preview)?;
    command.args([
        "-c",
        "core.quotePath=true",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        "current",
        "checkpoint",
    ]);
    let result = super::super::process::run(command, ticket, 120)?;
    if result.interrupted || !matches!(result.exit_code, Some(0 | 1)) {
        return Err("Checkpoint diff failed or stopped.".into());
    }
    if files::tree_id(&before, storage::LIMITS, || ticket.check().is_ok())? != current_tree
        || files::tree_id(&after, storage::LIMITS, || ticket.check().is_ok())? != checkpoint_tree
    {
        return Err("Diff inputs changed during review. Preview again.".into());
    }
    storage::remove_tree(&preview, Limits::CODING, ticket)?;
    Ok((result.output, result.truncated))
}
