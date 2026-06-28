import { describe, expect, it } from "vitest";
import { addNotificationToHistory, shapeWorkflowNotification } from "./shape";

const run = {
  id: "run-1",
  definitionId: "wf-private",
  definitionVersion: 1,
  status: "failed" as const,
  trigger: "schedule" as const,
  input: { privatePrompt: "Acquisition target" },
  steps: [],
  failureReason: "Secret provider response",
  startedAt: "2026-06-28T10:00:00Z",
  updatedAt: "2026-06-28T10:01:00Z"
};

describe("workflow notifications", () => {
  it("keeps OS bodies private and honors disabled preferences", () => {
    const record = shapeWorkflowNotification({
      id: "n-1",
      kind: "run-failed",
      run,
      prefs: { disableOs: true, enabledKinds: ["run-failed"] },
      createdAt: "2026-06-28T10:01:00Z"
    });
    expect(record.body).not.toContain("Acquisition");
    expect(record.body).not.toContain("Secret");
    expect(record.suppressed).toBe(true);
  });

  it("deduplicates bounded in-app history", () => {
    const record = shapeWorkflowNotification({
      id: "n-1",
      kind: "run-failed",
      run,
      createdAt: "2026-06-28T10:01:00Z"
    });
    expect(addNotificationToHistory([record], record)).toHaveLength(1);
  });
});
