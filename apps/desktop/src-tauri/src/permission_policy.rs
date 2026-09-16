//! Workspace permission profile policy.
//!
//! The public protocol keeps the existing mode values (`read-only`,
//! `trusted-scope`, `full-access`). This module gives those values explicit
//! profile semantics at native execution boundaries.
//!
//! Allow-sets, effect vocabulary, and tool/action maps are the TypeScript
//! `permission-policy.json` fixture. Native code `include_str!`s the same file
//! so a host that trusts either evaluator cannot under- or over-gate relative
//! to the other.

use crate::models::APPROVAL_MODES;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const VOCABULARY_JSON: &str =
    include_str!("../../../../packages/connectors/src/permission-policy.json");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PermissionPolicyDecision {
    pub profile: String,
    pub mode: String,
    pub allowed: bool,
    pub approval_required: bool,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reasons {
    read_only_denied: String,
    trusted_denied: String,
    approval_required: String,
    read_like_allowed: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vocabulary {
    effects: Vec<String>,
    profile_for_mode: HashMap<String, String>,
    read_only_allowed: Vec<String>,
    trusted_allowed: Vec<String>,
    high_severity_effects: Vec<String>,
    consequential_effects: Vec<String>,
    high_risks: Vec<String>,
    reasons: Reasons,
    tool_effects: HashMap<String, String>,
    connector_delete_actions: Vec<String>,
    connector_publish_actions: Vec<String>,
    browser_action_effects: HashMap<String, String>,
}

struct CompiledPolicy {
    #[allow(dead_code)]
    effects: Vec<String>,
    profile_for_mode: HashMap<String, String>,
    mode_for_profile: HashMap<String, String>,
    read_only_allowed: HashSet<String>,
    trusted_allowed: HashSet<String>,
    #[allow(dead_code)]
    high_severity: HashSet<String>,
    consequential: HashSet<String>,
    high_risks: HashSet<String>,
    tool_effects: HashMap<String, String>,
    connector_delete: HashSet<String>,
    connector_publish: HashSet<String>,
    browser_action_effects: HashMap<String, String>,
    reasons: Reasons,
}

fn compiled() -> &'static CompiledPolicy {
    static CELL: OnceLock<CompiledPolicy> = OnceLock::new();
    CELL.get_or_init(|| {
        let vocabulary: Vocabulary = serde_json::from_str(VOCABULARY_JSON)
            .expect("packages/connectors/src/permission-policy.json must parse");
        let to_set = |values: Vec<String>| values.into_iter().collect::<HashSet<_>>();
        let mode_for_profile = vocabulary
            .profile_for_mode
            .iter()
            .map(|(mode, profile)| (profile.clone(), mode.clone()))
            .collect();
        CompiledPolicy {
            effects: vocabulary.effects,
            profile_for_mode: vocabulary.profile_for_mode,
            mode_for_profile,
            read_only_allowed: to_set(vocabulary.read_only_allowed),
            trusted_allowed: to_set(vocabulary.trusted_allowed),
            high_severity: to_set(vocabulary.high_severity_effects),
            consequential: to_set(vocabulary.consequential_effects),
            high_risks: to_set(vocabulary.high_risks),
            tool_effects: vocabulary.tool_effects,
            connector_delete: to_set(vocabulary.connector_delete_actions),
            connector_publish: to_set(vocabulary.connector_publish_actions),
            browser_action_effects: vocabulary.browser_action_effects,
            reasons: vocabulary.reasons,
        }
    })
}

pub(crate) fn profile_for_mode(mode: &str) -> Option<&'static str> {
    compiled().profile_for_mode.get(mode).map(String::as_str)
}

fn mode_for_profile(profile: &str) -> Option<&'static str> {
    compiled().mode_for_profile.get(profile).map(String::as_str)
}

pub(crate) fn normalize_permission_route(
    mode: &str,
    profile: Option<&str>,
) -> Result<(String, String), String> {
    let normalized_mode = mode.trim().to_ascii_lowercase();
    if !APPROVAL_MODES.contains(&normalized_mode.as_str()) {
        return Err("Permission mode is not recognized.".to_string());
    }

    match profile.map(|value| value.trim().to_ascii_lowercase()) {
        Some(profile) if !profile.is_empty() => {
            let expected_mode = mode_for_profile(&profile)
                .ok_or_else(|| "Permission profile is not recognized.".to_string())?;
            if expected_mode != normalized_mode {
                return Err("Permission profile does not match its protocol mode.".to_string());
            }
            Ok((normalized_mode, profile))
        }
        _ => Ok((
            normalized_mode.clone(),
            profile_for_mode(&normalized_mode)
                .ok_or_else(|| "Permission mode is not recognized.".to_string())?
                .to_string(),
        )),
    }
}

pub(crate) fn effect_for_tool(tool: &str) -> Option<&'static str> {
    compiled().tool_effects.get(tool).map(String::as_str)
}

pub(crate) fn effect_for_connector_action(action: &str) -> &'static str {
    let policy = compiled();
    if policy.connector_delete.contains(action) {
        "delete"
    } else if policy.connector_publish.contains(action) {
        "publish-external"
    } else {
        "connector-write"
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn effect_for_browser_action(action: &str) -> Option<&'static str> {
    compiled()
        .browser_action_effects
        .get(action)
        .map(String::as_str)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn is_high_severity_effect(effect: &str) -> bool {
    compiled().high_severity.contains(effect)
}

pub(crate) fn evaluate_permission_policy(
    mode: &str,
    profile: Option<&str>,
    effect: &str,
    risk_level: &str,
) -> Result<PermissionPolicyDecision, String> {
    let (mode, profile) = normalize_permission_route(mode, profile)?;
    let policy = compiled();

    if profile == "read-only" && !policy.read_only_allowed.contains(effect) {
        return Ok(PermissionPolicyDecision {
            profile,
            mode,
            allowed: false,
            approval_required: false,
            reason: policy.reasons.read_only_denied.clone(),
        });
    }
    if profile == "trusted" && !policy.trusted_allowed.contains(effect) {
        return Ok(PermissionPolicyDecision {
            profile,
            mode,
            allowed: false,
            approval_required: false,
            reason: policy.reasons.trusted_denied.clone(),
        });
    }

    let approval_required = policy.consequential.contains(effect)
        || effect == "web-fetch"
        || policy.high_risks.contains(risk_level);

    Ok(PermissionPolicyDecision {
        profile,
        mode,
        allowed: true,
        approval_required,
        reason: if approval_required {
            policy.reasons.approval_required.clone()
        } else {
            policy.reasons.read_like_allowed.clone()
        },
    })
}

pub(crate) fn ensure_permission_allowed(
    mode: &str,
    profile: Option<&str>,
    effect: &str,
    risk_level: &str,
) -> Result<PermissionPolicyDecision, String> {
    let decision = evaluate_permission_policy(mode, profile, effect, risk_level)?;
    if decision.allowed {
        Ok(decision)
    } else {
        Err(format!("Permission denied: {}", decision.reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CONNECTOR_ACTIONS;
    use crate::tools::SUPPORTED_TOOLS;

    fn expected_decision(profile: &str, effect: &str, risk_level: &str) -> (bool, bool) {
        let policy = compiled();
        let allowed = match profile {
            "read-only" => policy.read_only_allowed.contains(effect),
            "trusted" => policy.trusted_allowed.contains(effect),
            _ => true,
        };
        if !allowed {
            return (false, false);
        }
        let approval_required = policy.consequential.contains(effect)
            || effect == "web-fetch"
            || policy.high_risks.contains(risk_level);
        (true, approval_required)
    }

    #[test]
    fn read_only_blocks_writes_and_shell_execution() {
        assert!(ensure_permission_allowed("read-only", None, "local-read", "low").is_ok());
        assert!(ensure_permission_allowed("read-only", None, "coordination", "low").is_ok());
        assert!(ensure_permission_allowed("read-only", None, "local-write", "medium").is_err());
        assert!(
            ensure_permission_allowed("read-only", None, "shell-execution", "critical").is_err()
        );
        assert!(ensure_permission_allowed("read-only", None, "connector-write", "high").is_err());
        assert!(ensure_permission_allowed("read-only", None, "delete", "high").is_err());
        assert!(ensure_permission_allowed("read-only", None, "publish-external", "high").is_err());
    }

    #[test]
    fn trusted_requires_approval_for_consequential_and_blocks_shell() {
        for effect in &[
            "local-write",
            "connector-write",
            "app-state-mutation",
            "browser-state-mutation",
            "delete",
            "publish-external",
            "memory-promotion",
        ] {
            let decision =
                evaluate_permission_policy("trusted-scope", None, effect, "low").unwrap();
            assert!(decision.allowed, "{effect}");
            assert!(decision.approval_required, "{effect}");
        }
        assert!(
            ensure_permission_allowed("trusted-scope", None, "shell-execution", "medium").is_err()
        );
        assert!(
            ensure_permission_allowed("trusted-scope", None, "cache-mutation", "medium").is_err()
        );
    }

    #[test]
    fn full_access_allows_consequential_but_requires_approval() {
        for effect in &[
            "local-write",
            "shell-execution",
            "connector-write",
            "cache-mutation",
            "app-state-mutation",
            "delete",
            "publish-external",
            "memory-promotion",
            "browser-state-mutation",
        ] {
            let decision = evaluate_permission_policy("full-access", None, effect, "low").unwrap();
            assert!(decision.allowed, "{effect}");
            assert!(decision.approval_required, "{effect}");
        }
    }

    #[test]
    fn profile_must_match_public_mode() {
        assert!(normalize_permission_route("trusted-scope", Some("trusted")).is_ok());
        assert!(normalize_permission_route("read-only", Some("full-with-approvals")).is_err());
    }

    #[test]
    fn shared_vocabulary_decisions_match_native_evaluator() {
        let policy = compiled();
        for mode in ["read-only", "trusted-scope", "full-access"] {
            let profile = profile_for_mode(mode).expect(mode);
            for effect in &policy.effects {
                for risk in ["low", "medium", "high", "critical"] {
                    let decision = evaluate_permission_policy(mode, None, effect, risk).unwrap();
                    let (allowed, approval_required) = expected_decision(profile, effect, risk);
                    assert_eq!(
                        (decision.allowed, decision.approval_required),
                        (allowed, approval_required),
                        "{mode} {effect} {risk}"
                    );
                }
            }
        }
    }

    #[test]
    fn shared_tool_and_action_maps_match_native_lookups() {
        let policy = compiled();
        for (tool, effect) in &policy.tool_effects {
            assert_eq!(effect_for_tool(tool), Some(effect.as_str()), "{tool}");
        }
        assert_eq!(effect_for_tool("local-browser"), None);
        for (action, effect) in &policy.browser_action_effects {
            assert_eq!(
                effect_for_browser_action(action),
                Some(effect.as_str()),
                "{action}"
            );
        }
        assert_eq!(effect_for_browser_action("browser.dom-dump"), None);
        for action in CONNECTOR_ACTIONS {
            let expected = if policy.connector_delete.contains(action) {
                "delete"
            } else if policy.connector_publish.contains(action) {
                "publish-external"
            } else {
                "connector-write"
            };
            assert_eq!(effect_for_connector_action(action), expected, "{action}");
        }
        assert_eq!(
            effect_for_connector_action("unknown.write"),
            "connector-write"
        );
        for action in policy
            .connector_delete
            .iter()
            .chain(&policy.connector_publish)
        {
            assert!(
                CONNECTOR_ACTIONS.contains(&action.as_str()),
                "{action} is not a native connector action"
            );
        }
        for tool in SUPPORTED_TOOLS {
            assert!(
                effect_for_tool(tool).is_some(),
                "{tool} is missing from the shared toolEffects table"
            );
        }
        for effect in &policy.high_severity {
            assert!(is_high_severity_effect(effect), "{effect}");
        }
        assert!(!is_high_severity_effect("local-read"));
    }
}
