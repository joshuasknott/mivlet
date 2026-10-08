use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;

pub(super) const MAX_CHECKPOINTS: usize = 24;
pub(super) const MAX_STORAGE: u64 = 512 * 1024 * 1024;
pub(super) const LIMITS: Limits = Limits {
    file_bytes: 16 * 1024 * 1024,
    tree_bytes: 64 * 1024 * 1024,
    file_count: 4096,
    ..Limits::CODING
};
const MANIFEST_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Entry {
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: u8,
    pub checkpoint: Checkpoint,
    pub scope_id: String,
    pub files: BTreeMap<String, Entry>,
}

pub(super) fn id(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(super) fn storage(directory: &Path, repo: &Repository) -> Result<PathBuf, String> {
    let canonical = crate::paths::strict_canonicalize(directory)
        .map_err(|_| "Repository ownership changed.")?;
    let storage = canonical.join(&repo.id);
    if crate::paths::strict_canonicalize(&storage).map_err(|_| "Repository ownership changed.")?
        != storage
        || checkout(directory, repo)? != storage.join("checkout")
    {
        return Err("File checkpoints require the selected, isolated Mivlet copy.".into());
    }
    Ok(storage)
}
pub(super) fn home(directory: &Path, repo: &Repository) -> Result<PathBuf, String> {
    let path = storage(directory, repo)?.join("checkpoints");
    fs::create_dir_all(&path).map_err(|_| "Cannot open checkpoint storage.")?;
    crate::paths::strict_canonicalize(&path)
        .map_err(|_| "Checkpoint storage identity changed.".into())
}
pub(super) fn allowed(path: &str) -> bool {
    if super::super::safe_path(path).is_err() {
        return false;
    }
    !path.split('/').any(|part| {
        let lower = part.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | "_netrc"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".gnupg"
                | ".gitmodules"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
                | "id_rsa"
                | "id_ed25519"
        ) || lower.ends_with(".p12")
            || lower.ends_with(".pfx")
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || lower.starts_with(".env")
    })
}
pub(super) fn candidates(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<BTreeSet<String>, String> {
    // NUL names preserve spaces and avoid Git's quotePath ambiguity. The native
    // process bound fails closed instead of silently losing a truncated list.
    let mut command = git::repo_git(directory, repo)?;
    command.args([
        "ls-files",
        "--cached",
        "--stage",
        "--others",
        "--exclude-standard",
        "-z",
    ]);
    let result = super::super::process::run(command, ticket, 120)?;
    if result.exit_code != Some(0) || result.interrupted || result.truncated || result.redacted {
        return Err(
            "Checkpoint file inventory is unavailable or exceeds its bounded output.".into(),
        );
    }
    let listing = result.output;
    let root = checkout(directory, repo)?;
    let mut paths = BTreeSet::new();
    for record in listing.split('\0').filter(|p| !p.is_empty()) {
        let (path, tracked) = if let Some((metadata, path)) = record.split_once('\t') {
            let fields: Vec<_> = metadata.split(' ').collect();
            if fields.len() != 3 || !matches!(fields[0], "100644" | "100755") || fields[2] != "0" {
                return Err("Checkpoint requires resolved regular files; submodules, symlinks and unmerged entries are unsupported.".into());
            }
            (path, true)
        } else {
            (record, false)
        };
        files::relative(path)?;
        if !allowed(path) {
            continue;
        }
        match fs::symlink_metadata(root.join(path)) {
            Ok(metadata) if metadata.is_file() => { paths.insert(path.to_owned()); }
            // Tracked file-to-directory changes are deletions; new descendants
            // are enumerated separately by Git as untracked files.
            Ok(metadata) if tracked && metadata.is_dir() => {},
            Err(error) if tracked && matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {},
            _ => return Err("Checkpoints require regular files; links, submodules and special entries are unsupported.".into()),
        }
    }
    if paths.len() > LIMITS.file_count {
        return Err("Checkpoint exceeds 4096 files.".into());
    }
    Ok(paths)
}
pub(super) fn inspect(
    root: &Path,
    paths: &BTreeSet<String>,
    ticket: &OperationTicket,
) -> Result<BTreeMap<String, Entry>, String> {
    let mut result = BTreeMap::new();
    let mut total = 0u64;
    for path in paths {
        let bytes = files::read(&root.join(path), LIMITS.file_bytes, || {
            ticket.check().is_ok()
        })?;
        if bytes.starts_with(b"version https://git-lfs.github.com/spec/v1") {
            return Err(
                "Materialized Git LFS repositories are not supported by checkpoints.".into(),
            );
        }
        total += bytes.len() as u64;
        if total > LIMITS.tree_bytes {
            return Err("Checkpoint exceeds 64 MiB.".into());
        }
        result.insert(
            path.clone(),
            Entry {
                bytes: bytes.len() as u64,
                sha256: hex::encode(Sha256::digest(&bytes)),
            },
        );
    }
    Ok(result)
}
pub(super) fn tree_id(entries: &BTreeMap<String, Entry>) -> String {
    let mut hash = Sha256::new();
    for (path, entry) in entries {
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        hash.update(hex::decode(&entry.sha256).expect("validated SHA256"));
    }
    hex::encode(hash.finalize())
}
pub(super) fn load(
    home: &Path,
    checkpoint_id: &str,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<Manifest, String> {
    if !id(checkpoint_id, 48) {
        return Err("Invalid checkpoint identity.".into());
    }
    let bytes = files::read(
        &home.join(checkpoint_id).join("manifest.json"),
        MANIFEST_LIMIT,
        || ticket.check().is_ok(),
    )?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "Checkpoint metadata needs inspection.")?;
    if manifest.version != 1
        || manifest.checkpoint.id != checkpoint_id
        || manifest.checkpoint.repository_id != repo.id
        || manifest.scope_id != ticket.execution_binding().scope_id
        || manifest.files.len() > LIMITS.file_count
        || manifest.checkpoint.file_count != manifest.files.len()
        || !id(&manifest.checkpoint.tree_id, 64)
        || manifest.files.iter().any(|(path, entry)| {
            files::relative(path).is_err()
                || !allowed(path)
                || !id(&entry.sha256, 64)
                || entry.bytes > LIMITS.file_bytes
        })
        || manifest.files.values().map(|e| e.bytes).sum::<u64>() != manifest.checkpoint.bytes
        || manifest.checkpoint.bytes > LIMITS.tree_bytes
        || tree_id(&manifest.files) != manifest.checkpoint.tree_id
    {
        return Err("Checkpoint scope, identity or manifest changed; files preserved.".into());
    }
    Ok(manifest)
}
pub(super) fn list(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<Vec<Checkpoint>, String> {
    // Retirement was already approved before this fixed native-only rename.
    // Finish interrupted cleanup without touching a live saved checkpoint.
    remove_tree(
        &storage(directory, repo)?.join("checkpoint-deleting"),
        Limits::CODING,
        ticket,
    )?;
    let home = home(directory, repo)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&home).map_err(|_| "Cannot list checkpoints.")? {
        ticket.check()?;
        if entries.len() >= MAX_CHECKPOINTS {
            return Err("Checkpoint count exceeds its bound; inspect storage.".into());
        }
        let name = entry
            .map_err(|_| "Cannot inspect checkpoint.")?
            .file_name()
            .into_string()
            .map_err(|_| "Invalid checkpoint name.")?;
        entries.push(load(&home, &name, repo, ticket)?.checkpoint);
    }
    if entries.iter().map(|c| c.bytes).sum::<u64>() > MAX_STORAGE {
        return Err("Checkpoint storage exceeds its bound.".into());
    }
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(entries)
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid checkpoint destination.")?)
        .map_err(|_| "Cannot create checkpoint directory.")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Checkpoint path collision.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist checkpoint file.".into())
}

/// Only named native staging/custody trees enter this function. Validate the
/// whole bounded tree before any deletion; never follow a replacement link.
pub(super) fn remove_tree(
    path: &Path,
    limits: Limits,
    ticket: &OperationTicket,
) -> Result<(), String> {
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect checkpoint staging.")?
    {
        return Ok(());
    }
    files::tree_id(path, limits, || ticket.check().is_ok())?;
    let mut pending = vec![(path.to_owned(), false)];
    while let Some((path, visited)) = pending.pop() {
        ticket.check()?;
        crate::paths::strict_canonicalize(&path).map_err(|_| "Checkpoint cleanup path changed.")?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| "Cannot inspect checkpoint cleanup.")?;
        if metadata.is_dir() && !visited {
            pending.push((path.clone(), true));
            for entry in fs::read_dir(path).map_err(|_| "Cannot inspect checkpoint cleanup.")? {
                if pending.len() > limits.file_count * 2 + 8 {
                    return Err("Checkpoint cleanup exceeded its bound.".into());
                }
                pending.push((
                    entry
                        .map_err(|_| "Cannot inspect checkpoint cleanup.")?
                        .path(),
                    false,
                ));
            }
        } else {
            if metadata.is_dir() {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
            .map_err(|_| "Checkpoint cleanup interrupted; retry to finish.".to_owned())?;
        }
    }
    Ok(())
}

pub(super) fn capture(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    label: &str,
    request_id: &str,
    reason: &str,
) -> Result<Checkpoint, String> {
    if label.trim().is_empty()
        || label.len() > 160
        || label.chars().any(char::is_control)
        || crate::secret_redaction::secret_marker_survives(label)
    {
        return Err("Give this checkpoint a short label without credentials.".into());
    }
    let existing = list(directory, repo, ticket)?;
    if existing.len() >= MAX_CHECKPOINTS {
        return Err(
            "24 checkpoints are retained. Delete an older checkpoint before capturing another."
                .into(),
        );
    }
    let root = checkout(directory, repo)?;
    // Validate ALL current files (including ignored paths) for aliases/links.
    let current = files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())?;
    let paths = candidates(directory, repo, ticket)?;
    let entries = inspect(&root, &paths, ticket)?;
    let bytes = entries.values().map(|e| e.bytes).sum::<u64>();
    if bytes + existing.iter().map(|c| c.bytes).sum::<u64>() > MAX_STORAGE {
        return Err(
            "Checkpoint storage is full (512 MiB). Delete an older checkpoint first.".into(),
        );
    }
    let storage = storage(directory, repo)?;
    let pending = storage.join("checkpoint-pending");
    remove_tree(&pending, Limits::CODING, ticket)?;
    let tree = pending.join("tree");
    fs::create_dir_all(&tree).map_err(|_| "Cannot stage checkpoint.")?;
    for path in &paths {
        let content = files::read(&root.join(path), LIMITS.file_bytes, || {
            ticket.check().is_ok()
        })?;
        if hex::encode(Sha256::digest(&content)) != entries[path].sha256 {
            return Err("Files changed during checkpoint capture. Retry.".into());
        }
        write_new(&tree.join(path), &content)?;
    }
    let checkpoint = Checkpoint {
        id: super::super::super::desktop_tools::opaque_id()?,
        repository_id: repo.id.clone(),
        label: label.trim().into(),
        tree_id: tree_id(&entries),
        head: git::run(directory, repo, &["rev-parse", "HEAD"], ticket)?,
        created_at: chrono::Utc::now().to_rfc3339(),
        bytes,
        file_count: entries.len(),
        request_id: request_id.into(),
        generation: ticket.generation,
        reason: reason.into(),
    };
    let manifest = Manifest {
        version: 1,
        checkpoint: checkpoint.clone(),
        scope_id: ticket.execution_binding().scope_id,
        files: entries,
    };
    let encoded = serde_json::to_vec(&manifest).map_err(|_| "Cannot encode checkpoint.")?;
    if encoded.len() as u64 > MANIFEST_LIMIT {
        return Err("Checkpoint manifest exceeds its limit.".into());
    }
    write_new(&pending.join("manifest.json"), &encoded)?;
    if files::tree_id(&tree, LIMITS, || ticket.check().is_ok())? != checkpoint.tree_id
        || files::tree_id(&root, Limits::CODING, || ticket.check().is_ok())? != current
    {
        return Err("Files changed during checkpoint capture. Retry.".into());
    }
    let destination = home(directory, repo)?.join(&checkpoint.id);
    ticket.with_current(|| {
        fs::rename(&pending, destination).map_err(|_| "Cannot publish checkpoint.".to_owned())
    })?;
    Ok(checkpoint)
}
