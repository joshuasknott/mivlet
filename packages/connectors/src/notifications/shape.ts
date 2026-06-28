import type {
  NotificationKind,
  NotificationPrefs,
  NotificationRecord,
  WorkflowRun
} from "@fable/protocol";

const TITLES: Record<NotificationKind, string> = {
  "run-completed": "Workflow completed",
  "run-failed": "Workflow needs attention",
  "approval-needed": "Workflow approval needed"
};

export function shapeWorkflowNotification(input: {
  id: string;
  kind: NotificationKind;
  run: WorkflowRun;
  prefs?: NotificationPrefs;
  createdAt: string;
}): NotificationRecord {
  const enabled =
    !input.prefs?.disableOs &&
    (input.prefs?.enabledKinds ?? ["run-completed", "run-failed", "approval-needed"]).includes(
      input.kind
    );
  return {
    id: input.id,
    kind: input.kind,
    runId: input.run.id,
    definitionId: input.run.definitionId,
    title: TITLES[input.kind],
    // Deliberately generic: prompts, connector data, file names, and failures
    // stay in the in-app run history instead of the OS lock screen.
    body: "Open Fable to review this workflow.",
    suppressed: !enabled,
    createdAt: input.createdAt,
    deepLink: { page: "Schedules", runId: input.run.id },
    delivered: false
  };
}

export function addNotificationToHistory(
  history: NotificationRecord[],
  record: NotificationRecord,
  limit = 200
): NotificationRecord[] {
  return [record, ...history.filter((entry) => entry.id !== record.id)].slice(0, limit);
}
