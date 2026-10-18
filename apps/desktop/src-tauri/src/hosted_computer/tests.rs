//! Focused validation and native-secret regression tests.

use super::*;
use crate::store::repos::workspace_directory as directory;
use std::sync::Mutex;

#[test]
fn validates_public_control_plane_identifiers() {
    assert!(valid_id("workspace:alpha"));
    assert!(valid_id("agent_research-1"));
    assert!(!valid_id("../escape"));
    assert!(!valid_id("ab"));
    assert!(!valid_id("agent secret"));
}

#[test]
fn provision_keys_are_opaque_and_valid() {
    let first = opaque_key("provision").unwrap();
    let second = opaque_key("provision").unwrap();
    assert!(valid_id(&first));
    assert_ne!(first, second);
}

fn draft() -> HostedProcessDraft {
    HostedProcessDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        run_id: "run-123".into(),
        argv: vec!["node".into(), "worker.mjs".into(), "--once".into()],
        cwd: Some("/workspace/project".into()),
        timeout_ms: Some(60_000),
    }
}

#[test]
fn process_approval_binds_every_visible_argument() {
    let draft = normalize_draft(draft()).unwrap();
    let proposal = HostedProcessLaunchProposal {
        request_key: "process-example".into(),
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
    };
    let fingerprint = proposal_fingerprint(&proposal).unwrap();
    let approval = approval_for_process(
        &proposal,
        &fingerprint,
        "approval-hosted-process-example".into(),
        "2026-08-24T12:00:00.000Z".into(),
    );
    assert!(approval.data_used.contains(&"program: node".to_string()));
    assert!(approval
        .data_used
        .contains(&"argument 1: worker.mjs".to_string()));
    assert!(approval
        .data_used
        .contains(&"argument 2: --once".to_string()));
    assert!(approval
        .data_used
        .iter()
        .any(|value| value.ends_with(&fingerprint)));
    assert_eq!(approval.decisions, vec!["once", "deny"]);
}

#[test]
fn process_proposal_fingerprint_changes_with_arguments() {
    let draft = normalize_draft(draft()).unwrap();
    let mut proposal = HostedProcessLaunchProposal {
        request_key: "process-example".into(),
        workspace_id: draft.workspace_id,
        agent_id: draft.agent_id,
        device_id: draft.device_id,
        run_id: draft.run_id,
        argv: draft.argv,
        cwd: draft.cwd,
        timeout_ms: draft.timeout_ms,
    };
    let first = proposal_fingerprint(&proposal).unwrap();
    proposal.argv[2] = "--all".into();
    assert_ne!(first, proposal_fingerprint(&proposal).unwrap());
}

#[test]
fn rejects_shell_control_characters_and_workspace_escape() {
    let mut invalid = draft();
    invalid.argv[1] = "worker.mjs\nmalicious".into();
    assert!(normalize_draft(invalid).is_err());
    let mut escaped = draft();
    escaped.cwd = Some("/workspace/../etc".into());
    assert!(normalize_draft(escaped).is_err());
}

#[test]
fn cloud_browser_accepts_only_public_https_pages() {
    assert_eq!(
        normalize_public_https_url("https://example.com/path?q=1#section").unwrap(),
        "https://example.com/path?q=1"
    );
    for value in [
        "http://example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://10.0.0.1",
        "https://192.168.1.1",
        "https://[::1]",
        "https://user:secret@example.com",
    ] {
        assert!(
            normalize_public_https_url(value).is_err(),
            "accepted {value}"
        );
    }
}

#[test]
fn browser_approval_binds_the_exact_page_and_scope() {
    let proposal = HostedBrowserNavigateProposal {
        request_key: "browser-example".into(),
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        url: "https://example.com/".into(),
    };
    let fingerprint = browser_proposal_fingerprint(&proposal).unwrap();
    let approval = approval_for_browser(
        &proposal,
        &fingerprint,
        "approval-hosted-browser-example".into(),
        "2026-08-25T12:00:00.000Z".into(),
    );
    assert!(approval
        .data_used
        .contains(&"page: https://example.com/".to_string()));
    assert!(approval
        .data_used
        .iter()
        .any(|value| value.ends_with(&fingerprint)));
    assert_eq!(
        approval.confirmation_phrase.as_deref(),
        Some("open cloud browser")
    );
    assert_eq!(approval.decisions, vec!["once", "deny"]);
}

#[test]
fn browser_action_binds_one_observed_control_and_rejects_unsupported_keys() {
    let draft = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-1".into(),
        control_role: "button".into(),
        control_name: "Continue".into(),
        action: "click".into(),
        value: None,
        key: None,
    };
    let normalized = normalize_browser_action_draft(draft).unwrap();
    let proposal = HostedBrowserActionProposal {
        request_key: "browser-action-example".into(),
        workspace_id: normalized.workspace_id,
        agent_id: normalized.agent_id,
        device_id: normalized.device_id,
        observation_id: normalized.observation_id,
        element_ref: normalized.element_ref,
        control_role: normalized.control_role,
        control_name: normalized.control_name,
        action: normalized.action,
        value: normalized.value,
        key: normalized.key,
    };
    let fingerprint = browser_action_fingerprint(&proposal).unwrap();
    let approval = approval_for_browser_action(
        &proposal,
        &fingerprint,
        "approval-hosted-browser-action-example".into(),
        "2026-08-25T12:00:00.000Z".into(),
    );
    assert!(approval
        .data_used
        .contains(&"control name: Continue".to_string()));
    assert_eq!(
        approval.confirmation_phrase.as_deref(),
        Some("act in cloud browser")
    );
    let mut invalid_key = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-1".into(),
        control_role: "textbox".into(),
        control_name: "Search".into(),
        action: "press".into(),
        value: None,
        key: Some("Control+A".into()),
    };
    assert!(normalize_browser_action_draft(invalid_key.clone()).is_err());
    invalid_key.key = Some("Enter".into());
    assert!(normalize_browser_action_draft(invalid_key).is_ok());
    let select = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-2".into(),
        control_role: "combobox".into(),
        control_name: "Region".into(),
        action: "select".into(),
        value: Some("Europe".into()),
        key: None,
    };
    assert!(normalize_browser_action_draft(select).is_ok());
    let mut scroll = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-0".into(),
        control_role: "document".into(),
        control_name: "Page".into(),
        action: "scroll".into(),
        value: Some("page-down".into()),
        key: None,
    };
    assert!(normalize_browser_action_draft(scroll.clone()).is_ok());
    scroll.element_ref = "control-1234567890abcdef-1".into();
    assert!(normalize_browser_action_draft(scroll.clone()).is_err());
    scroll.element_ref = "control-1234567890abcdef-0".into();
    scroll.value = Some("bottom".into());
    assert!(normalize_browser_action_draft(scroll).is_err());
    let mut history = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-0".into(),
        control_role: "document".into(),
        control_name: "Page".into(),
        action: "history".into(),
        value: Some("back".into()),
        key: None,
    };
    assert!(normalize_browser_action_draft(history.clone()).is_ok());
    history.value = Some("reload".into());
    assert!(normalize_browser_action_draft(history).is_err());
    let mut download = HostedBrowserActionDraft {
        workspace_id: "workspace:alpha".into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
        observation_id: "observation-1234567890abcdef".into(),
        element_ref: "control-1234567890abcdef-3".into(),
        control_role: "link".into(),
        control_name: "Download report".into(),
        action: "download".into(),
        value: None,
        key: None,
    };
    assert!(normalize_browser_action_draft(download.clone()).is_ok());
    download.value = Some("report.pdf".into());
    assert!(normalize_browser_action_draft(download).is_err());
}

#[test]
fn mismatched_hosted_drafts_are_rejected() {
    let scope = directory::HostedComputerScope {
        workspace_id: "workspace:alpha".into(),
        device_id: "device-desktop".into(),
    };
    let draft = normalize_draft(draft()).unwrap();
    assert!(directory::hosted_scope_matches(
        &scope,
        &draft.workspace_id,
        Some(&draft.device_id)
    ));
    let mut mismatched = draft;
    mismatched.workspace_id = "workspace:beta".into();
    assert!(!directory::hosted_scope_matches(
        &scope,
        &mismatched.workspace_id,
        Some(&mismatched.device_id)
    ));
    mismatched.workspace_id = "workspace:alpha".into();
    mismatched.device_id = "device-other".into();
    assert!(!directory::hosted_scope_matches(
        &scope,
        &mismatched.workspace_id,
        Some(&mismatched.device_id)
    ));
}

fn clear_live_view_handles() {
    live_view_handles()
        .lock()
        .expect("live view handle lock")
        .clear();
}

fn live_view_test_guard() -> std::sync::MutexGuard<'static, ()> {
    // Production intentionally retains only one takeover URL globally.
    // These tests must not clear each other's native secret mid-assertion.
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().expect("live view test lock")
}

fn live_view_target(workspace_id: &str) -> HostedBrowserTarget {
    HostedBrowserTarget {
        workspace_id: workspace_id.into(),
        agent_id: "agent-research".into(),
        device_id: "device-desktop".into(),
    }
}

#[test]
fn live_view_secrets_stay_native_and_are_omitted_from_frontend_snapshots() {
    let _guard = live_view_test_guard();
    clear_live_view_handles();
    let snapshot = HostedBrowserSnapshot {
        current_url: "https://example.com/".into(),
        title: "Example".into(),
        observation_id: "observation-1234567890abcdef".into(),
        viewport: HostedBrowserViewportSnapshot {
            scroll_x: 0,
            scroll_y: 0,
            width: 1280,
            height: 800,
            document_width: 1280,
            document_height: 1600,
            can_scroll_up: false,
            can_scroll_down: true,
        },
        navigation: HostedBrowserNavigationSnapshot {
            can_go_back: false,
            can_go_forward: false,
        },
        controls: vec![],
        preview_data_url: "data:image/jpeg;base64,cHJldmlldw==".into(),
        live_view_url: Some("https://live.browser.run/ui/token?wss=secret".into()),
        takeover_available: false,
        last_download: None,
        updated_at: "2026-08-25T12:00:02.000Z".into(),
    };
    let public = retain_live_view_for_frontend(
        snapshot,
        "workspace:alpha",
        "agent-research",
        "device-desktop",
    );
    assert!(public.live_view_url.is_none());
    assert!(public.takeover_available);
    let encoded = serde_json::to_string(&public).unwrap();
    assert!(!encoded.contains("wss"));
    assert!(!encoded.contains("liveViewUrl"));
    assert_eq!(
        live_view_handle("workspace:alpha", "agent-research", "device-desktop").as_deref(),
        Some("https://live.browser.run/ui/token?wss=secret")
    );
    assert!(validate_live_view_url("https://live.browser.run/ui/token?wss=secret").is_ok());
    assert!(validate_live_view_url("https://evil.example/?wss=secret").is_err());
}

#[test]
fn storing_a_live_view_drops_other_workspace_secrets() {
    let _guard = live_view_test_guard();
    clear_live_view_handles();
    store_live_view(
        "workspace:alpha",
        "agent-research",
        "device-desktop",
        "https://live.browser.run/ui/alpha?wss=secret-a".into(),
    )
    .expect("store alpha");
    store_live_view(
        "workspace:beta",
        "agent-research",
        "device-desktop",
        "https://live.browser.run/ui/beta?wss=secret-b".into(),
    )
    .expect("store beta");
    assert!(
        live_view_handle("workspace:alpha", "agent-research", "device-desktop").is_none(),
        "previous hosted workspace takeover URL must not survive a later snapshot"
    );
    assert_eq!(
        live_view_handle("workspace:beta", "agent-research", "device-desktop").as_deref(),
        Some("https://live.browser.run/ui/beta?wss=secret-b")
    );
    clear_live_view_handles();
}

#[test]
fn invalid_live_view_urls_are_not_stored() {
    let _guard = live_view_test_guard();
    clear_live_view_handles();
    assert!(store_live_view(
        "workspace:alpha",
        "agent-research",
        "device-desktop",
        "https://evil.example/ui/token?wss=secret".into(),
    )
    .is_err());
    assert!(live_view_handle("workspace:alpha", "agent-research", "device-desktop").is_none());
    let public = retain_live_view_for_frontend(
        HostedBrowserSnapshot {
            current_url: "https://example.com/".into(),
            title: "Example".into(),
            observation_id: "observation-1234567890abcdef".into(),
            viewport: HostedBrowserViewportSnapshot {
                scroll_x: 0,
                scroll_y: 0,
                width: 1280,
                height: 800,
                document_width: 1280,
                document_height: 1600,
                can_scroll_up: false,
                can_scroll_down: true,
            },
            navigation: HostedBrowserNavigationSnapshot {
                can_go_back: false,
                can_go_forward: false,
            },
            controls: vec![],
            preview_data_url: "data:image/jpeg;base64,cHJldmlldw==".into(),
            live_view_url: Some("https://evil.example/ui/token?wss=secret".into()),
            takeover_available: true,
            last_download: None,
            updated_at: "2026-08-25T12:00:02.000Z".into(),
        },
        "workspace:alpha",
        "agent-research",
        "device-desktop",
    );
    assert!(public.live_view_url.is_none());
    assert!(!public.takeover_available);
    assert!(live_view_handle("workspace:alpha", "agent-research", "device-desktop").is_none());
    clear_live_view_handles();
}

#[test]
fn live_view_open_requires_selected_hosted_scope_even_when_a_handle_exists() {
    let _guard = live_view_test_guard();
    clear_live_view_handles();
    store_live_view(
        "workspace:alpha",
        "agent-research",
        "device-desktop",
        "https://live.browser.run/ui/token?wss=secret".into(),
    )
    .expect("store");
    let error = live_view_url_for_open(live_view_target("workspace:alpha"))
        .expect_err("open must not skip the selected hosted workspace fence");
    assert!(
        error.contains("Account storage unavailable")
            || error.contains("Select an available hosted workspace")
            || error.contains("does not match the selected workspace"),
        "{error}"
    );
    assert!(
        live_view_handle("workspace:alpha", "agent-research", "device-desktop").is_some(),
        "scope refusal must not be confused with a missing handle"
    );
    clear_live_view_handles();
}
