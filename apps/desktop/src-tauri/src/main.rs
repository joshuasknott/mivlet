#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Antigravity's official ACP agent honours BROWSER. Explicit sign-in gets
    // a narrowly validated Google URL opener; background checks and ordinary
    // turns retain an inert helper so expired sessions cannot open a browser.
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
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
