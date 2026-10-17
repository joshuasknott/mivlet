use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Not Deserialize/IPC data. Only native authenticated v3 transport constructs
/// this after validating its exact completed task receipt and manifest digest.
pub(crate) struct AuthenticatedHostedRepositoryOutput {
    task: TaskIdentity,
    manifest: OutputManifest,
}
impl AuthenticatedHostedRepositoryOutput {
    pub(crate) fn from_authenticated_transport(
        local_workspace: &str,
        completed: &crate::hosted_tasks::models::TaskSnapshot,
        snapshot: &Snapshot,
        manifest: OutputManifest,
        authenticated_manifest_sha256: &str,
    ) -> Result<Self, String> {
        if !matches!(completed.status.as_str(), "completed" | "needs-review")
            || completed.binding.version != 3
            || authenticated_manifest_sha256 != manifest.output_manifest_sha256
            || completed
                .coding
                .as_ref()
                .is_none_or(|coding| coding.output != manifest)
        {
            return Err(
                "Only an authenticated completed coding receipt may stage returned files.".into(),
            );
        }
        validate_bound_snapshot(&completed.binding, snapshot)?;
        validate_output(snapshot, &manifest)?;
        Ok(Self {
            task: TaskIdentity::from_binding(local_workspace, &completed.binding)?,
            manifest,
        })
    }
}

pub(super) fn validate_output(
    snapshot: &Snapshot,
    manifest: &OutputManifest,
) -> Result<(), String> {
    validate_snapshot(snapshot)?;
    validate_entries(&manifest.files, manifest.total_bytes)?;
    let original: BTreeMap<_, _> = snapshot
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let returned: BTreeMap<_, _> = manifest
        .files
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let deleted: Vec<_> = original
        .keys()
        .filter(|path| !returned.contains_key(**path))
        .map(|path| (*path).to_string())
        .collect();
    let writable: BTreeSet<_> = snapshot.writable_paths.iter().map(String::as_str).collect();
    if manifest.version != 1
        || manifest.snapshot_id != snapshot.snapshot_id
        || manifest.input_manifest_sha256 != snapshot.manifest_sha256
        || manifest.output_manifest_sha256 != output_digest(manifest)?
        || manifest.deleted_paths != deleted
        || deleted.iter().any(|path| !writable.contains(path.as_str()))
        || manifest.files.iter().any(|entry| {
            original
                .get(entry.path.as_str())
                .is_none_or(|before| **before != *entry)
                && !writable.contains(entry.path.as_str())
        })
    {
        return Err("Returned files expand the reviewed write scope or changed their immutable output manifest.".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SavedOutput {
    pub version: u8,
    pub task: TaskIdentity,
    pub manifest: OutputManifest,
}
/// Idempotent authenticated refresh can reuse sealed bytes without refetching or
/// rerunning the task. A caller still compares this manifest to its fresh receipt.
pub(crate) fn retained_output(
    app: &tauri::AppHandle,
    state: &crate::local_computer::LocalComputerState,
    ticket: &OperationTicket,
    task: &TaskIdentity,
    snapshot_id: &str,
) -> Result<Option<OutputManifest>, String> {
    let current = crate::collaboration::hosted_repository::current_for_import(app, ticket, task)?;
    let (directory, repo) = storage::repository(state, task, &current.repository)?;
    let _custody = files::lease(&storage::home(&directory, &repo)?)?;
    let (root, record) = storage::load(&directory, &repo, ticket, snapshot_id)?;
    bound_context(&current, &record.snapshot)?;
    if record.task != *task {
        return Err("Returned file custody belongs to another coding task.".into());
    }
    let path = root.join("output");
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect retained returned files.")?
    {
        return Ok(None);
    }
    let saved: SavedOutput = storage::read(&path.join("authenticated.json"), ticket)?;
    validate_output(&record.snapshot, &saved.manifest)?;
    if saved.version != 1
        || saved.task != *task
        || files::tree_id(&path.join("tree"), DATA_LIMITS, || ticket.check().is_ok())?
            != tree_id(&saved.manifest.files)
    {
        return Err("The retained authenticated output changed. No task was replayed.".into());
    }
    crate::collaboration::hosted_repository::current_for_import(app, ticket, task)?;
    Ok(Some(saved.manifest))
}

/// Owns only private output staging, never the repository lock across network
/// waits. A restart can refetch immutable chunks; it cannot replay the task.
pub(crate) struct OutputStager {
    temporary: tempfile::TempDir,
    destination: PathBuf,
    record: models::Record,
    manifest: OutputManifest,
    progress: BTreeMap<String, u64>,
    _lease: fs::File,
    _custody: fs::File,
}
impl OutputStager {
    pub(crate) fn begin(
        app: &tauri::AppHandle,
        state: &crate::local_computer::LocalComputerState,
        ticket: &OperationTicket,
        authenticated: AuthenticatedHostedRepositoryOutput,
    ) -> Result<Self, String> {
        let current = crate::collaboration::hosted_repository::current_for_import(
            app,
            ticket,
            &authenticated.task,
        )?;
        let (directory, repo) =
            storage::repository(state, &authenticated.task, &current.repository)?;
        let custody = files::lease(&storage::home(&directory, &repo)?)?;
        let (root, record) = storage::load(
            &directory,
            &repo,
            ticket,
            &authenticated.manifest.snapshot_id,
        )?;
        bound_context(&current, &record.snapshot)?;
        if record.task != authenticated.task {
            return Err("The completed output belongs to another coding task.".into());
        }
        validate_output(&record.snapshot, &authenticated.manifest)?;
        let lease = files::lease(&root)?;
        let destination = root.join("output");
        if destination
            .try_exists()
            .map_err(|_| "Cannot inspect returned file custody.")?
        {
            return Err("Returned files are already retained. Review the existing native output; nothing was replayed.".into());
        }
        let temporary = tempfile::Builder::new()
            .prefix("output-preparing-")
            .tempdir_in(&root)
            .map_err(|_| "Cannot stage returned source files.")?;
        fs::create_dir(temporary.path().join("tree"))
            .map_err(|_| "Cannot prepare returned source custody.")?;
        let original: BTreeMap<_, _> = record
            .snapshot
            .files
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let mut progress = BTreeMap::new();
        for entry in &authenticated.manifest.files {
            let path = temporary.path().join("tree").join(&entry.path);
            if original
                .get(entry.path.as_str())
                .is_some_and(|before| **before == *entry)
            {
                let bytes = files::read(&root.join("input").join(&entry.path), FILE_BYTES, || {
                    ticket.check().is_ok()
                })?;
                if bytes.len() as u64 != entry.size_bytes || digest(&bytes) != entry.sha256 {
                    return Err("The retained input source changed.".into());
                }
                storage::write_bytes(&path, &bytes)?;
                progress.insert(entry.path.clone(), entry.size_bytes);
            } else {
                storage::write_bytes(&path, &[])?;
                progress.insert(entry.path.clone(), 0);
            }
        }
        Ok(Self {
            temporary,
            destination,
            record,
            manifest: authenticated.manifest,
            progress,
            _lease: lease,
            _custody: custody,
        })
    }
    pub(crate) fn write_chunk(
        &mut self,
        ticket: &OperationTicket,
        path: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        ticket.check()?;
        let entry = self
            .manifest
            .files
            .iter()
            .find(|entry| entry.path == path)
            .ok_or("Unexpected returned file path.")?;
        let written = self
            .progress
            .get_mut(path)
            .ok_or("Unexpected returned file custody.")?;
        if bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || offset != *written
            || written.saturating_add(bytes.len() as u64) > entry.size_bytes
        {
            return Err(
                "Returned chunks are oversized, missing or out of order; no files were imported."
                    .into(),
            );
        }
        let target = self.temporary.path().join("tree").join(path);
        crate::paths::strict_canonicalize(&target).map_err(|_| "Returned file custody changed.")?;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(target)
            .map_err(|_| "Cannot retain returned source bytes.")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot retain returned source bytes.")?;
        *written += bytes.len() as u64;
        Ok(())
    }
    pub(crate) fn needed_files(&self) -> Vec<Entry> {
        self.manifest
            .files
            .iter()
            .filter(|entry| self.progress[&entry.path] < entry.size_bytes)
            .cloned()
            .collect()
    }
    pub(crate) fn finish(
        self,
        app: &tauri::AppHandle,
        ticket: &OperationTicket,
    ) -> Result<OutputManifest, String> {
        for entry in &self.manifest.files {
            let bytes = files::read(
                &self.temporary.path().join("tree").join(&entry.path),
                FILE_BYTES,
                || ticket.check().is_ok(),
            )?;
            public_content(&bytes)?;
            if self.progress[&entry.path] != entry.size_bytes
                || bytes.len() as u64 != entry.size_bytes
                || digest(&bytes) != entry.sha256
            {
                return Err("Returned source bytes are incomplete or do not match the authenticated manifest.".into());
            }
        }
        if files::tree_id(&self.temporary.path().join("tree"), DATA_LIMITS, || {
            ticket.check().is_ok()
        })? != tree_id(&self.manifest.files)
        {
            return Err("Returned file custody contains unexpected entries.".into());
        }
        crate::collaboration::hosted_repository::current_for_import(
            app,
            ticket,
            &self.record.task,
        )?;
        let saved = SavedOutput {
            version: 1,
            task: self.record.task.clone(),
            manifest: self.manifest.clone(),
        };
        storage::write_new(&self.temporary.path().join("authenticated.json"), &saved)?;
        ticket.with_current(|| {
            fs::rename(self.temporary.path(), &self.destination)
                .map_err(|_| "Cannot retain immutable returned file custody.".into())
        })?;
        let _ = self.temporary.keep();
        Ok(self.manifest)
    }
}
