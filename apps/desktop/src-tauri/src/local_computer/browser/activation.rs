//! Explicit foreground tab selection, bound to the listed document and title.
use super::{navigation, observations, BrowserProcess};
use serde_json::json;
use std::time::{Duration, Instant};

const STALE: &str = "The browser tab choice expired, was consumed or changed. No browser input was dispatched. List tabs again before choosing an action.";
const UNKNOWN: &str = "Browser tab activation outcome is uncertain. The visible tab may have changed. No input was replayed; list current tabs and observe before acting again.";

pub(super) struct Choice {
    document: navigation::Choice,
    title: String,
}
impl Choice {
    pub(super) fn capture(document: navigation::Choice, title: String) -> Self {
        Self { document, title }
    }
    fn check_title(&self, requested: &str, current: &str) -> Result<(), String> {
        if requested != self.title || current != self.title {
            return Err(STALE.into());
        }
        Ok(())
    }
    fn validate(
        &self,
        process: &mut BrowserProcess,
        scope: (u64, u64),
        origin: &str,
        title: &str,
        check: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.document
            .validate_live(process, scope.0, scope.1, origin, check)?;
        let (_, pages) = observations::targets(process, scope.0, check)?;
        let page = pages
            .iter()
            .find(|page| page["targetId"] == self.document.target)
            .ok_or(STALE)?;
        self.check_title(title, &observations::title(page))
    }
}

pub(super) fn activate(
    process: &mut BrowserProcess,
    scope: (u64, u64),
    reference: &str,
    origin: &str,
    title: &str,
    check: &dyn Fn() -> Result<(), String>,
    dispatch: &super::super::super::control::NativeDispatch<'_>,
) -> Result<String, String> {
    // Retire all older choices even if validation or dispatch fails.
    let snapshot = process.tabs.take();
    process.navigation.clear();
    process.controls.clear();
    process.scroll = None;
    let choice = snapshot
        .ok_or(STALE)?
        .activation(scope.0, scope.1, reference)
        .map_err(|_| STALE)?;
    choice
        .validate(process, scope, origin, title, check)
        .and_then(|_| check())
        .map_err(|error| format!("{error} No browser input was dispatched."))?;
    process
        ._pipe
        .as_mut()
        .ok_or(STALE)?
        .activate(&choice.document.target, check, dispatch)
        .map_err(|_| UNKNOWN)?;
    // Activation is asynchronous. Poll only fixed read probes, never repeat input.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        choice
            .validate(process, scope, origin, title, check)
            .map_err(|_| UNKNOWN)?;
        let visible = process
            ._pipe
            .as_mut()
            .ok_or(UNKNOWN)?
            .visible(&choice.document.frame.id, &choice.document.session, check)
            .map_err(|_| UNKNOWN)?;
        choice
            .document
            .validate_live(process, scope.0, scope.1, origin, check)
            .map_err(|_| UNKNOWN)?;
        check().map_err(|_| UNKNOWN)?;
        if visible {
            return Ok(json!({"status":"tab-activated","inputDispatched":true,"verified":true,"origin":origin,"title":title,"requiresObservation":true,"message":"The listed document was visible after activation. List tabs and observe before any page action; no input was replayed."}).to_string());
        }
        if Instant::now() >= deadline {
            return Err(UNKNOWN.into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_binds_the_exact_listed_and_live_title() {
        let value = json!({"frameTree":{"frame":{"id":"frame","loaderId":"loader","url":"https://example.com/","securityOrigin":"https://example.com"}}});
        let document = navigation::Choice::capture(
            10,
            2,
            77,
            "target",
            "session",
            "https://example.com/",
            &value,
        )
        .unwrap();
        let choice = Choice::capture(document, "Report".into());
        assert!(choice.check_title("Report", "Report").is_ok());
        assert!(choice.check_title("Different", "Report").is_err());
        assert!(choice.check_title("Report", "Different").is_err());
    }
}
