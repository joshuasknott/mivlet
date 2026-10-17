//! Opt-in real installed-browser custody check; runs last because a successful
//! download intentionally closes its owned browser before native import.
use super::{fixture_server, observations, BrowserProcess};
use serde_json::Value;
use std::{path::Path, time::Duration};

pub(super) fn run(
    process: &mut BrowserProcess,
    hwnd: u64,
    native_root: &Path,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let server = fixture_server::Server::start()?;
    let listed: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Download QA tabs invalid.")?;
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.first())
        .ok_or("Download QA source tab missing.")?;
    process.activate(
        hwnd,
        1,
        tab["activationRef"]
            .as_str()
            .ok_or("Download QA activation missing.")?,
        tab["origin"]
            .as_str()
            .ok_or("Download QA origin missing.")?,
        check,
        dispatch,
    )?;
    let listed: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Download QA active tabs invalid.")?;
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.first())
        .ok_or("Download QA active tab missing.")?;
    process.navigate(
        hwnd,
        1,
        tab["navigationRef"]
            .as_str()
            .ok_or("Download QA navigation missing.")?,
        tab["origin"]
            .as_str()
            .ok_or("Download QA origin missing.")?,
        &format!("{}/download-page", server.origin),
        check,
        dispatch,
    )?;
    std::thread::sleep(Duration::from_millis(300));
    let listed: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Download QA fresh tabs invalid.")?;
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["origin"] == server.origin))
        .ok_or("Download QA tab missing.")?;
    let observed: Value = serde_json::from_str(&observations::observe(
        process,
        hwnd,
        1,
        tab["tabRef"]
            .as_str()
            .ok_or("Download QA tab reference missing.")?,
        &server.origin,
        check,
    )?)
    .map_err(|_| "Download QA observation invalid.")?;
    let link = observed["downloads"]
        .as_array()
        .and_then(|links| links.iter().find(|link| link["name"] == "Download report"))
        .ok_or("Download QA public link missing.")?;
    let input = super::super::DownloadRequest {
        download_ref: link["downloadRef"]
            .as_str()
            .ok_or("Download QA reference missing.")?
            .into(),
        origin: server.origin.clone(),
        name: "Download report".into(),
        url: format!("{}/download.csv", server.origin),
        file_name: "report.csv".into(),
        timeout_seconds: 5,
    };
    let workspace_root = tempfile::Builder::new()
        .prefix("download-workspace-")
        .tempdir_in(native_root)
        .map_err(|_| "Download QA workspace unavailable.")?;
    let workspace = crate::paths::strict_canonicalize(workspace_root.path()).map_err(|_|"Download QA workspace failed validation.")?;
    let transferred = process.download(hwnd, 1, &input, native_root, check, dispatch)?;
    let result = transferred.finish(&input, native_root, &workspace, check, &|action| action())?;
    let result: Value =
        serde_json::from_str(&result).map_err(|_| "Download QA receipt invalid.")?;
    let path = result["path"]
        .as_str()
        .ok_or("Download QA result path missing.")?;
    if result["status"] != "downloaded"
        || result["browserClosed"] != true
        || result["published"] != false
        || process.alive()
        || std::fs::read(workspace.join(path)).map_err(|_| "Download QA file missing.")?
            != b"quarter,revenue\nQ1,42\n"
    {
        return Err(
            "Download QA did not establish completed passive custody and browser shutdown.".into(),
        );
    }
    eprintln!("Owned browser download: exact frame/URL/GUID completed; owned Job closed before passive CSV import; browser cookies and host paths omitted.");
    Ok(())
}
