//! User-selected repository snapshots. Host source paths and archive bytes never
//! enter the renderer or model. Importing does not execute repository code.
use super::LocalComputerState;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    sync::Arc,
};
use tauri::State;

const MAX_ARCHIVE: u64 = 64 * 1024 * 1024;
const MAX_EXPANDED: u64 = 256 * 1024 * 1024;
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryImport {
    relative_path: String,
    files: usize,
    skipped: usize,
    size_bytes: u64,
}

fn entry_path(name: &str) -> Result<Option<String>, String> {
    let name = name.trim_end_matches('/');
    if name.is_empty()
        || name.len() > 512
        || name.contains(['\\', ':'])
        || name.chars().any(char::is_control)
    {
        return Err("The archive contains an unsafe file path.".into());
    }
    for part in name.split('/') {
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.starts_with(' ')
            || part.ends_with([' ', '.'])
        {
            return Err("The archive contains an unsafe file path.".into());
        }
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or("");
        if matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("The archive contains a reserved file path.".into());
        }
        if matches!(
            lower.as_str(),
            ".git"
                | ".ssh"
                | ".aws"
                | ".azure"
                | ".npmrc"
                | ".pypirc"
                | ".netrc"
                | "node_modules"
                | "target"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".ds_store"
        ) || lower == ".env"
            || lower.starts_with(".env.")
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || lower.ends_with(".p12")
            || lower.ends_with(".pfx")
        {
            return Ok(None);
        }
    }
    Ok(Some(name.to_string()))
}

fn extract_archive(bytes: &[u8], destination: &Path) -> Result<(usize, usize, u64), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "Choose a valid ZIP repository snapshot.")?;
    if archive.len() > MAX_ENTRIES {
        return Err("The repository archive contains too many entries.".into());
    }
    let mut names = HashSet::new();
    let (mut count, mut skipped, mut total) = (0, 0, 0u64);
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Encrypted or unreadable repository entries are unsupported.")?;
        if entry
            .unix_mode()
            .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("Repository archives cannot contain links or special files.".into());
        }
        let path = entry_path(entry.name())?;
        total = total
            .checked_add(entry.size())
            .ok_or("The repository archive is too large.")?;
        if entry.size() > MAX_FILE || total > MAX_EXPANDED {
            return Err("The expanded repository exceeds the import limit.".into());
        }
        let Some(path) = path else {
            skipped += 1;
            continue;
        };
        if !names.insert(path.to_lowercase()) {
            return Err("The archive contains duplicate file paths.".into());
        }
        let output = destination.join(path);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|_| "The repository folder could not be created.")?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "The repository folder could not be created.")?;
        }
        let expected = entry.size();
        let mut content = Vec::new();
        entry
            .by_ref()
            .take(MAX_FILE + 1)
            .read_to_end(&mut content)
            .map_err(|_| "The repository file could not be read.")?;
        if content.len() as u64 != expected {
            return Err("The repository file has an invalid expanded size.".into());
        }
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(|_| "The repository file could not be created.")?;
        file.write_all(&content)
            .map_err(|_| "The repository file could not be written.")?;
        count += 1;
    }
    if count == 0 {
        return Err("The repository archive contains no importable files.".into());
    }
    Ok((count, skipped, total))
}

#[tauri::command]
pub async fn local_computer_import_repository(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
) -> Result<Option<RepositoryImport>, String> {
    if window.label() != "main" {
        return Err("Repository import belongs to the main Mivlet window.".into());
    }
    state.validate_target(&workspace_id, &agent_id)?;
    state
        .authority_for(&workspace_id, &agent_id)?
        .begin_agent(expected_generation)?
        .finish(Ok(()))?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Import a repository ZIP snapshot")
        .add_filter("Repository ZIP", &["zip"])
        .pick_file()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Re-check authorization after the user-controlled dialog and hold the
        // generation ticket through publication. Stage outside the guest mount.
        state.with_agent_files(&workspace_id, &agent_id, expected_generation, |root| {
            let path = crate::paths::strict_canonicalize(selected.path())
                .map_err(|_| "Choose a regular local repository ZIP file.")?;
            let file =
                File::open(path).map_err(|_| "The selected repository could not be opened.")?;
            let metadata = file
                .metadata()
                .map_err(|_| "The selected repository could not be read.")?;
            if !metadata.is_file() || metadata.len() > MAX_ARCHIVE {
                return Err("Choose a repository ZIP smaller than 64 MB.".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_ARCHIVE + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "The repository archive could not be read.")?;
            if bytes.len() as u64 > MAX_ARCHIVE {
                return Err("The repository archive is too large.".into());
            }
            let staging = tempfile::Builder::new()
                .prefix("repo-import-")
                .tempdir_in(&state.root)
                .map_err(|_| "Repository staging is unavailable.")?;
            let (files, skipped, size_bytes) = extract_archive(&bytes, staging.path())?;
            let relative_path = format!("repo-{}", super::desktop_tools::opaque_id()?);
            let destination = root.join(&relative_path);
            if destination.exists() {
                return Err("Choose the repository again to create a fresh copy.".into());
            }
            fs::rename(staging.path(), &destination)
                .map_err(|_| "The repository snapshot could not be imported.")?;
            Ok(Some(RepositoryImport {
                relative_path,
                files,
                skipped,
                size_bytes,
            }))
        })
    })
    .await
    .map_err(|_| "Repository import could not finish.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn extraction_copies_source_and_omits_private_files() {
        let temp = tempfile::tempdir().unwrap();
        let bytes = archive(&[
            ("repo/src/app.ts", b"export const value = 1;"),
            ("repo/.env", b"EXAMPLE=private"),
            ("repo/.git/config", b"private remote"),
        ]);
        let result = extract_archive(&bytes, temp.path()).unwrap();
        assert_eq!((result.0, result.1), (1, 2));
        assert_eq!(
            fs::read_to_string(temp.path().join("repo/src/app.ts")).unwrap(),
            "export const value = 1;"
        );
        assert!(!temp.path().join("repo/.env").exists());
        assert!(!temp.path().join("repo/.git").exists());
    }
    #[test]
    fn extraction_rejects_case_collisions_and_traversal() {
        for entries in [
            vec![
                ("repo/A.ts", b"one".as_slice()),
                ("repo/a.ts", b"two".as_slice()),
            ],
            vec![("../escape", b"bad".as_slice())],
        ] {
            let temp = tempfile::tempdir().unwrap();
            assert!(extract_archive(&archive(&entries), temp.path()).is_err());
        }
    }
    #[test]
    fn paths_exclude_credentials_and_dependencies() {
        for path in [
            "repo/.env",
            "repo/.git/config",
            "repo/node_modules/x.js",
            "repo/.env.local",
            "repo/key.pem",
        ] {
            assert_eq!(entry_path(path).unwrap(), None);
        }
        assert_eq!(
            entry_path("repo/src/app.ts").unwrap(),
            Some("repo/src/app.ts".into())
        );
        assert_eq!(
            entry_path("repo/.github/workflows/test.yml").unwrap(),
            Some("repo/.github/workflows/test.yml".into())
        );
    }
    #[test]
    fn paths_reject_traversal_and_windows_aliases() {
        for path in [
            "../x",
            "/x",
            "repo/../x",
            "repo\\x",
            "C:/x",
            "repo/NUL.txt",
            "repo/x.",
        ] {
            assert!(entry_path(path).is_err(), "{path}");
        }
    }
}
