use super::super::authority::ComputerAuthority;
use super::*;

fn fixture() -> (
    tempfile::TempDir,
    PathBuf,
    Arc<ComputerAuthority>,
    Repository,
) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let directory = temp.path().join("managed");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&directory).unwrap();
    let authority = ComputerAuthority::load(&temp.path().join("authority")).unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
    ] {
        let mut command = process::command("git", &source).unwrap();
        command.args(args);
        process::checked(command, &ticket).unwrap();
    }
    fs::write(source.join("sum.js"), "module.exports = (a, b) => a - b;\n").unwrap();
    fs::write(source.join("test.js"), "require('node:assert/strict').equal(require('./sum')(2, 3), 5); console.log('sum test passed');\n").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-m", "initial"]] {
        let mut command = process::command("git", &source).unwrap();
        command.args(args);
        process::checked(command, &ticket).unwrap();
    }
    fs::write(source.join("unrelated.txt"), "preserve me").unwrap();
    fs::write(
        source.join("sum.js"),
        "module.exports = (a, b) => a - b;\n// Uncommitted source edit\n",
    )
    .unwrap();
    fs::write(source.join("staged.txt"), "staged source work").unwrap();
    let mut stage = process::command("git", &source).unwrap();
    stage.args(["add", "staged.txt"]);
    process::checked(stage, &ticket).unwrap();
    let repo = git::attach(&directory, &source, &ticket).unwrap();
    save(&directory, &repo).unwrap();
    (temp, directory, authority, repo)
}
fn call(directory: &Path, ticket: &OperationTicket, tool: &str, args: Value) -> Value {
    serde_json::from_str(&execute_in(directory, ticket, tool, args).unwrap()).unwrap()
}
#[test]
fn real_checkout_diff_commit_preserves_original_and_rejects_changed_review() {
    let (temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("unrelated.txt")
        .exists());
    let before = call(&directory, &ticket, "repository-status", json!({}));
    call(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": repo.id, "path": "sum.js", "content": "module.exports = (a, b) => a + b;\n"}),
    );
    assert!(execute_in(&directory, &ticket, "repository-commit", json!({"repositoryId": repo.id, "expectedDiff": before["changes"]["diffId"], "expectedHead": before["changes"]["head"], "message": "fix"})).is_err());
    let after = call(&directory, &ticket, "repository-status", json!({}));
    assert!(after["changes"]["diff"].as_str().unwrap().contains("a + b"));
    let commit = call(
        &directory,
        &ticket,
        "repository-commit",
        json!({"repositoryId": repo.id, "expectedDiff": after["changes"]["diffId"], "expectedHead": after["changes"]["head"], "message": "Fix addition"}),
    );
    assert_eq!(commit["commit"].as_str().unwrap().len(), 40);
    assert_eq!(
        fs::read_to_string(temp.path().join("source/sum.js")).unwrap(),
        "module.exports = (a, b) => a - b;\n// Uncommitted source edit\n"
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("source/unrelated.txt")).unwrap(),
        "preserve me"
    );
    assert!(execute_in(&directory, &ticket, "repository-publish", json!({"repositoryId": repo.id, "expectedHead": commit["commit"], "title": "Test", "body": "Test"})).unwrap_err().contains("github.com origin"));
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("staged.txt")
        .exists());
    let mut source_index = process::command("git", &temp.path().join("source")).unwrap();
    source_index.args(["diff", "--cached", "--name-only"]);
    assert_eq!(
        process::checked(source_index, &ticket).unwrap(),
        "staged.txt"
    );
    let mut bound = load(&directory).unwrap().unwrap();
    bound.remote = Some("https://github.com/example/repository.git".into());
    save(&directory, &bound).unwrap();
    for (remote, base) in [
        ("https://github.com/other/repository.git", "main"),
        ("https://github.com/example/repository.git", "other"),
    ] {
        assert!(execute_in(&directory, &ticket, "repository-publish", json!({"repositoryId": repo.id, "remote": remote, "baseBranch": base, "expectedHead": commit["commit"], "title": "Test", "body": "Test"})).unwrap_err().contains("exact attached remote"));
    }
}
#[test]
fn scope_paths_empty_files_and_generation_fail_closed() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    for path in [
        "../escape",
        "C:/escape",
        ".git/config",
        ".env",
        "dir/key.pem",
    ] {
        assert!(
            execute_in(
                &directory,
                &ticket,
                "repository-write",
                json!({"repositoryId": repo.id, "path": path, "content": "bad"})
            )
            .is_err(),
            "{path}"
        );
    }
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": "other", "path": "x", "content": "bad"})
    )
    .is_err());
    call(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": repo.id, "path": "empty.txt", "content": ""}),
    );
    assert_eq!(
        fs::metadata(checkout(&directory, &repo).unwrap().join("empty.txt"))
            .unwrap()
            .len(),
        0
    );
    authority.revoke(1).unwrap();
    assert!(execute_in(&directory, &ticket, "repository-status", json!({})).is_err());
}
#[test]
fn escaped_command_receipt_survives_reload() {
    let (_temp, directory, _authority, mut repo) = fixture();
    repo.last_result = Some(process::CommandResult {
        output: "\0".repeat(65536),
        exit_code: Some(0),
        ..Default::default()
    });
    save(&directory, &repo).unwrap();
    assert_eq!(
        load(&directory)
            .unwrap()
            .unwrap()
            .last_result
            .unwrap()
            .output
            .len(),
        65536
    );
}
#[test]
fn recovery_and_repository_lock_are_visible() {
    let (_temp, directory, authority, mut repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    repo.operation = "publication outcome unknown".into();
    save(&directory, &repo).unwrap();
    assert_eq!(
        status(&directory, &ticket).unwrap()["recoveryRequired"],
        true
    );
    for tool in [
        "repository-write",
        "repository-run",
        "repository-commit",
        "repository-publish",
    ] {
        assert!(
            execute_in(&directory, &ticket, tool, json!({"repositoryId": repo.id}))
                .unwrap_err()
                .contains("Publication outcome is unknown")
        );
    }
    assert!(load(&directory)
        .unwrap()
        .unwrap()
        .operation
        .starts_with("publication"));
    let mutex = lock(&directory).unwrap();
    let _guard = mutex.lock().unwrap();
    assert_eq!(status(&directory, &ticket).unwrap()["busy"], true);
    assert!(execute_in(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": repo.id, "path": "x", "content": "bad"})
    )
    .unwrap_err()
    .contains("running"));
}

#[test]
#[ignore = "Requires Windows WSL Ubuntu with Bubblewrap, Python 3 and Node; run explicitly for native acceptance"]
fn native_coding_acceptance() {
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let run = |command: &str| {
        call(
            &directory,
            &ticket,
            "repository-run",
            json!({"repositoryId": repo.id, "command": command, "network": false, "timeoutSeconds": 30}),
        )
    };
    let failure = run("node test.js");
    assert_ne!(failure["exitCode"], 0);
    assert!(failure["output"]
        .as_str()
        .unwrap()
        .contains("AssertionError"));
    call(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": repo.id, "path": "sum.js", "content": "module.exports = (a, b) => a + b;\n"}),
    );
    let success = run("node test.js && test ! -e /mnt/c && test ! -e /repo/.git && test ! -e /home/agent/.ssh && test -z \"$USERPROFILE\"");
    assert_eq!(success["exitCode"], 0, "{success}");
    assert!(success["output"]
        .as_str()
        .unwrap()
        .contains("sum test passed"));
    let changes = call(&directory, &ticket, "repository-status", json!({}));
    assert!(changes["changes"]["diff"]
        .as_str()
        .unwrap()
        .contains("a + b"));
    let bounded = run("node -e \"process.stdout.write('x'.repeat(100000))\"");
    assert_eq!(bounded["exitCode"], 0, "{bounded}");
    assert_eq!(bounded["truncated"], true);
    assert!(bounded["output"].as_str().unwrap().len() <= 65536);
    let missing = run("mivlet_nonexistent_build_tool");
    assert_eq!(missing["exitCode"], 127);
    let timed = call(
        &directory,
        &ticket,
        "repository-run",
        json!({"repositoryId": repo.id, "command": "(sleep 4; echo escaped > timeout.txt) & wait", "network": false, "timeoutSeconds": 1}),
    );
    assert_eq!(timed["interrupted"], true);
    std::thread::sleep(std::time::Duration::from_secs(4));
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("timeout.txt")
        .exists());
    let authority2 = authority.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        authority2.revoke(1).unwrap();
    });
    assert!(execute_in(&directory, &ticket, "repository-run", json!({"repositoryId": repo.id, "command": "(sleep 5; echo escaped > late.txt) & wait", "network": false, "timeoutSeconds": 30})).is_err());
    stopper.join().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(4));
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("late.txt")
        .exists());
    let recovered = load(&directory).unwrap().unwrap();
    assert!(recovered.last_result.unwrap().interrupted);
    println!("Native coding acceptance: real failing Node test, scoped edit, passing test, actual Git diff, cancellation killed descendant; no external publication.");
}
