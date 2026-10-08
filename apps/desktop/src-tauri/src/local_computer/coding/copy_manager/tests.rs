use super::super::process;
use super::*;
use crate::local_computer::authority::ComputerAuthority;

fn fixture() -> (
    tempfile::TempDir,
    PathBuf,
    Arc<ComputerAuthority>,
    Repository,
    Owner,
    CopyScope,
) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let directory = temp.path().join("managed");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&directory).unwrap();
    let directory = crate::paths::strict_canonicalize(&directory).unwrap();
    let authority = ComputerAuthority::load(&temp.path().join("authority")).unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    fs::write(source.join("file.txt"), b"original").unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Test"],
        vec!["config", "user.email", "test@example.invalid"],
        vec!["add", "."],
        vec!["commit", "-m", "initial"],
    ] {
        let mut command = process::command("git", &source).unwrap();
        command.args(args);
        process::checked(command, &ticket).unwrap();
    }
    let repo = git::attach(&directory, &source, &ticket).unwrap();
    let owner = Owner {
        account: "account-test".into(),
        workspace: "workspace-test".into(),
        agent: "agent-test".into(),
        source: None,
    };
    register_owner(
        &directory,
        &repo,
        &owner,
        Some(crate::paths::strict_canonicalize(&source).unwrap()),
    )
    .unwrap();
    save(&directory, &repo).unwrap();
    let target = CopyScope {
        workspace_id: owner.workspace.clone(),
        agent_id: owner.agent.clone(),
        expected_generation: 1,
    };
    (temp, directory, authority, repo, owner, target)
}
fn action(target: &CopyScope, preview: CleanupPreview) -> CopyAction {
    CopyAction {
        target: target.clone(),
        repository_id: preview.copy.id,
        preview_token: preview.preview_token,
    }
}

#[test]
fn retained_inventory_disk_accounting_selection_and_disposable_cleanup() {
    let (temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let other = git::attach(&directory, &temp.path().join("source"), &ticket).unwrap();
    register_owner(&directory, &other, &owner, None).unwrap();
    save(&directory, &other).unwrap();
    let inventory = inventory(&directory, &owner, &Evidence::default(), &ticket).unwrap();
    assert_eq!(inventory.copies.len(), 2);
    let entry = inventory
        .copies
        .iter()
        .find(|entry| entry.id == repo.id)
        .unwrap();
    assert!(!entry.selected);
    assert_eq!(entry.dirty, Some(false));
    assert!(entry.size_bytes.unwrap() > 8);
    assert!(entry.blockers.is_empty(), "{:?}", entry.blockers);
    select(&directory, &repo.id, &owner, &Evidence::default(), &ticket).unwrap();
    assert_eq!(load(&directory).unwrap().unwrap().id, repo.id);
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = action(&target, preview);
    delete(&directory, &owner, &action, &Evidence::default(), &ticket).unwrap();
    assert!(!directory.join(&repo.id).exists());
    assert!(load(&directory).unwrap().is_none());
    assert!(
        delete(&directory, &owner, &action, &Evidence::default(), &ticket)
            .unwrap_err()
            .contains("consumed")
    );
    assert_eq!(
        fs::read(temp.path().join("source/file.txt")).unwrap(),
        b"original"
    );
    assert!(temp.path().join("source/.git").exists());
    assert!(directory.join(&other.id).exists());
}

#[test]
fn hidden_untracked_and_ignored_files_are_protected() {
    let (_temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    git::run(
        &directory,
        &repo,
        &["config", "status.showUntrackedFiles", "no"],
        &ticket,
    )
    .unwrap();
    let root = directory.join(&repo.id).join("checkout");
    fs::write(root.join("notes.txt"), b"keep").unwrap();
    let result = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    assert!(result.preview_token.is_none());
    assert_eq!(result.copy.dirty, Some(true));
    fs::remove_file(root.join("notes.txt")).unwrap();
    fs::write(
        directory.join(&repo.id).join("git/info/exclude"),
        b"notes.txt\n",
    )
    .unwrap();
    fs::write(root.join("notes.txt"), b"ignored but valuable").unwrap();
    let result = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    assert!(result.preview_token.is_none());
    assert_eq!(result.copy.dirty, Some(true));
    assert!(root.join("notes.txt").exists());
}

#[test]
fn preview_is_bound_to_bytes_generation_account_and_single_use() {
    let (_temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = action(&target, preview);
    fs::write(
        directory.join(&repo.id).join("checkout/new.txt"),
        b"new work",
    )
    .unwrap();
    assert!(
        delete(&directory, &owner, &action, &Evidence::default(), &ticket)
            .unwrap_err()
            .contains("changed")
    );
    assert!(directory.join(&repo.id).exists());
    fs::remove_file(directory.join(&repo.id).join("checkout/new.txt")).unwrap();
    let preview = super::preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let mut action = self::action(&target, preview);
    action.target.expected_generation += 1;
    assert!(delete(&directory, &owner, &action, &Evidence::default(), &ticket).is_err());
    let preview = super::preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = self::action(&target, preview);
    let wrong = Owner {
        account: "other-account".into(),
        ..owner.clone()
    };
    assert!(delete(&directory, &wrong, &action, &Evidence::default(), &ticket).is_err());
    assert!(directory.join(&repo.id).exists());
}

#[test]
fn active_work_lock_recovery_checkpoint_and_unknown_ownership_fail_closed() {
    let (_temp, directory, authority, mut repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let active = Evidence {
        unresolved: true,
        ..Default::default()
    };
    assert!(
        preview(&directory, &repo.id, &owner, &target, &active, &ticket)
            .unwrap()
            .preview_token
            .is_none()
    );
    assert!(select(&directory, &repo.id, &owner, &active, &ticket).is_err());
    let mutex = lock(&directory).unwrap();
    let guard = mutex.lock().unwrap();
    assert!(
        inventory(&directory, &owner, &Evidence::default(), &ticket)
            .unwrap()
            .busy
    );
    assert!(preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket
    )
    .is_err());
    drop(guard);
    fs::write(
        directory.join(&repo.id).join("checkpoint.json"),
        b"checkpoint in use",
    )
    .unwrap();
    assert!(preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket
    )
    .unwrap()
    .preview_token
    .is_none());
    fs::remove_file(directory.join(&repo.id).join("checkpoint.json")).unwrap();
    repo.operation = "publication outcome uncertain".into();
    save(&directory, &repo).unwrap();
    assert!(preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket
    )
    .unwrap()
    .preview_token
    .is_none());
    let unknown_id = "a".repeat(48);
    fs::create_dir(directory.join(&unknown_id)).unwrap();
    let inventory = inventory(&directory, &owner, &Evidence::default(), &ticket).unwrap();
    assert!(!inventory
        .copies
        .iter()
        .find(|copy| copy.id == unknown_id)
        .unwrap()
        .blockers
        .is_empty());
    assert!(select(
        &directory,
        &unknown_id,
        &owner,
        &Evidence::default(),
        &ticket
    )
    .is_err());
}

#[test]
fn interrupted_cleanup_survives_restart_and_requires_fresh_preview() {
    let (temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    write_json(
        &directory.join(format!("cleanup-{}.json", repo.id)),
        &CleanupIntent {
            owner: owner.clone(),
            repository: repo.clone(),
        },
    )
    .unwrap();
    let tombstone = directory.join(format!("deleting-{}", repo.id));
    fs::rename(directory.join(&repo.id), &tombstone).unwrap();
    fs::remove_file(tombstone.join("repository.json")).unwrap();
    fs::remove_file(tombstone.join("ownership.json")).unwrap();
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    assert!(preview.copy.cleanup_pending);
    assert!(
        preview.preview_token.is_some(),
        "{:?}",
        preview.copy.blockers
    );
    let action = action(&target, preview);
    delete(&directory, &owner, &action, &Evidence::default(), &ticket).unwrap();
    assert!(!tombstone.exists());
    assert!(load(&directory).unwrap().is_none());
    assert!(temp.path().join("source/file.txt").exists());
}

#[test]
fn conflicting_retained_and_cleanup_paths_preserve_both_copies() {
    let (_temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let tombstone = directory.join(format!("deleting-{}", repo.id));
    fs::create_dir(&tombstone).unwrap();
    fs::write(tombstone.join("valuable.txt"), b"retain").unwrap();
    let result = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    assert!(result.preview_token.is_none());
    assert!(result
        .copy
        .blockers
        .iter()
        .any(|reason| reason.contains("Conflicting")));
    assert!(directory.join(&repo.id).join("checkout/file.txt").exists());
    assert_eq!(fs::read(tombstone.join("valuable.txt")).unwrap(), b"retain");
}

#[test]
fn expired_preview_and_stop_are_rejected_without_deletion() {
    let (_temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = action(&target, preview);
    permits()
        .lock()
        .unwrap()
        .get_mut(action.preview_token.as_ref().unwrap())
        .unwrap()
        .created = Instant::now() - PREVIEW_LIFETIME;
    assert!(delete(&directory, &owner, &action, &Evidence::default(), &ticket).is_err());
    let preview = super::preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = self::action(&target, preview);
    // Stop changes generation and fences the admitted ticket immediately.
    authority.revoke(1).unwrap();
    assert!(delete(&directory, &owner, &action, &Evidence::default(), &ticket).is_err());
    assert!(directory.join(&repo.id).exists());
}

#[test]
fn work_or_repository_activity_after_preview_consumes_authority_without_deleting() {
    let (_temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = action(&target, preview);
    let mutex = lock(&directory).unwrap();
    let guard = mutex.lock().unwrap();
    assert!(delete(&directory, &owner, &action, &Evidence::default(), &ticket).is_err());
    drop(guard);
    assert!(delete(&directory, &owner, &action, &Evidence::default(), &ticket).is_err());
    let preview = super::preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    let action = self::action(&target, preview);
    let evidence = Evidence {
        jobs: vec![LinkedJob {
            id: "native-run".into(),
            status: "streaming".into(),
        }],
        ..Default::default()
    };
    assert!(delete(&directory, &owner, &action, &evidence, &ticket).is_err());
    assert!(directory.join(&repo.id).exists());
    assert!(select(&directory, &repo.id, &owner, &evidence, &ticket).is_err());
}

#[test]
fn canonical_encrypted_execution_records_protect_active_and_recoverable_jobs() {
    use crate::store::{
        repos::{execution_attempt, scope::DataScope},
        vault::{MasterKey, Vault},
        Store,
    };
    let store =
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
    store
        .with_conn(|conn| {
            for (id, status, recoverable) in [
                ("live", "streaming", true),
                ("recover", "interrupted", true),
                ("settled", "interrupted", false),
                ("done", "completed", false),
            ] {
                execution_attempt::upsert(
                    conn,
                    &store,
                    id,
                    None,
                    "provider",
                    "model",
                    status,
                    1,
                    recoverable,
                    0,
                    "t",
                    "t",
                    &serde_json::json!({}),
                )?;
            }
            let evidence = execution_evidence(conn, &store, &DataScope::legacy_default())?;
            let mut ids: Vec<_> = evidence.into_iter().map(|item| item.id).collect();
            ids.sort();
            assert_eq!(ids, ["live", "recover"]);
            Ok(())
        })
        .unwrap();
}

#[cfg(windows)]
#[test]
fn windows_junctions_are_protected_and_long_paths_are_accounted() {
    let (temp, directory, authority, repo, owner, target) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = directory.join(&repo.id).join("checkout");
    let long = root.join("deep".repeat(30)).join("nested".repeat(25));
    fs::create_dir_all(&long).unwrap();
    fs::write(long.join("value.txt"), b"long path").unwrap();
    assert!(scan(&directory.join(&repo.id), &ticket).unwrap().0 > 9);
    let link = root.join("junction");
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(temp.path().join("source"))
        .status()
        .unwrap();
    assert!(status.success());
    let preview = preview(
        &directory,
        &repo.id,
        &owner,
        &target,
        &Evidence::default(),
        &ticket,
    )
    .unwrap();
    assert!(preview.preview_token.is_none());
    assert!(scan(&directory.join(&repo.id), &ticket).is_err());
    fs::remove_dir(&link).unwrap(); // remove the junction itself, never its target
    assert_eq!(
        fs::read(temp.path().join("source/file.txt")).unwrap(),
        b"original"
    );
}
