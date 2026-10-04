//! Private crash journals, immutable metadata receipts, and maintenance leases.
//! An anonymous kill-on-close job ends commands on host death. Recovery never
//! replays commands, imports bytes, or infers success from a surviving snapshot.
use crate::{files, security, setup, Receipt};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::fs::OpenOptionsExt,
    path::Path,
};
use windows_sys::Win32::{
    Security::Isolation::DeleteAppContainerProfile, Storage::FileSystem::FILE_SHARE_READ,
};

pub(crate) struct Lease {
    _installation: File,
    _run: File,
}
fn write_once(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(0)
        .open(path)
        .map_err(|_| "Cannot create immutable execution receipt.")?;
    serde_json::to_writer(&mut file, value).map_err(|_| "Cannot write execution receipt.")?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist execution receipt.".to_owned())
}
pub(crate) fn installation(root: &Path, maintenance: bool) -> Result<File, String> {
    let path = root.join("maintenance.lock");
    files::strict_path(&path)?;
    OpenOptions::new()
        .read(true)
        .write(maintenance)
        .share_mode(if maintenance { 0 } else { FILE_SHARE_READ })
        .open(path)
        .map_err(|_| {
            "Native execution is active or setup is being repaired. Stop commands and retry."
                .to_owned()
        })
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
        .share_mode(0)
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
    let _installation = installation(&root, false)?;
    let mut count = 0;
    for entry in fs::read_dir(&root).map_err(|_| "Cannot inspect execution recovery state.")? {
        let entry = entry.map_err(|_| "Cannot inspect execution recovery state.")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("run-") {
            continue;
        }
        let path = files::strict_path(&entry.path())?;
        // A live process (including an unimported result) holds this exclusive
        // handle. Sharing failure is never treated as evidence of host death.
        let lease = match OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
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
}
