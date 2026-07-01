import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition, WorkflowRun } from "@fable/protocol";
import { runWorkflow } from "./runner";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "wf-1",
  version: 1,
  name: "Brief",
  description: "test",
  steps: [
    { kind: "prompt", id: "prompt", prompt: "Summarize" },
    { kind: "tool", id: "write", tool: "write-file", arguments: { path: "brief.md" }, consequential: true }
  ],
  createdAt: "2026-06-28T00:00:00Z",
  updatedAt: "2026-06-28T00:00:00Z"
};

function dependencies(persisted: WorkflowRun[]) {
  const now = new Date("2026-06-28T10:00:00Z");
  return {
    now: () => now,
    persist: async (run: WorkflowRun) => void persisted.push(structuredClone(run)),
    connected: () => true,
    prompt: vi.fn(async () => "summary"),
    connectorRead: vi.fn(async () => ({})),
    connectorWrite: vi.fn(async () => ({ id: "created" })),
    agent: vi.fn(async () => "agent"),
    tool: vi.fn(async () => "written")
  };
}

describe("workflow runner", () => {
  it("pauses immediately before a consequential tool and resumes once with fresh approval", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const paused = await runWorkflow(definition, { runId: "run-1", trigger: "schedule" }, deps);
    expect(paused.status).toBe("awaiting-approval");
    expect(deps.tool).not.toHaveBeenCalled();

    const completed = await runWorkflow(
      definition,
      {
        runId: "run-1",
        trigger: "schedule",
        previous: paused,
        approvals: {
          write: {
            decision: "approved",
            decidedAt: "2026-06-28T09:59:59Z",
            expiresAt: "2026-06-28T10:05:00Z"
          }
        }
      },
      deps
    );
    expect(completed.status).toBe("completed");
    expect(deps.prompt).toHaveBeenCalledTimes(1);
    expect(deps.tool).toHaveBeenCalledTimes(1);
    expect((deps.tool.mock.calls as unknown[][])[0][1]).toMatch(/^wf:run-1:write:/);
  });

  it("does not execute with expired approval or a disconnected requirement", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const expired = await runWorkflow(
      definition,
      {
        runId: "run-expired",
        trigger: "manual",
        approvals: {
          write: {
            decision: "approved",
            decidedAt: "2026-06-28T09:00:00Z",
            expiresAt: "2026-06-28T09:05:00Z"
          }
        }
      },
      deps
    );
    expect(expired.status).toBe("awaiting-approval");
    expect(deps.tool).not.toHaveBeenCalled();
  });

  it("revalidates the captured permission profile when a scheduled run starts", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const blocked = await runWorkflow(
      {
        ...definition,
        permissionProfile: "read-only",
        steps: [{ kind: "prompt", id: "prompt", prompt: "Summarize" }]
      },
      { runId: "run-blocked", trigger: "schedule" },
      deps
    );

    expect(blocked.status).toBe("failed");
    expect(blocked.steps[0]).toMatchObject({
      stepId: "__run__",
      errorCode: "permission-denied"
    });
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("stores structured connector results without connector credentials", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    deps.connectorRead.mockResolvedValue({
      items: [{ id: "issue-1" }],
      token: "ghp_supersecret"
    });
    const connectorDefinition: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          kind: "connector-read",
          id: "issues",
          connectorId: "github",
          capability: "search",
          input: { query: "is:open" },
          outputVar: "issues"
        }
      ]
    };

    const completed = await runWorkflow(
      connectorDefinition,
      { runId: "run-connector", trigger: "manual" },
      deps
    );

    expect(completed.status).toBe("completed");
    expect(completed.steps[0].output).toEqual({
      connectorId: "github",
      capability: "search",
      response: {
        items: [{ id: "issue-1" }],
        token: "[REDACTED]"
      }
    });
    expect(completed.input.issues).toEqual({
      items: [{ id: "issue-1" }],
      token: "[REDACTED]"
    });
  });

  it("cancels before the next task through an AbortSignal", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const controller = new AbortController();
    controller.abort();

    const cancelled = await runWorkflow(
      definition,
      { runId: "run-cancelled", trigger: "manual", signal: controller.signal },
      deps
    );

    expect(cancelled.status).toBe("cancelled");
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("routes connector writes through the injected connector boundary with a stable idempotency key", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const writeDefinition: WorkflowDefinition = {
      ...definition,
      steps: [
        {
          kind: "connector-write",
          id: "create",
          connectorId: "linear",
          capability: "create-issue",
          input: { title: "Follow up" },
          target: "ENG",
          preview: "Create issue",
          riskLevel: "high"
        }
      ]
    };

    const completed = await runWorkflow(
      writeDefinition,
      { runId: "run-write", trigger: "manual" },
      deps
    );

    expect(completed.status).toBe("completed");
    expect(deps.connectorWrite).toHaveBeenCalledWith(
      writeDefinition.steps[0],
      expect.stringMatching(/^wf:run-write:create:/),
      undefined
    );
  });
});
