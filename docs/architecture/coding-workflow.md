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
Each agent has one selected repository; older copies remain on disk. Library →
Repository → Retained copies inventories copies across this account, including
ownership, source repository, account-relative managed path, branch/HEAD, current
dirty state, logical file bytes and linked Work. Choose the owning agent in the
Repository selector to manage its copies. Copies left by removed agents are
visible but protected. Use this copy restores a retained
selection through the same native repository service; no source files are moved.
Inventory does not claim filesystem allocation, compression or deduplication.

Cleanup is deliberate; there is no automatic garbage collection. Review cleanup
creates a native single-use preview valid for two minutes, bound to the account,
workspace, agent, computer generation, copy identity and a hash of the exact tree.
The user must explicitly confirm removal. Native code consumes the token and
rechecks under the existing repository lock and canonical Work store connection.
Dirty, untracked **and ignored** files protect the copy regardless of Git's
`status.showUntrackedFiles` configuration. Unfinished Work, active repository
operations, active or recoverable provider attempts without exact copy attribution,
unknown ownership/metadata, interrupted command imports, publication
recovery, published copies and commits beyond the imported HEAD also protect it.
Git calls use process-local `core.longpaths=true`; no global Git settings change.
The Git adapter converts canonical Windows verbatim paths to Git-compatible
drive/UNC arguments without losing UTF-16 identity; native path validation
continues to use canonical paths.
Links, Windows reparse points and paths outside the managed scope fail closed.

Per-copy `repository.json` and `ownership.json` records retain the native state;
the existing top-level record remains the canonical selected repository. The
source's canonical path stays native. A currently selected legacy copy can be
registered from its verified scope; older unregistered copies are shown and
protected instead of guessing ownership. Cleanup records an intent outside the
copy, renames it to `deleting-<id>`, and removes only that managed tree. Crashes,
Stop or file locks leave a discoverable cleanup receipt; a fresh explicit preview
is required to retry. Cleanup never resumes automatically after restart.

This baseline has no retained-copy checkpoint status service or detached-command
supervisor. The inventory labels those limits; unknown per-copy metadata protects
cleanup. Work records do not carry exact repository-copy IDs, so unfinished Work
protects all of that agent's copies. Integrating checkpoint, PR or detached-job
services must replace these conservative guards with their canonical status
evidence under this same lock; do not remove guards based on missing evidence.
Exact cleanup inspection is limited to 200,000 entries and 2 GiB of file bytes;
larger copies remain protected. Inventory measures metadata without hashing file
contents. No SQL migration, alternative Work queue or model-facing deletion tool
is introduced.

Read-only inventory and preview release the store connection before filesystem
inspection, so browsing retained copies does not stall conversation persistence.
Deletion retains the canonical connection through its final checks and cleanup.
After entering cleanup, the renamed tree is hashed again before any content is
removed. Conflicting retained and cleanup paths protect both copies.

The behavior was informed by T3 Code at
`a4c9494b0e3606775cc5fc929fc138399288bd43` (storage cleanup, Work settlement and
worktree settings), plus [Windows long paths #14917](https://github.com/pingdotgg/t3code/pull/14917),
[terminal Work states #15150](https://github.com/pingdotgg/t3code/pull/15150),
[squash-merge evidence #14847](https://github.com/pingdotgg/t3code/pull/14847), and
[hidden untracked files #15834](https://github.com/pingdotgg/t3code/pull/15834).
The implementation uses Mivlet's native authority and independent Rust/React
code; no T3 runtime, source, assets or product copy is transplanted.

Retained-copy native acceptance uses disposable Git repositories and the pinned
Windows executor. Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
native_copy_lifecycle_acceptance -- --ignored --nocapture --test-threads=1` after
preparing the bundled runtime and native execution setup. It verifies imported
command changes, dirty-copy protection, deliberate single-use cleanup, replay
rejection and preservation of the source. This does not establish native UI,
provider or installed-account acceptance. An isolated app data/WebView profile
still shares the Windows Clerk session credential; authenticated app acceptance
requires an isolated Windows test account, not merely a new portable profile.

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

Each ordinary run has a 1–900 second timeout and a combined 64 KiB result limit.
Live redacted output appears in Library's Commands section and through
`command-jobs`/`command-output`, with bounded scrollback and explicit gap markers.
The result records its actual exit code, interruption and truncation. A command
receipt is associated with the resulting tree hash, and the UI identifies later
edits as unverified. An exit code of zero does not prove that the command was an
appropriate test; the agent and reviewer must choose the project's real checks.

For a development server or other controlled long-lived process, approve
`repository-start` with an explicit lifetime (up to 24 hours). Native ownership
continues after the tool returns and the panel closes. The job uses a fixed
isolated snapshot; all writes are discarded, including on success. The repository
stays locked until the job and all descendants end. Use `command-stop` or the
Commands panel's Stop job control, then approve a new start to pick up changes.
Network remains off by default; approval does not add a loopback exemption or
host-browser access. There is no interactive terminal. Closing the native owner
ends its jobs; restart retains nonsecret status, reports uncertainty and never
replays commands. See [the lifecycle contract](native-execution.md#live-output-and-controlled-jobs).

Stop revokes the existing workspace/agent generation. Atomic kill-on-close job
membership contains all descendants before the first instruction; Stop and
timeout terminate the job and verify that it is empty. A per-repository lock excludes competing file,
command, commit and publication operations. Interrupted commands retain their
receipt/state and are never automatically replayed. Failed/stopped command
snapshots are discarded, so their partial file writes never update the managed
checkout. Successful snapshots are validated, hash-checked and imported while
the operation's generation remains current. Source checkouts stay untouched.

## File checkpoints

Library → Repository → File checkpoints saves recoverable code states in the
selected agent's private copy. Name a state, save it through the normal approval,
then choose **Preview restore** to see real additions, modifications and deletions.
Restore needs a fresh, explicit one-use approval for that checkpoint, its exact
SHA-256 file tree, the reviewed current tree, resulting tree and current Git HEAD.
It saves a **Before checkpoint restore** checkpoint first. Run checks again after
restoring: prior command verification is invalidated even if a previous test passed.

The shared provider tool registry exposes `repository-checkpoint-list`,
`repository-checkpoint-capture`, `repository-checkpoint-preview`,
`repository-checkpoint-restore` and `repository-checkpoint-delete`. Each goes
through the existing scoped coding authority. Capture a checkpoint before risky
edits or after a useful verified milestone; captures are explicit, not an implied
checkpoint after every message. Checkpoint metadata retains repository identity,
native request ID, generation, capture time, Git HEAD, label and file hashes.
This does not rewind conversations, provider sessions, commits or external effects.

Snapshots include tracked files and non-ignored new files, including tracked
deletions. Credential paths (`.env*`, private keys, credential directories and
package credential configuration), Git metadata, submodules, unmerged indexes,
symlinks/reparse points, hardlinks, unsupported Windows filenames and LFS pointers
are excluded or rejected. A private copy must be a regular self-contained tree;
unexpected aliases fail closed. Arbitrary secrets inside ordinary code cannot be
identified reliably: use repositories whose code is suitable for the connected
model. File diffs pass through the existing native redaction and bounded-output
policy. Truncated diffs are labelled and the complete changed-file list is retained.

Restore preserves current ignored and credential files. If a saved path now
conflicts with a changed ignored file, restore refuses rather than overwriting it.
Only deterministic, canonical `scope/coding/<repository-id>/checkout` paths are
eligible. No caller can nominate the original checkout, another agent's copy, a
shared root, or a parent/child overlap. All attachment, command, file, commit,
publication and checkpoint operations share the in-process repository lock and a
nonblocking OS file lease. A second process cannot restore through a live owner.

Native preparation runs outside the Stop fence and polls cancellation. The
existing `native-import.json` transaction then binds a fresh restore transaction ID,
checkpoint ID, scope/generation/operation and input/output/previous hashes. The
short generation fence commits directory renames and persists invalidated
verification state. The previous tree and durable intent survive until
acknowledgement. Status/restart inspect the same import journal; a missing checkout
can recover its previous tree, but staged checkpoint files are never imported
automatically. Uncertain outcomes block further mutation until `repository-recover`
reconciles the existing checkout. Stop cannot admit stale prepared files.

Storage is bounded to 24 saved checkpoints and 512 MiB of saved file content per
copy, plus bounded manifests. One snapshot permits 64 MiB, 16 MiB per file and
4096 file/directory entries; the NUL-delimited Git inventory also has the existing
64 KiB output cap. Restore preparation uses the native coding tree limits
(2 GiB/200,000 entries), because ignored files must survive. Fixed staging names
bound interrupted capture, diff, deletion and restore preparations; the existing
import transaction retains at most its staged and previous trees until recovery.
Delete an old checkpoint explicitly to release saved storage. Checkpoints do not
garbage-collect repository copies and do not introduce another SQL migration.

Native retained-copy inventory must use
`coding::checkpoints::retention::inspect(coding_directory, repository_id, execution_scope_id, current)`
under the canonical copy lock and OS lease. It does not create checkpoint
directories, retire saved data, load authority or reconcile import journals.
The caller verifies the account/workspace/agent owner and derives the expected
execution identity with `authority::execution_scope_id` from that owner's exact
`state.scope(...).directory`, without loading a new authority. The actor's scope
must not be substituted when inspecting another agent's copy. The callback
rechecks account, cancellation and freshness throughout the bounded read.

The projection reuses the checkpoint manifest parser, checks saved content and
byte counts, and returns repository/scope identity, saved count, logical saved
file bytes and recovery blockers. Missing checkpoint storage returns zero
without creating it. Malformed/foreign/unknown checkpoint records return an
error and must remain protected; callers must never substitute an empty result.
Pending capture/deletion/preview trees and missing checkout remain blockers.
Import remnants are explicitly unknown and are not parsed or recovered here.
Counts exclude staging and metadata, so they are not total disk usage. An empty
projection is not cleanup permission: ownership, Work/job/import/publication
guards and a fresh single-use cleanup approval remain mandatory. Copy-manager
consumption is a separate integration; its conservative guards stay in place.

The source reference is [T3 Code at a4c9494](https://github.com/pingdotgg/t3code/tree/a4c9494b0e3606775cc5fc929fc138399288bd43):
`CheckpointStore`, the Git driver's temporary-index capture and tests,
`CheckpointCaptureService`, `CheckpointRollbackService`, and
`CheckpointRestoreSafety`/scope-ownership tests. They informed immutable identities,
file/conversation separation and shared-workspace refusal. No T3 source or assets
were copied. Mivlet retains native file custody and its existing approval/import
authority rather than adopting the T3 server runtime.

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

Checkpoint coverage also includes `checkpoint_restore_permit_binds_every_hash_request_scope_and_is_single_use`
and `local_computer::coding::checkpoints` in the desktop native suite. These use
real disposable Git copies to cover new/modified/deleted files, file/directory
replacement, ignored-file preservation and conflicts, stale review, corruption,
scope changes, Stop, OS custody, bounds, deletion and pre-restore undo.
`cargo test --manifest-path packages/windows-executor/Cargo.toml repository_`
includes a supervisor that kills a separate process after each restore rename;
restart must retain or recover the previous tree without replaying the restore.
Renderer tests in `RepositoryCheckpoints.test.tsx` and the checkpoint runtime
domain verify the approval flow and scope binding with mocked native transport.
The retention tests compare file/directory names, contents, lengths and last-write
times before and after successful, failed and cancelled reads, including
interrupted deletion, unknown import custody, missing checkout, malformed or
foreign manifests, forged sizes, hardlinks and a Windows junction. The ignored
`native_checkpoint_restore_acceptance` uses the pinned executor to import a real
Node change, restore the original checkpoint, clear prior verification and restore
the automatically retained undo. This is disposable native service evidence;
it does not authenticate a GUI account or establish a live-provider journey.

On a configured unelevated Windows machine, explicitly run
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml native_coding_acceptance -- --ignored --nocapture`.
It uses the production native service on a temporary repository: a real failing
Node test, scoped fix, passing test, diff, timeout/output limits and Stop of a
descendant process. This establishes local native execution, not live model
selection, a provider-funded turn, or a remote publication. Renderer tests use
mocked native transport; live UI inspection and remote checks are separate evidence.
