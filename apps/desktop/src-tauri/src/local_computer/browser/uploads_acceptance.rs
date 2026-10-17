use super::{fixture_server, observations, BrowserProcess};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};
pub(super) fn run(
    process: &mut BrowserProcess,
    hwnd: u64,
    native_root: &Path,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let server = fixture_server::Server::start()?;
    let listed: Value = serde_json::from_str(&process.tabs(hwnd, 1, check)?)
        .map_err(|_| "Upload QA tabs invalid.")?;
    let first = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.first())
        .ok_or("Upload QA tab missing.")?;
    process.activate(
        hwnd,
        1,
        first["activationRef"]
            .as_str()
            .ok_or("Upload QA activation missing.")?,
        first["origin"]
            .as_str()
            .ok_or("Upload QA origin missing.")?,
        check,
        dispatch,
    )?;
    let listed: Value = serde_json::from_str(&process.tabs(hwnd, 1, check)?)
        .map_err(|_| "Upload QA tabs invalid.")?;
    let first = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.first())
        .ok_or("Upload QA tab missing.")?;
    process.navigate(
        hwnd,
        1,
        first["navigationRef"]
            .as_str()
            .ok_or("Upload QA navigation missing.")?,
        first["origin"]
            .as_str()
            .ok_or("Upload QA origin missing.")?,
        &format!("{}/upload-page", server.origin),
        check,
        dispatch,
    )?;
    std::thread::sleep(Duration::from_millis(300));
    let listed: Value = serde_json::from_str(&process.tabs(hwnd, 1, check)?)
        .map_err(|_| "Upload QA fresh tabs invalid.")?;
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["origin"] == server.origin))
        .ok_or("Upload QA origin tab missing.")?;
    let observed = process.upload_choices(
        hwnd,
        1,
        tab["tabRef"]
            .as_str()
            .ok_or("Upload QA tab reference missing.")?,
        &server.origin,
        check,
    )?;
    if observed.contains("Waiting for file") {
        return Err("Upload choices exposed page text.".into());
    }
    let choices: Value =
        serde_json::from_str(&observed).map_err(|_| "Upload QA choices invalid.")?;
    let field = choices["uploads"]
        .as_array()
        .and_then(|fields| fields.iter().find(|field| field["name"] == "Upload report"))
        .ok_or("Upload QA field missing.")?;
    let input = super::super::UploadRequest {
        upload_ref: field["uploadRef"]
            .as_str()
            .ok_or("Upload QA reference missing.")?
            .into(),
        origin: server.origin.clone(),
        name: "Upload report".into(),
        artifact_id: format!("artifact-{}", "a".repeat(64)),
    };
    // The fixture exercises real DOM/file transport with known passive bytes;
    // production receipt/account admission is covered by artifact boundary tests.
    let bytes = b"quarter,revenue\nQ1,42\n".to_vec();
    let source = super::super::super::artifacts::VerifiedUploadArtifact {
        file_name: "report.csv".into(),
        mime_type: "text/csv".into(),
        sha256: hex::encode(Sha256::digest(&bytes)),
        bytes,
    };
    let attached = process.upload(hwnd, 1, &input, &source, native_root, check, dispatch)?;
    if !attached.contains("file-attached")
        || process
            .upload(hwnd, 1, &input, &source, native_root, check, dispatch)
            .is_ok()
    {
        return Err("Upload QA file attachment was missing or replayable.".into());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while !server.received_upload() && Instant::now() < deadline {
        check()?;
        std::thread::sleep(Duration::from_millis(25));
    }
    if !server.received_upload() {
        return Err("The real browser did not deliver the exact passive file bytes.".into());
    }
    let listed: Value = serde_json::from_str(&process.tabs(hwnd, 1, check)?)
        .map_err(|_| "Upload QA post-file tabs invalid.")?;
    let tab = listed["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["origin"] == server.origin))
        .ok_or("Upload QA post-file tab missing.")?;
    if observations::observe(
        process,
        hwnd,
        1,
        tab["tabRef"]
            .as_str()
            .ok_or("Upload QA fresh reference missing.")?,
        &server.origin,
        check,
    )
    .is_ok()
    {
        return Err("A selected file field became readable after upload.".into());
    }
    eprintln!("Owned browser upload: labelled empty input received exact passive CSV through native immutable staging; page handler delivered its bytes; replay refused; selected-file page reads remained private.");
    Ok(())
}
