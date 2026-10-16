#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Antigravity's official ACP agent honours BROWSER. Explicit sign-in gets
    // a narrowly validated Google URL opener; background checks and ordinary
    // turns retain an inert helper so expired sessions cannot open a browser.
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--mivlet-background-worker") => {
            let Some(account) = args
                .next()
                .filter(|value| value.starts_with("bootstrap_") && value.len() <= 128)
            else {
                std::process::exit(2);
            };
            if args.next().is_some() {
                std::process::exit(2);
            }
            mivlet_desktop_lib::run_background_worker(account);
            return;
        }
        #[cfg(windows)]
        Some("--mivlet-execution-setup") => {
            let owner = args.next().unwrap_or_default();
            let mode = args.next().unwrap_or_default();
            if !matches!(mode.as_str(), "repair" | "cleanup")
                || args.next().is_some()
                || mivlet_windows_executor::setup::configure(&owner, mode == "cleanup").is_err()
            {
                std::process::exit(2);
            }
            return;
        }
        #[cfg(debug_assertions)]
        Some("--check-owned-browser") => {
            if let Err(error) = mivlet_desktop_lib::check_owned_browser() {
                eprintln!("{error}");
                std::process::exit(2);
            }
            return;
        }
        Some("--mivlet-browser-child") => {
            if !mivlet_desktop_lib::run_browser_child(
                &std::env::args_os().skip(2).collect::<Vec<_>>(),
            ) {
                std::process::exit(2);
            }
            return;
        }
        #[cfg(debug_assertions)]
        Some("--check-connectors") => {
            mivlet_desktop_lib::check_connectors();
            return;
        }
        Some("--antigravity-browser-open") => {
            if let Some(raw_url) = args.next() {
                let _ = mivlet_desktop_lib::open_antigravity_browser_helper(&raw_url);
            }
            return;
        }
        Some("--antigravity-browser-suppress") => return,
        _ => {}
    }
    mivlet_desktop_lib::run();
}
