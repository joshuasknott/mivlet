use super::*;

fn entry(path: &str, bytes: &[u8]) -> Entry {
    Entry {
        path: path.into(),
        size_bytes: bytes.len() as u64,
        sha256: digest(bytes),
    }
}
fn snapshot(entries: Vec<Entry>, writable: &[&str]) -> Snapshot {
    let mut value = Snapshot {
        version: 1,
        snapshot_id: "a".repeat(48),
        repository_id: "b".repeat(48),
        branch: "main".into(),
        base_commit: "c".repeat(40),
        input_tree_id: tree_id(&entries),
        manifest_sha256: String::new(),
        total_bytes: entries.iter().map(|file| file.size_bytes).sum(),
        files: entries,
        writable_paths: writable.iter().map(|path| (*path).into()).collect(),
    };
    value.manifest_sha256 = snapshot_digest(&value).unwrap();
    value
}
fn output(snapshot: &Snapshot, entries: Vec<Entry>) -> OutputManifest {
    let mut value = OutputManifest {
        version: 1,
        snapshot_id: snapshot.snapshot_id.clone(),
        input_manifest_sha256: snapshot.manifest_sha256.clone(),
        output_manifest_sha256: String::new(),
        total_bytes: entries.iter().map(|file| file.size_bytes).sum(),
        deleted_paths: snapshot
            .files
            .iter()
            .filter(|old| !entries.iter().any(|new| old.path == new.path))
            .map(|file| file.path.clone())
            .collect(),
        files: entries,
    };
    value.output_manifest_sha256 = output_digest(&value).unwrap();
    value
}
#[test]
fn source_paths_reject_private_control_alias_and_host_path_names() {
    for path in ["src/main.ts", "package.json", "test/unit.js"] {
        public_path(path).unwrap();
    }
    for path in [
        "../private",
        "/tmp/input",
        "C:/input",
        "src\\input",
        ".Git/config",
        ".ENV.local",
        "src/AGENTS.md",
        ".github/workflows/check.yml",
        "keys/client.PEM",
        "src/.netrc",
        "file:stream",
        "CON",
        "trailing.",
        "node_modules/package/index.js",
        "src/secrets/value.ts",
    ] {
        assert!(public_path(path).is_err(), "{path}");
    }
    assert!(public_content(b"source\0bytes").is_err());
    assert!(public_content(b"version https://git-lfs.github.com/spec/v1\noid sha256:abc").is_err());
    assert!(public_content(br"Read C:\Users\fixture\private.txt").is_err());
    assert!(public_content(&vec![b'x'; FILE_BYTES as usize + 1]).is_err());
    assert!(public_path(&format!("{}.ts", "x".repeat(238))).is_err());
}
#[test]
fn manifests_seal_order_sizes_names_and_exact_writable_scope() {
    let value = snapshot(
        vec![entry("a.ts", b"one"), entry("b.ts", b"two")],
        &["a.ts", "new.ts"],
    );
    validate_snapshot(&value).unwrap();
    for entries in [
        vec![entry("a.ts", b"a"), entry("A.ts", b"b")],
        vec![entry("a", b"a"), entry("a/b", b"b")],
        vec![entry("z", b"a"), entry("a", b"b")],
        vec![entry("Src/a.ts", b"a"), entry("src/b.ts", b"b")],
    ] {
        assert!(validate_entries(&entries, 2).is_err());
    }
    assert!(validate_writable(&["src".into(), "src/main.ts".into()]).is_err());
    let mut changed = value.clone();
    changed.writable_paths.push("z.ts".into());
    assert!(
        validate_snapshot(&changed).is_err(),
        "scope is part of the input digest"
    );
    let allowed = output(
        &value,
        vec![
            entry("a.ts", b"changed"),
            entry("b.ts", b"two"),
            entry("new.ts", b"new"),
        ],
    );
    output::validate_output(&value, &allowed).unwrap();
    assert!(output::validate_output(
        &value,
        &output(
            &value,
            vec![entry("a.ts", b"one"), entry("b.ts", b"changed")]
        )
    )
    .is_err());
    assert!(
        output::validate_output(&value, &output(&value, vec![entry("a.ts", b"one")])).is_err(),
        "unwritable deletion"
    );
    assert!(output::validate_output(
        &value,
        &output(
            &value,
            vec![
                entry("a.ts", b"one"),
                entry("b.ts", b"two"),
                entry("other.ts", b"new")
            ]
        )
    )
    .is_err());
    let mut missing = allowed;
    missing.files[0].sha256 = "f".repeat(64);
    assert!(output::validate_output(&value, &missing).is_err());
    let read_only = snapshot(vec![entry("a.ts", b"one")], &[]);
    validate_snapshot(&read_only).unwrap();
    output::validate_output(&read_only, &output(&read_only, read_only.files.clone())).unwrap();
    assert!(
        output::validate_output(
            &read_only,
            &output(&read_only, vec![entry("a.ts", b"changed")])
        )
        .is_err(),
        "empty write scope is read only"
    );
    assert!(
        validate_snapshot(&snapshot(vec![entry("Src/a.ts", b"one")], &["src/new.ts"])).is_err(),
        "new writable paths cannot alias input directories by case"
    );
    assert!(
        validate_snapshot(&snapshot(vec![entry("src/a.ts", b"one")], &["src"])).is_err(),
        "a newly writable file cannot replace a selected parent directory"
    );
}
#[test]
fn only_exact_bound_sealed_coding_receipts_can_create_output_custody() {
    let source = snapshot(vec![entry("main.ts", b"one")], &["main.ts"]);
    let returned = output(&source, vec![entry("main.ts", b"changed")]);
    let mut value = serde_json::json!({"binding":{"version":3,"mode":"offline-coding","repository":{"snapshot":source,"scope":{"writablePaths":["main.ts"],"checks":[],"image":"coding@sha256:fixture","network":"disabled"}},"taskId":"task-fixture","admissionId":"admit-fixture","runId":"run-fixture","workspaceId":"cloud-workspace","agentId":"lead","workId":"work-fixture","workGeneration":2,"conversationId":"conversation-fixture","conversationGeneration":1,"expectedSequence":1,"inputSha256":"0".repeat(64),"providerId":"openai","model":"fixture","credentialId":"credential-fixture","credentialRevision":1,"budget":{"maxModelCalls":1,"maxOutputTokens":4096,"maxElapsedMs":120000,"maxResultBytes":65536},"expiresAt":9000000000000i64},"generation":1,"status":"completed","sequence":3,"resultBytes":0,"createdAt":1,"updatedAt":2,"retainedUntil":86400001,"coding":{"modelCalls":1,"toolCalls":1,"allocatedOutputTokens":4096,"completedChecks":[],"output":returned}});
    let valid: crate::hosted_tasks::models::TaskSnapshot =
        serde_json::from_value(value.clone()).unwrap();
    AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
        "workspace",
        &valid,
        &source,
        returned.clone(),
        &returned.output_manifest_sha256,
    )
    .unwrap();
    value["status"] = serde_json::json!("running");
    let running = serde_json::from_value(value.clone()).unwrap();
    assert!(
        AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
            "workspace",
            &running,
            &source,
            returned.clone(),
            &returned.output_manifest_sha256
        )
        .is_err()
    );
    value["status"] = serde_json::json!("needs-review");
    let parked = serde_json::from_value(value.clone()).unwrap();
    AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
        "workspace",
        &parked,
        &source,
        returned.clone(),
        &returned.output_manifest_sha256,
    )
    .unwrap();
    value["binding"]["repository"]["scope"]["writablePaths"] = serde_json::json!(["other.ts"]);
    let expanded = serde_json::from_value(value).unwrap();
    assert!(
        AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
            "workspace",
            &expanded,
            &source,
            returned.clone(),
            &returned.output_manifest_sha256
        )
        .is_err()
    );
    assert!(
        AuthenticatedHostedRepositoryOutput::from_authenticated_transport(
            "workspace",
            &valid,
            &source,
            returned,
            &"0".repeat(64)
        )
        .is_err()
    );
}
#[test]
fn staged_overlay_preserves_private_and_unexported_files_and_refuses_base_drift() {
    let (_temp, directory, authority, repo) = super::super::tests::fixture();
    let ticket = authority.begin_agent(1).unwrap();
    let source = checkout(&directory, &repo).unwrap();
    fs::write(source.join(".env.private"), "keep private local bytes").unwrap();
    fs::write(source.join("unexported.txt"), "keep local file").unwrap();
    let mut original = snapshot(
        vec![
            entry("sum.js", &fs::read(source.join("sum.js")).unwrap()),
            entry("test.js", &fs::read(source.join("test.js")).unwrap()),
        ],
        &["new.ts", "sum.js", "test.js"],
    );
    original.repository_id = repo.id.clone();
    original.branch = repo.branch.clone();
    original.base_commit = repo.base.clone();
    original.manifest_sha256 = snapshot_digest(&original).unwrap();
    let record = models::Record {
        version: 1,
        snapshot: original.clone(),
        task: TaskIdentity {
            local_workspace_id: "workspace".into(),
            agent_id: "lead".into(),
            work_id: "work".into(),
            work_generation: 2,
            task_id: "cloud-task".into(),
            run_id: "cloud-run".into(),
        },
        account: "fixture".into(),
        scope_id: ticket.execution_binding().scope_id,
        repository: super::super::RepositoryWorkBinding {
            version: 1,
            repository_id: repo.id.clone(),
            branch: repo.branch.clone(),
            base_commit: repo.base.clone(),
            captured_at: "2026-10-17T10:00:00Z".into(),
        },
        full_tree_id: files::tree_id(&source, COPY_LIMITS, || true).unwrap(),
        head: git::run(&directory, &repo, &["rev-parse", "HEAD"], &ticket).unwrap(),
    };
    import::check_base(&directory, &repo, &ticket, &record).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let tree = staging.path().join("tree");
    fs::create_dir(&tree).unwrap();
    files::copy_tree(&source, &tree, COPY_LIMITS, || true).unwrap();
    let returned = staging.path().join("returned");
    fs::create_dir(&returned).unwrap();
    fs::create_dir(returned.join("tree")).unwrap();
    storage::write_bytes(&returned.join("tree/new.ts"), b"export const value = 1;\n").unwrap();
    storage::write_bytes(
        &returned.join("tree/sum.js"),
        b"module.exports = (a,b) => a+b;\n",
    )
    .unwrap();
    let manifest = output(
        &original,
        vec![
            entry("new.ts", b"export const value = 1;\n"),
            entry("sum.js", b"module.exports = (a,b) => a+b;\n"),
        ],
    );
    output::validate_output(&original, &manifest).unwrap();
    import::overlay(&tree, &returned, &record, &manifest, &ticket).unwrap();
    assert_eq!(
        fs::read(tree.join(".env.private")).unwrap(),
        b"keep private local bytes"
    );
    assert_eq!(
        fs::read(tree.join("unexported.txt")).unwrap(),
        b"keep local file"
    );
    assert!(!tree.join("test.js").exists());
    assert!(
        source.join("test.js").exists(),
        "review does not mutate original copy"
    );
    fs::write(source.join("unexported.txt"), "newer local edit").unwrap();
    assert!(
        import::check_base(&directory, &repo, &ticket, &record).is_err(),
        "even omitted local drift blocks import"
    );
    assert_eq!(
        fs::read(source.join("unexported.txt")).unwrap(),
        b"newer local edit"
    );
}
#[test]
fn overlay_refuses_new_returned_path_that_would_replace_unexported_local_file() {
    let temp = tempfile::tempdir().unwrap();
    let authority =
        crate::local_computer::authority::ComputerAuthority::load(&temp.path().join("authority"))
            .unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    let tree = temp.path().join("tree");
    fs::create_dir(&tree).unwrap();
    fs::write(tree.join("existing.ts"), "private omitted input").unwrap();
    let returned = temp.path().join("returned");
    fs::create_dir_all(returned.join("tree")).unwrap();
    fs::write(returned.join("tree/existing.ts"), "new").unwrap();
    let original = snapshot(vec![], &["existing.ts"]);
    let record = models::Record {
        version: 1,
        snapshot: original.clone(),
        task: TaskIdentity {
            local_workspace_id: "workspace".into(),
            agent_id: "lead".into(),
            work_id: "work".into(),
            work_generation: 1,
            task_id: "task".into(),
            run_id: "run".into(),
        },
        account: "fixture".into(),
        scope_id: ticket.execution_binding().scope_id,
        repository: super::super::RepositoryWorkBinding {
            version: 1,
            repository_id: original.repository_id.clone(),
            branch: original.branch.clone(),
            base_commit: original.base_commit.clone(),
            captured_at: "2026-10-17T10:00:00Z".into(),
        },
        full_tree_id: "0".repeat(64),
        head: "0".repeat(40),
    };
    let manifest = output(&original, vec![entry("existing.ts", b"new")]);
    assert!(import::overlay(&tree, &returned, &record, &manifest, &ticket).is_err());
    assert_eq!(
        fs::read(tree.join("existing.ts")).unwrap(),
        b"private omitted input"
    );
}
