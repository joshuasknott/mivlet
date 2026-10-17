//! Actual disposable-browser acceptance, called only by the existing opt-in probe.
use super::{forms, navigation, observations, BrowserProcess};
use serde_json::Value;
use std::time::{Duration, Instant};
pub(super) fn run(
    process: &mut BrowserProcess,
    hwnd: u64,
    origin: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<(), String> {
    let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
        .map_err(|_| "Form QA tabs invalid.")?;
    let first = &list["tabs"][0];
    navigation::navigate(
        process,
        hwnd,
        1,
        first["navigationRef"]
            .as_str()
            .ok_or("Form QA navigation missing.")?,
        first["origin"].as_str().ok_or("Form QA origin missing.")?,
        &format!("{origin}/form"),
        check,
        dispatch,
    )?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let active = loop {
        let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Form QA tabs invalid.")?;
        if let Some(tab) = list["tabs"].as_array().and_then(|tabs| {
            tabs.iter()
                .find(|tab| tab["title"] == "Public form fixture")
        }) {
            break tab.clone();
        }
        if Instant::now() >= deadline {
            return Err("Form QA page did not load; no navigation replayed.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    navigation::activate(
        process,
        hwnd,
        1,
        active["activationRef"]
            .as_str()
            .ok_or("Form QA activation missing.")?,
        origin,
        check,
        dispatch,
    )?;
    let observe = |process: &mut BrowserProcess| -> Result<Value, String> {
        let list: Value = serde_json::from_str(&observations::tabs(process, hwnd, 1, check)?)
            .map_err(|_| "Form QA tabs invalid.")?;
        let tab = list["tabs"]
            .as_array()
            .and_then(|tabs| {
                tabs.iter()
                    .find(|tab| tab["title"] == "Public form fixture")
            })
            .ok_or("Form QA tab missing.")?;
        serde_json::from_str(&observations::observe(
            process,
            hwnd,
            1,
            tab["tabRef"].as_str().ok_or("Form QA tab ref missing.")?,
            origin,
            check,
        )?)
        .map_err(|_| "Form QA observation invalid.".into())
    };
    let before = observe(process)?;
    let choices = before["fields"]
        .as_array()
        .ok_or("Form QA field projection missing.")?;
    if choices.len() != 1
        || choices[0]["name"] != "Public topic"
        || before.to_string().contains("Human text preserved")
    {
        return Err(format!("Form QA field projection failed: fields={} expectedPublicTopic={} existingValueLeaked={} visible={}", choices.len(), choices.first().is_some_and(|choice| choice["name"] == "Public topic"), before.to_string().contains("Human text preserved"), before["tabVisible"] == true));
    }
    let reference = choices[0]["fieldRef"]
        .as_str()
        .ok_or("Form QA field choice missing.")?;
    forms::fill(
        process,
        (hwnd, 1),
        reference,
        origin,
        "Public topic",
        "Public topic example",
        check,
        dispatch,
    )?;
    if forms::fill(
        process,
        (hwnd, 1),
        reference,
        origin,
        "Public topic",
        "replay",
        check,
        dispatch,
    )
    .is_ok()
    {
        return Err("Form QA replayed field entry.".into());
    }
    let after = observe(process)?;
    if !after.to_string().contains("Field edited once")
        || !after["fields"].as_array().is_some_and(Vec::is_empty)
        || after.to_string().contains("Public topic example")
        || after.to_string().contains("Human text preserved")
    {
        return Err("Form QA did not preserve omitted values or verify the single edit.".into());
    }
    eprintln!("Owned browser form fixture: exact empty field filled once; input event verified; existing values omitted and preserved; replay refused.");
    Ok(())
}
