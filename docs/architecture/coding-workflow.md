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

Commands require Windows, Git on the app's PATH, WSL distribution `Ubuntu`,
`/usr/bin/bwrap`, `/usr/bin/python3`, and the project's Linux build tools under
`/usr`. The app does not install these dependencies. Missing prerequisites fail
closed. Windows-only builds are unsupported by this execution lane. Submodules,
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

`repository-run` executes an explicit command inside a Bubblewrap namespace in
WSL. Only the checkout is writable persistent storage. `/usr` is read-only;
home and temporary storage are fresh; Windows drives, host home directories,
Git metadata and provider credentials are absent. Git metadata stays beside the
checkout, outside the namespace. The environment is cleared. Network is off by
default. Explicit network access shares WSL networking, including reachable local
services; it is not an internet-only allowlist.

Each run has a 1–900 second timeout and a combined 64 KiB output limit. The result
records its actual exit code, interruption and truncation. Output appears after
completion; there is no interactive terminal or live output streaming. A command
receipt is associated with the resulting tree hash, and the UI identifies later
edits as unverified. An exit code of zero does not prove that the command was an
appropriate test; the agent and reviewer must choose the project's real checks.

Stop revokes the existing workspace/agent generation. A private lifetime pipe
ends the WSL supervisor and its PID namespace; the native launcher also belongs
to a kill-on-close Windows job. A per-repository lock excludes competing file,
command, commit and publication operations. Interrupted commands retain their
receipt/state and are never automatically replayed.

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
existing PR is shown as a link. Updating an already published PR from this copy
is not supported in this first version.

## Source research

These projects informed the boundaries; no source code or UI assets were copied:

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

On a configured Windows/WSL machine, explicitly run
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_coding_acceptance -- --ignored --nocapture`.
It uses the production native service on a temporary repository: a real failing
Node test, scoped fix, passing test, diff, timeout/output limits and Stop of a
descendant process. This establishes local native execution, not live model
selection, a provider-funded turn, or a remote publication. Renderer tests use
mocked native transport; live UI inspection and remote checks are separate evidence.
