/**
 * Remote command dispatch — pure mapping of an AUTHORIZED command onto the
 * existing runtime seams.
 *
 * The dispatcher never performs I/O and never authorizes. It takes a command
 * that `authorizeCommand` already approved and routes it through an injected
 * {@link RemoteCommandRuntime} seam that the desktop shell / Rust boundary
 * implements on top of the EXISTING approval-resolution and scheduler paths.
 * No new side-effect paths are introduced.
 *
 * CRITICAL CONTRACT: callers MUST run `authorizeCommand` first. `dispatchCommand`
 * trusts an already-authorized command and applies it. Routing an unauthorized
 * command here is a caller bug. To make a misused call fail loudly rather than
 * silently execute, `dispatchCommand` re-checks the session is live and returns
 * a fail-closed result if it is not — but it does NOT re-check the approval/job
 * existence, because the caller holds the authoritative indexes at authorize
 * time and the apply is synchronous.
 *
 * SECRET INVARIANT: this module holds no key, no token.
 */

import type {
  ApprovalDecision,
  RemoteCommand,
  RemoteCommandResult,
  RemoteErrorCode,
  RemoteSession
} from "@fable/protocol";
import type { Now } from "./session";
import { isSessionLive } from "./session";

/**
 * The focused execution seam for mobile-remote control. The desktop implements
 * each method on top of its existing boundaries:
 *   - `resolveApproval` → the existing approval-resolution path (which still
 *     requires its own fresh fingerprinted permit for any tool to fire).
 *   - `setJobStatus` / `deleteJob` → the existing scheduler mutation paths.
 *
 * Each method is async because the underlying boundaries are; the dispatcher
 * awaits them and turns failures into fail-closed results.
 */
export interface RemoteCommandRuntime {
  /** Resolve an approval via the existing approval-resolution path. */
  resolveApproval(input: {
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<void>;
  /** Pause/resume a scheduled job via the existing scheduler path. */
  setJobStatus(input: { jobId: string; status: "active" | "paused" }): Promise<void>;
  /** Delete a scheduled job via the existing scheduler path. */
  deleteJob(input: { jobId: string }): Promise<void>;
}

/** A failed dispatch outcome. */
function denied(code: RemoteErrorCode, message: string): RemoteCommandResult {
  return { ok: false, code, message };
}

/**
 * Apply an already-authorized remote command through the injected runtime.
 * Returns the command result. The dispatcher re-checks session liveness as a
 * defense-in-depth guard against a caller that held a stale session between
 * authorize and apply.
 */
export async function dispatchCommand(input: {
  command: RemoteCommand;
  session: RemoteSession;
  runtime: RemoteCommandRuntime;
  now: Now;
}): Promise<RemoteCommandResult> {
  const { command, session, runtime, now } = input;

  // Defense-in-depth: a stale session between authorize and apply fails closed.
  if (!isSessionLive(session, now)) {
    return denied("session-expired", "Remote session is no longer live.");
  }

  try {
    switch (command.type) {
      case "approve":
        await runtime.resolveApproval({
          approvalId: command.approvalId,
          decision: command.decision
        });
        return { ok: true, appliedAt: now() };
      case "deny":
        await runtime.resolveApproval({
          approvalId: command.approvalId,
          decision: "deny"
        });
        return { ok: true, appliedAt: now() };
      case "pause-schedule":
        await runtime.setJobStatus({ jobId: command.jobId, status: "paused" });
        return { ok: true, appliedAt: now() };
      case "resume-schedule":
        await runtime.setJobStatus({ jobId: command.jobId, status: "active" });
        return { ok: true, appliedAt: now() };
      case "delete-schedule":
        await runtime.deleteJob({ jobId: command.jobId });
        return { ok: true, appliedAt: now() };
      default: {
        const _exhaustive: never = command;
        void _exhaustive;
        return denied("invalid-command", "Unrecognized command type.");
      }
    }
  } catch (error) {
    // The underlying boundary rejected the apply (e.g. approval was resolved by
    // the desktop in the race window). Fail closed rather than claim success.
    const message = error instanceof Error ? error.message : "Remote command could not be applied.";
    return denied("invalid-command", message);
  }
}
