import type { WorkStatus } from "@fable/protocol";

const STATUS_LABELS: Record<WorkStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  "awaiting-approval": "Awaiting approval",
  "awaiting-user": "Needs review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};

export function WorkStatusBadge({
  status,
  origin,
}: {
  status: WorkStatus;
  origin?: "chat" | "schedule";
}) {
  return (
    <span className="work-badges">
      <span className="work-status-badge" data-status={status}>
        {STATUS_LABELS[status] ?? status.replaceAll("-", " ")}
      </span>
      {origin === "schedule" ? (
        <span className="work-origin-badge" data-origin="schedule">
          Scheduled
        </span>
      ) : null}
    </span>
  );
}