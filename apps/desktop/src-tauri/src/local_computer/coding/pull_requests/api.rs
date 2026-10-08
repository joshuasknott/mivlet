//! Fixed-host GitHub transport. The renderer/model never receives the credential.
use super::*;
use futures_util::StreamExt;
use std::time::Duration;

pub(super) trait Api {
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String>;
    fn push(
        &self,
        directory: &Path,
        repo: &Repository,
        head: &str,
        expected: &str,
    ) -> Result<(), String>;
}
pub(super) struct GitHub<'a> {
    ticket: &'a OperationTicket,
    token: String,
    watch_stop: Option<(std::path::PathBuf, String)>,
}
impl<'a> GitHub<'a> {
    pub fn connect(directory: &Path, ticket: &'a OperationTicket) -> Result<Self, String> {
        let mut auth = git::gh(directory)?;
        auth.args(["auth", "token", "--hostname", "github.com"]);
        Ok(Self {
            ticket,
            token: process::credential(auth, ticket)?,
            watch_stop: None,
        })
    }
    pub fn watching(mut self, directory: &Path, repo: &Repository, id: &str) -> Self {
        self.watch_stop = Some((directory.join(&repo.id).join("pr-watch-stop"), id.into()));
        self
    }
    fn check(&self) -> Result<(), String> {
        self.ticket.check()?;
        if self
            .watch_stop
            .as_ref()
            .is_some_and(|(path, id)| std::fs::read_to_string(path).ok().as_ref() == Some(id))
        {
            return Err("PR watch stopped.".into());
        }
        Ok(())
    }
    pub fn push(
        &self,
        directory: &Path,
        repo: &Repository,
        head: &str,
        expected: &str,
    ) -> Result<(), String> {
        let remote = remote(repo)?;
        let mut command = git::repo_git(directory, repo)?;
        use base64::Engine;
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!(
                    "Authorization: Basic {}",
                    base64::engine::general_purpose::STANDARD
                        .encode(format!("x-access-token:{}", self.token))
                ),
            )
            .args([
                "-c",
                "protocol.https.allow=always",
                "push",
                "--porcelain",
                // Exact compare-and-swap, with ancestry independently checked before admission.
                &format!("--force-with-lease=refs/heads/{}:{expected}", repo.branch),
                &remote,
                &format!("{head}:refs/heads/{}", repo.branch),
            ]);
        process::checked(command, self.ticket)?;
        Ok(())
    }
}
impl Api for GitHub<'_> {
    fn push(
        &self,
        directory: &Path,
        repo: &Repository,
        head: &str,
        expected: &str,
    ) -> Result<(), String> {
        GitHub::push(self, directory, repo, head, expected)
    }
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        if !path.starts_with('/') || path.contains("..") || path.contains(['#', '\\', '\r', '\n']) {
            return Err("Invalid GitHub endpoint.".into());
        }
        self.check()?;
        tauri::async_runtime::block_on(async {
            let request = async {
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .timeout(Duration::from_secs(30))
                    .build()
                    .map_err(|_| "GitHub transport is unavailable.")?;
                let mut request = client
                    .request(
                        reqwest::Method::from_bytes(method.as_bytes())
                            .map_err(|_| "Invalid GitHub method.")?,
                        format!("https://api.github.com{path}"),
                    )
                    .bearer_auth(&self.token)
                    .header("User-Agent", "Mivlet")
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2026-03-10");
                if let Some(body) = body {
                    request = request.json(&body);
                }
                let response = request.send().await.map_err(|_| "GitHub request failed; a mutation may have completed. Reconcile before retrying.")?;
                let status = response.status().as_u16();
                if status == 429
                    || status == 403
                        && (response.headers().contains_key("retry-after")
                            || response
                                .headers()
                                .get("x-ratelimit-remaining")
                                .is_some_and(|h| h == "0"))
                {
                    return Err("GitHub rate limit reached. Wait before refreshing.".to_string());
                }
                if matches!(status, 401 | 403 | 404) {
                    return Err("GitHub access is unavailable. Check the signed-in account and repository permissions.".into());
                }
                if !(200..300).contains(&status) {
                    return Err(format!(
                        "GitHub returned HTTP {status}; reconcile any mutation before retrying."
                    ));
                }
                if status == 204 {
                    return Ok(Value::Null);
                }
                let mut bytes = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| "GitHub response was interrupted.")?;
                    if bytes.len() + chunk.len() > 1024 * 1024 {
                        return Err("GitHub response exceeds 1 MiB. Narrow the page or inspect this PR on GitHub.".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                serde_json::from_slice(&bytes).map_err(|_| "GitHub returned invalid JSON.".into())
            };
            tokio::pin!(request);
            loop {
                tokio::select! {
                    result = &mut request => return result,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => self.check()?,
                }
            }
        })
    }
}

pub(super) fn remote(repo: &Repository) -> Result<String, String> {
    repo.remote
        .as_deref()
        .and_then(git::github_remote)
        .ok_or_else(|| {
            "PR workflows require a canonical github.com origin and native gh login.".into()
        })
}
pub(super) fn slug(repo: &Repository) -> Result<String, String> {
    Ok(remote(repo)?
        .trim_start_matches("https://github.com/")
        .trim_end_matches(".git")
        .to_owned())
}
pub(super) fn endpoint(repo: &Repository, number: u64) -> Result<String, String> {
    if number == 0 || number > 9_007_199_254_740_991 {
        return Err("Invalid PR number.".into());
    }
    Ok(format!("/repos/{}/pulls/{number}", slug(repo)?))
}
pub(super) fn detail(api: &impl Api, repo: &Repository, number: u64) -> Result<Value, String> {
    let pr = api.request("GET", &endpoint(repo, number)?, None)?;
    let name = slug(repo)?;
    if pr["number"] != number
        || pr["base"]["repo"]["full_name"].as_str() != Some(&name)
        || pr["html_url"] != format!("https://github.com/{name}/pull/{number}")
    {
        return Err("GitHub returned a different repository or pull request.".into());
    }
    if !pr["head"]["sha"].as_str().is_some_and(sha)
        || !pr["base"]["sha"].as_str().is_some_and(sha)
        || !pr["title"].is_string()
        || !pr["head"]["ref"].is_string()
        || !pr["base"]["ref"].is_string()
    {
        return Err("GitHub returned an incomplete PR identity. Refresh before reviewing.".into());
    }
    Ok(pr)
}
pub(super) fn verify(pr: &Value, input: &Request) -> Result<(), String> {
    if !sha(&input.expected_head)
        || !sha(&input.base_sha)
        || pr["head"]["sha"] != input.expected_head
        || pr["base"]["sha"] != input.base_sha
        || pr["base"]["ref"] != input.base_branch
        || pr["head"]["ref"] != input.head_branch
    {
        return Err("PR head or base changed. Refresh and request a new exact approval.".into());
    }
    Ok(())
}
pub(super) fn sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub(super) fn summary(pr: &Value) -> Value {
    json!({
        "number": pr["number"], "url": pr["html_url"], "title": pr["title"], "body": pr["body"],
        "state": if pr["merged"] == true || !pr["merged_at"].is_null() { "merged" } else { pr["state"].as_str().unwrap_or("unknown") },
        "draft": pr["draft"], "head": pr["head"]["sha"], "headBranch": pr["head"]["ref"],
        "base": pr["base"]["sha"], "baseBranch": pr["base"]["ref"], "mergeable": pr["mergeable"],
        "author": pr["user"]["login"], "updatedAt": pr["updated_at"]
    })
}
pub(super) fn page(api: &impl Api, path: &str, page: u64, size: u64) -> Result<Value, String> {
    if !(1..=100).contains(&page) || !(1..=30).contains(&size) {
        return Err("Use page 1–100 and pageSize 1–30.".into());
    }
    let separator = if path.contains('?') { '&' } else { '?' };
    api.request(
        "GET",
        &format!("{path}{separator}per_page={size}&page={page}"),
        None,
    )
}
pub(super) fn all(api: &impl Api, path: &str, key: Option<&str>) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for index in 1..=10 {
        let response = page(api, path, index, 30)?;
        let rows = key
            .map_or(&response, |key| &response[key])
            .as_array()
            .ok_or("Invalid GitHub page.")?;
        items.extend(rows.iter().cloned());
        if rows.len() < 30 {
            return Ok(items);
        }
    }
    Err(
        "PR monitoring is unavailable above 300 items per collection. Review this PR manually."
            .into(),
    )
}
pub(super) fn read(api: &impl Api, repo: &Repository, input: &Request) -> Result<Value, String> {
    if input.action == "list" {
        let rows = page(
            api,
            &format!(
                "/repos/{}/pulls?state=all&sort=updated&direction=desc",
                slug(repo)?
            ),
            input.page,
            input.page_size,
        )?;
        let rows = rows.as_array().ok_or("Invalid GitHub PR list.")?;
        return Ok(
            json!({"items": rows.iter().map(summary).collect::<Vec<_>>(), "nextPage": next(rows.len(), input), "limitReached": input.page == 100 && rows.len() == input.page_size as usize}),
        );
    }
    let pr = detail(api, repo, input.number)?;
    if input.action == "detail" {
        return Ok(summary(&pr));
    }
    verify(&pr, input)?;
    let prefix = endpoint(repo, input.number)?;
    let path = match input.action.as_str() {
        "files" => format!("{prefix}/files"),
        "reviews" => format!("{prefix}/reviews"),
        "comments" => format!("{prefix}/comments"),
        "discussion" => format!("/repos/{}/issues/{}/comments", slug(repo)?, input.number),
        "checks" => format!(
            "/repos/{}/commits/{}/check-runs",
            slug(repo)?,
            input.expected_head
        ),
        "statuses" => format!(
            "/repos/{}/commits/{}/statuses",
            slug(repo)?,
            input.expected_head
        ),
        _ => return Err("Unknown PR read action.".into()),
    };
    let response = page(api, &path, input.page, input.page_size)?;
    let rows = if input.action == "checks" {
        &response["check_runs"]
    } else {
        &response
    };
    let rows = rows.as_array().ok_or("Invalid GitHub page.")?;
    // Revalidate after a potentially slow paged read; never attribute a page to another head.
    verify(&detail(api, repo, input.number)?, input)?;
    let items: Vec<Value> = if input.action == "files" {
        rows.iter().map(|file| json!({
            "path": file["filename"], "previousPath": file["previous_filename"],
            "status": file["status"], "additions": file["additions"], "deletions": file["deletions"],
            "patch": file["patch"], "revision": revision(file),
            "patchUnavailable": !complete_patch(file)
        })).collect()
    } else {
        rows.clone()
    };
    Ok(
        json!({"items": items, "nextPage": next(items.len(), input), "head": input.expected_head, "limitReached": input.page == 100 && items.len() == input.page_size as usize}),
    )
}
fn next(count: usize, input: &Request) -> Option<u64> {
    (count == input.page_size as usize && input.page < 100).then_some(input.page + 1)
}
pub(super) fn complete_patch(file: &Value) -> bool {
    let Some(patch) = file["patch"].as_str() else {
        return false;
    };
    let (mut additions, mut deletions) = (0u64, 0u64);
    let mut hunk = false;
    for line in patch.lines() {
        if line.starts_with("@@ ") {
            hunk = true;
        } else if !hunk {
            return false;
        } else if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        } else if !line.starts_with([' ', '\\']) {
            return false;
        }
    }
    hunk && file["additions"].as_u64() == Some(additions)
        && file["deletions"].as_u64() == Some(deletions)
}
pub(super) fn revision(file: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([
                file["filename"],
                file["previous_filename"],
                file["sha"],
                file["status"],
                file["patch"]
            ]))
            .unwrap_or_default()
        )
    )
}
