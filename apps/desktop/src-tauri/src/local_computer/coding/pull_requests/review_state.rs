use super::*;
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReviewState {
    pub head: String,
    pub body: String,
    pub comments: Vec<ReviewComment>,
    pub viewed: BTreeMap<String, String>,
}
pub(super) fn validate_draft(input: &Request) -> Result<(), String> {
    if input.body.len() > 12000 || input.comments.len() > 30 {
        return Err("Review exceeds its text or 30-comment limit.".into());
    }
    for comment in &input.comments {
        if comment.path.is_empty()
            || comment.path.len() > 1024
            || comment.path.contains(['\0', '\r', '\n'])
            || comment.line == 0
            || !["LEFT", "RIGHT"].contains(&comment.side.as_str())
            || comment.body.trim().is_empty()
            || comment.body.len() > 4000
        {
            return Err("Review comments need a path, positive diff line, LEFT/RIGHT side and 1–4000 bytes of text.".into());
        }
    }
    Ok(())
}
pub(super) fn validate_positions(
    api: &impl Api,
    repo: &Repository,
    input: &Request,
) -> Result<(), String> {
    if input.comments.is_empty() {
        return Ok(());
    }
    let files = api::all(
        api,
        &format!("{}/files", api::endpoint(repo, input.number)?),
        None,
    )?;
    for comment in &input.comments {
        let file = files
            .iter()
            .find(|file| file["filename"] == comment.path)
            .ok_or("Review comment path is not in the current PR diff.")?;
        let patch = file["patch"]
            .as_str()
            .ok_or("This file has no reviewable text patch.")?;
        if !api::complete_patch(file) {
            return Err("GitHub supplied an incomplete patch. Inspect this file on GitHub.".into());
        }
        if !line_in_patch(patch, comment.line, &comment.side) {
            return Err(
                "Review comment line is not present on that side of the current diff.".into(),
            );
        }
    }
    Ok(())
}
fn line_in_patch(patch: &str, target: u32, side: &str) -> bool {
    let mut old = 0u32;
    let mut new = 0u32;
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let pieces: Vec<_> = line.split_whitespace().collect();
            let number = |part: Option<&&str>| {
                part.and_then(|part| part.get(1..))
                    .and_then(|part| part.split(',').next())
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0)
            };
            old = number(pieces.get(1));
            new = number(pieces.get(2));
        } else if line.starts_with('+') {
            if side == "RIGHT" && new == target {
                return true;
            }
            new = new.saturating_add(1);
        } else if line.starts_with('-') {
            if side == "LEFT" && old == target {
                return true;
            }
            old = old.saturating_add(1);
        } else if line.starts_with(' ') {
            if side == "LEFT" && old == target || side == "RIGHT" && new == target {
                return true;
            }
            old = old.saturating_add(1);
            new = new.saturating_add(1);
        }
    }
    false
}
pub(super) fn apply(
    api: &impl Api,
    repo: &Repository,
    saved: &mut Saved,
    input: &Request,
) -> Result<Value, String> {
    if input.number == 0 {
        return Err("Choose a PR.".into());
    }
    if input.action == "state" {
        return Ok(
            json!({"review": saved.reviews.get(&input.number), "pending": saved.pending, "watch": saved.watch}),
        );
    }
    if saved.reviews.len() >= 20 && !saved.reviews.contains_key(&input.number) {
        return Err("Keep local review state for at most 20 PRs per copy.".into());
    }
    if input.action == "discard" {
        saved.reviews.remove(&input.number);
        return Ok(json!({"discarded": true}));
    }
    let pr = api::detail(api, repo, input.number)?;
    api::verify(&pr, input)?;
    let state = saved.reviews.entry(input.number).or_default();
    match input.action.as_str() {
        "draft" => {
            validate_draft(input)?;
            state.head.clone_from(&input.expected_head);
            state.body.clone_from(&input.body);
            state.comments.clone_from(&input.comments);
        }
        "viewed" => {
            if input.viewed {
                if state.viewed.len() >= 1000 && !state.viewed.contains_key(&input.path) {
                    return Err("Viewed-file limit reached.".into());
                }
                let result = api::read(
                    api,
                    repo,
                    &Request {
                        action: "files".into(),
                        ..input.clone()
                    },
                )?;
                let file = result["items"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|file| file["path"] == input.path))
                    .ok_or("Refresh the page containing this file before marking it viewed.")?;
                if file["revision"] != input.revision {
                    return Err(
                        "File changed; inspect its latest diff before marking it viewed.".into(),
                    );
                }
                if file["patchUnavailable"] != false {
                    return Err("A missing or partial patch cannot be marked fully viewed.".into());
                }
                state
                    .viewed
                    .insert(input.path.clone(), input.revision.clone());
            } else {
                state.viewed.remove(&input.path);
            }
        }
        _ => return Err("Unknown local review action.".into()),
    }
    Ok(json!({"review": state, "pending": saved.pending, "watch": saved.watch}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_positions_bind_the_diff_side_and_skip_hunk_gaps() {
        let patch = "@@ -8,3 +8,3 @@\n same\n-before\n+after\n context\n@@ -40 +40 @@\n-last\n+next\n\\ No newline at end of file";
        for side in ["LEFT", "RIGHT"] {
            assert!(line_in_patch(patch, 8, side));
            assert!(line_in_patch(patch, 9, side));
            assert!(line_in_patch(patch, 40, side));
            assert!(!line_in_patch(patch, 12, side));
            assert!(!line_in_patch(patch, 41, side));
        }
        assert!(line_in_patch("@@ -0,0 +1 @@\n+new", 1, "RIGHT"));
        assert!(!line_in_patch("@@ -0,0 +1 @@\n+new", 1, "LEFT"));
        assert!(!line_in_patch("@@ -1 +0,0 @@\n-old", 1, "RIGHT"));
    }
    #[test]
    fn partial_and_binary_patches_are_never_complete_review_evidence() {
        let mut file = json!({"patch":"@@ -1 +1 @@\n-old\n+new", "additions":1, "deletions":1});
        assert!(api::complete_patch(&file));
        file["additions"] = 2.into();
        assert!(!api::complete_patch(&file));
        file["patch"] = Value::Null;
        assert!(!api::complete_patch(&file));
    }
}
