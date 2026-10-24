//! Native, bounded folder snapshots for project source selection.
//!
//! The renderer never supplies a host path. A native picker selects the folder,
//! then this module copies only bounded, supported text files into the encrypted
//! local knowledge store. The folder is not retained as a live mount.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::authorized_scope::{command_scope, AuthorizedCommandScope, ScopeAccess};
use crate::knowledge::import_local_text_file;
use crate::models::{
    LocalFileImport, LocalTextFileCandidate, MAX_IMPORTED_KNOWLEDGE_SOURCES, MAX_LOCAL_FILE_BYTES,
    SUPPORTED_LOCAL_FILE_EXTENSIONS,
};
use crate::paths::{contains_symlink, imported_knowledge_path, strict_canonicalize};
use crate::store::{self, StoreError};

const MAX_FOLDER_FILES: usize = 64;
const MAX_FOLDER_TOTAL_BYTES: u64 = (MAX_FOLDER_FILES as u64) * (MAX_LOCAL_FILE_BYTES as u64);
const MAX_FOLDER_DEPTH: usize = 8;
const MAX_FOLDER_ENTRIES: usize = 512;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSourceFolderImport {
    pub id: String,
    pub name: String,
    pub sources: Vec<LocalFileImport>,
    pub skipped_count: usize,
}

fn lower_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_hidden_or_secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with('.')
        || matches!(
            lower.as_str(),
            "node_modules" | "target" | "dist" | "build" | "coverage" | "vendor" | "__pycache__"
        )
        || lower
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "secret"
                        | "secrets"
                        | "credential"
                        | "credentials"
                        | "token"
                        | "tokens"
                        | "password"
                        | "passwords"
                        | "apikey"
                )
            })
        || lower.contains("api-key")
        || lower.contains("api_key")
}

fn supported_file(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    SUPPORTED_LOCAL_FILE_EXTENSIONS
        .iter()
        .any(|supported| extension.eq_ignore_ascii_case(supported))
}

fn looks_binary(content: &str) -> bool {
    if content.contains('\0') {
        return true;
    }
    let sample = content.chars().take(8_192).collect::<Vec<_>>();
    if sample.is_empty() {
        return false;
    }
    let controls = sample
        .iter()
        .filter(|character| character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
        .count();
    controls * 20 > sample.len()
}

fn valid_content(path: &Path, content: &str) -> bool {
    if content.is_empty() || looks_binary(content) {
        return false;
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        serde_json::from_str::<serde_json::Value>(content).is_ok()
    } else {
        true
    }
}

fn safe_relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let value = relative.to_str()?.replace('\\', "/");
    if value.is_empty()
        || value.chars().count() > 512
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(value)
}

fn enumerate_files(root: &Path) -> (Vec<(PathBuf, String)>, usize) {
    let mut pending = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut files = Vec::new();
    let mut skipped = 0_usize;
    let mut entries_seen = 0_usize;

    while let Some((directory, depth)) = pending.pop_front() {
        let Ok(entries) = fs::read_dir(&directory) else {
            skipped += 1;
            continue;
        };
        let mut children = Vec::new();
        for entry in entries {
            if entries_seen >= MAX_FOLDER_ENTRIES {
                skipped += 1;
                break;
            }
            entries_seen += 1;
            match entry {
                Ok(entry) => children.push(entry),
                Err(_) => skipped += 1,
            }
        }
        children.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());

        for child in children {
            let path = child.path();
            let name = lower_name(&path);
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                skipped += 1;
                continue;
            };
            if name.is_empty() || is_hidden_or_secret(&name) || contains_symlink(&path) {
                if metadata.is_file() {
                    skipped += 1;
                }
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_FOLDER_DEPTH {
                    pending.push_back((path, depth + 1));
                } else {
                    skipped += 1;
                }
                continue;
            }
            if !metadata.is_file() || !supported_file(&path) {
                skipped += 1;
                continue;
            }
            let Some(relative) = safe_relative(root, &path) else {
                skipped += 1;
                continue;
            };
            files.push((path, relative));
        }
    }

    files.sort_by(|left, right| left.1.cmp(&right.1));
    (files, skipped)
}

fn same_authority(before: &AuthorizedCommandScope, after: &AuthorizedCommandScope) -> bool {
    before.internal_user_id == after.internal_user_id
        && before.member_id == after.member_id
        && before.data.workspace_id() == after.data.workspace_id()
}

#[cfg(windows)]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let mut buffer = vec![0_u16; 32_768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("The selected file handle could not be verified.".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;

    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "The selected file handle could not be verified.".into())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn opened_path(_file: &File) -> Result<PathBuf, String> {
    Err("Secure source-folder imports are not supported on this operating system yet.".into())
}

/// Open a source only after canonical containment checks and validate the
/// actual handle. The handle is then used for the bounded read, so a path
/// swap after enumeration cannot redirect the import to another file.
fn open_source_file(root: &Path, path: &Path) -> Result<(File, u64), String> {
    let canonical_path = strict_canonicalize(path)
        .map_err(|_| "A source file changed or contains a link; choose the folder again.")?;
    if !canonical_path.starts_with(root) {
        return Err("A source file left the selected folder.".into());
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(&canonical_path)
        .map_err(|_| "A source file is unavailable or unreadable; choose the folder again.")?;
    let actual_path = opened_path(&file)?;
    if !actual_path.starts_with(root) || contains_symlink(&actual_path) {
        return Err("A source file changed or contains a link; choose the folder again.".into());
    }
    let metadata = file
        .metadata()
        .map_err(|_| "A source file's metadata is unavailable.")?;
    if !metadata.is_file() {
        return Err("A source entry is not a regular file.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if crate::paths::is_windows_reparse_point(metadata.file_attributes()) {
            return Err("Reparse points are not supported in source folders.".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("Links are not supported in source folders.".into());
    }
    Ok((file, metadata.len()))
}

fn persist_sources_to_knowledge(
    tx: &rusqlite::Transaction<'_>,
    encrypted: &store::Store,
    scope: &crate::store::repos::scope::PrivateDataScope,
    incoming: &[LocalFileImport],
    now: &str,
) -> store::Result<()> {
    for source in incoming {
        let value = serde_json::to_value(source).map_err(|_| {
            StoreError::Invalid("Mivlet could not encode imported knowledge sources.".into())
        })?;
        crate::store::repos::knowledge_source::upsert_private(tx, encrypted, scope, value, now)?;
    }
    Ok(())
}

fn append_sources_with_fence(
    path: &Path,
    scope: &crate::store::repos::scope::PrivateDataScope,
    incoming: &[LocalFileImport],
    fence: &crate::account_session::AccountDispatchFence,
) -> Result<(), String> {
    let encrypted = store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let (storage_scope, key) = store::private_document_location(path, scope)?;
    encrypted
        .transaction_with_account_fence(fence, |tx| {
            let current = crate::store::repos::preferences::get_scoped(
                tx,
                encrypted,
                &storage_scope,
                &key,
            )
            .map_err(|error| StoreError::Invalid(error.to_string()))?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| {
                StoreError::Invalid("Mivlet could not decode imported knowledge sources.".into())
            })?;
            let mut sources: Vec<LocalFileImport> = current.unwrap_or_default();
            let mut new_count = sources.len();
            for source in incoming {
                if sources
                    .iter()
                    .any(|existing| existing.id == source.id && existing.deleted_at.is_some())
                {
                    return Err(StoreError::Invalid(
                        "Deleted knowledge cannot be restored by a folder import.".into(),
                    ));
                }
                if !sources.iter().any(|existing| existing.id == source.id) {
                    new_count += 1;
                }
            }
            if new_count > MAX_IMPORTED_KNOWLEDGE_SOURCES {
                return Err(StoreError::Invalid(
                    "The local knowledge library is full. Remove older sources before importing this folder."
                        .into(),
                ));
            }
            let now = chrono::Utc::now().to_rfc3339();
            persist_sources_to_knowledge(tx, encrypted, scope, incoming, &now)?;
            for source in incoming {
                sources.retain(|existing| existing.id != source.id);
                sources.insert(0, source.clone());
            }
            let value = serde_json::to_value(sources)
                .map_err(|_| {
                    StoreError::Invalid("Mivlet could not encode imported knowledge sources.".into())
                })?;
            crate::store::repos::preferences::upsert_scoped(
                tx,
                encrypted,
                &storage_scope,
                &key,
                &value,
                &now,
            )
            .map_err(|error| StoreError::Invalid(error.to_string()))?;
            Ok(())
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_project_source_folder(
    window: tauri::WebviewWindow,
    workspace_id: String,
) -> Result<Option<ProjectSourceFolderImport>, String> {
    if window.label() != "main" {
        return Err("Folder source selection belongs to the main Mivlet window.".into());
    }
    let account_fence = crate::account_session::AccountDispatchFence::capture()?;
    let before = command_scope(Some(workspace_id.clone()), None, ScopeAccess::Write)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Add a source folder — Mivlet imports a bounded text snapshot")
        .pick_folder()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let after = command_scope(Some(workspace_id.clone()), None, ScopeAccess::Write)?;
    if !same_authority(&before, &after) {
        return Err("The account or workspace changed while choosing the source folder.".into());
    }

    let root = strict_canonicalize(selected.path())
        .map_err(|_| "Choose an existing local folder without links or junctions.")?;
    let folder_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !is_hidden_or_secret(value))
        .ok_or("Choose a named local source folder.")?
        .to_string();
    let folder_hash = Sha256::digest(
        format!(
            "{}\0{}",
            after.private.owner_subject(),
            root.to_string_lossy()
        )
        .as_bytes(),
    );
    let folder_id = format!("folder-{}", hex::encode(&folder_hash[..16]));
    let path = imported_knowledge_path(window.app_handle())?;
    let scope = after.private.clone();
    let workspace_for_worker = workspace_id.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let (files, mut skipped_count) = enumerate_files(&root);
        let imported_at = chrono::Utc::now().to_rfc3339();
        let mut total_bytes = 0_u64;
        let mut sources = Vec::new();
        for (index, (path, relative)) in files.into_iter().enumerate() {
            if index >= MAX_FOLDER_FILES {
                skipped_count += 1;
                continue;
            }
            let Ok((file, size)) = open_source_file(&root, &path) else {
                skipped_count += 1;
                continue;
            };
            if size > MAX_LOCAL_FILE_BYTES as u64
                || total_bytes.saturating_add(size) > MAX_FOLDER_TOTAL_BYTES
            {
                skipped_count += 1;
                continue;
            }
            let mut bytes = Vec::new();
            if file
                .take((MAX_LOCAL_FILE_BYTES as u64) + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() != size as usize
                || bytes.len() > MAX_LOCAL_FILE_BYTES
            {
                skipped_count += 1;
                continue;
            }
            let Ok(content) = String::from_utf8(bytes) else {
                skipped_count += 1;
                continue;
            };
            if !valid_content(&path, &content) {
                skipped_count += 1;
                continue;
            }
            total_bytes = total_bytes.saturating_add(size);
            let mut source = import_local_text_file(LocalTextFileCandidate {
                name: relative.clone(),
                content,
                size_bytes: size as usize,
                imported_at: Some(imported_at.clone()),
            })?;
            let fingerprint = source.content_fingerprint.clone();
            let path_hash = Sha256::digest(relative.as_bytes());
            source.id = format!(
                "local-folder-{}-{}",
                hex::encode(&path_hash[..16]),
                fingerprint
            );
            source.title = relative.clone();
            source.provenance = format!("Local folder · {}", relative);
            source.pinned = false;
            source = crate::snapshot::canonicalize_private_source(source, &scope)?;
            sources.push(source);
        }
        let latest = command_scope(Some(workspace_for_worker), None, ScopeAccess::Write)?;
        if !same_authority(&after, &latest) {
            return Err(
                "The account or workspace changed while importing the source folder.".into(),
            );
        }
        if sources.is_empty() {
            return Err(
                "No supported text files were found in that folder. Add Markdown, text, JSON, CSV, or YAML files."
                    .into(),
            );
        }
        append_sources_with_fence(&path, &scope, &sources, &account_fence)?;
        Ok(Some(ProjectSourceFolderImport {
            id: folder_id,
            name: folder_name,
            sources,
            skipped_count,
        }))
    })
    .await
    .map_err(|_| "Folder source import stopped.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_folder(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("test clock should be after the epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "mivlet-source-folder-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn test_source(id: &str) -> LocalFileImport {
        let mut source = import_local_text_file(LocalTextFileCandidate {
            name: "notes.md".into(),
            content: "folder source".into(),
            size_bytes: 13,
            imported_at: Some("now".into()),
        })
        .expect("test source should be valid");
        source.id = id.into();
        source.pinned = false;
        source
    }

    #[test]
    fn skips_hidden_dependency_and_secret_names() {
        assert!(is_hidden_or_secret(".git"));
        assert!(is_hidden_or_secret("node_modules"));
        assert!(is_hidden_or_secret("client-secrets"));
        assert!(!is_hidden_or_secret("notes"));
        assert!(!is_hidden_or_secret("TokenMaxxer"));
        assert!(!is_hidden_or_secret("building-notes.md"));
    }

    #[test]
    fn rejects_binary_and_malformed_json() {
        assert!(!valid_content(Path::new("notes.md"), "hello\0world"));
        assert!(!valid_content(Path::new("data.json"), "{broken"));
        assert!(valid_content(Path::new("data.json"), "{\"ok\":true}"));
    }

    #[test]
    fn relative_paths_are_normalized_and_bounded() {
        let root = Path::new("C:/source");
        assert_eq!(
            safe_relative(root, Path::new("C:/source/src/notes.md")),
            Some("src/notes.md".into())
        );
        assert_eq!(safe_relative(root, Path::new("C:/other/notes.md")), None);
    }

    #[test]
    fn opens_only_regular_files_inside_the_selected_folder() {
        let directory = temporary_folder("open");
        fs::create_dir_all(&directory).unwrap();
        let inside = directory.join("inside.md");
        let outside = directory
            .parent()
            .expect("temporary directory should have a parent")
            .join(format!("mivlet-outside-{}.md", std::process::id()));
        fs::write(&inside, "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        let root = strict_canonicalize(&directory).unwrap();

        let (file, size) = open_source_file(&root, &inside).unwrap();
        assert_eq!(size, 6);
        drop(file);
        assert!(open_source_file(&root, &outside).is_err());

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn enumeration_stops_at_the_entry_bound() {
        let directory = temporary_folder("bound");
        fs::create_dir_all(&directory).unwrap();
        for index in 0..(MAX_FOLDER_ENTRIES + 8) {
            fs::write(directory.join(format!("file-{index:04}.md")), "x").unwrap();
        }

        let root = strict_canonicalize(&directory).unwrap();
        let (files, skipped) = enumerate_files(&root);
        assert!(files.len() <= MAX_FOLDER_ENTRIES);
        assert!(skipped > 0);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn persisted_folder_source_is_visible_to_project_ownership_validation() {
        let store =
            Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap();
        let data = DataScope::workspace("folder-test-workspace").unwrap();
        store
            .with_conn(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at)
                     VALUES('folder-test-workspace','Folder test','now','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let scope = PrivateDataScope::for_authenticated_user(
            data,
            "folder-test-user",
            Some("folder-test-member"),
        )
        .unwrap();
        let source = test_source("local-folder-regression");

        store
            .transaction(|tx| {
                persist_sources_to_knowledge(
                    tx,
                    &store,
                    &scope,
                    std::slice::from_ref(&source),
                    "now",
                )
            })
            .unwrap();
        let owned: bool = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM knowledge_source
                       WHERE workspace_id=?1 AND owner_subject=?2 AND id=?3
                         AND project_id IS NULL AND authority='local'
                         AND visibility='member-private' AND disabled=0
                     )",
                    rusqlite::params![scope.workspace_id(), scope.owner_subject(), source.id],
                    |row| row.get(0),
                )
                .map_err(StoreError::from)
            })
            .unwrap();
        assert!(
            owned,
            "project source validation must be able to resolve the imported id"
        );
    }
}
