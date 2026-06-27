//! App-data path resolution and shared text normalization helpers.

use std::{fs, path::PathBuf};
use tauri::Manager;

/// Resolve `<app_data_dir>/<file_name>`, creating the directory if needed.
pub fn app_data_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Fable could not resolve the app data folder.".to_string())?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|_| "Fable could not prepare the app data folder.".to_string())?;

    Ok(app_data_dir.join(file_name))
}

pub fn approval_audit_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "approval-audit.json")
}

pub fn approval_rules_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "approval-rules.json")
}

pub fn imported_knowledge_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "imported-knowledge.json")
}

pub fn memory_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "memory-state.json")
}

pub fn runtime_snapshot_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "runtime-snapshot.json")
}

/// Path for the connected-backend id manifest. Stores *which* backends are
/// connected (provider ids only), never secrets. Secrets live in the
/// process-scoped in-memory credential store.
pub fn connected_backends_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "connected-backends.json")
}

/// Collapse runs of whitespace into single spaces.
pub fn normalize_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Truncate to a maximum number of Unicode scalar values.
pub fn truncate_characters(value: &str, max_characters: usize) -> String {
    if value.chars().count() <= max_characters {
        return value.to_string();
    }

    value.chars().take(max_characters).collect()
}

/// Build a filesystem-safe slug (max 40 chars) from an arbitrary string.
pub fn file_slug(file_name: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;

    for character in file_name.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }

        if slug.len() >= 40 {
            break;
        }
    }

    slug.trim_matches('-').to_string()
}
