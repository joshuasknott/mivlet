//! Opt-in disposable browser scrolling; never a provider/account acceptance.
use super::{controls, observations, scrolling, BrowserProcess};
use serde_json::Value;
use std::time::{Duration, Instant};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or("Scroll QA choice missing.".into())
}
fn observe(
    process: &mut BrowserProcess,
    hwnd: u64,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Scroll QA list invalid.")?;
    let page = list["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|t| t["title"] == "Scroll fixture"))
        .ok_or("Scroll QA page missing.")?;
    serde_json::from_str(&observations::observe(
        process,
        hwnd,
        1,
        text(page, "tabRef")?,
        origin,
        check,
    )?)
    .map_err(|_| "Scroll QA observation invalid.".into())
}
fn button(value: &Value) -> Result<&str, String> {
    let control = value["controls"]
        .as_array()
        .and_then(|controls| controls.iter().find(|c| c["name"] == "Finish scroll"))
        .ok_or("Scroll QA button missing.")?;
    text(control, "controlRef")
}
fn position(value: &Value) -> Result<f64, String> {
    value["viewport"]["pageY"]
        .as_f64()
        .ok_or("Scroll QA viewport missing.".into())
}

pub(super) fn run(
    process: &mut BrowserProcess,
    hwnd: u64,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Scroll QA list invalid.")?;
    let page = list["tabs"]
        .as_array()
        .and_then(|tabs| tabs.iter().find(|t| t["title"] == "Second tab fixture"))
        .ok_or("Scroll QA second tab missing.")?;
    super::navigation::navigate(
        process,
        hwnd,
        1,
        text(page, "navigationRef")?,
        origin,
        &format!("{origin}/scroll"),
        check,
        dispatch,
    )?;
    std::thread::sleep(Duration::from_millis(350));
    let initial = observe(process, hwnd, origin, check)?;
    if position(&initial)? != 0.0 || initial["tabVisible"] != true {
        return Err("Scroll QA initial viewport changed.".into());
    }
    let refused = controls::click(
        process,
        (hwnd, 1),
        button(&initial)?,
        origin,
        "Finish scroll",
        check,
        dispatch,
    );
    if !refused
        .as_ref()
        .is_err_and(|e| e.contains("No browser input was dispatched"))
    {
        return Err("Scroll QA offscreen click was not refused.".into());
    }
    let mut current = observe(process, hwnd, origin, check)?;
    for _ in 0..6 {
        let y = position(&current)?;
        let height = current["viewport"]["height"]
            .as_f64()
            .ok_or("Scroll QA height missing.")?;
        if y <= 1250.0 && y + height >= 1290.0 {
            break;
        }
        let reference = text(&current, "scrollRef")?.to_string();
        scrolling::scroll(
            process,
            (hwnd, 1),
            &reference,
            origin,
            "down",
            check,
            dispatch,
        )?;
        if scrolling::scroll(
            process,
            (hwnd, 1),
            &reference,
            origin,
            "down",
            check,
            dispatch,
        )
        .is_ok()
        {
            return Err("Scroll QA replay was accepted.".into());
        }
        std::thread::sleep(Duration::from_millis(200));
        current = observe(process, hwnd, origin, check)?;
        if position(&current)? <= y {
            return Err("Scroll QA did not advance the actual native viewport.".into());
        }
    }
    if position(&current)? <= 0.0 {
        return Err("Scroll QA did not scroll.".into());
    }
    controls::click(
        process,
        (hwnd, 1),
        button(&current)?,
        origin,
        "Finish scroll",
        check,
        dispatch,
    )
    .map_err(|error| format!("Scroll QA visible Finish scroll click: {error}"))?;
    current = observe(process, hwnd, origin, check)?;
    if !current["content"].as_array().is_some_and(|nodes| {
        nodes
            .iter()
            .any(|n| n["name"] == "Scrolled action verified")
    }) {
        return Err("Scroll QA did not verify the offscreen button's real effect.".into());
    }
    let before = position(&current)?;
    scrolling::scroll(
        process,
        (hwnd, 1),
        text(&current, "scrollRef")?,
        origin,
        "up",
        check,
        dispatch,
    )?;
    std::thread::sleep(Duration::from_millis(200));
    let after_up = observe(process, hwnd, origin, check)?;
    if position(&after_up)? >= before {
        return Err("Scroll QA upward event did not change the viewport.".into());
    }
    // Return to the top with fresh requests so the companion button is visible.
    let mut top = after_up;
    for _ in 0..6 {
        if position(&top)? == 0.0 {
            break;
        }
        scrolling::scroll(
            process,
            (hwnd, 1),
            text(&top, "scrollRef")?,
            origin,
            "up",
            check,
            dispatch,
        )?;
        std::thread::sleep(Duration::from_millis(200));
        top = observe(process, hwnd, origin, check)?;
    }
    if position(&top)? != 0.0 {
        return Err("Scroll QA did not return to its initial viewport.".into());
    }
    let old_scroll = process
        .scroll
        .take()
        .ok_or("Scroll QA native choice missing.")?;
    let companion = top["controls"]
        .as_array()
        .and_then(|controls| {
            controls
                .iter()
                .find(|c| c["name"] == "Open scroll companion")
        })
        .ok_or("Scroll QA companion missing.")?;
    controls::click(
        process,
        (hwnd, 1),
        text(companion, "controlRef")?,
        origin,
        "Open scroll companion",
        check,
        dispatch,
    )
    .map_err(|error| format!("Scroll QA companion click: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Scroll QA list invalid.")?;
        if list["tabs"].as_array().is_some_and(|tabs| {
            tabs.len() == 3 && tabs.iter().any(|tab| tab["title"] == "Second tab fixture")
        }) {
            break;
        }
        if Instant::now() >= deadline {
            return Err("Scroll QA companion did not open; no input replayed.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let old_ref = old_scroll.0.clone();
    process.scroll = Some(old_scroll);
    if !scrolling::scroll(
        process,
        (hwnd, 1),
        &old_ref,
        origin,
        "down",
        check,
        dispatch,
    )
    .as_ref()
    .is_err_and(|error| error.contains("no longer visible"))
    {
        return Err("Scroll QA hidden-tab input was not refused.".into());
    }
    let hidden = observe(process, hwnd, origin, check)?;
    if hidden["tabVisible"] != false || !hidden["scrollRef"].is_null() {
        return Err("Scroll QA offered a hidden-tab wheel choice.".into());
    }
    eprintln!("Owned browser scroll fixture: offscreen click refused; bounded downward events advanced native viewport with no replay; newly visible button clicked and effect verified; upward wheel verified.");
    Ok(())
}
