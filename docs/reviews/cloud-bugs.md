# Correctness / bug-hunt (analysis only)

**Date:** 2026-09-15  
**Repo:** https://github.com/joshuasknott/mivlet  
**Scope:** agent execution, protocol fences, Convex, Tauri IPC, connectors, knowledge. No application code was changed.

This is a static production-path review plus focused tests. Findings are ranked by reachable impact on documented invariants (single-use approvals, generation/run fences, workspace/account binding, fail-closed prerequisites). Style nits and planned-but-unwired features are omitted unless an insecure API is already public.

## Method

Traced Chat → `WorkspaceExecution.submit` → native `collaboration/work` → provider loop → tool/approval/computer/connector egress, and the Convex → hosted-runner capability path. Compared Stop/steer/recover behavior against `docs/architecture/work-execution.md` and `docs/security/threat-model.md`.

**Checks run**

| Check | Result |
| --- | --- |
| `pnpm --filter @fable/protocol check:spine-parity` | pass |
| `pnpm --filter @fable/desktop typecheck` | pass |
| `pnpm --filter @fable/hosted-runner typecheck` | pass (after protocol build) |
| Desktop vitest: `workspace-execution`, `native-connector-actions`, `useShellRuntime.approvals` | 29 pass (gaps below are untested) |
| `pnpm --filter @fable/knowledge test` | 307 pass |
| `pnpm --filter @fable/hosted-runner test` | 28 pass |
| `pnpm --filter @fable/broker test` | 109 pass |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | skipped: Cargo 1.83 cannot parse `edition2024` crates |
| GitHub issues | none open |

Existing suites do **not** cover dispose-vs-Stop, connector account re-bind, approval-document lost updates, or hosted `ensure()` generation.

## P0

None confirmed. The worst local issues are fence violations on common UI paths (P1), not unauthenticated secret theft.

---

## P1

### P1-1. Account refresh unmounts the execution owner without native Stop

**Paths:** `apps/desktop/src/shell/TeammateWorkspace.tsx`, `apps/desktop/src/hooks/shell-runtime/useAccountWorkspace.ts`, `apps/desktop/src/lib/workspace-execution.ts` (`dispose` vs `stop`), `apps/desktop/src-tauri/src/collaboration.rs` (`ensure_run_current`)

**Trigger:** While Work is bound/`running`, the user clicks Settings → refresh account (`refreshIdentity` → `refreshAccountWorkspace(true)`). The same unmount happens on `reconcileAccountWorkspace`, identity recovery, or any `accountWorkspacePending` flip.

**What happens:** `TeammateWorkspace` treats `accountWorkspacePending` as a loading gate and unmounts `ActiveWorkspace`. Cleanup/`onScopeReset` calls `WorkspaceExecution.dispose()`, which fire-and-forgets `session.cancel` and **does not** issue `stop-work`. Native Work stays `running` with the same generation and `current_run_id`. `admit()` only starts `queued` Work, so remount leaves an executing assignment with no `ExecutionWorker`.

**Impact:** Work UI can sit on “Working” with no owner until manual Stop or process restart (`collaboration::recover`). Late provider checkpoints and assistant appends still pass `ensure_run_current` because the assignment is still `executing()`. Violates work-execution: Stop/scope change must reject late results; view/account chrome must not detach Work.

**Fix direction:** Keep `WorkspaceExecution` mounted across pending refreshes (do not use `accountWorkspacePending` as an unmount gate). Make `dispose` await cancel then native `stop-work`/`stop-project` (same as `stop()`), or call the same invalidation as `collaboration::recover` / `suspend_account`. Remount recovery should move orphaned executing Work to `awaiting-user` and bump generation.

```148:176:apps/desktop/src/shell/TeammateWorkspace.tsx
  if (
    runtime.accountWorkspacePending ||
    (!runtime.runtimeSnapshotReady &&
      !runtime.runtimeSnapshotError &&
      account.accountBound)
  )
    return ( /* "Opening your workspace…" — unmounts ActiveWorkspace */ );
```

```518:531:apps/desktop/src/lib/workspace-execution.ts
  dispose() {
    this.disposed = true;
    // cancels sessions without awaiting and without stop-work
  }
```

```657:683:apps/desktop/src-tauri/src/collaboration.rs
    if item.generation != author.generation
        || !item.status.executing()
        || item.current_run_id.as_deref() != Some(run)
```

---

### P1-2. Interrupted attempts can be overwritten to `completed`

**Paths:** `apps/desktop/src-tauri/src/execution_attempts.rs` (`save_execution_attempt`, `recover_interrupted_execution_attempts`)

**Trigger:** Same teardown as P1-1. Remount runs `recoverRuntimeExecutionAttempts`, marking the in-flight attempt `interrupted`. A straggling provider save of `completed` for the same id still passes `ensure_run_current` (Work still executing) and is allowed because the DB path only blocks terminal → in-flight, not terminal → other terminal. The file-based test helper `persist_execution_attempt` is stricter and is not used in production.

**Impact:** Journal shows a completed run while Work is still running or awaiting user; recovery “nothing replayed / interrupted is immutable” is false.

**Fix direction:** Reject non-identical writes to a terminal attempt (match the test helper). When marking attempts interrupted, also fence bound Work (generation bump / clear `current_run_id`).

```720:733:apps/desktop/src-tauri/src/execution_attempts.rs
                if terminal
                    && matches!(
                        attempt.status.as_str(),
                        "queued" | "streaming" | "awaiting-approval" | "retrying"
                    )
```

---

### P1-3. Approved connector writes use the currently selected account, not the prepared one

**Paths:** `apps/desktop/src-tauri/src/connectors.rs` (`prepare_connector_tool_action`, `execute_approved_connector_action`), `apps/desktop/src-tauri/src/connector_approvals.rs` (`verify_prepared_connector_action`), `apps/desktop/src-tauri/src/google.rs` (`execute_action`), `apps/desktop/src-tauri/src/collaboration_connectors.rs` (`execute`), `apps/desktop/src/lib/desktop-tool-runtime.ts`

**Trigger:** User has two Gmail/Drive/Calendar/Slack/Notion Connections. Agent prepares a send/mutation (preview bound to account A). While the approval dialog is open, user switches the connector to account B (`switch_connector_account`). User approves. JS only re-checks connector id membership, not account/connection id.

**Impact:** The exact preview the user approved is sent with account B’s OAuth token (wrong mailbox/drive/workspace). `account_id` is stored on the approval record and shown in the preview, then ignored at verify/execute. `authorized_tokens` / `access_token` resolve `None` → current selection. Native already has `authorized_tokens_for_connection`.

**Fix direction:** Include `account_id` / `connection_id` in `action_fingerprint` (or compare `record.account_id` in `verify_prepared_connector_action`). Pass that id into `authorized_tokens_for_connection` / `access_token_for_connection`. Fail closed if selection changed. Extend `native-connector-actions.test.ts` (today it only covers connector id revocation).

```307:323:apps/desktop/src-tauri/src/connector_approvals.rs
    if record.connector_id != action.connector_id
        || record.proposed_action != action.action
        || record.risk_level != action.approval.risk_level
        || record.action_fingerprint != action_fingerprint(action)?
```

```1257:1262:apps/desktop/src-tauri/src/google.rs
    let (_, tokens) = authorized_tokens(app, &action.connector_id).await?;
```

---

### P1-4. Single-use execution permits are not consumed atomically

**Paths:** `apps/desktop/src-tauri/src/execution_approvals.rs` (`verify_and_consume_execution_approval`, `write_records` / `store::write_document`)

**Trigger:** Two agents running at once (supported: up to three Work sessions, two native-API). Each tool consume is read → mutate → write as a **separate** SQLite transaction on the same preferences document. Native-API tools in one loop are sequential; concurrent **sessions** are not.

**Impact:** Lost update can un-consume a permit that already authorized an effect. A replay of the same exact request can then pass “already consumed”. Breaks the single-use approval invariant under concurrency. Same pattern exists for connector approval records (`connector_approvals.rs`).

**Fix direction:** Consume inside one SQLite transaction with a compare-and-swap on `consumed_at`, or store permits as rows with `UPDATE … WHERE consumed_at IS NULL`. Serialize all consume/invalidate writes on one lock.

---

### P1-5. Execution-approval TTL is not wall-clock

**Paths:** `apps/desktop/src-tauri/src/execution_approvals.rs`; callers in `tools.rs`, `connectors.rs`, `hosted_computer.rs`, `mcp_process/configuration.rs`, `capability_grants.rs`

**Trigger:** A persisted, unconsumed permit is presented later (delayed tool after approval, leftover renderer invoke, consume lost by P1-4). Callers pass `audit_entry.decided_at` / `approval.decided_at` as `consumed_at`.

**Impact:** The 15-minute TTL compares consume time to decision time, but consume time is the decision timestamp, so elapsed time is always ~0. Stale permits remain valid until consumed, invalidated, or truncated. Threat model assumes renderer metadata is not authority; the native clock should be.

**Fix direction:** Use `Utc::now()` inside `verify_and_consume_execution_approval`. Keep the client timestamp out of the TTL check.

```339:343:apps/desktop/src-tauri/src/tools.rs
    verify_and_consume_execution_approval(
        path,
        &request.approval.request,
        &request.approval.decided_at,
    )
```

---

### P1-6. Hosted computer is keyed by the first mirrored workspace, not the active one

**Paths:** `apps/desktop/src/shell/useExecutionController.ts`, `apps/desktop/src/shell/ComputerInspector.tsx`, `apps/desktop/src-tauri/src/account_workspace.rs` (`local_status`), `apps/desktop/convex/hostedExecutionPolicy.ts` (`hostedComputerId`)

**Trigger:** Account has two or more active Convex memberships. User uses the local workspace (status always reports `source: "local"`, `fableWorkspaceId: None`). Hosted provision/tools use `workspaces.find(active && membership active)`. Directory `select_active_workspace` exists but `account_workspace_status` never returns it.

**Impact:** Cloud computer/process/browser for workspace B while local chat/files are the generic PC workspace. Confused deputy between renderer list order and runner identity. Latent until multi-membership; single-workspace accounts always pick that one.

**Fix direction:** Drive hosted IPC from an explicit native selection (or the only membership). Reject drafts whose `workspaceId` is not that selection. Stop using `.find()` on the mirror list. Same for `devices.find(status === "active")`.

```89:98:apps/desktop/src/shell/useExecutionController.ts
  const hostedWorkspaceId =
    runtime.accountWorkspaceStatus.workspaces.find(
      (workspace) =>
        workspace.workspaceStatus === "active" &&
        workspace.membershipStatus === "active",
    )?.fableWorkspaceId ?? null;
```

```466:470:apps/desktop/src-tauri/src/account_workspace.rs
        active_workspace: directory::ActiveWorkspaceSelection {
            local_workspace_id: crate::store::repos::scope::DEFAULT_WORKSPACE_ID.into(),
            fable_workspace_id: None,
            name: "On this PC".into(), source: "local".into(),
        },
```

---

### P1-7. Hosted `ensure()` does not bump generation on re-provision

**Paths:** `apps/hosted-runner/src/computer-authority.ts` (`ensure` vs `destroy`), `apps/desktop/convex/hostedExecution.ts` (`provisionScheduled` PUT without DELETE)

**Trigger:** Convex `requestProvision` on an already-ready node patches it to provisioning and PUTs `/v1/computers/:id`. `ensure()` reuses `previous.generation`. `destroy()` is the only bump. Capabilities are generation-fenced for 2 minutes.

**Impact:** If the sandbox is replaced or reset in place, a still-valid capability minted for the previous runtime remains usable. Docs say delete invalidates authority; re-provision does not.

**Fix direction:** Increment generation at the start of `ensure()` whenever lifecycle was already `ready`/`degraded`, or always destroy-then-ensure. Have Convex destroy before re-provision.

```51:53:apps/hosted-runner/src/computer-authority.ts
    const generation = previous?.generation ?? 1;
    this.writeComputer({ computerId, lifecycle: "provisioning", keepAlive: true, generation, updatedAt: now });
```

Hosted runner is deployment-gated; this is still a real fence bug in the implemented worker.

---

## P2

### P2-1. Snapshot and connector-cache IPC trust renderer `workspaceId`

**Paths:** `apps/desktop/src-tauri/src/snapshot.rs` (`load_runtime_snapshot` / `save_runtime_snapshot` via `data_scope`), `apps/desktop/src-tauri/src/connector_cache.rs` (`required_workspace`)

**Trigger:** Compromised or scripted WebView invokes Tauri with another normalized workspace id (`hosted-{hash}`, sibling key).

**Impact:** Read/overwrite encrypted snapshot or connector cache partitions without `authorized_scope` / directory membership. Does not cross OS users; contradicts “renderer workspace IDs are assertions, never authority.” Production `local_status` still reports `default`, so this is mostly a confused-deputy hole and a landmine when hosted local ids are wired.

**Fix:** Route through `authorized_scope::command_scope` or `require_active_workspace_context_for_current_user`.

### P2-2. `authorized_scope` is `"default"`-only while the directory mints `hosted-{hash}` ids

**Paths:** `apps/desktop/src-tauri/src/authorized_scope.rs`, `apps/desktop/src-tauri/src/store/repos/workspace_directory.rs`

Selecting a hosted workspace would fail closed for collaboration/memory/tools, or keep using `"default"` while snapshots/cache use other ids (widens P2-1). Unify one native resolver before enabling hosted selection.

### P2-3. Convex `device.link` has no proof-of-possession; hosted `deviceId` is a renderer assertion

**Paths:** `apps/desktop/convex/device.ts`, `apps/desktop/convex/authorization.ts` (`requireActiveDevice`), `apps/desktop/src-tauri/src/hosted_computer.rs`

Global `deviceId` can be squatted; `publicKey` is stored and never verified. Hosted drafts forward whatever device id the renderer supplies among the user’s devices. Wrong audit attribution; any future device-bound policy is hollow.

**Fix:** Native-only device id; signed challenge on link; Tauri rejects mismatched device.

### P2-4. Knowledge/memory assembly has no post-await workspace fence

**Paths:** `apps/desktop/src/hooks/useShellRuntime.ts` (`assembleConversationContext`), `apps/desktop/src/shell/ExecutionWorker.tsx`

Import/memory commit re-check `connectorScopeRef` after awaits; assembly does not. Today local workspace id is always `default` and account changes usually restart the process, so cross-workspace leakage is latent. On in-process remount, React knowledge/memory can still be the previous snapshot while native summaries are the new private scope. `ExecutionWorker` aborts if `service.current` is false *after* assemble, which limits dispatch of mixed context, but the fence belongs in assembly.

**Fix:** Capture workspace/member generation at entry; fail closed after each await. Clear knowledge/memory synchronously on scope change.

`connectionIsAuthorized` ignores the `account` argument (authorization is connection-id only). Tighten when both are present.

### P2-5. `write-file` confinement TOCTOU for paths that do not exist yet

**Paths:** `apps/desktop/src-tauri/src/tools.rs` (`confine_path`, `run_write_file`)

Canonical containment runs only if `joined.exists()`. `create_dir_all` + write do not re-check. A junction planted on a new prefix between confine and write can escape the agent workspace. Needs a local race/adversary; preview paths in `local_computer.rs` already require strict canonicalize.

**Fix:** After `create_dir_all`, re-run strict canonical containment before open/write.

---

## Checked and not filed as bugs

| Area | Notes |
| --- | --- |
| Stop / steer / membership | Native `work::current`, `invalidate_room`, `invalidate_descendants` bump generation and move Work off `executing`. Covered in `collaboration/tests.rs`. Gap is teardown that **skips** those commands. |
| Background → foreground computer | Refused in `local_computer/control.rs` / `desktop_tools.rs`. |
| Host shell fallback | `run-shell` requires hosted location; native Windows shell fails closed. |
| MCP `tools/call` from renderer | `permitted_renderer_frame` allowlists init/list/ping only. |
| Broker | Single-use handoff/pending TTL; tokens not persisted beyond redemption. Tests pass. |
| App-start recovery | `collaboration::recover` in `lib.rs` fences Work; distinct from in-session dispose. |
| Protocol TS/Rust spine | `check:spine-parity` passed. |
| Knowledge as instructions | Retrieved blocks labeled untrusted in `assemble.ts`. |
| Secrets in React | Provider/connector tokens stay in Rust; hosted capability tokens stay in `hosted_computer.rs`. |

## Suggested fix order

1. **P1-1 / P1-2** — Stop detaching execution on account pending; fence orphaned running Work; make terminal attempts immutable.  
2. **P1-3** — Bind connector execute to prepared account/connection.  
3. **P1-4 / P1-5** — Atomic consume + native now() TTL.  
4. **P1-6 / P1-7** — Hosted workspace/device selection + generation bump on ensure.  
5. **P2** — IPC authz, assembly fence, write-file re-canonicalize.

No application code was modified in this review.
