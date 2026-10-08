use super::*;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pending {
    pub request: Request,
    pub actor: String,
    pub started_at: String,
    #[serde(default)]
    pub previous_reviews: Vec<u64>,
}
fn bound(repo: &Repository, input: &Request) -> Result<(), String> {
    if input.remote != api::remote(repo)? {
        return Err("Approval must name the exact attached remote.".into());
    }
    review_state::validate_draft(input)?;
    Ok(())
}
fn payload(input: &Request) -> Result<(String, Value), String> {
    match input.action.as_str() {
        "edit" => {
            if input.title.trim().is_empty() || input.title.len() > 200 {
                return Err("Supply a PR title up to 200 bytes.".into());
            }
            Ok((
                "PATCH".into(),
                json!({"title": input.title, "body": input.body}),
            ))
        }
        "review" => {
            if !["APPROVE", "REQUEST_CHANGES", "COMMENT", "PENDING"].contains(&input.event.as_str())
                || matches!(input.event.as_str(), "REQUEST_CHANGES" | "COMMENT")
                    && input.body.trim().is_empty()
            {
                return Err("Choose APPROVE, REQUEST_CHANGES, COMMENT or PENDING; comments/changes need a body.".into());
            }
            let mut body = json!({"commit_id": input.expected_head, "body": input.body, "comments": input.comments});
            if input.event != "PENDING" {
                body["event"] = input.event.clone().into();
            }
            Ok(("POST".into(), body))
        }
        "submit" => {
            if input.review_id == 0
                || !["APPROVE", "REQUEST_CHANGES", "COMMENT"].contains(&input.event.as_str())
            {
                return Err("Choose an existing pending review and a submit action.".into());
            }
            Ok((
                "POST".into(),
                json!({"event": input.event, "body": input.body}),
            ))
        }
        "delete-draft" if input.review_id > 0 => Ok(("DELETE".into(), Value::Null)),
        "push" => Ok(("".into(), Value::Null)),
        _ => Err("Unknown PR mutation.".into()),
    }
}
fn review_owned(api: &impl Api, prefix: &str, input: &Request, actor: &str) -> Result<(), String> {
    if matches!(input.action.as_str(), "submit" | "delete-draft") {
        let review = api.request(
            "GET",
            &format!("{prefix}/reviews/{}", input.review_id),
            None,
        )?;
        if review["state"] != "PENDING"
            || review["commit_id"] != input.expected_head
            || review["user"]["login"].as_str() != Some(actor)
        {
            return Err(
                "The draft review changed, belongs to another account, or reviews another commit."
                    .into(),
            );
        }
    }
    Ok(())
}
pub(super) fn execute(
    directory: &Path,
    repo: &mut Repository,
    saved: &mut Saved,
    input: &Request,
    ticket: &OperationTicket,
    api: &impl Api,
) -> Result<Value, String> {
    ticket.check()?;
    if input.action == "recover" {
        return recover(directory, repo, saved, ticket, api);
    }
    if saved.pending.is_some() || repo.operation != "idle" {
        return Err("Reconcile the pending repository/PR operation first; nothing is automatically retried.".into());
    }
    bound(repo, input)?;
    let pr = api::detail(api, repo, input.number)?;
    api::verify(&pr, input)?;
    if pr["state"] != "open" {
        return Err("This PR is closed; remote changes are unavailable.".into());
    }
    let (method, body) = payload(input)?;
    let actor = api.request("GET", "/user", None)?["login"]
        .as_str()
        .ok_or("GitHub account unavailable.")?
        .to_owned();
    let prefix = api::endpoint(repo, input.number)?;
    if matches!(input.action.as_str(), "review" | "submit")
        && matches!(input.event.as_str(), "APPROVE" | "REQUEST_CHANGES")
        && pr["user"]["login"]
            .as_str()
            .is_some_and(|author| author.eq_ignore_ascii_case(&actor))
    {
        return Err("GitHub does not allow approving or requesting changes on your own PR. Submit a comment instead.".into());
    }
    review_owned(api, &prefix, input, &actor)?;
    if input.action == "review" {
        review_state::validate_positions(api, repo, input)?;
    }
    let previous_reviews = if input.action == "review" {
        api::all(api, &format!("{prefix}/reviews"), None)?
            .iter()
            .filter_map(|review| review["id"].as_u64())
            .collect()
    } else {
        Vec::new()
    };
    if input.action == "push" {
        validate_push(directory, repo, input, &pr, ticket)?;
    }
    let latest = api::detail(api, repo, input.number)?;
    api::verify(&latest, input)?;
    if latest["state"] != "open" {
        return Err("The PR closed during preparation. Refresh before acting.".into());
    }
    // Persist intent before *any* remote write. A transport failure, Stop or crash
    // never proves that GitHub did not apply it.
    saved.pending = Some(Pending {
        request: input.clone(),
        actor,
        started_at: chrono::Utc::now().to_rfc3339(),
        previous_reviews,
    });
    ticket.with_current(|| save(directory, repo, saved))?;
    repo.operation = "publication PR outcome unknown; reconcile before retrying".into();
    ticket.with_current(|| super::super::save(directory, repo))?;
    let outcome = if input.action == "push" {
        api.push(directory, repo, &input.next_head, &input.expected_head)
            .map(|()| json!({"head": input.next_head}))
    } else {
        let path = match input.action.as_str() {
            "review" => format!("{prefix}/reviews"),
            "submit" => format!("{prefix}/reviews/{}/events", input.review_id),
            "delete-draft" => format!("{prefix}/reviews/{}", input.review_id),
            _ => prefix,
        };
        api.request(&method, &path, (method != "DELETE").then_some(body))
    };
    let result = match outcome {
        Ok(value) => value,
        Err(error) => {
            // A received validation/auth/rate-limit rejection is different from
            // an interrupted request or 5xx response. No write is replayed.
            if api.rejected_write() {
                complete(directory, repo, saved, ticket)?;
            }
            return Err(error);
        }
    };
    ticket.check()?;
    complete(directory, repo, saved, ticket)?;
    Ok(json!({"result": result, "message": "Approved action completed."}))
}
fn validate_push(
    directory: &Path,
    repo: &Repository,
    input: &Request,
    pr: &Value,
    ticket: &OperationTicket,
) -> Result<(), String> {
    if input.head_branch != repo.branch
        || input.base_branch != repo.base_branch
        || pr["head"]["repo"]["full_name"] != api::slug(repo)?
        || repo.publication.as_deref() != pr["html_url"].as_str()
    {
        return Err("Updates require this managed copy's linked PR and exact branch/base.".into());
    }
    if !api::sha(&input.next_head)
        || git::run(directory, repo, &["rev-parse", "HEAD"], ticket)? != input.next_head
        || git::tree(directory, repo, ticket)?
            != git::run(directory, repo, &["rev-parse", "HEAD^{tree}"], ticket)?
    {
        return Err("Commit and approve the exact clean local HEAD before updating the PR.".into());
    }
    // Even though the transport uses an exact lease, history rewrites are never
    // admitted. Missing previous objects fail closed; no arbitrary fetch/shell.
    git::run(
        directory,
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            &input.expected_head,
            &input.next_head,
        ],
        ticket,
    )
    .map_err(|_| {
        "PR updates must fast-forward the exact reviewed remote head; reconcile divergence first."
            .to_string()
    })?;
    if input.next_head == input.expected_head {
        return Err("The PR already has this commit.".into());
    }
    Ok(())
}
fn complete(
    directory: &Path,
    repo: &mut Repository,
    saved: &mut Saved,
    ticket: &OperationTicket,
) -> Result<(), String> {
    // Clear the repository marker first; pending remains authoritative if saving
    // the journal fails. Every attachment and mutation checks both.
    repo.operation = "idle".into();
    ticket.with_current(|| super::super::save(directory, repo))?;
    saved.pending = None;
    ticket.with_current(|| save(directory, repo, saved))
}
pub(super) fn recover(
    directory: &Path,
    repo: &mut Repository,
    saved: &mut Saved,
    ticket: &OperationTicket,
    api: &impl Api,
) -> Result<Value, String> {
    let pending = saved
        .pending
        .as_ref()
        .ok_or("No uncertain PR action. Use repository-recover for first publication.")?;
    let input = &pending.request;
    bound(repo, input)?;
    let pr = api::detail(api, repo, input.number)?;
    // Only exact positive evidence releases the lock. Absence is not proof of a
    // failed write: replication, deletion or another author may hide the effect.
    let confirmed = match input.action.as_str() {
        "push" => {
            pr["head"]["sha"] == input.next_head
                && pr["head"]["ref"] == input.head_branch
                && pr["base"]["ref"] == input.base_branch
                && pr["head"]["repo"]["full_name"] == api::slug(repo)?
        }
        "edit" => {
            api::verify(&pr, input)?;
            pr["title"] == input.title && pr["body"].as_str().unwrap_or("") == input.body
        }
        "review" | "submit" => {
            let reviews = api::all(
                api,
                &format!("{}/reviews", api::endpoint(repo, input.number)?),
                None,
            )?;
            let expected = match input.event.as_str() {
                "APPROVE" => "APPROVED",
                "REQUEST_CHANGES" => "CHANGES_REQUESTED",
                "COMMENT" => "COMMENTED",
                _ => "PENDING",
            };
            let matches: Vec<_> = reviews
                .iter()
                .filter(|r| {
                    r["user"]["login"] == pending.actor
                        && r["commit_id"] == input.expected_head
                        && (input.action != "review"
                            || r["id"]
                                .as_u64()
                                .is_some_and(|id| !pending.previous_reviews.contains(&id)))
                        && r["state"] == expected
                        && r["body"].as_str().unwrap_or("") == input.body
                        && (input.action != "submit" || r["id"] == input.review_id)
                        && (r["submitted_at"].as_str().is_some_and(|at| {
                            at >= pending.started_at.as_str().get(..19).unwrap_or("")
                        }) || input.event == "PENDING")
                })
                .collect();
            if matches.len() == 1 && !input.comments.is_empty() {
                let comments = api::all(
                    api,
                    &format!(
                        "{}/reviews/{}/comments",
                        api::endpoint(repo, input.number)?,
                        matches[0]["id"]
                    ),
                    None,
                )?;
                comments_confirmed(&input.comments, comments)
            } else {
                matches.len() == 1
            }
        }
        "delete-draft" => {
            // A successful complete listing proves this specific pending review
            // no longer exists; no deletion is replayed.
            !api::all(
                api,
                &format!("{}/reviews", api::endpoint(repo, input.number)?),
                None,
            )?
            .iter()
            .any(|r| r["id"] == input.review_id)
        }
        _ => false,
    };
    if !confirmed {
        return Err("Outcome remains uncertain. Inspect GitHub; this action cannot be retried automatically.".into());
    }
    complete(directory, repo, saved, ticket)?;
    Ok(
        json!({"reconciled": true, "message": "Confirmed the saved action from GitHub; no mutation was replayed."}),
    )
}

fn comments_confirmed(expected: &[ReviewComment], mut actual: Vec<Value>) -> bool {
    expected.iter().all(|expected| {
        let index = actual.iter().position(|row| {
            row["path"] == expected.path
                && row["body"] == expected.body
                && row["original_line"]
                    .as_u64()
                    .or_else(|| row["line"].as_u64())
                    == Some(u64::from(expected.line))
                && row["side"] == expected.side
        });
        if let Some(index) = index {
            actual.swap_remove(index);
            true
        } else {
            false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_recovery_uses_original_positions_and_requires_each_comment() {
        let expected = ReviewComment {
            path: "sum.js".into(),
            line: 2,
            side: "RIGHT".into(),
            body: "Check overflow".into(),
        };
        let observed = json!({"path":"sum.js", "line":null, "original_line":2, "side":"RIGHT", "body":"Check overflow"});
        assert!(comments_confirmed(
            std::slice::from_ref(&expected),
            vec![observed.clone()]
        ));
        assert!(!comments_confirmed(
            &[expected.clone(), expected],
            vec![observed]
        ));
    }
}
