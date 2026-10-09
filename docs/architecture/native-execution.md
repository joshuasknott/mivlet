# Native Windows execution

`repository-run` and `workspace-run` use one Mivlet-owned Windows x64 executor.
Every provider route that bridges Mivlet tools reaches this same boundary. It
does not invoke a provider shell or alter Computer Use window grants, leases or
foreground/background delivery. WSL/Ubuntu/Bubblewrap are not prerequisites for
these tools. The separate experimental Grok bridge is unchanged.

## Security identity and launch

Each execution has a random, ephemeral Less Privileged AppContainer package SID.
This is a dedicated Windows security principal, not a persistent local login
with a password. LPAC checks intersect host-user rights with explicit package or
capability grants and opt out of ALL_APPLICATION_PACKAGES. Mivlet verifies the
suspended child's AppContainer SID and performs positive/negative AccessCheck
probes before resuming it. Query class 46 is not relied on: this host rejects it
with ERROR_INVALID_PARAMETER. No command starts when verification fails.
The final single-use resume action runs inside the caller's native ticket fence.
Stop that wins this fence leaves the verified child suspended and terminates its
job; a stale command cannot start between a predicate check and resume.

The only grants are the per-run work/home/temp trees (modify), pinned runtime and
batch file (read/execute), fixed ancestry metadata (traverse/read attributes,
without directory listing or content), system registryRead and optionally
internetClient. RegistryRead supports Winsock and system runtime initialization;
it does not grant arbitrary host-user registry access. The normal AppContainer
profile directory is sealed read-only. Windows still creates its private package
registry namespace; registry growth is not covered by the filesystem watchdog.

Windows denies access to unselected files, host credentials, other package
namespaces and higher-integrity processes. Credential Manager and DPAPI canary
denials are tested with actual native APIs. An executed process can access any
data deliberately selected into its snapshot; attach only shareable committed
project content. Output redaction is additional protection, not secret detection.

The environment is constructed from scratch. No host PATH, provider connection,
Git credential pipe or native-store handle is inherited. An explicit handle list
contains only empty stdin and bounded stdout/stderr pipes. A private desktop and
job UI restrictions prevent this lane from becoming interactive Computer Use.

The job is attached atomically during suspended process creation, has no breakaway
permission, and kills all descendants on Stop, timeout, host death or parent exit.
Mivlet verifies that no job processes remain before inspecting outputs. Memory,
process count and aggregate CPU time are kernel limits; wall time and storage
are watchdogs. Analysis uses 1 GiB/32 processes/64 MiB storage; coding uses
2 GiB/64 processes/2 GiB storage. The command result and live scrollback are each
bounded at 64 KiB; live scrollback also retains at most 512 frames. The disk
watchdog is not a hard quota and cannot eliminate every resource exhaustion risk.
Live storage enumeration polls generation and deadline before each directory
entry and metadata visit, with a bound on queued entries under churn. Post-exit
hashing polls the same control, including bounded file-read chunks; interruption
cannot produce an importable seal.

## Setup and runtimes

Library exposes setup, inspection, repair and removal of setup permissions.
The same installed Mivlet executable has a fixed setup entry point invoked
through Windows UAC. It accepts only the requesting user SID and repair/cleanup.
It changes the exact installation capability ACE on the fixed ProgramData
ancestry, creates private custody storage, and verifies each grant. No local user
passwords, services, scheduled tasks, firewall exemptions or project ACL grants
are provisioned. Maintenance takes an exclusive lease and fails while any run
or unimported result holds custody. Cleanup removes only its exact capability
ACEs and readiness stamp, preserving receipts and user files. Declined UAC,
enterprise policy, missing resources and ACL drift leave commands unavailable.
Privileged setup pins every existing/created ancestry directory with no-follow
handles and no write/delete sharing. ACL reads use these held objects. DACL writes
resolve each held handle's stable final path and use the non-propagating
`SetFileSecurityW` setter while all ancestry/target handles remain pinned. The
newer `SetSecurityInfo` can alter child inheritance flags even when ACE propagation
is suppressed; disposable inherited-child tests preserve the complete child ACL.
Both setup files are exclusively opened without truncation and checked for
reparse points/hardlinks before ACL changes or writes. Removal uses the verified
stamp handle. Runtime status hashing runs on a blocking worker, outside UI dispatch.

The bundle includes official Node 22.23.3/npm, Python 3.13.16 embeddable and
pip 26.2.1. `prepare-execution-runtime.mjs` verifies pinned upstream archives and
preserves their notices; `files.json` is compiled into the executor as the trust
anchor. Every staged file is re-opened with path, reparse/hardlink, size and hash
validation. Release resources resolve from Tauri's resource directory, never
the current working directory or model-provided paths. Python's `_pth` excludes
host/user site discovery and permits work/.python-packages. Projects can use
`npm install`, `npm run build`, `npm test` or `python -m pip install --target
.python-packages` with explicit network approval. Other host toolchains require
a reviewed pinned extension and currently fail as missing commands.

## Results and recovery

### Live output and controlled jobs

`repository-run` and `workspace-run` register native command jobs before launch.
`repository-start` and `workspace-start` use the same restricted executor but
return a job identity while Rust retains the operation ticket. They require an
explicit 1–86400 second lifetime and the existing exact single-use approval over
the full command, selected repository/files, network policy and timeout. Ordinary
command timeouts remain unchanged. There is no interactive stdin or provider
shell fallback.

`command-jobs` lists this agent's bounded native history. `command-output` reads
after a sequence cursor, returning at most 32 KiB with explicit dropped-history
and closed markers. The Commands section in Library polls that same scoped
authority. Native reads recheck account/workspace/agent membership and generation;
they never broadcast output to all windows. A slow or disconnected reader neither
blocks pipe drainage nor owns the job. Native scrollback evicts complete oldest
frames and continues receiving fresh output; the client also bounds its history.
Ordering is the order complete lines were observed from the two pipes, not a
claimed Windows ordering between independent stdout and stderr handles.

Lines are buffered before redaction so split secrets and UTF-8 cannot escape as
partial chunks. Native shared redaction includes multiline PEM and split-header
suppression. Oversized (over 8 KiB), invalid UTF-8 or control-bearing lines suppress
the remainder of that stream. Partial final lines are emitted at EOF. This lane
is plain build/test output, not an ANSI terminal. Redaction is defense in depth;
arbitrary unmarked project secrets cannot be reliably identified.

Persistent jobs own a fixed snapshot and **never import writes**, including after
a zero exit code. A repository job retains the canonical repository operation
lock through snapshot creation, execution, descendant termination and cleanup;
file edits, another command, attachment and publication must wait or Stop it.
Workspace jobs copy only selected inputs and accept no output import list.
Changes require stopping the job and a freshly approved start. No live bind mount,
host watcher, executable discovery on host PATH or loopback exemption is added.
A server listening inside the job does not establish access from a host browser.

`command-stop` binds the exact job identity and generation and reports `stopping`
until the executor confirms termination. Global Stop, revoked generation, plugin
disable, native owner closure, timeout and kernel limits retain the existing
descendant containment. Closing a panel leaves the native job alive; closing the
native owner kills it. This feature does not provide detached Work scheduling.
The opt-in [background owner](work-execution.md#opt-in-native-background-text-execution-on-windows)
can retain approved commands after the desktop window closes. Library's Retry
output rechecks the current generation and reads retained frames; it does not
restart or replay the command.

Native scope storage retains up to 128 nonsecret records (identity, command digest,
repository identity, generation/operation, lifetime, network policy, status and
exit). Commands, paths, raw output and credentials are absent. An exclusive
Windows owner-file lease prevents a second native process claiming the same job
scope. Interrupted `preparing/running/stopping` records reconcile to uncertainty
when that scope reopens; output is memory-only and unavailable after restart.
Admission is flushed before launch. The live transition to `running` updates
memory only, so the process supervisor never waits for metadata I/O while it
must poll Stop and timeouts. Terminal state is flushed after process cleanup;
an abrupt exit may therefore recover the earlier `preparing` admission record.
No PID is reattached, no command is replayed, and no persistent snapshot is
imported during recovery. Four active jobs per agent are admitted at a time.
Scrollback is retained for at most 16 jobs per scope, with at most 64 open native
job scopes per owner; older metadata can therefore exist without its log.

Integration seams: the executor's `run_with_output`, `ExecutionMode` and
`OutputLog` are provider-neutral; desktop `command_jobs` owns identity/status and
native cancellation. A detached worker must call this authority and retain the
same ticket/lease rather than starting another process service. Repository copy
cleanup must acquire the existing `coding::lock` and preserve its repository
identity; it cannot delete a copy while a persistent job owns that lock. No SQL
migration or replacement Work/approval store is introduced.

Fresh snapshots exclude Git custody and reject links, reparse paths, hardlinks,
aliases and oversized entries. Originals are never changed. Successful commands
seal a tree hash; repository import verifies it again and uses a staged rename
with rollback. Hashing/copying polls Stop outside the authority lock; only the
final rename holds the current-generation fence, and old-tree deletion follows
outside that fence. Analysis reopens only declared passive outputs, validates content
and imports the set through its existing generation-fenced transaction.
Repository import first flushes one bounded durable intent, bound to the canonical
checkout, run/command/input/output/previous hashes and scope/generation/operation.
The previous tree and intent survive both renames and remain until native
repository state is saved and acknowledgement is persisted. Restart inspection
validates the intent and every surviving tree, restores only a missing previous
checkout, and records immutable uncertainty. A completed second rename preserves
both current and previous trees until explicit `repository-recover` reconciles
the existing checkout. Staged command output is never imported during recovery;
changes/publication are blocked until reconciliation. Interrupted acknowledged
cleanup resumes without replaying imports or losing the recovery intent.

Private crash journals are persisted before runtime staging. Exclusive run
leases distinguish live custody from abandoned staging. The anonymous job dies
when the native host exits. The next execution reconciles abandoned profiles and
staging, records uncertainty and never replays a command or imports leftovers.
Unexpected links or invalid recovery journals block cleanup for inspection.
Initialization uses a separate short lease. New directories stay in the fixed
`preparing-<runId>` namespace until their lease and complete flushed journal are
published atomically as `run-<runId>` and final custody is acquired. Restart can
reconcile a bounded partial preparation before journal completion; unexpected
entries/links still fail closed. No profile or command exists before publication.

Append-only receipts record run/runtime/input/output/command digests, an opaque
authority scope, operation/generation, actual exit/interruption, bounds and
network policy. Raw command output is not persisted in the executor journal;
the native desktop redacts the returned output. Receipts do not assert that the
chosen check was appropriate or that external effects were undone. Existing
single-use request/agent/workspace approvals and publication uncertainty remain
authoritative. Commit/push/PR tools retain reviewed tree and HEAD checks and keep
credentials in the separate native publication adapter.

## Verification and references

Prepare resources with `node apps/desktop/scripts/prepare-execution-runtime.mjs`.
Run ordinary core tests/Clippy plus the desktop suites. On an unelevated configured
machine, run `cargo test --manifest-path packages/windows-executor/Cargo.toml
native_ -- --ignored --nocapture --test-threads=1`, then the desktop
`native_cancelled_launch_acceptance`, `native_coding_acceptance`,
`native_repository_import_recovery_acceptance` and
`native_workspace_execution_acceptance` tests individually with
`-- --ignored --nocapture --test-threads=1`.
These are actual local process/service checks. Live authenticated model/app,
installed packaging and a clean-machine/enterprise-policy rehearsal are separate
evidence and must not be inferred from them.

Local acceptance on October 4, 2026 used Windows x64, bounded elevated setup and
ordinary unelevated commands:

| Evidence | Result and boundary |
| --- | --- |
| Repository native acceptance | A real Node test failed, a scoped edit fixed it, a second command passed and the Git diff reflected the change. Original checkout remained intact; Stop killed a detached descendant. No external publication. |
| Projectless native acceptance | Python read selected CSV copies, computed 15 and imported a validated CSV. Host/network reads were denied; originals remained intact; Stop/timeout imported nothing. |
| Core isolation acceptance | Unselected file read/write, Credential Manager and DPAPI denied under the actual child token; output capped; sealed-tree tampering rejected. |
| Approved network/toolchain | Bundled npm built/tested a staged project, pip ran and explicitly enabled public HTTPS returned 200. This does not establish an IP/domain allowlist. |
| Actual host death/restart | Supervisor terminated only its own host; kill-on-close ended its detached child. Recovery preserved an uncertain receipt with command/scope binding, imported nothing and removed abandoned staging. A supplied host environment canary did not reach the command. |
| Review regressions | Abrupt host termination at both import rename boundaries and during partial journal preparation; cancellable wide-directory walks, live Stop inside storage enumeration, revoked suspended launch, and native coding status/recover with a missing checkout. Desktop Stop waits for a bound ready marker, observes the exact detached descendant, and preserves an unrelated sentinel. Setup link sentinels and directory replacement tests avoid protected targets. |
| UI | Production setup component rendered in a browser fixture with simulated IPC: setup/repair/removal/declined responses, narrow wrapping and keyboard focus. This is separate from Windows UAC and authenticated native UI evidence. |

Run these acceptance supervisors serially: any subsequent execution legitimately
recovers abandoned staging, which would otherwise interfere with the host-death
test's explicit restart step. Python 3.13 currently prints a restricted-path
resolution warning while executing successfully; the CSV and pip assertions
check actual results, not the absence of that warning. Installed-bundle,
clean-machine and authenticated live provider-to-tool journeys remain unverified.

References informed the design; no source was copied:

- [T3 Code terminal manager, output window and tests at a4c9494](https://github.com/pingdotgg/t3code/tree/a4c9494b0e3606775cc5fc929fc138399288bd43/apps/server/src/terminal)
  and [terminal history guidance](https://github.com/pingdotgg/t3code/blob/a4c9494b0e3606775cc5fc929fc138399288bd43/docs/user/terminal.md).
  The October 8 reference informed native ownership, bounded history, reconnect
  cursors and observation-before-exit tests. Its unrestricted terminal runtime,
  provider environments, assets and product copy were not imported. The remote
  main reference was rechecked at the same commit during implementation.
  Recent source history also inspected passive observation commit
  `cc41482df0232454af0cc5ac2f1afd984e342134` (PR #9791, October 7) and shared
  keyed-lock commit `37de6cbde65c7cf9ba90a2557c232e63b7e16988` (PR #15577,
  October 5). Mivlet keeps observation separate from process mutation and retains
  its own repository lock and approval model.

- [Microsoft AppContainer/LPAC launch and isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).
- [Microsoft directory moves](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-directories), [ACL updates and inheritance behavior](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo), and the [non-propagating file-security setter](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setfilesecurityw). The older setter is intentional here because changing unvalidated children is outside privileged setup's authority; held handles prevent path replacement.
- [Codex Windows sandbox](https://openai.com/index/building-codex-windows-sandbox/) and
  [Apache-2.0 public source at c2f7fe8](https://github.com/openai/codex/tree/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/windows-sandbox-rs).

Codex's broad-read restricted-user policy is not used as proof of Mivlet's secret
isolation. The LPAC intersection and actual denial probes establish this lane's
stronger file/credential boundary on tested Windows builds. This design still
trusts Windows, its system components and the native Mivlet application.
