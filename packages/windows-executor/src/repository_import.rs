//! A single bounded import intent per managed checkout. The intent survives
//! both renames; only acknowledgement after repository-state persistence permits
//! cleanup. Restart may restore the old checkout, never import staged commands.
use crate::{files, Binding, Limits, Receipt};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const JOURNAL: &str = "native-import.json";
const MAX_JOURNAL: u64 = 8192;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    version: u32,
    destination: PathBuf,
    transaction: String,
    run_id: String,
    binding: Binding,
    command_id: String,
    input_id: String,
    previous_id: String,
    output_id: String,
    acknowledged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint_id: Option<String>,
}
pub struct Prepared {
    parent: PathBuf,
    intent: Intent,
}
pub struct Committed(Prepared);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub run_id: String,
    pub binding: Binding,
    pub command_id: String,
    pub destination: PathBuf,
    pub input_id: String,
    pub previous_id: String,
    pub output_id: String,
    pub outcome: String,
    pub previous: Option<PathBuf>,
    pub checkpoint_id: Option<String>,
}
fn hex_id(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Cannot inspect import custody.".into()),
    }
}
fn location(destination: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = files::strict_path(destination.parent().ok_or("Invalid import destination.")?)?;
    let name = destination
        .file_name()
        .ok_or("Invalid import destination.")?;
    // Resolve only the existing parent: checkout is legitimately absent in the
    // first rename gap. The journal cannot nominate another parent or filename.
    let target = parent.join(name);
    if present(&target)? && files::strict_path(&target)? != target {
        return Err("Import destination identity changed.".into());
    }
    Ok((parent, target))
}
fn write_intent(parent: &Path, intent: &Intent, create: bool) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Cannot prepare durable import intent.")?;
    let bytes = serde_json::to_vec(intent).map_err(|_| "Cannot write import intent.")?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err("Import intent exceeds its bound.".into());
    }
    file.write_all(&bytes)
        .map_err(|_| "Cannot write import intent.")?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot persist import intent.")?;
    let path = parent.join(JOURNAL);
    if create {
        file.persist_noclobber(path)
            .map_err(|_| "An import requires recovery before another command.")?;
    } else {
        files::strict_path(&path)?;
        file.persist(path)
            .map_err(|_| "Cannot acknowledge import intent.")?;
    }
    Ok(())
}
fn read_intent(destination: &Path, scope: &str) -> Result<Option<Prepared>, String> {
    let (parent, target) = location(destination)?;
    let path = parent.join(JOURNAL);
    if !present(&path)? {
        return Ok(None);
    }
    let intent: Intent = serde_json::from_slice(&files::read(&path, MAX_JOURNAL)?)
        .map_err(|_| "Import journal requires inspection.")?;
    if intent.version != 1
        || intent.destination != target
        || intent.binding.scope_id != scope
        || !hex_id(scope, 64)
        || intent.binding.generation == 0
        || intent.binding.operation_id == 0
        || !hex_id(&intent.run_id, 48)
        || intent
            .checkpoint_id
            .as_ref()
            .is_some_and(|id| !hex_id(id, 48))
        || !intent
            .transaction
            .starts_with(&format!("native-import-{}-", intent.run_id))
        || intent.transaction.len() > 80
        || !intent
            .transaction
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || [
            &intent.command_id,
            &intent.input_id,
            &intent.previous_id,
            &intent.output_id,
        ]
        .iter()
        .any(|id| !hex_id(id, 64))
    {
        return Err("Import journal scope, path or identity changed; files preserved.".into());
    }
    Ok(Some(Prepared { parent, intent }))
}
fn rename(source: &Path, destination: &Path) -> Result<(), String> {
    files::strict_path(source)?;
    files::strict_path(destination.parent().ok_or("Invalid import rename.")?)?;
    if present(destination)? {
        return Err("Import rename target already exists; files preserved.".into());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        if unsafe {
            MoveFileExW(
                crate::security::wide(source).as_ptr(),
                crate::security::wide(destination).as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("Cannot complete import rename; durable recovery intent preserved.".into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, destination).map_err(|_| "Cannot complete import rename.")?;
    Ok(())
}
pub(crate) fn prepare(
    source: &Path,
    destination: &Path,
    limits: Limits,
    receipt: &Receipt,
    current: &dyn Fn() -> bool,
) -> Result<Prepared, String> {
    let origin = ImportSource {
        id: &receipt.run_id,
        binding: &receipt.binding,
        operation_id: &receipt.command_id,
        input_id: &receipt.input_id,
        output_id: receipt
            .output_id
            .as_deref()
            .ok_or("Import needs a sealed output.")?,
        checkpoint_id: None,
    };
    prepare_source(source, destination, limits, origin, None, current)
}

struct ImportSource<'a> {
    id: &'a str,
    binding: &'a Binding,
    operation_id: &'a str,
    input_id: &'a str,
    output_id: &'a str,
    checkpoint_id: Option<&'a str>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_restore(
    source: &Path,
    destination: &Path,
    limits: Limits,
    checkpoint_id: &str,
    expected_current: &str,
    expected_output: &str,
    binding: Binding,
    current: &dyn Fn() -> bool,
) -> Result<Prepared, String> {
    use sha2::{Digest, Sha256};
    if !hex_id(checkpoint_id, 48)
        || !hex_id(expected_current, 64)
        || !hex_id(expected_output, 64)
        || !hex_id(&binding.scope_id, 64)
        || binding.generation == 0
        || binding.operation_id == 0
    {
        return Err("Invalid checkpoint restore binding.".into());
    }
    let mut nonce = [0u8; 24];
    getrandom::fill(&mut nonce).map_err(|_| "Cannot identify checkpoint restore.")?;
    let restore_id = hex::encode(nonce);
    let operation_id = hex::encode(Sha256::digest(format!(
        "checkpoint-restore:{checkpoint_id}:{expected_current}:{expected_output}"
    )));
    let origin = ImportSource {
        id: &restore_id,
        binding: &binding,
        operation_id: &operation_id,
        input_id: expected_current,
        output_id: expected_output,
        checkpoint_id: Some(checkpoint_id),
    };
    prepare_source(
        source,
        destination,
        limits,
        origin,
        Some(expected_current),
        current,
    )
}

fn prepare_source(
    source: &Path,
    destination: &Path,
    limits: Limits,
    origin: ImportSource<'_>,
    expected_current: Option<&str>,
    current: &dyn Fn() -> bool,
) -> Result<Prepared, String> {
    let (parent, target) = location(destination)?;
    if present(&parent.join(JOURNAL))? {
        return Err("Recover the previous import before another command.".into());
    }
    let previous_id = files::tree_id_current(&target, limits, current)?;
    if expected_current.is_some_and(|expected| expected != previous_id) {
        return Err(
            "Repository changed after restore review. Preview again; nothing restored.".into(),
        );
    }
    let transaction = tempfile::Builder::new()
        .prefix(&format!("native-import-{}-", origin.id))
        .tempdir_in(&parent)
        .map_err(|_| "Cannot stage repository import.")?;
    let staged = transaction.path().join("staged");
    fs::create_dir(&staged).map_err(|_| "Cannot stage repository import.")?;
    let output_id = files::copy_tree_current(source, &staged, limits, current)?;
    if origin.output_id != output_id {
        return Err(
            "The sealed command snapshot changed during import. No changes imported.".into(),
        );
    }
    if expected_current.is_some()
        && files::tree_id_current(&target, limits, current)? != previous_id
    {
        return Err(
            "Repository changed during restore preparation. Preview again; nothing restored."
                .into(),
        );
    }
    if !current() {
        return Err("Repository import stopped before preparation.".into());
    }
    let intent = Intent {
        version: 1,
        destination: target,
        transaction: transaction
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        run_id: origin.id.to_owned(),
        binding: origin.binding.clone(),
        command_id: origin.operation_id.to_owned(),
        input_id: origin.input_id.to_owned(),
        previous_id,
        output_id,
        acknowledged: false,
        checkpoint_id: origin.checkpoint_id.map(str::to_owned),
    };
    // Retain custody before publishing the intent. An early host death can leave
    // a staging directory, but can never move the checkout without this journal.
    let retained = transaction.keep();
    if let Err(error) = write_intent(&parent, &intent, true) {
        // No checkout rename has occurred. Only this freshly staged tree is ours.
        let _ = fs::remove_dir_all(retained);
        return Err(error);
    }
    Ok(Prepared { parent, intent })
}
impl Prepared {
    fn transaction(&self) -> PathBuf {
        self.parent.join(&self.intent.transaction)
    }
    pub(crate) fn commit(self) -> Result<Committed, String> {
        self.commit_at(|_| {})
    }
    fn commit_at(self, boundary: impl Fn(u8)) -> Result<Committed, String> {
        let previous = self.transaction().join("previous");
        rename(&self.intent.destination, &previous)?;
        boundary(1);
        if let Err(error) = rename(&self.transaction().join("staged"), &self.intent.destination) {
            // Rollback is useful in-process; the durable intent remains valid if
            // this rollback itself fails or the host dies during either rename.
            let _ = rename(&previous, &self.intent.destination);
            return Err(error);
        }
        boundary(2);
        Ok(Committed(self))
    }
}
fn check(current: &dyn Fn() -> bool) -> Result<(), String> {
    current()
        .then_some(())
        .ok_or_else(|| "Repository import recovery stopped.".into())
}
fn cleanup(prepared: &Prepared, limits: Limits, current: &dyn Fn() -> bool) -> Result<(), String> {
    let root = prepared.transaction();
    if present(&root)? {
        // Postorder, bounded and cancellable; never recurse through a link. The
        // acknowledged journal survives partial cleanup and is removed last.
        let mut stack = vec![(root.clone(), false)];
        let mut count = 0usize;
        while let Some((path, visited)) = stack.pop() {
            check(current)?;
            if !visited {
                count += 1;
                if count > limits.file_count.saturating_mul(4).saturating_add(16) {
                    return Err("Import cleanup exceeded its entry bound; files preserved.".into());
                }
            }
            files::strict_path(&path)?;
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "Cannot inspect import cleanup.")?;
            if metadata.is_dir() && !visited {
                stack.push((path.clone(), true));
                let mut children =
                    fs::read_dir(&path).map_err(|_| "Cannot inspect import cleanup.")?;
                loop {
                    check(current)?;
                    let Some(child) = children.next() else { break };
                    stack.push((
                        child.map_err(|_| "Cannot inspect import cleanup.")?.path(),
                        false,
                    ));
                    if count.saturating_add(stack.len())
                        > limits.file_count.saturating_mul(4).saturating_add(16)
                    {
                        return Err(
                            "Import cleanup exceeded its entry bound; files preserved.".into()
                        );
                    }
                }
            } else {
                if metadata.is_dir() {
                    fs::remove_dir(&path)
                } else {
                    fs::remove_file(&path)
                }
                .map_err(|_| "Import cleanup incomplete; acknowledgement retained.")?;
            }
        }
    }
    check(current)?;
    files::strict_path(&prepared.parent.join(JOURNAL))?;
    fs::remove_file(prepared.parent.join(JOURNAL))
        .map_err(|_| "Cannot finish import cleanup.".into())
}
impl Committed {
    /// Call only after the owning repository state has been durably persisted,
    /// outside the authority lock. Dropping this value never destroys recovery.
    pub fn acknowledge(mut self, limits: Limits, current: &dyn Fn() -> bool) -> Result<(), String> {
        check(current)?;
        self.0.intent.acknowledged = true;
        write_intent(&self.0.parent, &self.0.intent, false)?;
        cleanup(&self.0, limits, current)
    }
}
pub fn recover(
    destination: &Path,
    limits: Limits,
    scope: &str,
    current: impl Fn() -> bool,
    dispatch: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<Option<Recovery>, String> {
    let Some(prepared) = read_intent(destination, scope)? else {
        return Ok(None);
    };
    check(&current)?;
    if prepared.intent.acknowledged {
        cleanup(&prepared, limits, &current)?;
        return Ok(None);
    }
    let previous = prepared.transaction().join("previous");
    let staged = prepared.transaction().join("staged");
    let tree = |path: &Path| -> Result<Option<String>, String> {
        if present(path)? {
            files::tree_id_current(path, limits, &current).map(Some)
        } else {
            Ok(None)
        }
    };
    let old = tree(&previous)?;
    let new = tree(&staged)?;
    let target = tree(&prepared.intent.destination)?;
    let before = Some(prepared.intent.previous_id.clone());
    let after = Some(prepared.intent.output_id.clone());
    let restore = target.is_none() && old == before && new == after;
    let outcome = if restore || target == before && old.is_none() && new == after {
        "previous checkout retained; command import uncertain"
    } else if target == after && old == before && new.is_none() {
        "new checkout present; import acknowledgement uncertain"
    } else {
        return Err(
            "Import recovery paths or hashes changed; all files preserved for inspection.".into(),
        );
    };
    let recovery = Recovery {
        run_id: prepared.intent.run_id.clone(),
        binding: prepared.intent.binding.clone(),
        command_id: prepared.intent.command_id.clone(),
        previous_id: prepared.intent.previous_id.clone(),
        destination: prepared.intent.destination.clone(),
        input_id: prepared.intent.input_id.clone(),
        output_id: prepared.intent.output_id.clone(),
        outcome: outcome.into(),
        checkpoint_id: prepared.intent.checkpoint_id.clone(),
        previous: Some(if target == after && old == before && new.is_none() {
            previous.clone()
        } else {
            prepared.intent.destination.clone()
        }),
    };
    let receipt = prepared
        .parent
        .join(format!("native-import-recovery-{}.json", recovery.run_id));
    check(&current)?;
    dispatch(&mut || {
        // Dispatch performs final validation under the owning authority lock.
        // Calling its predicate here could re-enter that same lock.
        if restore {
            rename(&previous, &prepared.intent.destination)?;
        }
        if !present(&receipt)? {
            let mut file = tempfile::NamedTempFile::new_in(&prepared.parent)
                .map_err(|_| "Cannot retain uncertain import receipt.")?;
            serde_json::to_writer(&mut file, &recovery)
                .map_err(|_| "Cannot write import recovery receipt.")?;
            file.flush()
                .and_then(|_| file.as_file().sync_all())
                .map_err(|_| "Cannot persist import recovery receipt.")?;
            file.persist_noclobber(&receipt)
                .map_err(|_| "Cannot publish import recovery receipt.")?;
        } else {
            let saved: serde_json::Value =
                serde_json::from_slice(&files::read(&receipt, MAX_JOURNAL)?)
                    .map_err(|_| "Import recovery receipt changed.")?;
            // A restored checkout changes layout, but not its bound uncertainty.
            if saved["runId"] != recovery.run_id
                || saved["commandId"] != recovery.command_id
                || saved["binding"]
                    != serde_json::to_value(&recovery.binding)
                        .map_err(|_| "Invalid import binding.")?
                || saved["destination"]
                    != serde_json::to_value(&recovery.destination)
                        .map_err(|_| "Invalid import path.")?
                || saved["inputId"] != recovery.input_id
                || saved["previousId"] != recovery.previous_id
                || saved["outputId"] != recovery.output_id
                || saved["checkpointId"]
                    != serde_json::to_value(&recovery.checkpoint_id)
                        .map_err(|_| "Invalid checkpoint provenance.")?
            {
                return Err("Import recovery receipt identity changed.".into());
            }
        }
        Ok(())
    })?;
    Ok(Some(recovery))
}
/// Explicit reconciliation may acknowledge existing bytes after saving an
/// uncertain repository result. It never executes or imports the staged tree.
pub fn acknowledge_recovery(
    destination: &Path,
    limits: Limits,
    scope: &str,
    current: impl Fn() -> bool,
) -> Result<(), String> {
    if let Some(prepared) = read_intent(destination, scope)? {
        Committed(prepared).acknowledge(limits, &current)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    fn fixture(root: &Path) -> (PathBuf, PathBuf, Receipt) {
        let destination = root.join("checkout");
        let source = root.join("source");
        fs::create_dir_all(&destination).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(destination.join("data"), b"previous").unwrap();
        fs::write(source.join("data"), b"new").unwrap();
        let receipt = Receipt {
            run_id: "a".repeat(48),
            command_id: "b".repeat(64),
            input_id: "c".repeat(64),
            output_id: Some(files::tree_id(&source, Limits::ANALYSIS).unwrap()),
            binding: Binding {
                scope_id: "d".repeat(64),
                generation: 1,
                operation_id: 2,
            },
            ..Default::default()
        };
        (source, destination, receipt)
    }
    #[test]
    fn prepared_import_requires_acknowledgement_and_rejects_changed_identity() {
        let root = tempfile::tempdir().unwrap();
        let (source, destination, receipt) = fixture(root.path());
        assert!(prepare(&source, &destination, Limits::ANALYSIS, &receipt, &|| false).is_err());
        let prepared =
            prepare(&source, &destination, Limits::ANALYSIS, &receipt, &|| true).unwrap();
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"previous");
        assert!(recover(
            &destination,
            Limits::ANALYSIS,
            &"e".repeat(64),
            || true,
            |action| action()
        )
        .is_err());
        let transaction = prepared.transaction();
        let committed = prepared.commit().unwrap();
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"new");
        assert_eq!(
            fs::read(transaction.join("previous/data")).unwrap(),
            b"previous"
        );
        assert!(root.path().join(JOURNAL).exists());
        committed.acknowledge(Limits::ANALYSIS, &|| true).unwrap();
        assert!(!root.path().join(JOURNAL).exists());
        assert!(!transaction.exists());
    }
    #[test]
    fn recovery_predicate_is_never_reentered_inside_the_dispatch_fence() {
        let root = tempfile::tempdir().unwrap();
        let (source, destination, receipt) = fixture(root.path());
        drop(
            prepare(&source, &destination, Limits::ANALYSIS, &receipt, &|| true)
                .unwrap()
                .commit()
                .unwrap(),
        );
        let authority = std::sync::Mutex::new(());
        let recovered = recover(
            &destination,
            Limits::ANALYSIS,
            &receipt.binding.scope_id,
            || authority.try_lock().is_ok(),
            |action| {
                let _fence = authority.lock().unwrap();
                action()
            },
        )
        .unwrap();
        assert!(recovered.is_some());
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"new");
    }
    #[test]
    fn checkpoint_restore_rejects_stale_trees_and_has_distinct_transaction_provenance() {
        let root = tempfile::tempdir().unwrap();
        let (source, destination, receipt) = fixture(root.path());
        let before = files::tree_id(&destination, Limits::ANALYSIS).unwrap();
        let output = receipt.output_id.as_deref().unwrap();
        let checkpoint = "f".repeat(48);
        assert!(prepare_restore(
            &source,
            &destination,
            Limits::ANALYSIS,
            &checkpoint,
            &"0".repeat(64),
            output,
            receipt.binding.clone(),
            &|| true
        )
        .is_err());
        assert!(!root.path().join(JOURNAL).exists());
        assert!(prepare_restore(
            &source,
            &destination,
            Limits::ANALYSIS,
            &checkpoint,
            &before,
            output,
            receipt.binding.clone(),
            &|| false
        )
        .is_err());
        let prepared = prepare_restore(
            &source,
            &destination,
            Limits::ANALYSIS,
            &checkpoint,
            &before,
            output,
            receipt.binding.clone(),
            &|| true,
        )
        .unwrap();
        let first_id = prepared.intent.run_id.clone();
        assert_eq!(
            prepared.intent.checkpoint_id.as_deref(),
            Some(checkpoint.as_str())
        );
        drop(prepared); // Stop before commit: recovery must keep the current tree.
        let recovered = recover(
            &destination,
            Limits::ANALYSIS,
            &receipt.binding.scope_id,
            || true,
            |action| action(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            recovered.checkpoint_id.as_deref(),
            Some(checkpoint.as_str())
        );
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"previous");
        acknowledge_recovery(
            &destination,
            Limits::ANALYSIS,
            &receipt.binding.scope_id,
            || true,
        )
        .unwrap();
        let second = prepare_restore(
            &source,
            &destination,
            Limits::ANALYSIS,
            &checkpoint,
            &before,
            output,
            receipt.binding,
            &|| true,
        )
        .unwrap();
        assert_ne!(first_id, second.intent.run_id);
        second
            .commit()
            .unwrap()
            .acknowledge(Limits::ANALYSIS, &|| true)
            .unwrap();
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"new");
    }
    #[test]
    #[ignore = "Only invoked in a disposable import crash supervisor"]
    fn import_crash_probe() {
        let root = PathBuf::from(std::env::var_os("MIVLET_IMPORT_CRASH_ROOT").unwrap());
        let phase: u8 = std::env::var("MIVLET_IMPORT_CRASH_PHASE")
            .unwrap()
            .parse()
            .unwrap();
        let (source, destination, receipt) = fixture(&root);
        let prepared = if std::env::var("MIVLET_IMPORT_CRASH_CHECKPOINT").as_deref() == Ok("1") {
            prepare_restore(
                &source,
                &destination,
                Limits::ANALYSIS,
                &"f".repeat(48),
                &files::tree_id(&destination, Limits::ANALYSIS).unwrap(),
                receipt.output_id.as_deref().unwrap(),
                receipt.binding.clone(),
                &|| true,
            )
            .unwrap()
        } else {
            prepare(&source, &destination, Limits::ANALYSIS, &receipt, &|| true).unwrap()
        };
        prepared
            .commit_at(|boundary| {
                if boundary == phase {
                    fs::write(root.join("boundary-ready"), boundary.to_string()).unwrap();
                    std::thread::sleep(Duration::from_secs(60));
                }
            })
            .unwrap();
        panic!("Crash supervisor failed to terminate probe");
    }
    #[test]
    fn checkpoint_restore_refuses_edits_made_while_staging_before_publishing_intent() {
        let root = tempfile::tempdir().unwrap();
        let (source, destination, receipt) = fixture(root.path());
        let before = files::tree_id(&destination, Limits::ANALYSIS).unwrap();
        let changed = std::cell::Cell::new(false);
        let error = prepare_restore(
            &source,
            &destination,
            Limits::ANALYSIS,
            &"f".repeat(48),
            &before,
            receipt.output_id.as_deref().unwrap(),
            receipt.binding,
            &|| {
                let staged = fs::read_dir(root.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .any(|entry| entry.path().join("staged/data").exists());
                if staged && !changed.replace(true) {
                    fs::write(destination.join("data"), b"newer editor change").unwrap();
                }
                true
            },
        )
        .err()
        .expect("an edit during staging must refuse the restore");
        assert!(changed.get());
        assert!(error.contains("changed during restore preparation"));
        assert_eq!(
            fs::read(destination.join("data")).unwrap(),
            b"newer editor change"
        );
        assert!(!root.path().join(JOURNAL).exists());
    }
    #[test]
    fn abrupt_host_death_at_both_rename_boundaries_reconciles_without_replay() {
        for (phase, checkpoint) in [(1u8, false), (2, false), (1, true), (2, true)] {
            let root = tempfile::tempdir().unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "repository_import::tests::import_crash_probe",
                    "--nocapture",
                ])
                .env("MIVLET_IMPORT_CRASH_ROOT", root.path())
                .env("MIVLET_IMPORT_CRASH_PHASE", phase.to_string())
                .env(
                    "MIVLET_IMPORT_CRASH_CHECKPOINT",
                    if checkpoint { "1" } else { "0" },
                )
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            while !root.path().join("boundary-ready").exists() {
                if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("Import probe failed to reach rename boundary");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            child.kill().unwrap();
            child.wait().unwrap();
            let destination = root.path().join("checkout");
            assert_eq!(destination.exists(), phase == 2);
            let recovery = recover(
                &destination,
                Limits::ANALYSIS,
                &"d".repeat(64),
                || true,
                |action| action(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(recovery.binding.generation, 1);
            assert_eq!(recovery.checkpoint_id, checkpoint.then(|| "f".repeat(48)));
            let recovery_id = recovery.run_id.clone();
            assert_eq!(
                fs::read(destination.join("data")).unwrap(),
                if phase == 1 {
                    b"previous".as_slice()
                } else {
                    b"new".as_slice()
                }
            );
            assert_eq!(
                fs::read(recovery.previous.unwrap().join("data")).unwrap(),
                b"previous"
            );
            assert!(
                root.path().join(JOURNAL).exists(),
                "Uncertainty must survive inspection"
            );
            assert!(root
                .path()
                .join(format!("native-import-recovery-{recovery_id}.json"))
                .exists());
            // Restart inspection is idempotent. It never consumes staged bytes.
            assert!(recover(
                &destination,
                Limits::ANALYSIS,
                &"d".repeat(64),
                || true,
                |action| action()
            )
            .unwrap()
            .is_some());
            acknowledge_recovery(&destination, Limits::ANALYSIS, &"d".repeat(64), || true).unwrap();
            assert_eq!(
                fs::read(destination.join("data")).unwrap(),
                if phase == 1 {
                    b"previous".as_slice()
                } else {
                    b"new".as_slice()
                }
            );
            assert!(!root.path().join(JOURNAL).exists());
        }
    }
    #[test]
    fn changed_import_paths_hashes_and_partial_cleanup_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let (source, destination, receipt) = fixture(root.path());
        let prepared =
            prepare(&source, &destination, Limits::ANALYSIS, &receipt, &|| true).unwrap();
        fs::write(prepared.transaction().join("staged/data"), b"tampered").unwrap();
        assert!(recover(
            &destination,
            Limits::ANALYSIS,
            &receipt.binding.scope_id,
            || true,
            |action| action()
        )
        .is_err());
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"previous");
        fs::write(prepared.transaction().join("staged/data"), b"new").unwrap();
        let committed = prepared.commit().unwrap();
        let polls = std::cell::Cell::new(0);
        assert!(committed
            .acknowledge(Limits::ANALYSIS, &|| {
                polls.set(polls.get() + 1);
                polls.get() < 3
            })
            .is_err());
        assert!(root.path().join(JOURNAL).exists());
        assert!(recover(
            &destination,
            Limits::ANALYSIS,
            &receipt.binding.scope_id,
            || true,
            |action| action()
        )
        .unwrap()
        .is_none());
        assert_eq!(fs::read(destination.join("data")).unwrap(), b"new");
    }
}
