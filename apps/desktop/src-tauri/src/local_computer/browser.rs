//! Browser profiles belong to native account custody, outside agent files.
//! Their processes outlive input-driver Stop but close with this account/app.
use super::LocalComputerState;
#[cfg(windows)]
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::{collections::HashMap, sync::Mutex};

#[cfg(windows)]
#[path = "browser/windows.rs"]
mod platform;

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
        let process = ticket.with_current(|| {
            computers.ensure_open()?;
            crate::account_session::ensure_current()?;
            if computers.browsers.closing.load(Ordering::Acquire) {
                return Err("This account's browsers are closing.".into());
            }
            platform::BrowserProcess::launch(image, &profile, pins)
        })?;
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
        ticket.commit(|| {
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
