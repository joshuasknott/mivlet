use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
#[derive(Deserialize)]
struct Inventory {
    version: u32,
    files: BTreeMap<String, String>,
}
const INVENTORY: &str =
    include_str!("../../../apps/desktop/src-tauri/resources/execution-runtime/files.json");
pub(crate) fn stage(
    resources: &Path,
    destination: &Path,
    current: &impl Fn() -> bool,
) -> Result<String, String> {
    visit(resources, Some(destination), current)
}
pub(crate) fn verify(resources: &Path) -> Result<String, String> {
    visit(resources, None, &|| true)
}
fn visit(
    resources: &Path,
    destination: Option<&Path>,
    current: &impl Fn() -> bool,
) -> Result<String, String> {
    let inventory: Inventory =
        serde_json::from_str(INVENTORY).map_err(|_| "Native runtime inventory is invalid.")?;
    if inventory.version != 1 || inventory.files.len() > 10000 {
        return Err("Native runtime inventory is unsupported.".into());
    }
    crate::files::strict_path(resources).map_err(|_| {
        "The bundled execution runtime is missing. Repair the Mivlet installation.".to_owned()
    })?;
    for (relative, expected) in inventory.files {
        if !current() {
            return Err("Execution stopped during runtime preparation.".into());
        }
        let bytes =
            crate::files::read(&resources.join(&relative), 128 * 1024 * 1024).map_err(|_| {
                "The bundled execution runtime failed its path or size check. Repair Mivlet."
                    .to_owned()
            })?;
        if hex::encode(Sha256::digest(&bytes)) != expected {
            return Err("The bundled execution runtime checksum changed. Repair Mivlet; execution remains blocked.".into());
        }
        if let Some(destination) = destination {
            let target = destination.join(relative);
            fs::create_dir_all(target.parent().ok_or("Invalid runtime path.")?)
                .map_err(|_| "Cannot stage execution runtime.")?;
            fs::write(target, bytes).map_err(|_| "Cannot stage execution runtime.")?;
        }
    }
    Ok(hex::encode(Sha256::digest(INVENTORY.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_and_tampered_resources_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        assert!(verify(root.path()).unwrap_err().contains("path or size"));
        let inventory: Inventory = serde_json::from_str(INVENTORY).unwrap();
        let first = inventory.files.keys().next().unwrap();
        let file = root.path().join(first);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, b"tampered runtime").unwrap();
        assert!(verify(root.path()).unwrap_err().contains("checksum"));
    }
}
