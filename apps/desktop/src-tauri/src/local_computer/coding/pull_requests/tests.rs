use super::*;
use std::{cell::RefCell, collections::VecDeque};
pub(super) struct Fake {
    replies: RefCell<VecDeque<Result<Value, String>>>,
    calls: RefCell<Vec<(String, String, Option<Value>)>>,
    rejected: bool,
}
impl Fake {
    pub(super) fn new(replies: Vec<Result<Value, String>>) -> Self {
        Self {
            replies: RefCell::new(replies.into()),
            calls: RefCell::new(Vec::new()),
            rejected: false,
        }
    }
}
impl Api for Fake {
    fn rejected_write(&self) -> bool {
        self.rejected
    }
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        self.calls
            .borrow_mut()
            .push((method.into(), path.into(), body));
        self.replies
            .borrow_mut()
            .pop_front()
            .expect("Unexpected GitHub call")
    }
    fn push(
        &self,
        _directory: &Path,
        _repo: &Repository,
        head: &str,
        expected: &str,
    ) -> Result<(), String> {
        self.calls
            .borrow_mut()
            .push(("PUSH".into(), head.into(), Some(json!(expected))));
        self.replies
            .borrow_mut()
            .pop_front()
            .expect("Unexpected push")
            .map(|_| ())
    }
}
fn request(repo: &Repository) -> Request {
    Request {
        repository_id: repo.id.clone(),
        number: 7,
        action: "review".into(),
        remote: "https://github.com/example/repository.git".into(),
        expected_head: repo.base.clone(),
        base_sha: repo.base.clone(),
        base_branch: "main".into(),
        head_branch: repo.branch.clone(),
        event: "APPROVE".into(),
        page: 1,
        page_size: 20,
        ..Default::default()
    }
}
fn pr(input: &Request) -> Value {
    json!({"number": 7, "html_url":"https://github.com/example/repository/pull/7", "state":"open",
        "head":{"sha":input.expected_head,"ref":input.head_branch,"repo":{"full_name":"example/repository"}},
        "base":{"sha":input.base_sha,"ref":"main","repo":{"full_name":"example/repository"}},
        "title":"Title","body":"Body"})
}
#[test]
fn stale_head_base_remote_and_foreign_review_fail_before_writes() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let ticket = authority.begin_agent(1).unwrap();
    let input = request(&repo);
    for field in ["head", "base"] {
        let mut moved = pr(&input);
        moved[field]["sha"] = "b".repeat(40).into();
        let fake = Fake::new(vec![Ok(moved)]);
        assert!(mutations::execute(
            &directory,
            &mut repo,
            &mut Saved::default(),
            &input,
            &ticket,
            &fake
        )
        .unwrap_err()
        .contains("changed"));
        assert_eq!(fake.calls.borrow().len(), 1);
    }
    let fake = Fake::new(vec![]);
    let wrong = Request {
        remote: "https://github.com/other/repository.git".into(),
        ..input.clone()
    };
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &wrong,
        &ticket,
        &fake
    )
    .is_err());
    assert!(fake.calls.borrow().is_empty());
    let input = Request {
        action: "submit".into(),
        review_id: 99,
        ..input
    };
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(json!({"login":"viewer"})),
        Ok(
            json!({"state":"PENDING","commit_id":input.expected_head,"user":{"login":"someone-else"}}),
        ),
    ]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .is_err());
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
}
#[test]
fn uncertain_review_survives_reload_blocks_edits_and_recovery_never_replays() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let ticket = authority.begin_agent(1).unwrap();
    let input = request(&repo);
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(json!({"login":"viewer"})),
        Ok(json!([])),
        Ok(pr(&input)),
        Err("connection lost".into()),
    ]);
    let mut saved = Saved::default();
    assert!(mutations::execute(&directory, &mut repo, &mut saved, &input, &ticket, &fake).is_err());
    assert!(load(&directory, &repo).unwrap().pending.is_some());
    assert!(super::super::execute_in(
        &directory,
        &ticket,
        "repository-write",
        json!({"repositoryId":repo.id,"path":"sum.js","content":"bad"})
    )
    .is_err());
    let mut saved = load(&directory, &repo).unwrap();
    let review = json!({"id":10,"user":{"login":"viewer"},"commit_id":input.expected_head,"state":"APPROVED","body":"","submitted_at":"2099-01-01T00:00:00Z"});
    let fake = Fake::new(vec![Ok(pr(&input)), Ok(json!([review]))]);
    assert!(
        mutations::recover(&directory, &mut repo, &mut saved, &ticket, &fake).unwrap()
            ["reconciled"]
            == true
    );
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
    assert!(!has_pending(&directory, &repo).unwrap());
}
#[test]
fn local_drafts_and_file_revisions_persist_without_remote_mutation() {
    let (_temp, directory, _authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let input = Request {
        action: "draft".into(),
        body: "A saved draft".into(),
        ..request(&repo)
    };
    let fake = Fake::new(vec![Ok(pr(&input))]);
    let mut saved = Saved::default();
    review_state::apply(&fake, &repo, &mut saved, &input).unwrap();
    save(&directory, &repo, &saved).unwrap();
    assert_eq!(
        load(&directory, &repo).unwrap().reviews[&7].body,
        "A saved draft"
    );
    let file = json!({"filename":"sum.js","sha":"old","patch":"@@ -1 +1 @@\n-before\n+after","status":"modified","additions":1,"deletions":1});
    let revision = api::revision(&file);
    let input = Request {
        action: "viewed".into(),
        path: "sum.js".into(),
        revision: revision.clone(),
        viewed: true,
        ..input
    };
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(pr(&input)),
        Ok(json!([file])),
        Ok(pr(&input)),
    ]);
    review_state::apply(&fake, &repo, &mut saved, &input).unwrap();
    assert_eq!(saved.reviews[&7].viewed["sum.js"], revision);
    let changed = json!({"filename":"sum.js","sha":"new","patch":"+different","status":"modified"});
    assert_ne!(api::revision(&changed), revision);
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(pr(&input)),
        Ok(json!([changed])),
        Ok(pr(&input)),
    ]);
    assert!(review_state::apply(&fake, &repo, &mut saved, &input)
        .unwrap_err()
        .contains("changed"));
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
}
#[test]
fn pages_are_explicit_and_bad_pagination_or_drift_never_looks_complete() {
    let (_temp, _directory, _authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let input = Request {
        action: "list".into(),
        page_size: 1,
        ..request(&repo)
    };
    let fake = Fake::new(vec![Ok(json!([pr(&input)]))]);
    assert_eq!(api::read(&fake, &repo, &input).unwrap()["nextPage"], 2);
    assert!(fake.calls.borrow()[0].1.ends_with("per_page=1&page=1"));
    let fake = Fake::new(vec![]);
    assert!(api::page(&fake, "/repos/example/repository/pulls", 101, 20).is_err());
    assert!(fake.calls.borrow().is_empty());
    let input = Request {
        action: "files".into(),
        ..input
    };
    let mut moved = pr(&input);
    moved["head"]["sha"] = "a".repeat(40).into();
    let fake = Fake::new(vec![Ok(pr(&input)), Ok(json!([])), Ok(moved)]);
    assert!(api::read(&fake, &repo, &input)
        .unwrap_err()
        .contains("changed"));
}
#[test]
fn managed_branch_update_rejects_divergence_and_stopped_ticket_without_push() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    repo.publication = Some("https://github.com/example/repository/pull/7".into());
    let ticket = authority.begin_agent(1).unwrap();
    let mut input = Request {
        action: "push".into(),
        next_head: repo.base.clone(),
        ..request(&repo)
    };
    let fake = Fake::new(vec![Ok(pr(&input)), Ok(json!({"login":"viewer"}))]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .unwrap_err()
    .contains("already"));
    input.next_head = "0".repeat(40);
    let fake = Fake::new(vec![Ok(pr(&input)), Ok(json!({"login":"viewer"}))]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .is_err());
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
    authority.revoke(1).unwrap();
    let fake = Fake::new(vec![]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .is_err());
    assert!(fake.calls.borrow().is_empty());
}

#[test]
fn fast_forward_update_pushes_only_reviewed_commit_and_never_replays_after_restart() {
    let (temp, directory, authority, mut repo) = super::super::tests::fixture();
    let ticket = authority.begin_agent(1).unwrap();
    repo.remote = Some("https://github.com/example/repository.git".into());
    repo.publication = Some("https://github.com/example/repository/pull/7".into());
    super::super::save(&directory, &repo).unwrap();
    std::fs::write(
        super::super::checkout(&directory, &repo)
            .unwrap()
            .join("sum.js"),
        "module.exports = (a, b) => a + b;\n",
    )
    .unwrap();
    let changes = git::changes(&directory, &repo, &ticket).unwrap();
    let commit: Value = serde_json::from_str(&super::super::execute_in(&directory, &ticket, "repository-commit", json!({"repositoryId":repo.id,"expectedHead":changes["head"],"expectedDiff":changes["diffId"],"message":"Fix addition"})).unwrap()).unwrap();
    let input = Request {
        action: "push".into(),
        next_head: commit["commit"].as_str().unwrap().into(),
        ..request(&repo)
    };
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(json!({"login":"viewer"})),
        Ok(pr(&input)),
        Err("connection lost after push".into()),
    ]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .is_err());
    assert_eq!(fake.calls.borrow().last().unwrap().0, "PUSH");
    assert_eq!(fake.calls.borrow().last().unwrap().1, input.next_head);
    assert_eq!(
        fake.calls.borrow().last().unwrap().2,
        Some(json!(input.expected_head))
    );
    drop(ticket);
    drop(authority);
    let restarted =
        super::super::super::authority::ComputerAuthority::load(&temp.path().join("authority"))
            .unwrap();
    let next = restarted.begin_agent(2).unwrap();
    let mut journal = load(&directory, &repo).unwrap();
    let mut observed = pr(&input);
    observed["head"]["sha"] = input.next_head.clone().into();
    let fake = Fake::new(vec![Ok(observed)]);
    assert_eq!(
        mutations::recover(&directory, &mut repo, &mut journal, &next, &fake).unwrap()
            ["reconciled"],
        true
    );
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
}

#[test]
#[ignore = "Opt-in read-only live GitHub acceptance; requires native gh login and MIVLET_PR_READ_ACCEPTANCE_REMOTE"]
fn native_github_pr_read_acceptance() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    let remote = std::env::var("MIVLET_PR_READ_ACCEPTANCE_REMOTE")
        .expect("Supply canonical remote for an authorized read-only test");
    assert_eq!(
        git::github_remote(&remote).as_deref(),
        Some(remote.as_str())
    );
    repo.remote = Some(remote);
    let ticket = authority.begin_agent(1).unwrap();
    let api = api::GitHub::connect(&directory, &ticket).unwrap();
    let input = Request {
        action: "list".into(),
        repository_id: repo.id.clone(),
        page: 1,
        page_size: 2,
        ..Default::default()
    };
    let result = api::read(&api, &repo, &input).unwrap();
    let rows = result["items"].as_array().unwrap();
    assert!(rows.len() <= 2);
    if let Some(first) = rows.first() {
        let detail = api::read(
            &api,
            &repo,
            &Request {
                number: first["number"].as_u64().unwrap(),
                action: "detail".into(),
                ..input
            },
        )
        .unwrap();
        assert!(detail["head"].as_str().is_some_and(api::sha));
        println!("Live native GitHub list/detail passed; no remote mutation attempted.");
    }
}

#[test]
fn concurrent_review_reads_wait_for_the_lock_and_stop_cancels_the_wait() {
    let (_temp, directory, authority, _repo) = super::super::tests::fixture();
    let lock = super::super::lock(&directory).unwrap();
    let guard = lock.lock().unwrap();
    let ready = std::sync::mpsc::channel();
    let queued_lock = lock.clone();
    let ticket = authority.begin_agent(1).unwrap();
    let worker = std::thread::spawn(move || {
        ready.0.send(()).unwrap();
        review_lock(&queued_lock, &ticket).map(|_| ())
    });
    ready.1.recv().unwrap();
    drop(guard);
    worker.join().unwrap().unwrap();
    let _guard = lock.lock().unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    authority.revoke(1).unwrap();
    assert!(review_lock(&lock, &ticket).is_err());
}

#[test]
fn confirmed_rejection_releases_the_journal_without_replaying_the_write() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let ticket = authority.begin_agent(1).unwrap();
    let input = request(&repo);
    let mut fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(json!({"login":"viewer"})),
        Ok(json!([])),
        Ok(pr(&input)),
        Err("GitHub rejected HTTP 422".into()),
    ]);
    fake.rejected = true;
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .is_err());
    assert!(!has_pending(&directory, &repo).unwrap());
    assert_eq!(repo.operation, "idle");
    assert_eq!(
        fake.calls
            .borrow()
            .iter()
            .filter(|(method, _, _)| method != "GET")
            .count(),
        1
    );
}

#[test]
fn own_approval_and_a_head_that_moves_during_preparation_never_write() {
    let (_temp, directory, authority, mut repo) = super::super::tests::fixture();
    repo.remote = Some("https://github.com/example/repository.git".into());
    let ticket = authority.begin_agent(1).unwrap();
    let input = request(&repo);
    let mut own = pr(&input);
    own["user"] = json!({"login":"VIEWER"});
    let fake = Fake::new(vec![Ok(own), Ok(json!({"login":"viewer"}))]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .unwrap_err()
    .contains("own PR"));
    let mut moved = pr(&input);
    moved["head"]["sha"] = "c".repeat(40).into();
    let fake = Fake::new(vec![
        Ok(pr(&input)),
        Ok(json!({"login":"viewer"})),
        Ok(json!([])),
        Ok(moved),
    ]);
    assert!(mutations::execute(
        &directory,
        &mut repo,
        &mut Saved::default(),
        &input,
        &ticket,
        &fake
    )
    .unwrap_err()
    .contains("changed"));
    assert!(fake
        .calls
        .borrow()
        .iter()
        .all(|(method, _, _)| method == "GET"));
    assert!(!has_pending(&directory, &repo).unwrap());
}
