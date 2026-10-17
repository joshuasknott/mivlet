//! Browser profiles belong to native account custody, outside agent files.
//! Their processes outlive input-driver Stop but close with this account/app.
use super::LocalComputerState;
#[cfg(windows)]
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::{collections::HashMap, sync::Mutex};

#[path = "browser/handover.rs"]
mod handover;
#[cfg(windows)]
#[path = "browser/windows.rs"]
mod platform;
pub(crate) use handover::handover;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadRequest {
    pub download_ref: String,
    pub origin: String,
    pub name: String,
    pub url: String,
    pub file_name: String,
    pub timeout_seconds: u64,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadRequest {
    pub upload_ref: String,
    pub origin: String,
    pub name: String,
    pub artifact_id: String,
}
pub(crate) fn upload_choices(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::UploadChoices(reference, origin),
    )
}
pub(crate) fn upload(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    input: &UploadRequest,
) -> Result<String, String> {
    let (receipt, bytes) = super::artifacts::verified_artifact(
        computers,
        &super::artifacts::OpenArtifactRequest {
            workspace_id: workspace.into(),
            agent_id: agent.into(),
            artifact_id: input.artifact_id.clone(),
            expected_generation: generation,
        },
    )?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Browser uploads support passive published artifacts up to 8 MiB; choose a smaller file or upload manually.".into());
    }
    let source = super::artifacts::VerifiedUploadArtifact {
        bytes,
        file_name: receipt.export_name,
        mime_type: receipt.artifact.mime_type,
        sha256: receipt.sha256,
    };
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Upload(input, &source),
    )
}
pub(crate) fn download(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    input: &DownloadRequest,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Download(input),
    )
}

pub(super) trait LaunchStop: Send + Sync {
    fn stop(&self);
}

#[derive(Default)]
pub(super) struct BrowserManager {
    closing: AtomicBool,
    #[cfg(windows)]
    processes: Mutex<HashMap<String, platform::BrowserProcess>>,
}

impl BrowserManager {
    pub(super) fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        #[cfg(windows)]
        if let Ok(mut processes) = self.processes.lock() {
            processes.clear();
        }
    }
}

pub(crate) fn open(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    request_id: &str,
) -> Result<String, String> {
    if let Some(error) = computers
        .activity_error
        .lock()
        .map_err(|_| "The native Stop control is unavailable.")?
        .clone()
    {
        return Err(error);
    }
    computers.validate_target(workspace, agent)?;
    let authority = computers.authority_for(workspace, agent)?;
    let ticket = authority.begin_agent(generation)?;
    let _launch = computers
        .native
        .reserve_browser_launch(workspace, agent, generation, request_id, authority)?;
    // Browser control uses the same pinned runtime; do not advertise a shell fallback.
    let _driver_image = super::cua::verified_executable(&computers.driver_directory)?;
    ticket.check()?;
    #[cfg(not(windows))]
    {
        Err("Mivlet's owned browser currently requires Windows x64.".into())
    }
    #[cfg(windows)]
    {
        if !cfg!(target_arch = "x86_64") {
            return Err("Mivlet's owned browser currently requires Windows x64.".into());
        }
        let scope = computers.scope(workspace, agent)?;
        let mut processes = computers
            .browsers
            .processes
            .lock()
            .map_err(|_| "Mivlet could not access its owned browsers.")?;
        if computers.browsers.closing.load(Ordering::Acquire) {
            return Err("This account's browsers are closing.".into());
        }
        if let Some(process) = processes.get(&scope.key).filter(|process| process.alive()) {
            ticket.check()?;
            return receipt(process.product(), "existing");
        }
        processes.retain(|_, process| process.alive());
        if processes.len() >= 4 {
            return Err("Four Mivlet browsers are already open. Close an unused browser before opening another.".into());
        }
        let image = platform::installed_browser()?;
        let mut pins = vec![
            platform::pin_directory(&computers.root)?,
            platform::pin_directory(&scope.directory)?,
        ];
        // This is a sibling of workspace/, not a readable agent workspace folder.
        let profile = scope.directory.join("browser-profile");
        std::fs::create_dir_all(&profile)
            .map_err(|_| "Mivlet could not prepare its private browser profile.")?;
        let profile = crate::paths::strict_canonicalize(&profile)
            .map_err(|_| "The private browser profile failed its path check.")?;
        let directory = crate::paths::strict_canonicalize(&scope.directory)
            .map_err(|_| "The private browser folder failed its path check.")?;
        if profile.parent() != Some(directory.as_path()) {
            return Err("The browser profile escaped native custody.".into());
        }
        pins.push(platform::pin_directory(&profile)?);
        let process = platform::BrowserProcess::launch(
            image,
            &profile,
            pins,
            &ticket,
            &|| {
                computers.ensure_open()?;
                crate::account_session::ensure_current()?;
                if computers.browsers.closing.load(Ordering::Acquire) {
                    return Err("This account's browsers are closing.".into());
                }
                Ok(())
            },
            &|job| _launch.attach(job),
        )?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            ticket.check()?;
            computers.ensure_open()?;
            crate::account_session::ensure_current()?;
            if process.ready_window()?.is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err("The owned browser did not open a supported visible window. No control was granted.".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let product = process.product();
        // A transition after launch discards the process rather than publishing it.
        _launch.publish(ticket, || {
            computers.ensure_open()?;
            crate::account_session::ensure_current()?;
            if computers.browsers.closing.load(Ordering::Acquire) {
                return Err("This account's browsers are closing.".into());
            }
            processes.insert(scope.key, process);
            receipt(product, "opened")
        })
    }
}

pub(crate) fn run_child(arguments: &[std::ffi::OsString]) -> bool {
    #[cfg(windows)]
    {
        if !cfg!(target_arch = "x86_64") {
            return false;
        }
        platform::run_helper(arguments).is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = arguments;
        false
    }
}

pub(crate) fn read(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    arguments: Option<(&str, &str)>,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Read(arguments),
    )
}
pub(crate) fn navigate(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
    url: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Navigate(reference, origin, url),
    )
}
enum Request<'a> {
    Read(Option<(&'a str, &'a str)>),
    Navigate(&'a str, &'a str, &'a str),
    Click(&'a str, &'a str, &'a str),
    Scroll(&'a str, &'a str, &'a str),
    Activate(&'a str, &'a str),
    Fill(&'a str, &'a str, &'a str, &'a str),
    Download(&'a DownloadRequest),
    UploadChoices(&'a str, &'a str),
    Upload(
        &'a UploadRequest,
        &'a super::artifacts::VerifiedUploadArtifact,
    ),
}
pub(crate) fn fill(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
    name: &str,
    text: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Fill(reference, origin, name, text),
    )
}
pub(crate) fn activate(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Activate(reference, origin),
    )
}
pub(crate) fn scroll(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
    direction: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Scroll(reference, origin, direction),
    )
}
pub(crate) fn click(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    reference: &str,
    origin: &str,
    name: &str,
) -> Result<String, String> {
    execute(
        computers,
        workspace,
        agent,
        generation,
        Request::Click(reference, origin, name),
    )
}
fn execute(
    computers: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    arguments: Request<'_>,
) -> Result<String, String> {
    computers.validate_target(workspace, agent)?;
    let ticket = computers
        .authority_for(workspace, agent)?
        .begin_agent(generation)?;
    #[cfg(not(windows))]
    {
        let _ = (arguments, ticket);
        Err("Mivlet browser reads require Windows x64.".into())
    }
    #[cfg(windows)]
    {
        let scope = computers.scope(workspace, agent)?;
        if let Request::Download(input) = arguments {
            let download_workspace = computers.tool_workspace_root(workspace, agent)?;
            let account = crate::account_session::AccountDispatchFence::capture()?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let check = || {
                computers.ensure_open()?;
                ticket.check()?;
                crate::account_session::ensure_current()?;
                if computers.browsers.closing.load(Ordering::Acquire)
                    || std::time::Instant::now() >= deadline
                {
                    return Err("The browser transfer stopped; no action was replayed.".into());
                }
                Ok(())
            };
            let transfer = computers.native.transfer_native(
                workspace,
                agent,
                generation,
                &ticket,
                |window, lease_check, dispatch| {
                    let check_transfer = || {
                        lease_check()?;
                        check()
                    };
                    let dispatch_transfer = |start: &mut dyn FnMut() -> Result<(), String>| {
                        dispatch(&mut || account.with_current(&mut *start))
                    };
                    let mut processes = computers
                        .browsers
                        .processes
                        .lock()
                        .map_err(|_| "The owned browser is unavailable.")?;
                    let process = processes
                        .get_mut(&scope.key)
                        .filter(|process| process.alive())
                        .ok_or("Select this agent's owned browser before a download.")?;
                    process.download(
                        window.identity.hwnd,
                        generation,
                        input,
                        &scope.directory,
                        &check_transfer,
                        &dispatch_transfer,
                    )
                },
            );
            let commit = |action: &mut dyn FnMut() -> Result<(), String>| {
                check()?;
                account.with_current(&mut || ticket.with_current(&mut *action))
            };
            let result = transfer.and_then(|transfer| {
                transfer.finish(
                    input,
                    &scope.directory,
                    &download_workspace,
                    &check,
                    &commit,
                )
            });
            let result = ticket.finish(result);
            computers.native.stop_scope(workspace, agent, generation, "Browser download finished or stopped. The owned browser was closed for transfer custody; select a fresh owned window before further input.");
            return result;
        }
        // Secret-store reads happen before taking any control/authority lock.
        let account_dispatch =
            if !matches!(arguments, Request::Read(..) | Request::UploadChoices(..)) {
                Some(crate::account_session::AccountDispatchFence::capture()?)
            } else {
                None
            };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let run = |window: &super::windows::WindowBinding,
                   lease_check: &dyn Fn() -> Result<(), String>,
                   dispatch: Option<&super::control::NativeDispatch<'_>>| {
            let check_liveness = || {
                computers.ensure_open()?;
                if computers.browsers.closing.load(Ordering::Acquire)
                    || std::time::Instant::now() >= deadline
                {
                    return Err("The browser operation stopped or reached its time limit. Do not replay previously dispatched navigation.".into());
                }
                Ok(())
            };
            let check = || {
                lease_check()?;
                crate::account_session::ensure_current()?;
                check_liveness()
            };
            check()?;
            let mut processes = computers
                .browsers
                .processes
                .lock()
                .map_err(|_| "The owned browser is unavailable.")?;
            let process = processes.get_mut(&scope.key).filter(|process| process.alive()).ok_or("Select this agent's Mivlet-owned browser before reading its tabs. Ordinary browser profiles are not available through this tool.")?;
            let checked_dispatch = |start: &mut dyn FnMut() -> Result<(), String>| {
                dispatch.ok_or("Browser input requires a native dispatch fence.")?(&mut || {
                    check_liveness()?;
                    account_dispatch
                        .as_ref()
                        .ok_or("The account dispatch fence is unavailable.")?
                        .with_current(&mut *start)
                })
            };
            match arguments {
                Request::UploadChoices(reference, origin) => process.upload_choices(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    &check,
                ),
                Request::Upload(input, source) => process.upload(
                    window.identity.hwnd,
                    generation,
                    input,
                    source,
                    &scope.directory,
                    &check,
                    &checked_dispatch,
                ),
                Request::Download(_) => Err("Browser transfer custody was not established.".into()),
                Request::Fill(reference, origin, name, text) => process.fill(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    name,
                    text,
                    &check,
                    &checked_dispatch,
                ),
                Request::Activate(reference, origin) => process.activate(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    &check,
                    &checked_dispatch,
                ),
                Request::Read(Some((reference, origin))) => {
                    process.observe_tab(window.identity.hwnd, generation, reference, origin, &check)
                }
                Request::Read(None) => process.tabs(window.identity.hwnd, generation, &check),
                Request::Navigate(reference, origin, url) => process.navigate(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    url,
                    &check,
                    &checked_dispatch,
                ),
                Request::Click(reference, origin, name) => process.click(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    name,
                    &check,
                    &checked_dispatch,
                ),
                Request::Scroll(reference, origin, direction) => process.scroll(
                    window.identity.hwnd,
                    generation,
                    reference,
                    origin,
                    direction,
                    &check,
                    &checked_dispatch,
                ),
            }
        };
        let result = if !matches!(arguments, Request::Read(..) | Request::UploadChoices(..)) {
            computers.native.act_native(
                workspace,
                agent,
                generation,
                &ticket,
                |window, check, dispatch| run(window, check, Some(dispatch)),
            )
        } else {
            computers
                .native
                .read_native(workspace, agent, generation, &ticket, |window, check| {
                    run(window, check, None)
                })
        };
        ticket.finish(result)
    }
}

#[cfg(debug_assertions)]
pub(crate) fn check_owned_browser() -> Result<(), String> {
    #[cfg(windows)]
    {
        platform::acceptance()
    }
    #[cfg(not(windows))]
    {
        Err("The owned browser check requires Windows.".into())
    }
}

#[cfg(windows)]
fn receipt(product: &str, status: &str) -> Result<String, String> {
    serde_json::to_string(&json!({"status":status,"browser":product,"profile":"mivlet-owned",
        "inputAuthority":false,"initialPage":if status == "opened" { Some("about:blank") } else { None },
        "nextStep":"List current windows with local-app-list and select this browser explicitly. Opening can interrupt the current Windows session but grants no input authority. Stop leaves the browser available for you; closing Mivlet or changing account closes it."}))
        .map_err(|_| "The browser result could not be encoded.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_stop_control_refuses_browser_launch_before_any_process() {
        let root = tempfile::tempdir().unwrap();
        let computers = super::LocalComputerState::for_test(root.path().to_path_buf());
        *computers.activity_error.lock().unwrap() = Some("Stop control unavailable".into());
        assert_eq!(
            super::open(&computers, "workspace-one", "agent-one", 1, "request-one").unwrap_err(),
            "Stop control unavailable"
        );
        assert!(!computers.native.active());
        #[cfg(windows)]
        assert!(computers.browsers.processes.lock().unwrap().is_empty());
    }
}
