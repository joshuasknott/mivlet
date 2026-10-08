use super::{checkout, process, save, Input, OperationTicket, Repository};
use serde_json::{json, Value};
use std::{ffi::OsString, fs, path::Path, process::Command};

// Keep canonical paths for native validation. Git's clone destination parser
// rejects the Windows verbatim prefix; Git handles long paths itself with the
// process-local core.longpaths setting. Preserve UTF-16 and UNC identity.
fn git_path(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<_> = path.as_os_str().encode_wide().collect();
        let verbatim: Vec<_> = r"\\?\".encode_utf16().collect();
        let unc: Vec<_> = r"\\?\UNC\".encode_utf16().collect();
        let mut converted = if units.starts_with(&unc) {
            let mut value = vec![b'/' as u16, b'/' as u16];
            value.extend_from_slice(&units[unc.len()..]);
            value
        } else {
            units
                .strip_prefix(verbatim.as_slice())
                .unwrap_or(&units)
                .to_vec()
        };
        for unit in &mut converted {
            if *unit == b'\\' as u16 {
                *unit = b'/' as u16;
            }
        }
        OsString::from_wide(&converted)
    }
    #[cfg(not(windows))]
    path.as_os_str().to_os_string()
}

fn git(cwd: &Path) -> Result<Command, String> {
    let mut cmd = process::command("git", cwd)?;
    cmd.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
    ]);
    Ok(cmd)
}
fn repo_git(directory: &Path, repo: &Repository) -> Result<Command, String> {
    let storage = directory.join(&repo.id);
    crate::paths::strict_canonicalize(&storage.join("git"))
        .map_err(|_| "Git metadata failed validation.")?;
    let mut cmd = git(&storage)?;
    cmd.arg("--git-dir")
        .arg(git_path(&storage.join("git")))
        .arg("--work-tree")
        .arg(git_path(&checkout(directory, repo)?));
    Ok(cmd)
}
pub(super) fn run(
    directory: &Path,
    repo: &Repository,
    args: &[&str],
    ticket: &OperationTicket,
) -> Result<String, String> {
    let mut cmd = repo_git(directory, repo)?;
    cmd.args(args);
    process::checked(cmd, ticket)
}
fn ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 200
        && !name.starts_with(['-', '/'])
        && !name.ends_with(['.', '/'])
        && !name.contains("..")
        && !name.contains("//")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
}
fn github_remote(raw: &str) -> Option<String> {
    let value = raw
        .trim()
        .strip_prefix("https://github.com/")
        .or_else(|| raw.trim().strip_prefix("git@github.com:"))?;
    let value = value.strip_suffix(".git").unwrap_or(value);
    let parts: Vec<_> = value.split('/').collect();
    (parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        }))
    .then(|| format!("https://github.com/{value}.git"))
}
pub(super) fn attach(
    directory: &Path,
    source: &Path,
    ticket: &OperationTicket,
) -> Result<Repository, String> {
    let source = crate::paths::strict_canonicalize(source)
        .map_err(|_| "Choose a regular local Git repository.")?;
    let mut head = git(directory)?;
    head.arg("-C")
        .arg(git_path(&source))
        .args(["rev-parse", "--verify", "HEAD"]);
    let base = process::checked(head, ticket)?;
    let mut branch = git(directory)?;
    branch
        .arg("-C")
        .arg(git_path(&source))
        .args(["symbolic-ref", "--short", "HEAD"]);
    let base_branch = process::checked(branch, ticket)
        .map_err(|_| "Choose a repository on a named branch with at least one commit.")?;
    if !ref_name(&base_branch) {
        return Err("The repository branch name is unsupported.".into());
    }
    let mut origin = git(directory)?;
    origin
        .arg("-C")
        .arg(git_path(&source))
        .args(["config", "--get", "remote.origin.url"]);
    let remote = process::checked(origin, ticket)
        .ok()
        .and_then(|r| github_remote(&r));
    let id = super::super::desktop_tools::opaque_id()?;
    let storage = directory.join(&id);
    fs::create_dir(&storage).map_err(|_| "Cannot prepare managed repository.")?;
    let root = storage.join("checkout");
    let mut clone = git(&storage)?;
    // --local copies objects without upload-pack or source hooks; no hardlinks
    // couple object mutation to the original. No source working files are moved.
    clone
        .args([
            "-c",
            "protocol.file.allow=always",
            "clone",
            "--local",
            "--no-hardlinks",
            "--no-checkout",
            "--",
        ])
        .arg(git_path(&source))
        .arg(git_path(&root));
    process::checked(clone, ticket)?;
    // A local source may itself borrow objects from another checkout. Reject
    // that coupling instead of retaining host paths in this managed copy.
    if root.join(".git/objects/info/alternates").exists() {
        return Err("Choose a self-contained repository without borrowed Git objects.".into());
    }
    fs::rename(root.join(".git"), storage.join("git"))
        .map_err(|_| "Cannot isolate Git metadata.")?;
    let repo = Repository {
        id: id.clone(),
        name: source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Repository")
            .into(),
        branch: format!("mivlet/{}", &id[..12]),
        base,
        base_branch,
        remote,
        operation: "idle".into(),
        last_result: None,
        last_command: None,
        command_diff_id: None,
        publication: None,
    };
    run(directory, &repo, &["remote", "remove", "origin"], ticket)?;
    run(
        directory,
        &repo,
        &["checkout", "-b", &repo.branch, &repo.base],
        ticket,
    )?;
    Ok(repo)
}

pub(super) fn tree(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<String, String> {
    let storage = directory.join(&repo.id);
    let index_dir = tempfile::tempdir_in(&storage).map_err(|_| "Cannot prepare review index.")?;
    let index = index_dir.path().join("index");
    for args in [&["read-tree", "HEAD"][..], &["add", "-A", "--", ":/"][..]] {
        let mut cmd = repo_git(directory, repo)?;
        cmd.env("GIT_INDEX_FILE", git_path(&index)).args(args);
        process::checked(cmd, ticket)?;
    }
    let mut cmd = repo_git(directory, repo)?;
    cmd.env("GIT_INDEX_FILE", git_path(&index))
        .arg("write-tree");
    process::checked(cmd, ticket)
}
pub(super) fn changes(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
) -> Result<Value, String> {
    let tree = tree(directory, repo, ticket)?;
    let head = run(directory, repo, &["rev-parse", "HEAD"], ticket)?;
    let mut command = repo_git(directory, repo)?;
    command.args([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        &repo.base,
        &tree,
        "--",
    ]);
    let diff = process::run(command, ticket, 120)?;
    if diff.interrupted || diff.exit_code != Some(0) {
        return Err("Repository diff is unavailable. Inspect again before committing.".into());
    }
    let files = run(
        directory,
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            &repo.base,
            &tree,
            "--",
        ],
        ticket,
    )?;
    Ok(
        json!({"head": head, "diffId": tree, "diff": diff.output, "truncated": diff.truncated, "files": files}),
    )
}
pub(super) fn commit(
    directory: &Path,
    repo: &mut Repository,
    input: &Input,
    ticket: &OperationTicket,
) -> Result<Value, String> {
    let current = tree(directory, repo, ticket)?;
    if input.expected_diff.as_deref() != Some(&current) {
        return Err(
            "Changes differ from the reviewed diff. Inspect status and approve the new diffId."
                .into(),
        );
    }
    let head = run(directory, repo, &["rev-parse", "HEAD"], ticket)?;
    if input.expected_head.as_deref() != Some(&head) {
        return Err("Repository HEAD changed. Review again before committing.".into());
    }
    let message = input
        .message
        .as_deref()
        .filter(|m| !m.trim().is_empty() && m.len() <= 2000)
        .ok_or("Supply a commit message up to 2000 bytes.")?;
    let patch = run(
        directory,
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            &head,
            &current,
            "--",
        ],
        ticket,
    )?;
    if patch.is_empty() {
        return Err("No uncommitted changes.".into());
    }
    if crate::secret_redaction::secret_marker_survives(&patch) {
        return Err("Changes contain a credential marker. Remove it before committing.".into());
    }
    // commit-tree bypasses hooks and preserves a precise reviewed snapshot.
    let mut command = repo_git(directory, repo)?;
    command
        .env("GIT_AUTHOR_NAME", "Mivlet Agent")
        .env("GIT_AUTHOR_EMAIL", "agent@mivlet.local")
        .env("GIT_COMMITTER_NAME", "Mivlet Agent")
        .env("GIT_COMMITTER_EMAIL", "agent@mivlet.local")
        .args(["commit-tree", &current, "-p", &head, "-m", message]);
    let commit = process::checked(command, ticket)?;
    run(
        directory,
        repo,
        &[
            "update-ref",
            &format!("refs/heads/{}", repo.branch),
            &commit,
            &head,
        ],
        ticket,
    )?;
    run(directory, repo, &["read-tree", &current], ticket)?;
    repo.operation = "idle".into();
    save(directory, repo)?;
    Ok(json!({"commit": commit, "branch": repo.branch}))
}

fn gh(directory: &Path) -> Result<Command, String> {
    let mut cmd = process::command("gh", directory)?;
    // GitHub CLI reads only its native login store. Never pass this environment
    // to project commands, and never return the token to the renderer/model.
    for key in ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd.env("GH_PROMPT_DISABLED", "1")
        .env("GH_HOST", "github.com");
    Ok(cmd)
}
fn pr_url(slug: &str, url: &str) -> bool {
    url.strip_prefix(&format!("https://github.com/{slug}/pull/"))
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}
fn recovered_publication(
    prs: &[Value],
    head: &str,
    base: &str,
    slug: &str,
) -> Result<Option<String>, String> {
    let Some(pr) = prs.first() else {
        return Ok(None);
    };
    if prs.len() != 1 || pr["headRefOid"] != head || pr["baseRefName"] != base {
        return Err("GitHub has a different or ambiguous PR for this branch. Review it on GitHub before further publication.".into());
    }
    pr["url"]
        .as_str()
        .filter(|url| pr_url(slug, url))
        .map(|url| Some(url.to_owned()))
        .ok_or_else(|| "GitHub returned an invalid PR URL.".into())
}
pub(super) fn recover(
    directory: &Path,
    repo: &mut Repository,
    ticket: &OperationTicket,
) -> Result<Value, String> {
    let remote = repo
        .remote
        .as_deref()
        .and_then(github_remote)
        .ok_or("Recovery requires a GitHub origin.")?;
    let slug = remote
        .strip_prefix("https://github.com/")
        .unwrap()
        .trim_end_matches(".git");
    let mut inspect = gh(directory)?;
    inspect.args([
        "pr",
        "list",
        "--repo",
        slug,
        "--head",
        &repo.branch,
        "--state",
        "all",
        "--json",
        "url,headRefOid,baseRefName",
    ]);
    let result = process::checked(inspect, ticket)?;
    let prs: Vec<Value> =
        serde_json::from_str(&result).map_err(|_| "GitHub recovery returned invalid data.")?;
    let head = run(directory, repo, &["rev-parse", "HEAD"], ticket)?;
    repo.publication = recovered_publication(&prs, &head, &repo.base_branch, slug)?;
    repo.operation = "idle".into();
    save(directory, repo)?;
    Ok(
        json!({"publication": repo.publication, "message": if prs.is_empty() { "No PR currently found. The branch may already be pushed. Review GitHub before explicitly approving a new publication; nothing was replayed." } else { "Existing PR recovered; no publication was replayed." }}),
    )
}
pub(super) fn publish(
    directory: &Path,
    repo: &mut Repository,
    input: &Input,
    ticket: &OperationTicket,
) -> Result<Value, String> {
    if repo.publication.is_some() {
        return Err("This checkout already has a PR. Review it on GitHub; repeated publication is not supported.".into());
    }
    let remote = repo.remote.as_deref().ok_or("Publication requires an attached repository with a github.com origin and GitHub CLI login.")?;
    let remote = github_remote(remote).ok_or("Unsupported publication remote.")?;
    if input.remote.as_deref() != Some(&remote)
        || input.base_branch.as_deref() != Some(&repo.base_branch)
    {
        return Err("Publication approval must name the exact attached remote and baseBranch from repository-status.".into());
    }
    let slug = remote
        .strip_prefix("https://github.com/")
        .unwrap()
        .trim_end_matches(".git");
    let head = run(directory, repo, &["rev-parse", "HEAD"], ticket)?;
    if input.expected_head.as_deref() != Some(&head) {
        return Err("HEAD differs from the approved publication. Review again.".into());
    }
    let current = tree(directory, repo, ticket)?;
    if current != run(directory, repo, &["rev-parse", "HEAD^{tree}"], ticket)? {
        return Err("Commit or review outstanding changes before publishing.".into());
    }
    if head == repo.base {
        return Err("There are no task commits to publish.".into());
    }
    let title = input
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 200)
        .ok_or("Supply a PR title up to 200 bytes.")?;
    let body = input
        .body
        .as_deref()
        .filter(|s| s.len() <= 12000)
        .ok_or("Supply a PR body up to 12000 bytes.")?;
    if repo.operation.starts_with("publication") {
        return Err("A previous publication may have succeeded. Check this branch on GitHub before another publication; automatic replay is blocked.".into());
    }
    // Get native credentials using a bounded private pipe, never process arguments.
    let mut auth = gh(directory)?;
    auth.args(["auth", "token", "--hostname", "github.com"]);
    let token = process::credential(auth, ticket)?;
    ticket.check()?;
    let mut push = repo_git(directory, repo)?;
    push.env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Basic {}", {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD
                    .encode(format!("x-access-token:{}", token.trim()))
            }),
        )
        .args([
            "-c",
            "protocol.https.allow=always",
            "push",
            "--porcelain",
            &remote,
            &format!("{}:refs/heads/{}", head, repo.branch),
        ]);
    repo.operation = "publication outcome unknown; inspect GitHub before retrying".into();
    save(directory, repo)?;
    process::checked(push, ticket)?;
    let body_file = directory.join(&repo.id).join("pr-body.txt");
    fs::write(&body_file, body).map_err(|_| "Cannot prepare PR description.")?;
    let mut create = gh(directory)?;
    create
        .args([
            "pr",
            "create",
            "--repo",
            slug,
            "--head",
            &repo.branch,
            "--base",
            &repo.base_branch,
            "--title",
            title,
            "--body-file",
        ])
        .arg(&body_file);
    let url = process::checked(create, ticket)?;
    if !pr_url(slug, &url) {
        return Err("PR outcome needs review on GitHub.".into());
    }
    repo.publication = Some(url.clone());
    repo.operation = "idle".into();
    save(directory, repo)?;
    Ok(json!({"url": url, "head": head, "branch": repo.branch}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn canonical_windows_paths_are_adapted_for_git_without_losing_identity() {
        assert_eq!(
            git_path(Path::new(r"\\?\C:\copy\checkout")),
            OsString::from("C:/copy/checkout")
        );
        assert_eq!(
            git_path(Path::new(r"\\?\UNC\server\share\copy")),
            OsString::from("//server/share/copy")
        );
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let original: Vec<_> = r"\\?\C:\copy\".encode_utf16().chain([0xd800]).collect();
        let path = OsString::from_wide(&original);
        let converted: Vec<_> = git_path(Path::new(&path)).encode_wide().collect();
        assert_eq!(
            converted,
            "C:/copy/"
                .encode_utf16()
                .chain([0xd800])
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn publication_destinations_and_recovery_fail_closed() {
        assert_eq!(
            github_remote("git@github.com:owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        for bad in [
            "https://token@github.com/owner/repo",
            "https://github.com.evil/owner/repo",
            "ext::command",
            "file:///repo",
            "https://github.com/../repo",
        ] {
            assert!(github_remote(bad).is_none());
        }
        let valid = json!({"headRefOid":"head","baseRefName":"main","url":"https://github.com/owner/repo/pull/1"});
        assert_eq!(
            recovered_publication(&[], "head", "main", "owner/repo").unwrap(),
            None
        );
        assert!(
            recovered_publication(std::slice::from_ref(&valid), "head", "main", "owner/repo")
                .unwrap()
                .is_some()
        );
        assert!(
            recovered_publication(std::slice::from_ref(&valid), "other", "main", "owner/repo")
                .is_err()
        );
        assert!(
            recovered_publication(std::slice::from_ref(&valid), "head", "other", "owner/repo")
                .is_err()
        );
        assert!(recovered_publication(
            &[valid.clone(), valid.clone()],
            "head",
            "main",
            "owner/repo"
        )
        .is_err());
        assert!(recovered_publication(&[valid], "head", "main", "other/repo").is_err());
    }
}
