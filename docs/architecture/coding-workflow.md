# Local coding workflow

An agent can work on a real local Git repository through Mivlet-owned tools.
Open Library, expand Repository, select a named agent and attach the repository
using the native folder picker. Ask that agent to inspect the project, make a
change, run its checks and review the diff. Commit and publication remain separate
actions through Mivlet's existing approval system.

## Ownership and prerequisites

The native service copies the selected repository's committed HEAD into private
workspace/agent storage on a new `mivlet/<id>` branch. Uncommitted source work is
not included. The source repository, its index and its branches are untouched.
Each agent has one selected repository; older copies remain on disk. This first
version has no copy-management browser or automatic garbage collection.

Commands require Windows x64 and native execution setup in Library. Git is
required for attachment and review. Node 22.23.3/npm and Python 3.13.16/pip
26.2.1 are bundled, pinned and checked before execution. Run Mivlet unelevated.
Setup/repair asks Windows for administrator approval for bounded metadata ACLs;
normal execution never elevates. Missing resources or changed permissions fail
closed. Project dependencies may be installed into the staged work tree after
network approval. Host PATH, globally installed packages, MSVC, Rust, .NET and
other host toolchains are not implicitly exposed; projects needing those tools
need a separately reviewed, pinned runtime extension. Submodules,
Git LFS materialization and borrowed Git object stores are not supported.

Repository tools require Computer Use to be enabled and a provider route that
bridges Mivlet tools: ChatGPT/Codex, Claude SDK or supported direct API routes. This does not
enable a provider's own shell. Other account routes do not receive these tools.
There is no Windows host-shell fallback and no new app/window control grant.

## Files, commands and review

`repository-status` returns the repository identity, committed HEAD, exact tree
hash (`diffId`), changed filenames, and a real Git diff from the starting commit.
`repository-read` and `repository-write` operate on confined relative paths.
Credential-file paths and Git internals are excluded from these file tools.
Command output and file text pass through the existing credential redaction.
Redaction is defense in depth, not a guarantee that arbitrary project secrets
will be detected: only attach repositories whose committed files may be shared
with the selected model and any explicitly approved command network destinations.

`repository-run` executes an explicit Windows `cmd` batch command through the
shared `packages/windows-executor` boundary, also used by `workspace-run`.
Each run receives a unique Less Privileged AppContainer package SID, a fresh
copy of the checkout, fresh home/temp and read-only verified runtime. Windows
dual-principal access checks deny host files, credential services, unselected
workspace data and Git metadata. No provider shell, host PATH or credential
environment is inherited. Git metadata remains beside the managed checkout,
outside the execution snapshot. See [native execution](native-execution.md)
for enforcement, setup and limitations.

Network is off by default. Explicit approval grants Windows `internetClient`,
without private-network capability or loopback exemption. Windows classifies
network destinations; this is not an IP/domain allowlist. Network access can
have external effects, including disclosure of selected project content.

Each run has a 1–900 second timeout and a combined 64 KiB output limit. The result
records its actual exit code, interruption and truncation. Output appears after
completion; there is no interactive terminal or live output streaming. A command
receipt is associated with the resulting tree hash, and the UI identifies later
edits as unverified. An exit code of zero does not prove that the command was an
appropriate test; the agent and reviewer must choose the project's real checks.

Stop revokes the existing workspace/agent generation. Atomic kill-on-close job
membership contains all descendants before the first instruction; Stop and
timeout terminate the job and verify that it is empty. A per-repository lock excludes competing file,
command, commit and publication operations. Interrupted commands retain their
receipt/state and are never automatically replayed. Failed/stopped command
snapshots are discarded, so their partial file writes never update the managed
checkout. Successful snapshots are validated, hash-checked and imported while
the operation's generation remains current. Source checkouts stay untouched.

## Commits and publication

All repository approvals bind the full canonical argument digest, tool, account,
workspace, agent, request and generation through the existing one-use permit.
The native service rechecks the selected repository identity. Commit requires
both the reviewed `diffId` and expected HEAD. It creates exactly that tree with
`commit-tree` and updates the managed branch with a compare-and-swap. Repository
hooks, global/system Git configuration, executable discovery in the checkout,
external diff commands and text converters are excluded from native Git work.

Publication is optional and supports canonical `github.com` origins only. Its
approval names the exact remote, base branch, HEAD, PR title and body. A clean
committed tree is required. Native GitHub CLI login supplies credentials through
a private bounded pipe, never to the model, renderer, project command or command
arguments. Native Git pushes the approved commit to the managed branch without
force; `gh pr create` opens the PR against the source branch captured at attachment.
This does not merge, deploy, or modify the source checkout.

Before any push, the service persists an unknown-outcome marker. Failure, Stop
or restart keeps it. `repository-recover` queries GitHub and reconciles a unique
PR with the exact head/base; it never publishes. Until recovery, mutation,
replacement attachment and publication are blocked. If no PR exists, the branch
may already be pushed; a new publication needs a fresh explicit approval. An
existing PR is shown as a link. Recovery reads every bounded result page and
checks the source repository, branch, base and commit; failed or incomplete
queries never establish absence.

### Pull request review and updates

Library → Repository → Pull requests lists GitHub PRs with explicit pagination.
Select the linked PR or another PR in the attached origin to inspect its current
head/base, changed files and text patches, checks, commit statuses, reviews,
inline comments and discussion. File/review pages are bound to the inspected
head and base; refresh after either changes. Search filters the current page.
Missing or truncated text patches are labelled and cannot be marked viewed. Viewed marks
belong to exact file revisions, so a later change becomes unread. Draft summaries
and inline comments remain local until an agent submits an approved action.

The native tools are available through the existing bridged provider routes:

- `repository-pr-read`: list/detail, then files/checks/statuses/reviews/comments/
  discussion. Follow `nextPage`; a `limitReached` response is not a complete list.
- `repository-pr-local`: read local state, save/discard drafts or mark a file
  revision viewed. Saved drafts remain readable without GitHub access.
- `repository-pr-action`: update the managed linked branch, edit the PR title/
  body, create a pending review or submit a comment, approval or request for
  changes. It can submit/delete the native account's own pending review.
  `recover` only reconciles an uncertain action and performs no remote write.
- `repository-pr-watch`: explicitly start/stop the PR-specific monitor described
  below. Stop names the exact `watchId` returned by local state.

Remote actions use the ordinary single-use native approval, binding repository
ID, canonical origin, PR number, head branch/SHA, base branch/SHA and full action
payload. Native code checks these again immediately before mutation. Reviews
name the reviewed commit, and inline comments must target lines on the selected
side of its actual diff. Updating a branch additionally binds `nextHead` to the
clean local committed tree and requires an ancestor relationship to the reviewed
remote head. Git's exact reference lease rejects a concurrent head change; the
native ancestry check forbids history rewrites. No merge or arbitrary Git/HTTP
operation is exposed.

Every mutation persists an intent journal before sending it. Stop, timeout or
restart retains uncertainty and blocks subsequent repository writes and
replacement attachment. Recovery requires exact positive evidence for edits,
pushes and reviews; it never resubmits, and excludes reviews that predated the
intent. Ambiguous/absent evidence leaves the operation locked for inspection.
An explicit HTTP validation, permission or rate-limit rejection releases the
intent without retrying; fixing it requires a fresh approved request. Transport
failures, timeouts and server errors retain uncertainty.
GitHub does not offer an atomic expected-head condition for PR metadata edits;
their head/base validation is a preflight check, whereas pushes use an exact
server-side reference lease and reviews explicitly name their commit.

Native `gh` login supplies a token only through its private bounded pipe.
GitHub API requests use the fixed `api.github.com` destination, disable redirects
and retries, cap each response at 1 MiB, and expose no credential to the renderer,
model or repository command. Public read pages hold at most 30 items; internal
reconciliation/monitor collections cap at 300 and fail closed if incomplete.
No extra SQL migration or replacement repository/conversation store is needed.

### Optional PR watches

A watch binds an existing root Work item and its generation to the selected
repository and PR. It establishes a baseline without waking Work, then reports
new check failures, all reported checks passing, new/edited reviews and comments
from other accounts, or new merge conflicts. Own-account comments and duplicate
facts stay quiet. “All reported checks” is not a branch-protection/merge claim.
Remote text is untrusted evidence and grants no new authority.

The monitor admits idempotent task messages into existing Work. Running turns
finish before a new message is handled; waiting/completed Work receives a fresh
queued turn. Approval, blockage, user decisions, existing turn/usage limits,
account ownership and conversation generations remain enforced. The monitor
does not invoke a provider or own execution. A persisted pending event and native
message ID bridge the crash gap without duplicating a wake.
Native admission emits a scoped update to the main renderer; its small bridge
refreshes the existing workspace executor, which admits the queued turn under
the same provider availability, permissions and capacity checks as other Work.

Monitoring requires the open, authenticated desktop. It polls no faster than
every two minutes, rotates at most two profiles per 30-second sweep, backs off
failed reads to 30 minutes, and stops after eight failures or ten relevant wakes.
Large workspaces poll less frequently. Closure, access/account changes, Work
Stop and computer-generation changes stop the watch. Desktop restart requires
explicit rearming. Stop PR watch writes a durable watch-specific cancellation
marker independently of the repository lock; it does not cancel previously
admitted Work or another repository operation. Generic webhooks and closed-app
execution belong to their separate features.

## Source research

These projects informed the boundaries; no source code or UI assets were copied:

- [T3 Code at a4c9494](https://github.com/pingdotgg/t3code/tree/a4c9494b0e3606775cc5fc929fc138399288bd43):
  inspected source-control documentation, `PullRequestWatchReactor`, watch
  evaluation, GitHub PR API/provider tests, and viewed-file revision services and
  tests. The concepts were adapted to Mivlet's existing authority and Work lane.
  Related verified merge commits: #15057 `18b21325c3ab1ff4f0ee7b017d9c4eefc2b2d307`,
  #16235 `3da82d5d384a5f45e3e4a9c5bdb8336eb54e49ff`, #14623
  `14fe0158ede3d964f183e281f9fec225d30a6b32`, and #16319–#16322 respectively
  `1564aaa5d29deb2520d1211f9f35dd6150b1512e`,
  `adc3c9327abedda6a36694e2344e620fe0d62ae4`,
  `649418f01fcb4ae5ebbc07739e0bfee8fae3aaec`,
  `9ac8f33f1685d1d6e843b657829d0d7462a13813`. This source snapshot is ahead
  of T3's stable installer; no installer-parity claim is made.
- GitHub's current [PR API](https://docs.github.com/en/rest/pulls/pulls) and
  [review API](https://docs.github.com/en/rest/pulls/reviews), checked on 8 October
  2026, define commit-bound reviews, pending/submitted states and pagination.
  Requests pin API version `2026-03-10`.

- [T3 Code at aad7329](https://github.com/pingdotgg/t3code/tree/aad732901e4b7d485574eaef5a9c1fb388c4291a):
  separate terminal lifecycle, Git workflows, checkpoints, provider permissions
  and PR operations. Mivlet retains its existing conversation and approval model.
- [OpenCode at 907b3bc](https://github.com/anomalyco/opencode/tree/907b3bc518fa48e90e8ec24dd327d13eee71c36c):
  scoped worktrees and separate Git indexes for snapshots. Mivlet uses independent
  local copies and a temporary index so the original working tree stays intact.
- [Cline at 39ff235](https://github.com/cline/cline/tree/39ff2359f7e08231281539696e48a166ce49270c):
  recovery transactions before destructive checkpoint restoration. Mivlet avoids
  destructive source restoration and persists publication uncertainty before effects.

## Verification

`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer::coding`
covers real local Git copies, original-work preservation, scoped file writes,
stale review rejection, exact commits, generation revocation and recovery locks.
The permit test `repository_permits_bind_full_payload_scope_generation_and_consume_once`
covers substitution and replay at the native approval boundary.

PR-specific fixtures live in `coding/pull_requests/tests.rs` and
`collaboration/pr_watch_tests.rs`. They cover stale targets, local state,
pagination, updates against actual local Git commits, uncertainty across reload,
read-only reconciliation, review positions, deduplication and Work Stop. The
opt-in `native_github_pr_read_acceptance` test requires `gh auth login` and an
explicit `MIVLET_PR_READ_ACCEPTANCE_REMOTE`; it only lists/views PRs and performs
no remote mutation. Renderer fixtures establish UI behavior, not live approval,
provider or publication acceptance. Remote mutation acceptance requires separate
explicit authorization and a disposable GitHub target.

On a configured unelevated Windows machine, explicitly run
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_coding_acceptance -- --ignored --nocapture`.
It uses the production native service on a temporary repository: a real failing
Node test, scoped fix, passing test, diff, timeout/output limits and Stop of a
descendant process. This establishes local native execution, not live model
selection, a provider-funded turn, or a remote publication. Renderer tests use
mocked native transport; live UI inspection and remote checks are separate evidence.
