import type { CollaborationWorkItem, WorkStatus } from "@mivlet/protocol";

export type WorkState =
  | "queued"
  | "working"
  | "waiting"
  | "scheduled"
  | "completed"
  | "failed"
  | "stopped";

const STATE_LABELS: Record<WorkState, string> = {
  queued: "Queued",
  working: "Working",
  waiting: "Waiting",
  scheduled: "Scheduled",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * One unified user-facing state per request. Native statuses map onto the
 * seven states; specific conditions (awaiting approval, outcome review, a
 * blocked dependency) stay visible as secondary detail. A schedule origin is
 * only the Scheduled state while the request is still queued; a running or
 * finished scheduled run shows its real progress.
 */
export function workPresentation(
  item: Pick<CollaborationWorkItem, "status" | "origin">,
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
        state: "waiting",
        label: STATE_LABELS.waiting,
        detail: "A delegated assignment is unresolved",
      };
    case "awaiting-approval":
      return {
        state: "working",
        label: STATE_LABELS.working,
        detail: "Awaiting approval",
      };
    case "awaiting-user":
      return {
        state: "waiting",
        label: STATE_LABELS.waiting,
        detail: "Needs outcome review",
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
  item: Pick<CollaborationWorkItem, "status" | "origin">;
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