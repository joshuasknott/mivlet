use super::*;

/// Called by native v3 preparation after the canonical queue hold commits.
/// The selected paths are disclosed in metadata; no bytes cross renderer IPC.
pub(crate) fn capture_snapshot(
    app: &tauri::AppHandle,
    state: &crate::local_computer::LocalComputerState,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    selected_paths: &[String],
    writable_paths: &[String],
) -> Result<Snapshot, String> {
    if !retention::is_preparing(task)? {
        return Err("Native source capture requires its live preparation custody through review publication.".into());
    }
    let current = crate::collaboration::hosted_repository::current(app, ticket, task, false)?;
    let (directory, repo) = storage::repository(state, task, &current.repository)?;
    let mutex = lock(&directory)?;
    let _guard = mutex.try_lock()?;
    let _lease = files::lease(&directory)?;
    if repo.operation != "idle"
        || directory
            .join(&repo.id)
            .join("native-import.json")
            .try_exists()
            .map_err(|_| "Cannot inspect repository recovery.")?
    {
        return Err("Recover the original repository copy before capturing hosted source.".into());
    }
    if selected_paths.is_empty() || selected_paths.len() > FILES {
        return Err("Select between 1 and 2000 source files for this exact task.".into());
    }
    let mut paths = selected_paths.to_vec();
    paths.sort();
    let mut writable_paths = writable_paths.to_vec();
    writable_paths.sort();
    validate_writable(&writable_paths)?;
    let mut aliases = BTreeSet::new();
    for path in &paths {
        public_path(path)?;
        if !aliases.insert(path.to_ascii_lowercase()) {
            return Err("Selected source files contain an alias or duplicate.".into());
        }
    }
    let root = checkout(&directory, &repo)?;
    let full_tree_id = files::tree_id(&root, COPY_LIMITS, || ticket.check().is_ok())?;
    let head = git::run(&directory, &repo, &["rev-parse", "HEAD"], ticket)?;
    let home = storage::home(&directory, &repo)?;
    retention::prune(app, ticket, &directory, &repo, &home)?;
    let pending = storage::reserve(&home)?;
    let tree = pending.path().join("input");
    fs::create_dir(&tree).map_err(|_| "Cannot stage source files.")?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    for path in paths {
        let bytes = files::read(&root.join(&path), FILE_BYTES, || ticket.check().is_ok())?;
        public_content(&bytes)?;
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("Source size overflow.")?;
        if total > TREE_BYTES {
            return Err("Selected source exceeds 32 MiB.".into());
        }
        storage::write_bytes(&tree.join(&path), &bytes)?;
        entries.push(Entry {
            path,
            size_bytes: bytes.len() as u64,
            sha256: digest(&bytes),
        });
    }
    validate_entries(&entries, total)?;
    let snapshot_id = crate::local_computer::desktop_tools::opaque_id()?;
    let mut snapshot = Snapshot {
        version: 1,
        snapshot_id: snapshot_id.clone(),
        repository_id: repo.id.clone(),
        branch: repo.branch.clone(),
        base_commit: repo.base.clone(),
        input_tree_id: tree_id(&entries),
        manifest_sha256: String::new(),
        files: entries,
        writable_paths,
        total_bytes: total,
    };
    snapshot.manifest_sha256 = snapshot_digest(&snapshot)?;
    validate_snapshot(&snapshot)?;
    if files::tree_id(&tree, DATA_LIMITS, || ticket.check().is_ok())? != snapshot.input_tree_id
        || files::tree_id(&root, COPY_LIMITS, || ticket.check().is_ok())? != full_tree_id
        || git::run(&directory, &repo, &["rev-parse", "HEAD"], ticket)? != head
    {
        return Err(
            "The private copy changed while capturing source. Nothing was exported.".into(),
        );
    }
    let checked = crate::collaboration::hosted_repository::current(app, ticket, task, false)?;
    checked.repository.check(&repo)?;
    let record = models::Record {
        version: 1,
        snapshot: snapshot.clone(),
        task: task.clone(),
        account: crate::account_session::binding()?.into(),
        scope_id: ticket.execution_binding().scope_id,
        repository: checked.repository,
        full_tree_id,
        head,
    };
    storage::write_new(&pending.path().join("snapshot.json"), &record)?;
    ticket.with_current(|| {
        fs::rename(pending.path(), home.join(&snapshot_id))
            .map_err(|_| "Cannot publish immutable source custody.".into())
    })?;
    let _ = pending.keep();
    Ok(snapshot)
}

/// Native transport only. A canonical claimed owner is required even for the
/// first chunk; a reviewed/held task alone cannot release repository bytes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn read_snapshot_chunk(
    app: &tauri::AppHandle,
    state: &crate::local_computer::LocalComputerState,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    snapshot_id: &str,
    path: &str,
    offset: u64,
) -> Result<Vec<u8>, String> {
    let current = crate::collaboration::hosted_repository::current(app, ticket, task, true)?;
    let (directory, repo) = storage::repository(state, task, &current.repository)?;
    let _custody = files::lease(&storage::home(&directory, &repo)?)?;
    let (root, record) = storage::load(&directory, &repo, ticket, snapshot_id)?;
    bound_context(&current, &record.snapshot)?;
    if record.task != *task {
        return Err("Source custody belongs to another exact coding task.".into());
    }
    let entry = record
        .snapshot
        .files
        .iter()
        .find(|entry| entry.path == path)
        .ok_or("This source path was not reviewed for export.")?;
    if offset > entry.size_bytes || offset % CHUNK_BYTES as u64 != 0 {
        return Err("Invalid source chunk offset.".into());
    }
    let bytes = files::read(&root.join("input").join(path), FILE_BYTES, || {
        ticket.check().is_ok()
    })?;
    if bytes.len() as u64 != entry.size_bytes || digest(&bytes) != entry.sha256 {
        return Err("Immutable source bytes changed; no chunk was exported.".into());
    }
    crate::collaboration::hosted_repository::current(app, ticket, task, true)?;
    let start = offset as usize;
    Ok(bytes[start..bytes.len().min(start + CHUNK_BYTES)].to_vec())
}
