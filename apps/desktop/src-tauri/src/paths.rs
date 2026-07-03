//! App-data path resolution and shared text normalization helpers.

use std::path::PathBuf;

/// Resolve the effective (portable-aware) app data directory. Thin wrapper over
/// hardened resolve that prefers marker-based portable dir when present.
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let tauri_cand = app.path().app_data_dir().ok();
    let exe_cand = std::env::current_exe().ok();
    resolve_data_directory(exe_cand.as_deref(), tauri_cand)
        .map_err(|e| format!("Fable could not resolve data directory: {}", e))
}

/// Resolve `<app_data_dir>/<file_name>`, creating the directory if needed.
/// Now routes through hardened portable-aware resolution.
pub fn app_data_file_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?;
    Ok(dir.join(file_name))
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

/// Durable, non-secret native agent run journal. Provider credentials and
/// connector tokens never enter this file.
pub fn agent_runs_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "agent-runs.json")
}

/// Durable execution-boundary approval records for connector actions.
pub fn connector_approval_records_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "connector-approval-records.json")
}

pub fn execution_approvals_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "execution-approvals.json")
}

/// Non-secret connector account/connection metadata. OAuth tokens remain in
/// the OS credential store.
pub fn connector_connections_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "connector-connections.json")
}

/// Workspace-scoped, credential-free connector sync journal.
pub fn connector_sync_state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "connector-sync-state.json")
}

/// Path for the connected-backend id manifest. Stores *which* backends are
/// connected (provider ids only), never secrets. Secrets live in the OS-secure
/// store (keychain); this manifest lets the Rust boundary re-resolve auth state
/// against the keychain after a restart.
pub fn connected_backends_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "connected-backends.json")
}

/// Durable scheduler store (jobs + queue). Non-secret: job definitions, trigger
/// shapes, lease state, and attempt history only. The in-process tick leases
/// due entries; because Tauri is a single shared process, the lease map is the
/// cross-window duplicate-execution guard.
pub fn scheduler_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "scheduler-store.json")
}

/// Durable workflow-run journal. Inputs, outputs, tool calls, approval state,
/// and failure reason are persisted here (non-secret). Restart recovery marks
/// in-flight runs as interrupted on the TS side; Rust owns atomic writes.
pub fn workflow_runs_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "workflow-runs.json")
}

pub fn workflow_definitions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_data_file_path(app, "workflow-definitions.json")
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

// ---------------------------------------------------------------------------
// Hardened path resolution for portable data directories and workspace roots.
// Fail-closed: missing, traversal, symlinks/junctions, UNC/device, non-contained
// all error with no side effects or unsafe fallbacks. Pure core accepts explicit
// inputs for testability from synthetic fixtures.
// ---------------------------------------------------------------------------

/// Error kinds for path resolution (unit-testable).
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum PathResolutionError {
    MissingRoot,
    Traversal,
    NotContained,
    SymlinkOrJunction,
    UncOrDevice,
    CanonicalizationFailed(String),
    Invalid(String),
}

impl std::fmt::Display for PathResolutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathResolutionError::MissingRoot => write!(f, "Root path does not exist"),
            PathResolutionError::Traversal => {
                write!(f, "Parent-directory traversal is not permitted")
            }
            PathResolutionError::NotContained => write!(
                f,
                "Path is not contained within the root after canonicalization"
            ),
            PathResolutionError::SymlinkOrJunction => write!(
                f,
                "Symlinks and Windows junctions are not permitted in root paths"
            ),
            PathResolutionError::UncOrDevice => write!(f, "UNC and device paths are not permitted"),
            PathResolutionError::CanonicalizationFailed(s) => {
                write!(f, "Canonicalization failed: {}", s)
            }
            PathResolutionError::Invalid(s) => write!(f, "Invalid path: {}", s),
        }
    }
}

/// Detects a portable-mode marker next to the executable. Returns the portable
/// data directory candidate if present. Marker is ".fable-portable" (file or dir)
/// sibling to the exe. Pure (caller controls I/O); detection is explicit/one-way.
pub fn detect_portable_data_dir(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = exe_path.parent()?;
    let marker = parent.join(".fable-portable");
    if marker.exists() {
        Some(parent.join("fable-data"))
    } else {
        None
    }
}

/// Returns true if the path string indicates network UNC (\\server or \\?\UNC\...) or device (\\.\).
/// Local extended canon forms (\\?\C:\...) are allowed (they are produced by strict_canonicalize on Windows).
/// Uses string/component inspection for tests without FS assumptions.
pub fn is_unc_or_device_path(p: &std::path::Path) -> bool {
    let s = p.to_string_lossy();
    if s.starts_with("\\\\.\\") {
        return true; // device
    }
    // Network UNC: plain \\server or extended \\?\UNC\...
    let lower = s.to_lowercase();
    if lower.starts_with("\\\\?\\unc\\") {
        return true;
    }
    if s.starts_with("\\\\") && !s.starts_with("\\\\?\\") {
        return true; // plain network UNC
    }
    false
}

/// Walks the path checking symlink_metadata for any symlink component.
/// On Windows also detects junctions/reparse points (FILE_ATTRIBUTE_REPARSE_POINT)
/// using MetadataExt; junctions do not report is_symlink().
/// This ensures strict_canonicalize rejects them per requirements.
pub fn contains_symlink(path: &std::path::Path) -> bool {
    let mut accum = std::path::PathBuf::new();
    for comp in path.components() {
        accum.push(comp.as_os_str());
        if let Ok(meta) = std::fs::symlink_metadata(&accum) {
            if meta.file_type().is_symlink() {
                return true;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                let attrs = meta.file_attributes();
                if is_windows_reparse_point(attrs) {
                    return true;
                }
            }
        }
    }
    false
}

/// Pure predicate for Windows reparse point attribute (including junctions).
/// Extracted so it can be unit-tested with synthetic values without mklink or FS.
#[cfg(windows)]
pub fn is_windows_reparse_point(attrs: u32) -> bool {
    (attrs & 0x400) != 0
}

#[cfg(not(windows))]
pub fn is_windows_reparse_point(_attrs: u32) -> bool {
    false
}

/// Strict canonicalize: path must exist, contain no symlinks in prefix, not be
/// UNC/device, and canonicalize successfully. Used after create_dir_all for
/// data dirs (bootstrap) and for existing roots.
pub fn strict_canonicalize(p: &std::path::Path) -> Result<std::path::PathBuf, PathResolutionError> {
    if !p.exists() {
        return Err(PathResolutionError::MissingRoot);
    }
    if contains_symlink(p) {
        return Err(PathResolutionError::SymlinkOrJunction);
    }
    if is_unc_or_device_path(p) {
        return Err(PathResolutionError::UncOrDevice);
    }
    std::fs::canonicalize(p).map_err(|e| PathResolutionError::CanonicalizationFailed(e.to_string()))
}

/// Safe create + strict validate for data dirs (portable or tauri).
/// Pre-validates UNC/symlink/junction, creates, then strict-canon.
/// If post-create strict fails and we created it (!existed), best-effort remove to avoid side-effect dir.
fn ensure_valid_data_dir(
    candidate: std::path::PathBuf,
) -> Result<std::path::PathBuf, PathResolutionError> {
    let existed = candidate.exists();
    if is_unc_or_device_path(&candidate) {
        return Err(PathResolutionError::UncOrDevice);
    }
    if contains_symlink(&candidate) {
        return Err(PathResolutionError::SymlinkOrJunction);
    }
    std::fs::create_dir_all(&candidate)
        .map_err(|e| PathResolutionError::Invalid(format!("create data dir failed: {}", e)))?;
    match strict_canonicalize(&candidate) {
        Ok(c) => Ok(c),
        Err(e) => {
            if !existed {
                let _ = std::fs::remove_dir_all(&candidate);
                // Clean empty parent dirs created for this deep candidate (no litter).
                let mut p = candidate.parent().map(|x| x.to_path_buf());
                while let Some(pp) = p {
                    if let Ok(mut it) = pp.read_dir() {
                        if it.next().is_none() {
                            let _ = std::fs::remove_dir(&pp);
                            p = pp.parent().map(|x| x.to_path_buf());
                            continue;
                        }
                    }
                    break;
                }
            }
            Err(e)
        }
    }
}

/// Hardened workspace root selection from an explicit candidate (e.g. cwd).
/// Fail-closed, no silent fallbacks. Returns the canonical root.
pub fn harden_workspace_root(
    candidate: &std::path::Path,
) -> Result<std::path::PathBuf, PathResolutionError> {
    if candidate.as_os_str().is_empty() {
        return Err(PathResolutionError::Invalid("empty root".into()));
    }
    let canon = strict_canonicalize(candidate)?;
    // Reject filesystem roots on every platform. Counting components is not
    // portable: a Windows drive root commonly has both Prefix and RootDir.
    if canon.parent().is_none() {
        return Err(PathResolutionError::Invalid(
            "filesystem root not allowed as workspace".into(),
        ));
    }
    Ok(canon)
}

/// Resolve the effective data directory (portable via marker next to exe, or
/// provided tauri candidate). Creates dir (bootstrap), then strict-canon validates.
/// Pre-init friendly when tauri_cand is None (portable marker required or error).
/// Never silently relocates; marker presence is the only switch.
pub fn resolve_data_directory(
    exe_path: Option<&std::path::Path>,
    tauri_app_data: Option<std::path::PathBuf>,
) -> Result<std::path::PathBuf, PathResolutionError> {
    if let Some(exe) = exe_path {
        if detect_portable_data_dir(exe).is_some() {
            // Wire pre-init resolver for portable marker case (production early path + pre-project).
            return resolve_data_directory_pre_init(exe);
        }
        // No marker: must have tauri cand (or error); fall to candidate selection.
        if tauri_app_data.is_none() {
            return Err(PathResolutionError::Invalid(
                "no portable marker and no tauri app data candidate for pre-init".into(),
            ));
        }
    }
    let candidate = if let Some(tauri) = tauri_app_data {
        tauri
    } else {
        return Err(PathResolutionError::Invalid(
            "no data dir source available".into(),
        ));
    };

    // Use shared ensure: pre-validate + create + strict + cleanup-on-fail-if-we-created.
    // Ensures no side-effect dir left for fail-closed cases.
    ensure_valid_data_dir(candidate)
}

/// Thin pre-init only resolver (std::env only). Supports portable marker only;
/// fails closed otherwise (no unsafe default to app_data without Tauri context).
pub fn resolve_data_directory_pre_init(
    exe_path: &std::path::Path,
) -> Result<std::path::PathBuf, PathResolutionError> {
    let p = detect_portable_data_dir(exe_path).ok_or_else(|| {
        PathResolutionError::Invalid(
            "pre-init requires portable marker next to exe; no fallback".into(),
        )
    })?;
    // Delegate to ensure for consistent pre-validate + create + strict + no-side-effect cleanup.
    ensure_valid_data_dir(p)
}

// Note: app_data_dir and app_data_file_path are defined near top of module and
// delegate into resolve_data_directory (above) for the hardened logic. No
// duplicate definitions here to avoid compile errors.
