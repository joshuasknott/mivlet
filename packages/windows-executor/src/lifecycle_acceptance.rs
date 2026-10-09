//! Actual restricted-process acceptance; never launches a host shell fallback.
use super::*;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("Executor package belongs to the workspace")
        .join("apps/desktop/src-tauri/resources/execution-runtime/runtime")
}
fn binding(operation_id: u64) -> Binding {
    Binding {
        scope_id: "5".repeat(64),
        generation: 1,
        operation_id,
    }
}

#[test]
#[ignore = "Real LPAC process: requires prepared bundled runtimes and native execution setup"]
fn native_live_persistent_server_acceptance() {
    persistent_job_lifecycle_acceptance(
        r#"
const fs=require('node:fs'), http=require('node:http'), cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('late.txt','escaped'),15000)"],{detached:true,stdio:'ignore'}); child.unref();
const server=http.createServer((req,res)=>res.end('disposable native development server'));
server.listen(0,'127.0.0.1',()=>{
  fs.writeFileSync('ready.json',JSON.stringify({pid:child.pid, port:server.address().port}));
  console.log('SERVER_LISTENING '+server.address().port+' CHILD='+child.pid);
  process.stdout.write('token=synthetic-');
  setTimeout(()=>process.stdout.write('canary-value\n'),50);
});
setInterval(()=>console.log('server heartbeat'),200);
"#,
        "SERVER_LISTENING",
        1,
    );
}

#[test]
#[ignore = "Real LPAC live output and Stop: requires bundled runtimes and native setup"]
fn native_live_persistent_process_acceptance() {
    persistent_job_lifecycle_acceptance(
        r#"
const fs=require('node:fs'), cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('late.txt','escaped'),15000)"],{detached:true,stdio:'ignore'}); child.unref();
fs.writeFileSync('ready.json',JSON.stringify({pid:child.pid}));
console.log('PROCESS_READY CHILD='+child.pid);
process.stdout.write('token=synthetic-');
setTimeout(()=>process.stdout.write('canary-value\n'),50);
setInterval(()=>console.log('process heartbeat'),200);
"#,
        "PROCESS_READY",
        4,
    );
}

fn persistent_job_lifecycle_acceptance(script: &str, ready_marker: &str, operation_id: u64) {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("persistent.js"), script).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let stopped = cancel.clone();
    let log =
        OutputLog::new(|_, text| text.replace("token=synthetic-canary-value", "token=[REDACTED]"));
    let observed = log.clone();
    let path = source.path().to_owned();
    let worker = std::thread::spawn(move || {
        run_with_output(
            &resources(),
            &path,
            "node persistent.js",
            false,
            60,
            Limits::ANALYSIS,
            binding(operation_id),
            ExecutionMode::Persistent,
            log,
            || !stopped.load(Ordering::Acquire),
            |launch| launch(),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut cursor = 0;
    let mut seen = String::new();
    loop {
        let page = observed.read(cursor).unwrap();
        cursor = page.next_cursor;
        for frame in page.frames {
            seen.push_str(&frame.text);
        }
        if seen.contains(ready_marker) && seen.contains("[REDACTED]") {
            break;
        }
        if worker.is_finished() || Instant::now() >= deadline {
            cancel.store(true, Ordering::Release);
            panic!(
                "Persistent job failed to produce live output: {seen}; result: {:?}",
                worker.join().unwrap().map(|run| run.receipt().clone())
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !worker.is_finished(),
        "Logs were withheld until process exit"
    );
    assert!(!seen.contains("synthetic-canary-value"));
    println!("Observed while job was running:\n{seen}");
    use windows_sys::Win32::{
        Foundation::*, Storage::FileSystem::SYNCHRONIZE, System::Threading::*,
    };
    let pid = seen
        .split("CHILD=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    // Pin the exact descendant before Stop; do not infer termination from a
    // recycled or no-longer-openable PID after the fact.
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        cancel.store(true, Ordering::Release);
        let _ = worker.join();
        panic!("Cannot observe owned descendant before Stop");
    }
    cancel.store(true, Ordering::Release);
    let completed = worker.join().unwrap().unwrap();
    let descendant_status = unsafe { WaitForSingleObject(handle, 5000) };
    unsafe {
        CloseHandle(handle);
    }
    assert_eq!(
        descendant_status, WAIT_OBJECT_0,
        "Detached child survived Stop"
    );
    assert!(completed.receipt().interrupted && completed.receipt().persistent);
    assert!(completed.receipt().output_id.is_none());
    assert!(completed.import_repository(source.path()).is_err());
    assert!(
        !source.path().join("ready.json").exists(),
        "Persistent writes reached the source"
    );
    assert!(!completed.work().join("late.txt").exists());
    println!("Stop confirmed, all job descendants ended; persistent snapshot is not importable.");
}

#[test]
#[ignore = "Real LPAC build/test output: requires bundled runtimes and native setup"]
fn native_successful_persistent_job_never_imports() {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("original.txt"), "original").unwrap();
    let completed = run_with_output(
        &resources(),
        source.path(),
        "echo changed>original.txt",
        false,
        30,
        Limits::ANALYSIS,
        binding(3),
        ExecutionMode::Persistent,
        OutputLog::new(|_, text| text.to_owned()),
        || true,
        |launch| launch(),
    )
    .unwrap();
    assert_eq!(completed.receipt().exit_code, Some(0));
    assert!(!completed.receipt().interrupted);
    assert!(completed.receipt().persistent);
    assert!(completed.receipt().output_id.is_none());
    assert!(completed
        .verify_seal()
        .unwrap_err()
        .contains("never importable"));
    assert!(completed.import_repository(source.path()).is_err());
    assert_eq!(
        fs::read_to_string(source.path().join("original.txt")).unwrap(),
        "original"
    );
    assert!(fs::read_to_string(completed.work().join("original.txt"))
        .unwrap()
        .contains("changed"));
}

#[test]
#[ignore = "Real LPAC build/test output: requires bundled runtimes and native setup"]
fn native_live_build_and_test_acceptance() {
    let source = tempfile::tempdir().unwrap();
    fs::write(
        source.path().join("package.json"),
        r#"{"scripts":{"build":"node --check app.js","test":"node --test app.test.js"}}"#,
    )
    .unwrap();
    fs::write(
        source.path().join("app.js"),
        "module.exports = (a,b) => a+b;\n",
    )
    .unwrap();
    fs::write(source.path().join("app.test.js"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('actual addition',()=>assert.equal(require('./app')(2,3),5));\n").unwrap();
    let log = OutputLog::new(|_, text| text.to_owned());
    let completed = run_with_output(
        &resources(),
        source.path(),
        "npm run build && npm test",
        false,
        60,
        Limits::ANALYSIS,
        binding(2),
        ExecutionMode::Command,
        log.clone(),
        || true,
        |launch| launch(),
    )
    .unwrap();
    assert_eq!(
        completed.receipt().exit_code,
        Some(0),
        "Restricted build/test failed: interrupted={}, reason={:?}, elapsed={}ms\n{}",
        completed.receipt().interrupted,
        completed.receipt().reason,
        completed.receipt().elapsed_ms,
        completed.receipt().output
    );
    assert!(!completed.receipt().interrupted);
    assert!(completed.receipt().output.contains("actual addition"));
    assert!(completed.receipt().output.contains("node --check app.js"));
    assert!(log.read(0).unwrap().closed);
    println!(
        "Actual restricted native build/test logs:\n{}",
        completed.receipt().output
    );
}
