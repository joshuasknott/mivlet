use super::*;
use crate::local_computer::{
    authority::OperationTicket,
    coding::{execute_in, tests::fixture, Repository},
};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

fn capture(directory: &Path, repo: &Repository, ticket: &OperationTicket) -> String {
    let result = execute_in(
        directory,
        ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId":repo.id,"label":"Retained code"}),
    )
    .unwrap();
    serde_json::from_str::<serde_json::Value>(&result).unwrap()["checkpoint"]["id"]
        .as_str()
        .unwrap()
        .into()
}

// Include content, file length and last-write times of files AND directories.
// Reading must not create a home, retire data, rewrite state or reconcile gaps.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, (u64, std::time::SystemTime, Vec<u8>)> {
    let mut result = BTreeMap::new();
    let mut pending = vec![root.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).unwrap();
        let bytes = if metadata.is_file() {
            fs::read(&path).unwrap()
        } else {
            pending.extend(fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
            Vec::new()
        };
        result.insert(path, (metadata.len(), metadata.modified().unwrap(), bytes));
    }
    result
}

#[test]
fn empty_projection_never_creates_checkpoint_storage_or_authority() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let before = snapshot(temp.path());
    let scope =
        crate::local_computer::authority::execution_scope_id(&temp.path().join("authority"));
    assert_eq!(scope, ticket.execution_binding().scope_id);
    // Pure derivation for an uninitialized owner cannot persist new authority.
    let missing = temp.path().join("not-initialized");
    assert_eq!(
        crate::local_computer::authority::execution_scope_id(&missing).len(),
        64
    );
    assert!(!missing.exists());
    let view = inspect(
        &directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || ticket.check().is_ok(),
    )
    .unwrap();
    assert_eq!(view.saved_count, 0);
    assert_eq!(view.saved_bytes, 0);
    assert!(!view.requires_retention());
    assert!(!directory.join(&repo.id).join("checkpoints").exists());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn retained_copy_projection_uses_canonical_scope_count_and_actual_bytes() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &repo, &ticket);
    let home = directory.join(&repo.id).join("checkpoints");
    let manifest = storage::load(&home, &checkpoint, &repo, &ticket).unwrap();
    // Account inventory includes copies that are no longer selected. It must
    // not load/rewrite the selected repository or require an action ticket for
    // this other copy's current owner just to read its retained data.
    fs::remove_file(directory.join("repository.json")).unwrap();
    let before = snapshot(temp.path());
    let view = inspect(&directory, &repo.id, &manifest.scope_id, || {
        ticket.check().is_ok()
    })
    .unwrap();
    assert_eq!(view.repository_id, repo.id);
    assert_eq!(view.execution_scope_id, manifest.scope_id);
    assert_eq!(view.saved_count, 1);
    assert_eq!(view.saved_bytes, manifest.checkpoint.bytes);
    assert!(view.requires_retention());
    assert!(view.recovery.is_empty());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn pending_deletion_and_missing_checkout_are_reported_without_recovery() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &repo, &ticket);
    let copy = directory.join(&repo.id);
    fs::rename(
        copy.join("checkpoints").join(checkpoint),
        copy.join("checkpoint-deleting"),
    )
    .unwrap();
    fs::create_dir(copy.join("CHECKPOINT-PENDING")).unwrap();
    fs::write(
        copy.join("CHECKPOINT-PENDING/partial"),
        b"incomplete capture",
    )
    .unwrap();
    fs::create_dir(copy.join("checkpoint-restore-staging")).unwrap();
    fs::create_dir(copy.join("checkpoint-diff")).unwrap();
    fs::rename(copy.join("checkout"), copy.join("native-import-gap")).unwrap();
    // Malformed import evidence stays explicitly unknown; no second parser or
    // automatic reconciliation may manufacture a clean retention result.
    fs::write(copy.join("NATIVE-IMPORT.json"), b"malformed import").unwrap();
    let before = snapshot(temp.path());
    let view = inspect(
        &directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || true,
    )
    .unwrap();
    assert_eq!(view.saved_count, 0);
    assert!(view.requires_retention());
    for reason in [
        Recovery::DeletionPending,
        Recovery::CapturePending,
        Recovery::RestoreStaging,
        Recovery::DiffStaging,
        Recovery::CheckoutMissing,
        Recovery::ImportUnknown,
    ] {
        assert!(view.recovery.contains(&reason), "{view:?}");
    }
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn zero_byte_saved_checkpoint_still_requires_retention() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = directory.join(&repo.id).join("checkout");
    fs::remove_file(root.join("sum.js")).unwrap();
    fs::remove_file(root.join("test.js")).unwrap();
    capture(&directory, &repo, &ticket);
    let before = snapshot(temp.path());
    let view = inspect(
        &directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || true,
    )
    .unwrap();
    assert_eq!(view.saved_bytes, 0);
    assert_eq!(view.saved_count, 1);
    assert!(view.requires_retention());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn malformed_foreign_or_unknown_checkpoint_metadata_never_becomes_empty() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let scope = ticket.execution_binding().scope_id;
    let checkpoint = capture(&directory, &repo, &ticket);
    let copy = directory.join(&repo.id);
    let path = copy
        .join("checkpoints")
        .join(&checkpoint)
        .join("manifest.json");
    let original = fs::read(&path).unwrap();
    let valid: serde_json::Value = serde_json::from_slice(&original).unwrap();
    for corrupt in [
        json!({"unknown":true}),
        {
            let mut value = valid.clone();
            value["scopeId"] = json!("f".repeat(64));
            value
        },
        {
            let mut value = valid.clone();
            value["checkpoint"]["repositoryId"] = json!("f".repeat(48));
            value
        },
        {
            let mut value = valid.clone();
            value["checkpoint"]["fileCount"] = json!(0);
            value
        },
        {
            let mut value = valid.clone();
            value["checkpoint"]["bytes"] = json!(u64::MAX);
            value
        },
        {
            let mut value = valid.clone();
            value["checkpoint"]["generation"] = json!(0);
            value
        },
        {
            let mut value = valid.clone();
            value["checkpoint"]["createdAt"] = json!("unknown");
            value
        },
        {
            let mut value = valid.clone();
            value["futureField"] = json!(true);
            value
        },
    ] {
        fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        let before = snapshot(temp.path());
        assert!(inspect(&directory, &repo.id, &scope, || true).is_err());
        assert_eq!(snapshot(temp.path()), before);
    }
    fs::write(&path, &original).unwrap();
    assert!(inspect(&directory, &repo.id, &"e".repeat(64), || true).is_err());
    assert!(inspect(&directory, "../escape", &scope, || true).is_err());
    assert!(inspect(&directory, &repo.id, "unknown", || true).is_err());
    fs::write(copy.join("checkpoint-future.json"), b"unknown").unwrap();
    let before = snapshot(temp.path());
    assert!(inspect(&directory, &repo.id, &scope, || true).is_err());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn corrupt_tree_forged_size_and_undeclared_contents_fail_closed() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &repo, &ticket);
    let saved = directory
        .join(&repo.id)
        .join("checkpoints")
        .join(checkpoint);
    let scope = ticket.execution_binding().scope_id;
    let manifest_path = saved.join("manifest.json");
    let original = fs::read(&manifest_path).unwrap();
    let mut manifest: storage::Manifest = serde_json::from_slice(&original).unwrap();
    manifest.files.get_mut("sum.js").unwrap().bytes += 1;
    manifest.checkpoint.bytes += 1;
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let before = snapshot(temp.path());
    assert!(inspect(&directory, &repo.id, &scope, || true)
        .unwrap_err()
        .contains("size changed"));
    assert_eq!(snapshot(temp.path()), before);
    fs::write(&manifest_path, original).unwrap();
    fs::write(saved.join("unexpected"), b"retain").unwrap();
    assert!(inspect(&directory, &repo.id, &scope, || true)
        .unwrap_err()
        .contains("Unknown"));
    fs::remove_file(saved.join("unexpected")).unwrap();
    fs::write(saved.join("tree/sum.js"), b"corrupt").unwrap();
    let before = snapshot(temp.path());
    assert!(inspect(&directory, &repo.id, &scope, || true).is_err());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
fn cancellation_and_count_bound_preserve_all_checkpoint_data() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &repo, &ticket);
    let scope = ticket.execution_binding().scope_id;
    let before = snapshot(temp.path());
    let reads = std::cell::Cell::new(0);
    assert!(inspect(&directory, &repo.id, &scope, || {
        reads.set(reads.get() + 1);
        reads.get() < 10
    })
    .is_err());
    assert!(reads.get() >= 10);
    assert_eq!(snapshot(temp.path()), before);
    let home = directory.join(&repo.id).join("checkpoints");
    let saved = storage::load(&home, &checkpoint, &repo, &ticket).unwrap();
    for index in 1..=storage::MAX_CHECKPOINTS {
        let mut manifest = saved.clone();
        manifest.checkpoint.id = format!("{index:048x}");
        let target = home.join(&manifest.checkpoint.id);
        fs::create_dir_all(target.join("tree")).unwrap();
        for path in manifest.files.keys() {
            fs::copy(
                home.join(&checkpoint).join("tree").join(path),
                target.join("tree").join(path),
            )
            .unwrap();
        }
        fs::write(
            target.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }
    let before = snapshot(temp.path());
    assert!(inspect(&directory, &repo.id, &scope, || true)
        .unwrap_err()
        .contains("count exceeds"));
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
#[cfg(windows)]
fn manifest_hardlink_cannot_be_used_as_retention_evidence() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &repo, &ticket);
    let path = directory
        .join(&repo.id)
        .join("checkpoints")
        .join(checkpoint)
        .join("manifest.json");
    fs::hard_link(&path, temp.path().join("alias.json")).unwrap();
    let before = snapshot(temp.path());
    assert!(inspect(
        &directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || true
    )
    .is_err());
    assert_eq!(snapshot(temp.path()), before);
}

#[test]
#[cfg(windows)]
fn checkpoint_home_junction_is_rejected_without_touching_its_target() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), b"preserve").unwrap();
    let before = snapshot(&outside);
    let home = directory.join(&repo.id).join("checkpoints");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&home)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(inspect(
        &directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || true
    )
    .is_err());
    assert_eq!(snapshot(&outside), before);
    // Remove only the junction; never recursively delete its target.
    fs::remove_dir(home).unwrap();
}
