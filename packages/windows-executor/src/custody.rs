//! Private crash journals, immutable metadata receipts, and maintenance leases.
//! An anonymous kill-on-close job ends commands on host death. Recovery never
//! replays commands, imports bytes, or infers success from a surviving snapshot.
use crate::{files, security, setup, ExecutionDirectory, Receipt};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::Path,
};
use windows_sys::Win32::{
    Security::Isolation::DeleteAppContainerProfile,
    Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ},
};

pub(crate) struct Lease {
    _installation: File,
    _run: File,
}
fn write_once(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    write_once_at(path, value, || {})
}
fn write_once_at(
    path: &Path,
    value: &serde_json::Value,
    during_write: impl FnOnce(),
) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid receipt parent.")?)
        .map_err(|_| "Cannot create immutable execution receipt.")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot write execution receipt.")?;
    let middle = bytes.len() / 2;
    file.write_all(&bytes[..middle])
        .map_err(|_| "Cannot write execution receipt.")?;
    during_write();
    file.write_all(&bytes[middle..])
        .map_err(|_| "Cannot write execution receipt.")?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot persist execution receipt.".to_owned())?;
    file.persist_noclobber(path)
        .map_err(|_| "Cannot publish immutable execution receipt.")?;
    Ok(())
}
fn initialization(root: &Path) -> Result<File, String> {
    files::strict_path(root)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root.join("initialization.lock"))
        .map_err(|_| "Native custody initialization or recovery is active; retry shortly.")?;
    files::regular_file(&file)?;
    Ok(file)
}
pub(crate) fn prepare_run(
    root: &Path,
    id: &str,
    binding: &crate::Binding,
    command_id: &str,
    network: bool,
) -> Result<(ExecutionDirectory, Lease), String> {
    let _initialization = initialization(root)?;
    let mut directory = ExecutionDirectory::create(root.join(format!("preparing-{id}")))?;
    let Lease {
        _installation,
        _run,
    } = begin(root, directory.path(), id, binding, command_id, network)?;
    // Windows cannot rename this directory with the exclusive child-file lease
    // open. The installation initialization lock excludes every recoverer while
    // we close it, publish the complete intent, and reacquire final run custody.
    drop(_run);
    directory.publish(root.join(format!("run-{id}")))?;
    let _run = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(directory.path().join("lease"))
        .map_err(|_| "Cannot acquire published native execution custody.")?;
    files::regular_file(&_run)?;
    let lease = Lease {
        _installation,
        _run,
    };
    Ok((directory, lease))
}
pub(crate) fn installation(root: &Path, maintenance: bool) -> Result<File, String> {
    let path = root.join("maintenance.lock");
    files::strict_path(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(maintenance)
        .share_mode(if maintenance { 0 } else { FILE_SHARE_READ })
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| {
            "Native execution is active or setup is being repaired. Stop commands and retry."
                .to_owned()
        })?;
    files::regular_file(&file)?;
    Ok(file)
}
pub(crate) fn begin(
    root: &Path,
    run: &Path,
    id: &str,
    binding: &crate::Binding,
    command_id: &str,
    network: bool,
) -> Result<Lease, String> {
    let installation = installation(root, false)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_DELETE)
        .open(run.join("lease"))
        .map_err(|_| "Cannot acquire native execution custody.")?;
    write_once(
        &run.join("prepared.json"),
        &serde_json::json!({"version":1,"runId":id,"profile":format!("Mivlet.Exec.{id}"),"binding":binding,"commandId":command_id,"network":network,"state":"uncertain","notice":"No command or output is replayed after interruption."}),
    )?;
    Ok(Lease {
        _installation: installation,
        _run: file,
    })
}
pub(crate) fn seal(root: &Path, receipt: &Receipt) -> Result<(), String> {
    let mut value = serde_json::to_value(receipt).map_err(|_| "Invalid execution receipt.")?;
    let object = value.as_object_mut().ok_or("Invalid execution receipt.")?;
    object.remove("output");
    object.insert(
        "outputDigest".into(),
        serde_json::json!(hex::encode(Sha256::digest(receipt.output.as_bytes()))),
    );
    let receipts = root.join("receipts");
    fs::create_dir_all(&receipts).map_err(|_| "Cannot preserve execution receipt.")?;
    files::strict_path(&receipts)?;
    write_once(&receipts.join(format!("{}.json", receipt.run_id)), &value)
}
pub fn recover() -> Result<usize, String> {
    let root = setup::ready()?;
    recover_in(&root)
}
fn recover_in(root: &Path) -> Result<usize, String> {
    let _initialization = initialization(root)?;
    let _installation = installation(root, false)?;
    let mut count = 0;
    for entry in fs::read_dir(root).map_err(|_| "Cannot inspect execution recovery state.")? {
        let entry = entry.map_err(|_| "Cannot inspect execution recovery state.")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_prefix("preparing-") {
            if id.len() != 48 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(
                    "Unrecognized native preparation custody; inspect before continuing.".into(),
                );
            }
            let path = files::strict_path(&entry.path())?;
            let mut entries = 0usize;
            for child in
                fs::read_dir(&path).map_err(|_| "Cannot inspect interrupted preparation.")?
            {
                entries += 1;
                if entries > 3 {
                    return Err(
                        "Interrupted preparation has unexpected entries; files preserved.".into(),
                    );
                }
                let child = child.map_err(|_| "Cannot inspect interrupted preparation.")?;
                let name = child.file_name().to_string_lossy().into_owned();
                // Before publication only the lease and journal files exist.
                // Atomic receipt writes may leave one incomplete temp file.
                if !matches!(name.as_str(), "lease" | "prepared.json") && !name.starts_with(".tmp")
                {
                    return Err("Unexpected interrupted preparation entry; files preserved.".into());
                }
                let file = security::locked_file(&files::strict_path(&child.path())?)?;
                if file
                    .metadata()
                    .map_err(|_| "Cannot inspect preparation file.")?
                    .len()
                    > 8192
                {
                    return Err("Interrupted preparation exceeded its bound.".into());
                }
            }
            fs::create_dir_all(root.join("receipts"))
                .map_err(|_| "Cannot preserve preparation uncertainty.")?;
            files::strict_path(&root.join("receipts"))?;
            let receipt = root.join("receipts").join(format!("{id}.json"));
            if !receipt.exists() {
                write_once(
                    &receipt,
                    &serde_json::json!({"runId":id,"executor":"windows-lpac-v1","interrupted":true,"reason":"host interrupted during preparation; no command started or replayed"}),
                )?;
            }
            fs::remove_dir_all(path).map_err(|_| "Cannot remove interrupted preparation.")?;
            count += 1;
            continue;
        }
        if !name.starts_with("run-") {
            continue;
        }
        let path = files::strict_path(&entry.path())?;
        // A live process (including an unimported result) holds this exclusive
        // handle. Sharing failure is never treated as evidence of host death.
        let lease = match OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path.join("lease"))
        {
            Ok(v) => v,
            Err(e) if e.raw_os_error() == Some(32) => continue,
            Err(_) => {
                return Err(
                    "Native recovery lease needs inspection; commands remain blocked.".into(),
                )
            }
        };
        files::regular_file(&lease)?;
        let value: serde_json::Value =
            serde_json::from_slice(&files::read(&path.join("prepared.json"), 4096)?)
                .map_err(|_| "Native recovery journal is invalid.")?;
        let id = value["runId"]
            .as_str()
            .filter(|s| s.len() == 48 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("Native recovery identity is invalid.")?;
        let profile = format!("Mivlet.Exec.{id}");
        if value["version"] != 1 || value["profile"] != profile {
            return Err("Native recovery identity changed.".into());
        }
        if unsafe { DeleteAppContainerProfile(security::wide(profile).as_ptr()) } < 0 {
            return Err(
                "Native profile recovery failed; staging preserved and commands blocked.".into(),
            );
        }
        let receipt = root.join("receipts").join(format!("{id}.json"));
        if !receipt.exists() {
            fs::create_dir_all(root.join("receipts"))
                .map_err(|_| "Cannot preserve uncertain execution receipt.")?;
            write_once(
                &receipt,
                &serde_json::json!({"runId":id,"executor":"windows-lpac-v1","binding":value["binding"],"commandId":value["commandId"],"network":value["network"],"interrupted":true,"reason":"host interrupted; outcome uncertain; no outputs imported"}),
            )?;
        }
        // Strictly inspect every descendant before recursive removal; never
        // follow an attacker-created junction left by an interrupted process.
        let mut stack = vec![path.clone()];
        while let Some(p) = stack.pop() {
            files::strict_path(&p)?;
            if p.is_dir() {
                for child in fs::read_dir(p).map_err(|_| "Cannot inspect recovery tree.")? {
                    stack.push(child.map_err(|_| "Cannot inspect recovery tree.")?.path());
                }
            }
        }
        drop(lease);
        fs::remove_dir_all(&path).map_err(|_| {
            "Native recovery could not remove abandoned staging; commands remain blocked."
        })?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_publishes_only_complete_journals_under_a_live_lease() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("maintenance.lock"), b"1").unwrap();
        let binding = crate::Binding {
            scope_id: "a".repeat(64),
            generation: 1,
            operation_id: 1,
        };
        let (directory, _lease) = prepare_run(
            root.path(),
            &"b".repeat(48),
            &binding,
            &"c".repeat(64),
            false,
        )
        .unwrap();
        assert!(directory.path().join("prepared.json").exists());
        assert!(directory
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("run-"));
        assert_eq!(
            recover_in(root.path()).unwrap(),
            0,
            "Live custody was recovered"
        );
    }
    #[test]
    fn receipts_are_create_once_without_raw_output() {
        let root = tempfile::tempdir().unwrap();
        let receipt = Receipt {
            run_id: "a".repeat(48),
            output: "private-canary-output".into(),
            ..Default::default()
        };
        seal(root.path(), &receipt).unwrap();
        let saved = fs::read_to_string(
            root.path()
                .join("receipts")
                .join(format!("{}.json", receipt.run_id)),
        )
        .unwrap();
        assert!(!saved.contains("private-canary-output"));
        assert!(saved.contains("outputDigest"));
        assert!(seal(root.path(), &receipt).is_err());
    }
    #[test]
    #[ignore = "Only invoked in a disposable preparation crash supervisor"]
    fn preparation_crash_probe() {
        let root =
            std::path::PathBuf::from(std::env::var_os("MIVLET_PREPARATION_CRASH_ROOT").unwrap());
        let _initialization = initialization(&root).unwrap();
        let path = root.join(format!("preparing-{}", "e".repeat(48)));
        fs::create_dir(&path).unwrap();
        let _lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(FILE_SHARE_DELETE)
            .open(path.join("lease"))
            .unwrap();
        write_once_at(
            &path.join("prepared.json"),
            &serde_json::json!({"runId":"e".repeat(48),"binding":{"scopeId":"f".repeat(64)}}),
            || {
                fs::write(root.join("preparation-ready"), b"partial journal").unwrap();
                std::thread::sleep(std::time::Duration::from_secs(60));
            },
        )
        .unwrap();
        panic!("Preparation supervisor failed to kill probe");
    }
    #[test]
    fn partial_preparation_host_death_is_recoverable_and_unknown_entries_block() {
        use std::{
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("maintenance.lock"), b"1").unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "custody::tests::preparation_crash_probe",
                "--nocapture",
            ])
            .env("MIVLET_PREPARATION_CRASH_ROOT", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !root.path().join("preparation-ready").exists() {
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Preparation probe did not reach partial write");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let path = root.path().join(format!("preparing-{}", "e".repeat(48)));
        assert!(!path.join("prepared.json").exists());
        assert_eq!(recover_in(root.path()).unwrap(), 1);
        assert!(!path.exists());
        assert_eq!(recover_in(root.path()).unwrap(), 0);
        let receipt: serde_json::Value = serde_json::from_slice(
            &fs::read(
                root.path()
                    .join("receipts")
                    .join(format!("{}.json", "e".repeat(48))),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(receipt["reason"]
            .as_str()
            .unwrap()
            .contains("no command started"));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("unexpected-command.cmd"), b"unrecognized").unwrap();
        assert!(recover_in(root.path()).is_err());
        assert!(path.join("unexpected-command.cmd").exists());
    }
}
