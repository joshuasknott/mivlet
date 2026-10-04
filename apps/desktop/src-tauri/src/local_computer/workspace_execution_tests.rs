use super::super::authority::ComputerAuthority;
use super::*;

fn fixture() -> (
    tempfile::TempDir,
    PathBuf,
    std::sync::Arc<ComputerAuthority>,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let authority = ComputerAuthority::load(&temp.path().join("authority")).unwrap();
    (temp, root, authority)
}
fn request(command: &str) -> Value {
    json!({"command":command,"inputs":[],"outputs":[],"network":false,"timeoutSeconds":30})
}

#[test]
fn selection_and_execution_contract_fail_closed() {
    for path in [
        "../secret.txt",
        "/etc/passwd",
        "C:/file.csv",
        "dir\\file.txt",
        ".env",
        "dir/key.pem",
        "dir/.git/config",
        "dir/../file.csv",
        "dir/file. ",
    ] {
        let mut arguments = request("true");
        arguments["inputs"] = json!([path]);
        assert!(input(arguments).is_err(), "{path}");
    }
    for outputs in [
        json!(["program.exe"]),
        json!(["view.html"]),
        json!(["image.svg"]),
        json!(["Report.csv", "report.csv"]),
        json!(vec!["report.csv"; 17]),
    ] {
        let mut arguments = request("true");
        arguments["outputs"] = outputs;
        assert!(input(arguments).is_err());
    }
    for timeout in [0, 301] {
        let mut arguments = request("true");
        arguments["timeoutSeconds"] = json!(timeout);
        assert!(input(arguments).is_err());
    }
    let mut arguments = request("true");
    arguments["hostPath"] = json!("C:/private");
    assert!(input(arguments).is_err());
    assert!(input(request(&"a".repeat(8193))).is_err());
    assert!(input(request(" ")).is_err());
    assert!(input(request("python3 -V")).is_ok());
}

#[test]
fn selected_inputs_are_frozen_and_other_files_remain_absent() {
    let (temp, root, authority) = fixture();
    let snapshot = temp.path().join("snapshot");
    fs::create_dir(&snapshot).unwrap();
    fs::write(root.join("selected.csv"), "value\n7\n").unwrap();
    fs::write(root.join("unselected.csv"), "keep private").unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    copy_inputs(&root, &snapshot, &["selected.csv".into()], &ticket).unwrap();
    assert!(!snapshot.join("unselected.csv").exists());
    fs::write(snapshot.join("selected.csv"), "modified by sandbox").unwrap();
    assert_eq!(
        fs::read_to_string(root.join("selected.csv")).unwrap(),
        "value\n7\n"
    );
    fs::write(root.join("large.csv"), vec![b'x'; FILE_LIMIT + 1]).unwrap();
    assert!(copy_inputs(&root, &snapshot, &["large.csv".into()], &ticket).is_err());
    authority.revoke(1).unwrap();
    assert!(copy_inputs(&root, &snapshot, &["selected.csv".into()], &ticket).is_err());
}

#[test]
fn declared_outputs_are_validated_before_any_atomic_placement() {
    let (temp, root, _authority) = fixture();
    let scratch = temp.path().join("scratch");
    fs::create_dir(&scratch).unwrap();
    fs::write(scratch.join("good.csv"), "total\n15\n").unwrap();
    fs::write(scratch.join("bad.pdf"), b"%PDF-1.7\nnot a document").unwrap();
    assert!(prepare_outputs(
        &root,
        &scratch,
        &["good.csv".into(), "bad.pdf".into()],
        "bad"
    )
    .is_err());
    assert!(!root.join("Generated").exists());
    fs::write(scratch.join("bad.png"), b"\x89PNG\r\n\x1a\ntruncated").unwrap();
    assert!(prepare_outputs(&root, &scratch, &["bad.png".into()], "bad").is_err());
    assert!(prepare_outputs(&root, &scratch, &["missing.csv".into()], "missing").is_err());
    assert!(!root.join("Generated").exists());
    let prepared = prepare_outputs(&root, &scratch, &["good.csv".into()], "good").unwrap();
    fs::write(scratch.join("good.csv"), "changed after validation").unwrap();
    let outputs = prepared.commit().unwrap();
    assert_eq!(
        fs::read_to_string(root.join(&outputs[0].path)).unwrap(),
        "total\n15\n"
    );
    assert_eq!(
        outputs[0].sha256,
        hex::encode(Sha256::digest(b"total\n15\n"))
    );
    assert!(
        prepare_outputs(&root, &scratch, &["good.csv".into()], "good")
            .unwrap()
            .commit()
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(root.join(&outputs[0].path)).unwrap(),
        "total\n15\n"
    );
}

#[test]
fn stop_prevents_result_placement_and_cleanup_discards_staging() {
    let (temp, root, authority) = fixture();
    let scratch = temp.path().join("scratch");
    fs::create_dir(&scratch).unwrap();
    fs::write(scratch.join("result.txt"), "a verified result").unwrap();
    let prepared = prepare_outputs(&root, &scratch, &["result.txt".into()], "stopped").unwrap();
    let staging = prepared.staging.path().to_owned();
    let ticket = authority.begin_agent(1).unwrap();
    authority.revoke(1).unwrap();
    assert!(ticket.commit(|| prepared.commit()).is_err());
    assert!(!staging.exists());
    assert!(!root.join("Generated").exists());
}

#[test]
fn structured_outputs_require_valid_json_and_keep_original_bytes() {
    let (temp, root, _authority) = fixture();
    let scratch = temp.path().join("scratch");
    fs::create_dir(&scratch).unwrap();
    fs::write(scratch.join("good.json"), b"{\"total\":15}\n").unwrap();
    fs::write(scratch.join("bad.json"), b"{invalid}").unwrap();
    assert!(prepare_outputs(
        &root,
        &scratch,
        &["good.json".into(), "bad.json".into()],
        "bad"
    )
    .is_err());
    assert!(!root.join("Generated").exists());
    let prepared = prepare_outputs(&root, &scratch, &["good.json".into()], "good").unwrap();
    let outputs = prepared.commit().unwrap();
    assert_eq!(
        fs::read(root.join(&outputs[0].path)).unwrap(),
        b"{\"total\":15}\n"
    );
}

#[test]
#[ignore = "Requires Windows native execution setup and bundled runtime; real projectless execution acceptance"]
fn native_workspace_execution_acceptance() {
    let (_temp, root, authority) = fixture();
    fs::write(root.join("data.csv"), "name,value\nAlpha,6\nBeta,9\n").unwrap();
    fs::write(root.join("private.txt"), "unselected data").unwrap();
    fs::write(root.join("analysis.py"), "import csv,os,socket\nassert not os.path.exists('private.txt')\nassert 'OPENAI_API_KEY' not in os.environ\nassert 'MivletExecution' in os.environ['USERPROFILE']\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=0.2)\n raise AssertionError('network unexpectedly available')\nexcept OSError: pass\nwith open('data.csv') as f: total=sum(int(row['value']) for row in csv.DictReader(f))\nwith open('report.csv','w',newline='') as f: f.write('total\\n'+str(total)+'\\n')\nwith open('data.csv','w') as f: f.write('changed inside snapshot')\nprint('actual CSV total',total)\n").unwrap();
    let mut arguments = request("python3 analysis.py");
    arguments["inputs"] = json!(["data.csv", "analysis.py"]);
    arguments["outputs"] = json!(["report.csv"]);
    let result: Value = serde_json::from_str(
        &execute_in(&root, authority.begin_agent(1).unwrap(), arguments).unwrap(),
    )
    .unwrap();
    assert_eq!(result["command"]["exitCode"], 0, "{result}");
    assert!(result["command"]["output"]
        .as_str()
        .unwrap()
        .contains("actual CSV total 15"));
    let output = result["outputs"][0]["path"].as_str().unwrap();
    assert_eq!(
        fs::read_to_string(root.join(output)).unwrap(),
        "total\n15\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("data.csv")).unwrap(),
        "name,value\nAlpha,6\nBeta,9\n"
    );
    let failed: Value = serde_json::from_str(
        &execute_in(
            &root,
            authority.begin_agent(1).unwrap(),
            request("echo partial > partial.txt & exit /b 7"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(failed["command"]["exitCode"], 7);
    assert_eq!(failed["outputs"], json!([]));
    let mut timed = request(
        "node -e \"setTimeout(()=>require('fs').writeFileSync('late.txt','escape'),4000)\"",
    );
    timed["timeoutSeconds"] = json!(1);
    let timeout: Value =
        serde_json::from_str(&execute_in(&root, authority.begin_agent(1).unwrap(), timed).unwrap())
            .unwrap();
    assert_eq!(timeout["command"]["interrupted"], true);
    assert_eq!(timeout["outputs"], json!([]));
    let a = authority.clone();
    let stop = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        a.revoke(1).unwrap();
    });
    assert!(execute_in(
        &root,
        authority.begin_agent(1).unwrap(),
        request(
            "node -e \"setTimeout(()=>require('fs').writeFileSync('late.txt','escape'),4000)\""
        )
    )
    .is_err());
    stop.join().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(4));
    assert!(!root.join("late.txt").exists());
    assert_eq!(fs::read_dir(root.join("Generated")).unwrap().count(), 1);
    assert!(root
        .parent()
        .unwrap()
        .read_dir()
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("workspace-")));
    println!("Actual projectless CSV analysis passed; selected inputs only, network/host files absent, original preserved, bounded output receipt, timeout/Stop discarded all results and cleaned staging.");
}
