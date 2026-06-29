/**
 * Remote command authorization — the fail-closed gate.
 *
 * This is the load-bearing safety module for mobile remote control. A mobile
 * `RemoteCommand` only authorizes when ALL of the following hold:
 *   - the session is live (active + within lifetime + within idle window)
 *   - for approve/deny: the approval id matches a pending desktop approval that
 *     still exists and has NOT been resolved yet
 *   - for schedule commands: the job id matches an existing scheduled job
 *
 * Every other case fails closed: replayed approval ids, non-existent approvals,
 * already-resolved approvals, expired/revoked/pairing sessions, unknown job
 * ids, and unrecognized command types all return `{ ok: false }` and authorize
 * nothing.
 *
 * IMPORTANT: authorization only says a command is ELIGIBLE to be applied. It
 * does NOT issue an execution permit. The actual permit issuance stays in the
 * existing Rust `approvals` / `execution_approvals` path, unchanged. A mobile
 * approve is an input to the approval queue, never execution authority.
 *
 * SECRET INVARIANT: this module holds no key, no token. It operates only on
 * non-secret approval/schedule/session metadata.
 */

import type {
  ApprovalRequest,
  RemoteCommand,
  RemoteCommandResult,
  RemoteErrorCode,
  RemoteSession,
  ScheduledJob
} from "@fable/protocol";
import type { Now } from "./session";
import { isSessionLive } from "./session";

/** The set of pending (unresolved) desktop approvals a mobile device may act on. */
export interface PendingApprovalIndex {
  /** True when an approval with this id is still pending (unresolved). */
  has(id: string): boolean;
  /** The pending approval by id, or undefined when missing/resolved. */
  get(id: string): ApprovalRequest | undefined;
}

/** The set of scheduled jobs a mobile device may pause/resume/delete. */
export interface ScheduledJobIndex {
  has(id: string): boolean;
  get(id: string): ScheduledJob | undefined;
}

/** A failed authorization outcome. */
function denied(code: RemoteErrorCode, message: string): RemoteCommandResult {
  return { ok: false, code, message };
}

/**
 * Decide whether a remote command is authorized to be applied. Returns
 * `{ ok: true, appliedAt }` only when every fail-closed check passes.
 * Otherwise returns `{ ok: false, code, message }` and the command is a no-op.
 *
 * Callers (the Rust command boundary, via the dispatcher) MUST treat a
 * non-`ok` result as "do nothing" — they must not dispatch the command.
 */
export function authorizeCommand(input: {
  command: RemoteCommand;
  session: RemoteSession;
  pendingApprovals: PendingApprovalIndex;
  scheduledJobs: ScheduledJobIndex;
  now: Now;
}): RemoteCommandResult {
  const { command, session, pendingApprovals, scheduledJobs, now } = input;

  // 1. Session must be live. Non-live sessions (pairing/expired/idle/revoked)
  //    fail closed and authorize nothing.
  if (!isSessionLive(session, now)) {
    return denied("session-expired", "Remote session is not live.");
  }

  switch (command.type) {
    case "approve":
    case "deny": {
      const approval = pendingApprovals.get(command.approvalId);
      if (!approval) {
        // Non-existent OR already-resolved approvals look identical here, and
        // both must fail closed. We can't distinguish them via a pending index
        // by design — a resolved approval is no longer pending.
        if (pendingApprovals.has(command.approvalId)) {
          // Defensive: has() true but get() undefined should not happen with a
          // well-formed index, but treat it as already-resolved (fail closed).
          return denied("approval-already-resolved", "Approval is no longer pending.");
        }
        return denied("approval-not-found", "Approval is not pending or has been resolved.");
      }
      // approve carries a grant decision; deny does not. Validate the decision.
      if (command.type === "approve") {
        if (command.decision !== "once" && command.decision !== "session" && command.decision !== "rule") {
          return denied("invalid-command", "Approve command carries an invalid grant decision.");
        }
      }
      return { ok: true, appliedAt: now() };
    }

    case "pause-schedule":
    case "resume-schedule":
    case "delete-schedule": {
      if (!scheduledJobs.has(command.jobId)) {
        return denied("schedule-not-found", "Scheduled job was not found.");
      }
      return { ok: true, appliedAt: now() };
    }

    default: {
      // Exhaustiveness check: any command type not in the union fails closed.
      // `command` is `never` here when the switch is exhaustive, so this branch
      // is reached only for an unrecognized command.
      const _exhaustive: never = command;
      void _exhaustive;
      return denied("invalid-command", `Unrecognized command type.`);
    }
  }
}
