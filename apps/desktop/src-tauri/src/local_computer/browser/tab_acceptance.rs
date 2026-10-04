//! Explicitly opted-in disposable browser QA; no account or public tool surface.
use super::{controls, observations, BrowserProcess};
use serde_json::Value;
use std::time::{Duration, Instant};

fn listed(
    process: &mut BrowserProcess,
    hwnd: u64,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Tab QA response invalid.".into())
}
fn tab<'a>(list: &'a Value, title: &str) -> Result<&'a Value, String> {
    list["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|tab| tab["title"] == title))
        .ok_or("Tab QA fixture identity missing.".into())
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field].as_str().ok_or("Tab QA choice missing.".into())
}
fn observe(
    process: &mut BrowserProcess,
    hwnd: u64,
    origin: &str,
    title: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let list = listed(process, hwnd, check)?;
    let reference = text(tab(&list, title)?, "tabRef")?;
    serde_json::from_str(&observations::observe(
        process, hwnd, 1, reference, origin, check,
    )?)
    .map_err(|_| "Tab QA observation invalid.".into())
}
fn control(value: &Value, name: &str) -> Result<String, String> {
    let control = value["controls"]
        .as_array()
        .and_then(|controls| controls.iter().find(|control| control["name"] == name))
        .ok_or("Tab QA expected visible control missing.")?;
    Ok(text(control, "controlRef")?.into())
}
fn has_text(value: &Value, text: &str) -> bool {
    value["content"]
        .as_array()
        .is_some_and(|nodes| nodes.iter().any(|node| node["name"] == text))
}
pub(super) fn run(
    process: &mut BrowserProcess,
    hwnd: u64,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let list = listed(process, hwnd, check)?;
    let initial = &list["tabs"][0];
    super::navigation::navigate(
        process,
        hwnd,
        1,
        text(initial, "navigationRef")?,
        text(initial, "origin")?,
        &format!("{origin}/report"),
        check,
        dispatch,
    )
    .map_err(|error| format!("Browser two-tab QA report navigation: {error}"))?;
    std::thread::sleep(Duration::from_millis(350));
    let observed = observe(process, hwnd, origin, "Mivlet browser fixture", check)?;
    let old_ref = control(&observed, "Activate once")?;
    // Hold an originally valid native choice across a tab change. Production
    // agent input clears its refs; this additionally tests a human tab change
    // without relying on that cleanup to reject an invisible document.
    let old_choice = process
        .controls
        .remove(&old_ref)
        .ok_or("Tab QA native choice missing.")?;
    let open_ref = control(&observed, "Open second tab")?;
    controls::click(
        process,
        (hwnd, 1),
        &open_ref,
        origin,
        "Open second tab",
        check,
        dispatch,
    )?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let list = listed(process, hwnd, check)?;
        if list["tabs"].as_array().is_some_and(|tabs| tabs.len() == 2)
            && tab(&list, "Second tab fixture").is_ok()
        {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Tab QA second tab did not load; no input replayed.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    process.controls.insert(old_ref.clone(), old_choice);
    let rejected = controls::click(
        process,
        (hwnd, 1),
        &old_ref,
        origin,
        "Activate once",
        check,
        dispatch,
    );
    if !rejected
        .as_ref()
        .is_err_and(|error| error.contains("no longer visible"))
    {
        return Err("Tab QA failed to refuse an originally valid hidden-tab click.".into());
    }
    let hidden = observe(process, hwnd, origin, "Mivlet browser fixture", check)?;
    if hidden["tabVisible"] != false
        || !hidden["controls"].as_array().is_some_and(Vec::is_empty)
        || !has_text(&hidden, "Not activated")
    {
        return Err("Tab QA hidden-page controls or input were exposed despite its spoofed main-world visibility getter.".into());
    }
    let active = observe(process, hwnd, origin, "Second tab fixture", check)?;
    if active["tabVisible"] != true {
        return Err("Tab QA second tab was not visible.".into());
    }
    let reference = control(&active, "Activate once")?;
    controls::click(
        process,
        (hwnd, 1),
        &reference,
        origin,
        "Activate once",
        check,
        dispatch,
    )?;
    if controls::click(
        process,
        (hwnd, 1),
        &reference,
        origin,
        "Activate once",
        check,
        dispatch,
    )
    .is_ok()
    {
        return Err("Tab QA replayed a visible-tab click.".into());
    }
    let verified = observe(process, hwnd, origin, "Second tab fixture", check)?;
    if !has_text(&verified, "Activated once") || has_text(&verified, "Not activated") {
        return Err("Tab QA visible second-page click did not produce its fresh result.".into());
    }
    eprintln!("Owned browser two-tab fixture: visible tab clicked once and freshly verified; originally valid hidden-tab choice refused without input; hidden observation offered no controls despite spoofed page visibility getter.");
    Ok(())
}
