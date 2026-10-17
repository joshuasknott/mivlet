use super::*;
use crate::local_computer::command_jobs::JobManager;

fn owner(directory: &Path, repo: &Repository) {
    fs::write(directory.join(&repo.id).join("ownership.json"),
        serde_json::to_vec(&json!({"account":"account-review","workspace":"workspace-review","agent":"agent-review","source":null})).unwrap()).unwrap();
}
fn target(id: &str) -> ReviewRequest {
    ReviewRequest {
        workspace_id: "workspace-review".into(),
        agent_id: "agent-review".into(),
        expected_generation: 1,
        job_id: id.into(),
        job_generation: 1,
    }
}

#[test]
fn base_names_require_complete_nul_framing_without_ambiguous_or_protected_paths() {
    assert!(public_base_names(""));
    assert!(public_base_names("src/app.ts\0literal[1].txt\0"));
    for output in [
        "src/app.ts",
        "\0",
        "src/app.ts\0\0",
        "src/app.ts\n\0",
        "src/\u{fffd}.txt\0",
        "../outside\0",
        "nested/.ENV.LOCAL\0",
        "key.PEM\0",
    ] {
        assert!(!public_base_names(output), "{output:?}");
    }
}
fn inspect(
    directory: &Path,
    jobs: &ScopeJobs,
    target: &ReviewRequest,
    ticket: &OperationTicket,
) -> Result<Value, String> {
    inspect_in(
        directory,
        jobs,
        target,
        "account-review",
        ticket,
        Instant::now() + Duration::from_secs(8),
        &|| ticket.check(),
    )
}

#[test]
fn exact_job_review_retains_copy_after_library_switch_and_never_changes_index_or_selection() {
    let (temp, directory, authority, repo) = super::super::tests::fixture();
    owner(&directory, &repo);
    let ticket = authority.begin_agent(1).unwrap();
    let other = git::attach(&directory, &temp.path().join("source"), &ticket).unwrap();
    owner(&directory, &other);
    save(&directory, &other).unwrap();
    let selected = fs::read(directory.join("repository.json")).unwrap();
    let index_path = directory.join(&repo.id).join("git/index");
    let real_index = fs::read(&index_path).unwrap();
    fs::write(
        checkout(&directory, &repo).unwrap().join("sum.js"),
        "// exact review copy A\n",
    )
    .unwrap();
    fs::write(
        checkout(&directory, &repo).unwrap().join("new.txt"),
        "new A content\n",
    )
    .unwrap();
    fs::write(
        checkout(&directory, &other).unwrap().join("sum.js"),
        "// unrelated copy B\n",
    )
    .unwrap();
    let manager = JobManager::default();
    let jobs = manager.scope(&temp.path().join("jobs")).unwrap();
    let mut session = jobs
        .start(&ticket, Some(&repo.id), "echo test", false, 60, true)
        .unwrap();
    let binding = RepositoryWorkBinding::from_repository(&repo, "2026-10-17T12:00:00Z").unwrap();
    let task = task_binding::TaskRepository::for_test(
        binding,
        "account-review",
        "workspace-review",
        "agent-review",
    );
    super::super::jobs::bind_repository(&mut session, &repo, Some(&task)).unwrap();
    let target = target(&session.snapshot().unwrap().id);
    let review = inspect(&directory, &jobs, &target, &ticket).unwrap();
    assert_eq!(review["repository"]["id"], repo.id);
    assert_eq!(review["jobId"], target.job_id);
    assert_eq!(review["jobGeneration"], 1);
    assert_eq!(review["busy"], false);
    assert_eq!(review["recoveryRequired"], false);
    assert!(review["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|name| name == "new.txt"));
    let diff = review["changes"]["diff"].as_str().unwrap();
    assert!(diff.contains("exact review copy A") && diff.contains("new A content"));
    assert!(!diff.contains("unrelated copy B"));
    assert_eq!(fs::read(index_path).unwrap(), real_index);
    assert_eq!(
        fs::read(directory.join("repository.json")).unwrap(),
        selected
    );
    assert_eq!(load(&directory).unwrap().unwrap().id, other.id);
    assert_eq!(
        fs::read_to_string(checkout(&directory, &repo).unwrap().join("new.txt")).unwrap(),
        "new A content\n"
    );

    let mut foreign = target.clone();
    foreign.agent_id = "other-agent".into();
    assert!(inspect(&directory, &jobs, &foreign, &ticket).is_err());
    let mut stale = target.clone();
    stale.expected_generation = 2;
    stale.job_generation = 2;
    assert!(inspect(&directory, &jobs, &stale, &ticket).is_err());
    assert!(inspect_in(
        &directory,
        &jobs,
        &target,
        "other-account",
        &ticket,
        Instant::now() + Duration::from_secs(8),
        &|| ticket.check()
    )
    .is_err());
    let mut changed = repo.clone();
    changed.base = "f".repeat(40);
    copy_manager::save_copy(&directory, &changed).unwrap();
    assert!(inspect(&directory, &jobs, &target, &ticket).is_err());
    copy_manager::save_copy(&directory, &repo).unwrap();
    let mutex = lock(&directory).unwrap();
    let guard = mutex.try_lock().unwrap();
    let busy = inspect(&directory, &jobs, &target, &ticket).unwrap();
    assert_eq!(busy["busy"], true);
    assert!(busy["changes"].is_null());
    assert!(busy["files"].as_array().unwrap().is_empty());
    drop(guard);
    let mut recovery = repo.clone();
    recovery.operation = "outcome requires review".into();
    copy_manager::save_copy(&directory, &recovery).unwrap();
    let before = fs::read(directory.join(&repo.id).join("repository.json")).unwrap();
    let review = inspect(&directory, &jobs, &target, &ticket).unwrap();
    assert_eq!(review["recoveryRequired"], true);
    assert!(review["changes"].is_null());
    assert_eq!(
        fs::read(directory.join(&repo.id).join("repository.json")).unwrap(),
        before
    );
    authority.revoke(1).unwrap();
    assert!(inspect(&directory, &jobs, &target, &ticket).is_err());
    drop(ticket);
    copy_manager::save_copy(&directory, &repo).unwrap();
    let viewer = authority.begin_viewer(2).unwrap();
    let mut retained = target.clone();
    retained.expected_generation = 2;
    let review = inspect(&directory, &jobs, &retained, &viewer).unwrap();
    assert_eq!(review["repository"]["id"], repo.id);
    assert_eq!(review["jobGeneration"], 1);
    retained.job_generation = 2;
    assert!(inspect(&directory, &jobs, &retained, &viewer).is_err());
}

#[test]
fn listing_is_bounded_cancellable_and_never_exposes_git_custody() {
    let temp = tempfile::tempdir().unwrap();
    for index in 0..(MAX_FILES + 5) {
        fs::write(temp.path().join(format!("file-{index}.txt")), "bounded").unwrap();
    }
    let (paths, truncated, complete) = files(temp.path(), &|| Ok(())).unwrap();
    assert_eq!(paths.len(), MAX_FILES);
    assert!(truncated);
    assert!(complete);
    assert!(paths.iter().map(String::len).sum::<usize>() <= MAX_NAMES);
    assert!(files(temp.path(), &|| Err("revoked".into())).is_err());
    let private = tempfile::tempdir().unwrap();
    fs::create_dir(private.path().join(".git")).unwrap();
    fs::write(private.path().join(".git/config"), "not visible").unwrap();
    assert!(files(private.path(), &|| Ok(())).is_err());
    let text = "é".repeat(MAX_TEXT);
    let (text, truncated) = bounded_text(text);
    assert!(truncated);
    assert_eq!(text.len(), MAX_TEXT);
}

#[test]
fn protected_base_deleted_case_and_directory_contents_never_enter_public_review() {
    let (temp, directory, authority, mut repo) = super::super::tests::fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let root = checkout(&directory, &repo).unwrap();
    for (path, text) in [
        (".ENV.LOCAL", "synthetic-private-uppercase-content\n"),
        (".env.deleted", "synthetic-private-deleted-content\n"),
        (
            "vault.KEY/inner.txt",
            "synthetic-private-directory-content\n",
        ),
        (
            "nested/.env.private/inner.txt",
            "synthetic-private-nested-directory\n",
        ),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    git::run(&directory, &repo, &["add", "-A", "--", ":/"], &ticket).unwrap();
    git::run(
        &directory,
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "private fixture base",
        ],
        &ticket,
    )
    .unwrap();
    repo.base = git::run(&directory, &repo, &["rev-parse", "HEAD"], &ticket).unwrap();
    save(&directory, &repo).unwrap();
    owner(&directory, &repo);
    fs::rename(root.join(".env.deleted"), root.join("public-renamed.txt")).unwrap();
    fs::write(
        root.join(".ENV.LOCAL"),
        "synthetic-private-modified-uppercase\n",
    )
    .unwrap();
    fs::write(
        root.join("vault.KEY/inner.txt"),
        "synthetic-private-modified-directory\n",
    )
    .unwrap();
    fs::write(root.join("visible.txt"), "visible public content\n").unwrap();
    fs::write(root.join("literal[1].txt"), "literal pathspec characters\n").unwrap();
    let manager = JobManager::default();
    let jobs = manager.scope(&temp.path().join("jobs")).unwrap();
    let mut session = jobs
        .start(&ticket, Some(&repo.id), "echo fixture", false, 60, true)
        .unwrap();
    super::super::jobs::bind_repository(&mut session, &repo, None).unwrap();
    let review = inspect(
        &directory,
        &jobs,
        &target(&session.snapshot().unwrap().id),
        &ticket,
    )
    .unwrap();
    assert_eq!(review["truncated"], true);
    assert!(review["changes"].is_null());
    assert!(!review.to_string().contains("synthetic-private"));
    let names = review["files"].as_array().unwrap();
    assert!(names.iter().any(|name| name == "literal[1].txt"));
    assert!(names.iter().any(|name| name == "visible.txt"));
    assert!(names
        .iter()
        .all(|name| super::super::safe_path(&name.as_str().unwrap().to_ascii_lowercase()).is_ok()));
    // Removing all protected current paths must not reveal their base/renamed
    // content through the remaining public filename.
    fs::remove_file(root.join(".ENV.LOCAL")).unwrap();
    fs::remove_file(root.join("vault.KEY/inner.txt")).unwrap();
    fs::remove_dir(root.join("vault.KEY")).unwrap();
    fs::remove_file(root.join("nested/.env.private/inner.txt")).unwrap();
    fs::remove_dir(root.join("nested/.env.private")).unwrap();
    let review = inspect(
        &directory,
        &jobs,
        &target(&session.snapshot().unwrap().id),
        &ticket,
    )
    .unwrap();
    assert!(review["changes"].is_null());
    assert_eq!(review["truncated"], true);
    assert!(!review.to_string().contains("synthetic-private"));
}
