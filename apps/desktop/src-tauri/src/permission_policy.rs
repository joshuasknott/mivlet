//! Workspace permission profile policy.
//!
//! The public protocol keeps the existing mode values (`read-only`,
//! `trusted-scope`, `full-access`). This module gives those values explicit
//! profile semantics at native execution boundaries.

use crate::models::APPROVAL_MODES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PermissionPolicyDecision {
    pub profile: String,
    pub mode: String,
    pub allowed: bool,
    pub approval_required: bool,
    pub reason: String,
}

pub(crate) fn profile_for_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "read-only" => Some("read-only"),
        "trusted-scope" => Some("trusted"),
        "full-access" => Some("full-with-approvals"),
        _ => None,
    }
}

fn mode_for_profile(profile: &str) -> Option<&'static str> {
    match profile {
        "read-only" => Some("read-only"),
        "trusted" => Some("trusted-scope"),
        "full-with-approvals" => Some("full-access"),
        _ => None,
    }
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
    match tool {
        "read-file" => Some("local-read"),
        "write-file" => Some("local-write"),
        "run-shell" => Some("shell-execution"),
        "web-fetch" => Some("web-fetch"),
        "github-read"
        | "vercel-read"
        | "linear-read"
        | "google-drive-read"
        | "gmail-read"
        | "google-calendar-read"
        | "search-notion"
        | "search-slack" => Some("connector-read"),
        _ => None,
    }
}

pub(crate) fn evaluate_permission_policy(
    mode: &str,
    profile: Option<&str>,
    effect: &str,
    risk_level: &str,
) -> Result<PermissionPolicyDecision, String> {
    let (mode, profile) = normalize_permission_route(mode, profile)?;
    let read_only_allowed = matches!(
        effect,
        "local-read" | "connector-read" | "web-fetch" | "cache-read"
    );
    let trusted_allowed = read_only_allowed
        || matches!(
            effect,
            "local-write"
                | "connector-write"
                | "app-state-mutation"
                | "schedule-mutation"
                | "schedule-execution"
        );

    if profile == "read-only" && !read_only_allowed {
        return Ok(PermissionPolicyDecision {
            profile,
            mode,
            allowed: false,
            approval_required: false,
            reason: "Read-only only permits safe local, connector, cache, and web reads."
                .to_string(),
        });
    }
    if profile == "trusted" && !trusted_allowed {
        return Ok(PermissionPolicyDecision {
            profile,
            mode,
            allowed: false,
            approval_required: false,
            reason: "Trusted profile blocks shell execution and cache mutation.".to_string(),
        });
    }

    let approval_required = matches!(
        effect,
        "local-write"
            | "shell-execution"
            | "connector-write"
            | "cache-mutation"
            | "app-state-mutation"
            | "schedule-mutation"
            | "schedule-execution"
            | "web-fetch"
    ) || matches!(risk_level, "high" | "critical");

    Ok(PermissionPolicyDecision {
        profile,
        mode,
        allowed: true,
        approval_required,
        reason: if approval_required {
            "This action is allowed only through the approval and audit boundary.".to_string()
        } else {
            "This read-like action is allowed by the active permission profile.".to_string()
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

    #[test]
    fn read_only_blocks_writes_shell_and_schedules() {
        assert!(ensure_permission_allowed("read-only", None, "local-read", "low").is_ok());
        assert!(ensure_permission_allowed("read-only", None, "local-write", "medium").is_err());
        assert!(
            ensure_permission_allowed("read-only", None, "shell-execution", "critical").is_err()
        );
        assert!(
            ensure_permission_allowed("read-only", None, "schedule-execution", "medium").is_err()
        );
        assert!(
            ensure_permission_allowed("read-only", None, "schedule-mutation", "medium").is_err()
        );
        assert!(ensure_permission_allowed("read-only", None, "connector-write", "high").is_err());
    }

    #[test]
    fn trusted_requires_approval_for_consequential_and_blocks_shell() {
        // Consequential allowed but require approval
        for effect in &[
            "local-write",
            "connector-write",
            "app-state-mutation",
            "schedule-mutation",
            "schedule-execution",
        ] {
            let decision =
                evaluate_permission_policy("trusted-scope", None, effect, "low").unwrap();
            assert!(decision.allowed);
            assert!(decision.approval_required);
        }
        // Shell and cache mutations are blocked
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
            "schedule-mutation",
            "schedule-execution",
        ] {
            let decision = evaluate_permission_policy("full-access", None, effect, "low").unwrap();
            assert!(decision.allowed);
            assert!(decision.approval_required);
        }
    }

    #[test]
    fn profile_must_match_public_mode() {
        assert!(normalize_permission_route("trusted-scope", Some("trusted")).is_ok());
        assert!(normalize_permission_route("read-only", Some("full-with-approvals")).is_err());
    }
}
