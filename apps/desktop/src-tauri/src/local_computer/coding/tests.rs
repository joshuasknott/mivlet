use super::super::authority::ComputerAuthority;
use super::*;

pub(super) fn fixture() -> (
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
#[ignore = "Real native job and repository authority; needs prepared runtime and execution setup"]
fn native_persistent_repository_job_lifecycle_acceptance() {
    use crate::local_computer::command_jobs::{JobManager, JobStatus};
    use std::{
        sync::atomic::Ordering,
        time::{Duration, Instant},
    };
    let (temp, directory, authority, repo) = fixture();
    let manager = JobManager::default();
    let jobs = manager.scope(&temp.path().join("authority")).unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    let cancelled = ticket.cancellation();
    let result: Value = serde_json::from_str(&jobs::start(directory.clone(), ticket, jobs.clone(),
        json!({"repositoryId":repo.id,"command":"node -e \"require('fs').writeFileSync('persistent-only.txt','discard');console.log('native owned job');setTimeout(()=>{},60000)\"", "network":false,"timeoutSeconds":60})).unwrap()).unwrap();
    let id = result["job"]["id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let current = jobs
            .list()
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap();
        if current.status == JobStatus::Running {
            break;
        }
        if current.finished_at.is_some() || Instant::now() >= deadline {
            cancelled.store(true, Ordering::Release);
            panic!("Persistent job did not start: {current:?}");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        lock(&directory).unwrap().try_lock().is_err(),
        "Repository lock was released while the job was running"
    );
    let edit_ticket = authority.begin_agent(1).unwrap();
    assert!(execute_in(
        &directory,
        &edit_ticket,
        "repository-write",
        json!({"repositoryId":repo.id,"path":"blocked.txt","content":"no"})
    )
    .is_err());
    cancelled.store(true, Ordering::Release);
    let stopped = Instant::now() + Duration::from_secs(30);
    loop {
        let job = jobs
            .list()
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap();
        if job.finished_at.is_some() && lock(&directory).unwrap().try_lock().is_ok() {
            assert_eq!(job.status, JobStatus::Stopped);
            println!("Native persistent job {} returned before exit, retained its repository lock, and stopped with receipt {:?}.", job.id, job.execution_id);
            break;
        }
        assert!(
            Instant::now() < stopped,
            "Persistent repository job did not finish Stop and cleanup"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("persistent-only.txt")
        .exists());
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("blocked.txt")
        .exists());
    assert!(temp.path().join("source/unrelated.txt").exists());
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
#[cfg(windows)]
#[ignore = "Requires Windows native execution setup and bundled runtime; run explicitly for native acceptance"]
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
    let success = run("node test.js && node -e \"const a=require('assert'); a(!require('fs').existsSync('.git')); a(!process.env.OPENAI_API_KEY); a(process.env.USERPROFILE.includes('MivletExecution'))\"");
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
    assert_eq!(missing["exitCode"], 1);
    assert!(missing["output"]
        .as_str()
        .unwrap()
        .contains("mivlet_nonexistent_build_tool"));
    let timed = call(
        &directory,
        &ticket,
        "repository-run",
        json!({"repositoryId": repo.id, "command": "node -e \"setTimeout(()=>require('fs').writeFileSync('timeout.txt','escape'),4000)\"", "network": false, "timeoutSeconds": 1}),
    );
    assert_eq!(timed["interrupted"], true);
    std::thread::sleep(std::time::Duration::from_secs(4));
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("timeout.txt")
        .exists());
    let authority2 = authority.clone();
    let mut sentinel = process::NativeSentinel::new();
    call(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId": repo.id, "path": "stop.js", "content": process::NATIVE_STOP_SCRIPT}),
    );
    let binding = ticket.execution_binding();
    let stopper = std::thread::spawn(move || {
        process::stop_after_native_ready(&binding, || {
            authority2.revoke(1).unwrap();
        });
    });
    assert!(execute_in(&directory, &ticket, "repository-run", json!({"repositoryId": repo.id, "command": "node stop.js", "network": false, "timeoutSeconds": 30})).is_err());
    stopper.join().unwrap();
    sentinel.assert_alive();
    assert!(!checkout(&directory, &repo)
        .unwrap()
        .join("late.txt")
        .exists());
    let recovered = load(&directory).unwrap().unwrap();
    assert!(recovered.last_result.unwrap().interrupted);
    println!("Native coding acceptance: real failing Node test, scoped edit, passing test, actual Git diff, cancellation killed descendant; no external publication.");
}

#[test]
#[cfg(windows)]
#[ignore = "Requires native setup/runtime; revokes exactly between suspended creation and resume"]
fn native_cancelled_launch_acceptance() {
    use std::cell::Cell;
    let (_temp, directory, authority, repo) = fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let binding = ticket.execution_binding();
    let reached = Cell::new(false);
    let resumed = Cell::new(false);
    let mut sentinel = process::NativeSentinel::new();
    let result = mivlet_windows_executor::run(
        &process::execution_resources().unwrap(),
        &checkout(&directory, &repo).unwrap(),
        "node -e \"require('fs').writeFileSync('launch-ran.txt','stale execution')\"",
        false,
        20,
        mivlet_windows_executor::Limits::CODING,
        binding.clone(),
        || ticket.check().is_ok(),
        |launch| {
            reached.set(true);
            // The actual process is already suspended, job-bound and verified.
            let work = process::native_work(&binding).unwrap();
            authority.revoke(1).unwrap();
            let result = ticket.with_current(|| {
                resumed.set(true);
                launch()
            });
            assert!(result.is_err());
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(!work.join("launch-ran.txt").exists());
            result
        },
    );
    assert!(
        reached.get(),
        "Fixture never reached suspended native launch"
    );
    assert!(
        !resumed.get(),
        "The revoked dispatch fence resumed a stale command"
    );
    assert!(result.is_err());
    sentinel.assert_alive();
}

#[test]
#[cfg(windows)]
#[ignore = "Requires native setup/runtime; exercises coding status/recover across import rename gaps"]
fn native_repository_import_recovery_acceptance() {
    for boundary in [1u8, 2] {
        let (temp, directory, authority, mut repo) = fixture();
        let ticket = authority.begin_agent(1).unwrap();
        let root = checkout(&directory, &repo).unwrap();
        repo.operation = "command running; import outcome unknown after host restart".into();
        save(&directory, &repo).unwrap();
        let (_, completed) = process::native_run(
            &root,
            "echo actual command output > imported.txt",
            false,
            20,
            false,
            &ticket,
            None,
        )
        .unwrap();
        let prepared = completed
            .prepare_repository_import(&root, || ticket.check().is_ok())
            .unwrap();
        if boundary == 1 {
            let journal: Value = serde_json::from_slice(
                &fs::read(directory.join(&repo.id).join("native-import.json")).unwrap(),
            )
            .unwrap();
            let previous = directory
                .join(&repo.id)
                .join(journal["transaction"].as_str().unwrap())
                .join("previous");
            fs::rename(&root, previous).unwrap();
            drop(prepared);
        } else {
            drop(ticket.with_current(|| prepared.commit()).unwrap());
        }
        // Core crash supervisors actually terminate at both boundaries. Here
        // recreate native authority to prove the desktop recovery route remains
        // reachable with the missing checkout and a new generation.
        drop(completed);
        drop(ticket);
        drop(authority);
        let restarted = ComputerAuthority::load(&temp.path().join("authority")).unwrap();
        let generation = restarted.snapshot().unwrap().generation;
        let ticket = restarted.begin_agent(generation).unwrap();
        let inspected = status(&directory, &ticket).unwrap();
        assert_eq!(inspected["recoveryRequired"], true);
        assert!(!inspected["changes"].is_null());
        assert!(checkout(&directory, &repo).unwrap().exists());
        assert_eq!(root.join("imported.txt").exists(), boundary == 2);
        assert!(execute_in(
            &directory,
            &ticket,
            "repository-write",
            json!({"repositoryId":repo.id,"path":"blocked.txt","content":"must wait"})
        )
        .is_err());
        let recovered = call(
            &directory,
            &ticket,
            "repository-recover",
            json!({"repositoryId":repo.id}),
        );
        assert!(recovered["message"]
            .as_str()
            .unwrap()
            .contains("No command was replayed"));
        assert!(!directory.join(&repo.id).join("native-import.json").exists());
        assert_eq!(root.join("imported.txt").exists(), boundary == 2);
        assert!(
            load(&directory)
                .unwrap()
                .unwrap()
                .last_result
                .unwrap()
                .interrupted
        );
        assert!(!temp.path().join("source/imported.txt").exists());
    }
}
