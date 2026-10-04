use super::*;
use std::{fs, ptr, time::Duration};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Credentials::*, Cryptography::*},
};
fn resources() -> PathBuf {
    std::fs::canonicalize(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources/execution-runtime/runtime"),
    )
    .unwrap()
}
fn execute(root: &Path, command: &str, seconds: u64) -> CompletedRun {
    run(
        &resources(),
        root,
        command,
        false,
        seconds,
        Limits::ANALYSIS,
        Binding {
            scope_id: "0".repeat(64),
            generation: 1,
            operation_id: 1,
        },
        || true,
    )
    .unwrap()
}

#[test]
#[ignore = "Invoked only inside the native acceptance AppContainer"]
fn credential_probe() {
    let name = fs::read_to_string("credential-name.txt").unwrap();
    let mut credential = ptr::null_mut();
    assert_eq!(
        unsafe {
            CredReadW(
                security::wide(name).as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut credential,
            )
        },
        0,
        "Host Credential Manager entry became accessible"
    );
    let mut bytes = fs::read("sealed.bin").unwrap();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let unprotected = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            0,
            &mut output,
        )
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData.cast());
        }
    }
    assert_eq!(unprotected, 0, "Host DPAPI ciphertext became decryptable");
    println!("Credential Manager and DPAPI denied under native LPAC token");
}

#[test]
#[ignore = "Requires bounded native execution setup and prepared Windows runtime"]
fn native_execution_acceptance() {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("data.csv"), "name,value\nA,6\nB,9\n").unwrap();
    fs::write(source.path().join("analysis.py"),"import csv,os,socket\nassert 'OPENAI_API_KEY' not in os.environ\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=0.2)\n raise AssertionError('network escaped')\nexcept OSError: pass\nwith open('data.csv') as f: total=sum(int(x['value']) for x in csv.DictReader(f))\nwith open('result.csv','w') as f: f.write('total\\n'+str(total)+'\\n')\nprint('actual CSV total',total)\n").unwrap();
    let analysis = execute(source.path(), "python analysis.py", 20);
    println!("analysis receipt: {:?}", analysis.receipt);
    assert_eq!(analysis.receipt.exit_code, Some(0));
    assert!(!analysis.receipt.interrupted);
    assert_eq!(
        fs::read_to_string(analysis.work().join("result.csv"))
            .unwrap()
            .lines()
            .collect::<Vec<_>>(),
        vec!["total", "15"]
    );
    assert_eq!(
        fs::read_to_string(source.path().join("data.csv")).unwrap(),
        "name,value\nA,6\nB,9\n"
    );
    fs::write(analysis.work().join("result.csv"), "tampered after sealing").unwrap();
    assert!(analysis
        .import_repository(source.path())
        .unwrap_err()
        .contains("snapshot changed"));
    let outside = tempfile::tempdir().unwrap();
    let forbidden = outside.path().join("private.txt");
    fs::write(&forbidden, "private-test-canary").unwrap();
    fs::write(source.path().join("boundary.js"),format!("const fs=require('fs');for(const op of [()=>fs.readFileSync({path}),()=>fs.writeFileSync({path},'escaped')]){{let blocked=false;try{{op()}}catch(e){{blocked=true}}if(!blocked)throw Error('filesystem escaped')}}; console.log('forbidden read/write denied');",path=serde_json::to_string(&forbidden.to_string_lossy()).unwrap())).unwrap();
    let boundary = execute(source.path(), "node boundary.js", 20);
    println!("boundary receipt: {:?}", boundary.receipt);
    assert_eq!(boundary.receipt.exit_code, Some(0));
    assert_eq!(
        fs::read_to_string(&forbidden).unwrap(),
        "private-test-canary"
    );
    // A host credential and a deliberately supplied encrypted canary prove that
    // credential isolation is stronger than hiding filenames or clearing env.
    let target = format!("Mivlet.Execution.Test.{}", security::random_id().unwrap());
    let target_wide = security::wide(&target);
    let mut canary = b"mivlet-native-canary".to_vec();
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target_wide.as_ptr().cast_mut();
    credential.CredentialBlobSize = canary.len() as u32;
    credential.CredentialBlob = canary.as_mut_ptr();
    credential.Persist = CRED_PERSIST_SESSION;
    assert_ne!(unsafe { CredWriteW(&credential, 0) }, 0);
    let data = CRYPT_INTEGER_BLOB {
        cbData: canary.len() as u32,
        pbData: canary.as_mut_ptr(),
    };
    let mut sealed: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe {
            CryptProtectData(
                &data,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                0,
                &mut sealed,
            )
        },
        0
    );
    fs::write(source.path().join("sealed.bin"), unsafe {
        std::slice::from_raw_parts(sealed.pbData, sealed.cbData as usize)
    })
    .unwrap();
    unsafe {
        LocalFree(sealed.pbData.cast());
    }
    fs::write(source.path().join("credential-name.txt"), &target).unwrap();
    fs::copy(
        std::env::current_exe().unwrap(),
        source.path().join("probe.exe"),
    )
    .unwrap();
    let credentials = execute(
        source.path(),
        "probe.exe --ignored --exact acceptance::credential_probe --nocapture",
        20,
    );
    unsafe {
        CredDeleteW(target_wide.as_ptr(), CRED_TYPE_GENERIC, 0);
    }
    println!("credential receipt: {:?}", credentials.receipt);
    assert_eq!(credentials.receipt.exit_code, Some(0));
    let bounded = execute(
        source.path(),
        "node -e \"process.stdout.write('x'.repeat(100000))\"",
        20,
    );
    assert_eq!(bounded.receipt.exit_code, Some(0));
    assert!(bounded.receipt.truncated);
    assert!(bounded.receipt.output.len() <= 65536);
    fs::write(source.path().join("descendant.js"),"const cp=require('child_process');cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('escaped.txt','escape'),4000)\"],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},20000);").unwrap();
    let timeout = execute(source.path(), "node descendant.js", 1);
    assert!(timeout.receipt.interrupted);
    std::thread::sleep(Duration::from_secs(4));
    assert!(!timeout.work().join("escaped.txt").exists());
    assert!(timeout.import_repository(source.path()).is_err());
    fs::write(source.path().join("descendant.js"),"const cp=require('child_process');cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('escaped.txt','escape'),4000)\"],{detached:true,stdio:'ignore'}).unref();require('fs').writeFileSync('stop-ready.txt','ready');setTimeout(()=>{},20000);").unwrap();
    let installation = setup::ready().unwrap();
    let stopped = run(
        &resources(),
        source.path(),
        "node descendant.js",
        false,
        20,
        Limits::ANALYSIS,
        Binding {
            scope_id: "0".repeat(64),
            generation: 1,
            operation_id: 2,
        },
        || {
            !fs::read_dir(&installation)
                .unwrap()
                .filter_map(Result::ok)
                .any(|e| e.path().join("work/stop-ready.txt").exists())
        },
    )
    .unwrap();
    assert!(stopped.receipt.interrupted);
    std::thread::sleep(Duration::from_secs(4));
    assert!(!stopped.work().join("escaped.txt").exists());
    assert!(stopped.import_repository(source.path()).is_err());
    assert!(
        crate::custody::installation(&installation, true).is_err(),
        "Cleanup must wait until an unimported result releases custody"
    );
    println!("Native LPAC acceptance: CSV analysis, actual output/status, preserved input, forbidden reads/writes/network/credentials, output bound and descendant timeout/Stop verified.");
}

#[test]
#[ignore = "Only launched by the crash recovery acceptance supervisor"]
fn crash_probe() {
    let source = PathBuf::from(std::env::var_os("MIVLET_CRASH_SOURCE").unwrap());
    let _result = execute(&source, "node crash.js", 60);
    panic!("The crash probe should be terminated by its supervisor");
}

#[test]
#[ignore = "Requires prepared native runtime; terminates only its own probe host"]
fn native_crash_recovery_acceptance() {
    use std::process::{Command, Stdio};
    use std::time::Instant;
    let source = tempfile::tempdir().unwrap();
    let marker = format!("crash-ready-{}.txt", security::random_id().unwrap());
    fs::write(source.path().join("crash.js"),format!("require('assert').equal(process.env.MIVLET_EXECUTION_HOST_CANARY,undefined);const cp=require('child_process');cp.spawn(process.execPath,['-e',\"setTimeout(()=>require('fs').writeFileSync('escaped-after-crash.txt','escape'),4000)\"],{{detached:true,stdio:'ignore'}}).unref();require('fs').writeFileSync('{marker}','ready');setTimeout(()=>{{}},50000);")).unwrap();
    let installation = setup::ready().unwrap();
    let diagnostics = tempfile::tempfile().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "--ignored",
        "--exact",
        "acceptance::crash_probe",
        "--nocapture",
    ]);
    // Inherit the ordinary host environment to simulate actual app termination.
    // The executor constructs the sandbox's separate, cleared environment.
    let mut probe = command
        .env("MIVLET_EXECUTION_HOST_CANARY", "host-only-test-canary")
        .env("MIVLET_CRASH_SOURCE", source.path())
        .stdin(Stdio::null())
        .stdout(diagnostics.try_clone().unwrap())
        .stderr(diagnostics.try_clone().unwrap())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    let abandoned = loop {
        if let Some(path) = fs::read_dir(&installation)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.join("work").join(&marker).exists())
        {
            break path;
        }
        if Instant::now() > deadline || probe.try_wait().unwrap().is_some() {
            let _ = probe.kill();
            use std::io::{Read, Seek, SeekFrom};
            let mut diagnostics = diagnostics;
            diagnostics.seek(SeekFrom::Start(0)).unwrap();
            let mut output = String::new();
            diagnostics.take(8192).read_to_string(&mut output).unwrap();
            panic!("Crash probe did not reach actual native command execution: {output}");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let journal: serde_json::Value =
        serde_json::from_slice(&fs::read(abandoned.join("prepared.json")).unwrap()).unwrap();
    let id = journal["runId"].as_str().unwrap();
    probe.kill().unwrap();
    probe.wait().unwrap();
    std::thread::sleep(Duration::from_secs(5));
    assert!(
        !abandoned.join("work/escaped-after-crash.txt").exists(),
        "A descendant survived host death"
    );
    assert!(recover().unwrap() >= 1);
    assert!(!abandoned.exists());
    let receipt: serde_json::Value = serde_json::from_slice(
        &fs::read(installation.join("receipts").join(format!("{id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(receipt["interrupted"], true);
    assert_eq!(receipt["binding"], journal["binding"]);
    assert_eq!(receipt["commandId"], journal["commandId"]);
    assert!(receipt["reason"].as_str().unwrap().contains("uncertain"));
    assert!(!source.path().join(&marker).exists());
    println!("Actual host termination killed descendants; restart recovery preserved uncertainty, imported nothing and removed only abandoned custody.");
}

#[test]
#[ignore = "Requires prepared native runtime; makes an approved public HTTPS request"]
fn native_network_build_acceptance() {
    let source = tempfile::tempdir().unwrap();
    fs::write(source.path().join("package.json"),r#"{"name":"native-build-proof","version":"1.0.0","scripts":{"build":"node -e \"require('fs').writeFileSync('bundle.js','module.exports=15')\"","test":"node -e \"require('assert').equal(require('./bundle.js'),15); console.log('actual npm build/test passed')\""}}"#).unwrap();
    fs::write(source.path().join("network.js"),"require('https').get('https://nodejs.org/dist/index.json',r=>{if(r.statusCode!==200)process.exitCode=1;r.resume();r.on('end',()=>console.log('approved public HTTPS',r.statusCode))}).on('error',e=>{console.error(e);process.exitCode=1})").unwrap();
    let result = run(
        &resources(),
        source.path(),
        "npm run build && npm test && python -m pip --version && node network.js",
        true,
        60,
        Limits::ANALYSIS,
        Binding {
            scope_id: "0".repeat(64),
            generation: 1,
            operation_id: 3,
        },
        || true,
    )
    .unwrap();
    println!("native build/network receipt: {:?}", result.receipt);
    assert_eq!(result.receipt.exit_code, Some(0));
    assert!(result
        .receipt
        .output
        .contains("actual npm build/test passed"));
    assert!(result.receipt.output.contains("approved public HTTPS 200"));
    assert!(!source.path().join("bundle.js").exists());
}
