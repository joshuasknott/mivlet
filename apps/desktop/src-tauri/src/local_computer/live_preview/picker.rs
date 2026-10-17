use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pick {
    pub kind: String,
    pub preview_id: String,
    pub job_id: String,
    pub job_generation: u64,
    pub revision: String,
    pub path: String,
    pub tag: String,
    pub label: String,
    pub bounds: Bounds,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(super) fn script(id: &str, job: &str, generation: u64, revision: &str) -> String {
    include_str!("picker.js").replace(
        "__MIVLET_NATIVE_PREVIEW_BINDING__",
        &json!({"previewId":id,"jobId":job,"jobGeneration":generation,"revision":revision})
            .to_string(),
    )
}
pub(super) fn feedback(
    pick: &Pick,
    id: &str,
    job: &str,
    generation: u64,
    revision: &str,
) -> Result<serde_json::Value, String> {
    if pick.kind != "mivlet-preview-pick"
        || pick.preview_id != id
        || pick.job_id != job
        || pick.job_generation != generation
        || pick.revision != revision
    {
        return Err("This preview selection belongs to a different or expired session.".into());
    }
    if !pick.path.starts_with('/')
        || pick.path.starts_with("//")
        || pick.path.len() > 1024
        || pick.path.contains(['?', '#', '\\'])
        || pick.path.chars().any(char::is_control)
        || pick.tag.is_empty()
        || pick.tag.len() > 40
        || !pick
            .tag
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
        || matches!(
            pick.tag.as_str(),
            "INPUT" | "TEXTAREA" | "SELECT" | "OPTION" | "SCRIPT" | "STYLE" | "IFRAME"
        )
        || pick.label.trim().is_empty()
        || pick.label.chars().count() > 200
        || pick.label.chars().any(char::is_control)
        || crate::secret_redaction::looks_secret(&pick.label)
        || crate::secret_redaction::looks_secret(&pick.path)
        || crate::secret_redaction::secret_marker_survives(&pick.label)
        || [
            pick.bounds.x,
            pick.bounds.y,
            pick.bounds.width,
            pick.bounds.height,
        ]
        .iter()
        .any(|n| !n.is_finite() || *n < 0.0 || *n > 100000.0)
        || pick.bounds.width == 0.0
        || pick.bounds.height == 0.0
    {
        return Err("Choose a public preview element without field values or private text.".into());
    }
    Ok(
        json!({"previewId":id,"revision":revision,"path":pick.path,"tag":pick.tag,"label":pick.label,"bounds":pick.bounds,"trust":"external-untrusted"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pick() -> Pick {
        Pick {
            kind: "mivlet-preview-pick".into(),
            preview_id: "preview".into(),
            job_id: "job".into(),
            job_generation: 3,
            revision: "tree".into(),
            path: "/pricing".into(),
            tag: "BUTTON".into(),
            label: "See plans".into(),
            bounds: Bounds {
                x: 1.0,
                y: 2.0,
                width: 80.0,
                height: 40.0,
            },
        }
    }
    #[test]
    fn element_feedback_binds_session_generation_revision_and_omits_form_values() {
        let point = pick();
        assert_eq!(
            feedback(&point, "preview", "job", 3, "tree").unwrap()["trust"],
            "external-untrusted"
        );
        for (id, job, generation, revision) in [
            ("other", "job", 3, "tree"),
            ("preview", "other", 3, "tree"),
            ("preview", "job", 4, "tree"),
            ("preview", "job", 3, "changed"),
        ] {
            assert!(feedback(&point, id, job, generation, revision).is_err());
        }
        let mut changed = pick();
        changed.tag = "INPUT".into();
        assert!(feedback(&changed, "preview", "job", 3, "tree").is_err());
        let mut changed = pick();
        changed.path = "/pricing?password=private".into();
        assert!(feedback(&changed, "preview", "job", 3, "tree").is_err());
        let mut changed = pick();
        changed.bounds.width = f64::NAN;
        assert!(feedback(&changed, "preview", "job", 3, "tree").is_err());
    }
    #[test]
    fn fixed_guest_script_has_no_tauri_bridge_or_user_expressions() {
        let source = script("preview", "job", 3, "tree");
        assert!(!source.contains("__MIVLET_NATIVE_PREVIEW_BINDING__"));
        assert!(source.contains("event.isTrusted"));
        assert!(source.contains("event.source !== parent"));
        assert!(source.contains("contenteditable"));
        assert!(!source.contains("__TAURI"));
    }
}
