import type { CollaborationWorkItem, WorkStatus } from "@mivlet/protocol";

export type WorkState =
  | "queued"
  | "working"
  | "waiting"
  | "waiting-for-user"
  | "awaiting-approval"
  | "blocked"
  | "interrupted"
  | "scheduled"
  | "completed"
  | "failed"
  | "stopped";

const STATE_LABELS: Record<WorkState, string> = {
  queued: "Queued",
  working: "Working",
  waiting: "Waiting",
  "waiting-for-user": "Waiting for you",
  "awaiting-approval": "Awaiting approval",
  blocked: "Blocked",
  interrupted: "Interrupted",
  scheduled: "Scheduled",
  completed: "Completed",
  failed: "Failed",
  stopped: "Cancelled",
};

/**
 * One unified user-facing state per request. Native statuses map onto the
 * explicit runtime states. A schedule origin is
 * only the Scheduled state while the request is still queued; a running or
 * finished scheduled run shows its real progress.
 */
export function workPresentation(
  item: Pick<CollaborationWorkItem, "status" | "origin"> & Partial<Pick<CollaborationWorkItem, "reason">>,
): { state: WorkState; label: string; detail?: string } {
  const scheduled = item.origin === "schedule";
  const originDetail = scheduled ? "Scheduled research" : undefined;
  const status: WorkStatus = item.status;
  switch (status) {
    case "queued":
      return scheduled
        ? { state: "scheduled", label: STATE_LABELS.scheduled, detail: originDetail }
        : { state: "queued", label: STATE_LABELS.queued };
    case "running":
      return {
        state: "working",
        label: STATE_LABELS.working,
        detail: originDetail,
      };
    case "waiting":
      return {
        state: "waiting",
        label: STATE_LABELS.waiting,
        detail: "For delegated assignments",
      };
    case "blocked":
      return {
        state: "blocked",
        label: STATE_LABELS.blocked,
        detail: "A delegated assignment is unresolved",
      };
    case "awaiting-approval":
      return {
        state: "awaiting-approval",
        label: STATE_LABELS["awaiting-approval"],
        detail: "Review the exact proposed action",
      };
    case "awaiting-user":
      if (item.reason?.startsWith("The app stopped during this work.") || item.reason?.startsWith("Mivlet restarted")) return { state: "interrupted", label: STATE_LABELS.interrupted, detail: "Review saved outcomes before continuing" };
      return {
        state: "waiting-for-user",
        label: STATE_LABELS["waiting-for-user"],
        detail: "Open work details to review and continue",
      };
    case "completed":
      return {
        state: "completed",
        label: STATE_LABELS.completed,
        detail: originDetail,
      };
    case "failed":
      return { state: "failed", label: STATE_LABELS.failed, detail: originDetail };
    case "cancelled":
      return { state: "stopped", label: STATE_LABELS.stopped, detail: originDetail };
  }
}

export function WorkStatusBadge({
  item,
}: {
  item: Pick<CollaborationWorkItem, "status" | "origin"> & Partial<Pick<CollaborationWorkItem, "reason">>;
}) {
  const presentation = workPresentation(item);
  return (
    <span className="work-badges">
      <span
        className="work-status-badge"
        data-state={presentation.state}
        title={presentation.detail}
      >
        {presentation.label}
      </span>
      {presentation.detail ? (
        <small className="work-status-detail">{presentation.detail}</small>
      ) : null}
    </span>
  );
}
