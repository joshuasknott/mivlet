use super::super::{execute_in, tests::fixture};
use super::*;

fn call(directory: &Path, ticket: &OperationTicket, tool: &str, args: Value) -> Value {
    serde_json::from_str(&execute_in(directory, ticket, tool, args).unwrap()).unwrap()
}
fn capture(directory: &Path, ticket: &OperationTicket, repo: &Repository) -> Value {
    call(
        directory,
        ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId": repo.id, "label": "Working version"}),
    )["checkpoint"]
        .clone()
}
fn preview(
    directory: &Path,
    ticket: &OperationTicket,
    repo: &Repository,
    checkpoint: &Value,
) -> Value {
    call(
        directory,
        ticket,
        "repository-checkpoint-preview",
        json!({"repositoryId": repo.id, "checkpointId": checkpoint["id"]}),
    )
}
fn restore_args(repo: &Repository, review: &Value) -> Value {
    json!({"repositoryId": repo.id, "checkpointId": review["checkpoint"]["id"], "expectedTree": review["currentTreeId"], "expectedCheckpointTree": review["checkpoint"]["treeId"], "expectedOutput": review["outputTreeId"], "expectedHead": review["head"]})
}

#[test]
fn checkpoint_restores_actual_new_modified_deleted_files_and_retains_undo() {
    let (temp, directory, authority, mut repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    fs::write(root.join(".gitignore"), "cache/\n").unwrap();
    fs::create_dir(root.join("cache")).unwrap();
    fs::write(root.join("cache/keep.txt"), "ignored").unwrap();
    fs::write(root.join(".env"), "private-value").unwrap();
    fs::write(root.join(" new file.txt"), "new checkpoint file\n").unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    assert_eq!(checkpoint["fileCount"], 4);
    assert_eq!(checkpoint["requestId"], "checkpoint-test-request");
    let stored = storage::home(&directory, &repo)
        .unwrap()
        .join(checkpoint["id"].as_str().unwrap())
        .join("tree");
    assert!(!stored.join(".env").exists());
    assert!(!stored.join("cache").exists());
    fs::write(root.join("sum.js"), "changed\n").unwrap();
    fs::remove_file(root.join(" new file.txt")).unwrap();
    fs::write(root.join("later.txt"), "later\n").unwrap();
    fs::write(root.join(".env"), "keep latest private value").unwrap();
    repo.command_diff_id = Some("old-verification".into());
    save(&directory, &repo).unwrap();
    let review = preview(&directory, &ticket, &repo, &checkpoint);
    assert!(review["diff"].as_str().unwrap().contains("-changed"));
    assert!(review["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["path"] == "later.txt" && f["status"] == "deleted"));
    let result = call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review),
    );
    assert_eq!(result["verificationInvalidated"], true);
    assert!(!root.join("later.txt").exists());
    assert!(root.join(" new file.txt").exists());
    assert_eq!(
        fs::read_to_string(root.join(".env")).unwrap(),
        "keep latest private value"
    );
    assert_eq!(
        fs::read_to_string(root.join("cache/keep.txt")).unwrap(),
        "ignored"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("source/unrelated.txt")).unwrap(),
        "preserve me"
    );
    assert!(fs::read_to_string(temp.path().join("source/sum.js"))
        .unwrap()
        .contains("Uncommitted source edit"));
    assert!(super::super::load(&directory)
        .unwrap()
        .unwrap()
        .command_diff_id
        .is_none());
    assert_eq!(
        git::run(&directory, &repo, &["rev-parse", "HEAD"], &ticket).unwrap(),
        checkpoint["head"].as_str().unwrap()
    );
    let undo = preview(&directory, &ticket, &repo, &result["beforeRestore"]);
    call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &undo),
    );
    assert_eq!(
        fs::read_to_string(root.join("sum.js")).unwrap(),
        "changed\n"
    );
    assert!(root.join("later.txt").exists());
}

#[test]
fn checkpoint_drift_corruption_and_foreign_identity_fail_without_writes() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    let review = preview(&directory, &ticket, &repo, &checkpoint);
    fs::write(root.join("sum.js"), "newer edit").unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review)
    )
    .unwrap_err()
    .contains("changed after review"));
    assert_eq!(
        fs::read_to_string(root.join("sum.js")).unwrap(),
        "newer edit"
    );
    let mut wrong = restore_args(&repo, &review);
    wrong["repositoryId"] = json!("other");
    assert!(execute_in(&directory, &ticket, "repository-checkpoint-restore", wrong).is_err());
    let stored = storage::home(&directory, &repo)
        .unwrap()
        .join(checkpoint["id"].as_str().unwrap())
        .join("tree/sum.js");
    fs::write(stored, "corrupted").unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-preview",
        json!({"repositoryId":repo.id, "checkpointId":checkpoint["id"]})
    )
    .unwrap_err()
    .contains("Checkpoint files changed"));
    assert_eq!(
        fs::read_to_string(root.join("sum.js")).unwrap(),
        "newer edit"
    );
}

#[test]
fn checkpoint_restart_provenance_stop_and_os_lease() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    let review = preview(&directory, &ticket, &repo, &checkpoint);
    let lease = files::lease(&directory).unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId":repo.id,"label":"blocked"})
    )
    .is_err());
    drop(lease);
    authority.revoke(1).unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review)
    )
    .is_err());
    drop(ticket);
    drop(authority);
    let restarted =
        super::super::super::authority::ComputerAuthority::load(&temp.path().join("authority"))
            .unwrap();
    let ticket = restarted
        .begin_agent(restarted.snapshot().unwrap().generation)
        .unwrap();
    let listed = call(
        &directory,
        &ticket,
        "repository-checkpoint-list",
        json!({"repositoryId":repo.id}),
    );
    assert_eq!(listed["checkpoints"][0], checkpoint);
    assert_eq!(
        preview(&directory, &ticket, &repo, &checkpoint)["checkpoint"],
        checkpoint
    );
}

#[test]
fn checkpoint_credential_paths_aliases_bounds_and_delete() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    for name in [
        ".env",
        ".env.local",
        "SECRET.KEY",
        ".npmrc",
        "id_rsa",
        "cert.pfx",
    ] {
        fs::write(root.join(name), "must not snapshot").unwrap();
    }
    let checkpoint = capture(&directory, &ticket, &repo);
    assert_eq!(checkpoint["fileCount"], 2);
    fs::hard_link(root.join("sum.js"), root.join("alias.js")).unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId":repo.id,"label":"alias"})
    )
    .is_err());
    fs::remove_file(root.join("alias.js")).unwrap();
    let huge = fs::File::create(root.join("huge.bin")).unwrap();
    huge.set_len(storage::LIMITS.file_bytes + 1).unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId":repo.id,"label":"oversized"})
    )
    .is_err());
    drop(huge);
    fs::remove_file(root.join("huge.bin")).unwrap();
    call(
        &directory,
        &ticket,
        "repository-checkpoint-delete",
        json!({"repositoryId":repo.id,"checkpointId":checkpoint["id"],"expectedCheckpointTree":checkpoint["treeId"]}),
    );
    assert!(storage::list(&directory, &repo, &ticket)
        .unwrap()
        .is_empty());
    assert!(root.join("sum.js").exists());
}

#[test]
fn checkpoint_ignored_conflicts_and_foreign_scope_fail_closed() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    fs::write(root.join("generated.txt"), "original checkpoint content").unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    fs::write(root.join(".gitignore"), "generated.txt\n").unwrap();
    fs::write(root.join("generated.txt"), "new ignored content").unwrap();
    let args = json!({"repositoryId": repo.id, "checkpointId": checkpoint["id"]});
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-preview",
        args.clone()
    )
    .unwrap_err()
    .contains("currently ignored file"));
    assert_eq!(
        fs::read_to_string(root.join("generated.txt")).unwrap(),
        "new ignored content"
    );
    let foreign = super::super::super::authority::ComputerAuthority::load(
        &temp.path().join("foreign-authority"),
    )
    .unwrap();
    let foreign_ticket = foreign.begin_agent(1).unwrap();
    assert!(execute_in(
        &directory,
        &foreign_ticket,
        "repository-checkpoint-preview",
        args
    )
    .unwrap_err()
    .contains("scope, identity or manifest changed"));
    assert_eq!(
        fs::read_to_string(root.join("generated.txt")).unwrap(),
        "new ignored content"
    );
}

#[test]
fn checkpoint_capacity_preserves_current_files_and_restart_finishes_retired_cleanup() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    let home = storage::home(&directory, &repo).unwrap();
    let manifest =
        storage::load(&home, checkpoint["id"].as_str().unwrap(), &repo, &ticket).unwrap();
    // Simulate persisted bounded metadata without writing hundreds of MiB.
    // The count gate must refuse before creating staging or replacing files.
    for index in 1..storage::MAX_CHECKPOINTS {
        let mut saved = manifest.clone();
        saved.checkpoint.id = format!("{index:048x}");
        storage::write_new(
            &home.join(&saved.checkpoint.id).join("manifest.json"),
            &serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
    }
    fs::write(root.join("sum.js"), "keep newest code").unwrap();
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-checkpoint-capture",
        json!({"repositoryId": repo.id, "label": "over capacity"})
    )
    .unwrap_err()
    .contains("24 checkpoints"));
    assert_eq!(
        fs::read_to_string(root.join("sum.js")).unwrap(),
        "keep newest code"
    );
    let retired = storage::storage(&directory, &repo)
        .unwrap()
        .join("checkpoint-deleting");
    fs::rename(home.join(checkpoint["id"].as_str().unwrap()), &retired).unwrap();
    assert_eq!(
        storage::list(&directory, &repo, &ticket).unwrap().len(),
        storage::MAX_CHECKPOINTS - 1
    );
    assert!(!retired.exists());
    assert_eq!(
        fs::read_to_string(root.join("sum.js")).unwrap(),
        "keep newest code"
    );
}

#[test]
fn checkpoint_restores_file_directory_replacements_in_both_directions() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    let file_state = capture(&directory, &ticket, &repo);
    fs::remove_file(root.join("sum.js")).unwrap();
    fs::create_dir(root.join("sum.js")).unwrap();
    fs::write(root.join("sum.js/index.js"), "directory version").unwrap();
    let directory_state = capture(&directory, &ticket, &repo);
    let review = preview(&directory, &ticket, &repo, &file_state);
    call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review),
    );
    assert!(root.join("sum.js").is_file());
    let review = preview(&directory, &ticket, &repo, &directory_state);
    call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review),
    );
    assert_eq!(
        fs::read_to_string(root.join("sum.js/index.js")).unwrap(),
        "directory version"
    );
}

#[test]
#[cfg(windows)]
#[ignore = "Requires pinned Windows native executor/runtime; disposable service acceptance, no GUI or provider"]
fn native_checkpoint_restore_acceptance() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let checkpoint = capture(&directory, &ticket, &repo);
    let source = fs::read(temp.path().join("source/sum.js")).unwrap();
    let run = |command: &str| {
        call(
            &directory,
            &ticket,
            "repository-run",
            json!({
                "repositoryId":repo.id, "command":command, "network":false,"timeoutSeconds":30
            }),
        )
    };
    // Real pinned executor output is imported before checkpoint restoration.
    // Direct in-process Node avoids the separately diagnosed pipe-spawn issue.
    let changed = run(
        "node -e \"require('fs').writeFileSync('sum.js','module.exports = (a, b) => a + b;\\n')\"",
    );
    assert_eq!(changed["exitCode"], 0, "{changed}");
    let verified = run("node test.js");
    assert_eq!(verified["exitCode"], 0, "{verified}");
    assert!(super::super::load(&directory)
        .unwrap()
        .unwrap()
        .command_diff_id
        .is_some());
    let review = preview(&directory, &ticket, &repo, &checkpoint);
    let restored = call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &review),
    );
    assert_eq!(restored["verificationInvalidated"], true);
    assert!(super::super::load(&directory)
        .unwrap()
        .unwrap()
        .command_diff_id
        .is_none());
    assert_eq!(
        git::run(&directory, &repo, &["rev-parse", "HEAD"], &ticket).unwrap(),
        checkpoint["head"]
    );
    let restored_test = run("node test.js");
    assert_ne!(restored_test["exitCode"], 0, "{restored_test}");
    assert!(restored_test["output"]
        .as_str()
        .unwrap()
        .contains("AssertionError"));
    let undo = preview(&directory, &ticket, &repo, &restored["beforeRestore"]);
    call(
        &directory,
        &ticket,
        "repository-checkpoint-restore",
        restore_args(&repo, &undo),
    );
    let passed_again = run("node test.js");
    assert_eq!(passed_again["exitCode"], 0, "{passed_again}");
    assert_eq!(fs::read(temp.path().join("source/sum.js")).unwrap(), source);
    assert_eq!(
        fs::read(temp.path().join("source/unrelated.txt")).unwrap(),
        b"preserve me"
    );
}
