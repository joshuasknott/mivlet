import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition, WorkflowRun } from "@fable/protocol";
import { runWorkflow } from "./runner";
import { createWorkflowConnectorRead, createWorkflowConnectorWrite } from "./connector-executor";
import { ConnectorRuntime, type ConnectorAdapter, type ConnectorAccountSession, type ConnectorApprovalBoundary } from "../sdk";

describe("Workflow + Connector Integration", () => {
  const mockApprovals: ConnectorApprovalBoundary = {
    approve: async (rec) => ({ ...rec, result: "approved", decidedAt: new Date().toISOString() }),
    complete: async () => {}
  };

  const runtime = new ConnectorRuntime({ approvals: mockApprovals });

  const mockGithubAdapter = {
    id: "github",
    capabilities: [
      { id: "search", kind: "read", consequence: "Search consequence" },
      { id: "create-issue", kind: "write", consequence: "Create consequence", consequential: true }
    ],
    startAuth: async () => ({ authorizationUrl: "", state: "" }),
    completeAuth: async () => ({ tokens: { accessToken: "sk-token" }, account: { id: "user-1" } }),
    refresh: async (t: any) => t,
    revoke: async () => {},
    read: async (req: any) => {
      if (req.capability === "search") {
        return {
          items: [{ id: "issue-1", secretToken: "supersecret-ghp-token" }]
        } as any;
      }
      throw new Error("not supported");
    },
    write: async (req: any) => {
      if (req.capability === "create-issue") {
        return {
          id: "created-1",
          clientSecret: "sk-leaked-123"
        } as any;
      }
      throw new Error("not supported");
    }
  } as any as ConnectorAdapter;

  runtime.register(mockGithubAdapter);

  const session = {
    connectorId: "github",
    account: { id: "user-1" },
    tokens: { accessToken: "sk-token", tokenType: "bearer", scopes: [] }
  } as any as ConnectorAccountSession;

  const boundary = {
    runtime,
    sessionFor: (id: string) => (id === "github" ? session : undefined)
  };

  const definition = {
    schemaVersion: 1,
    id: "wf-integration",
    version: 1,
    name: "Integration Workflow",
    description: "Workflow under test",
    steps: [
      {
        kind: "connector-read",
        id: "read-step",
        connectorId: "github",
        capability: "search",
        input: { query: "is:open" },
        outputVar: "read_res"
      },
      {
        kind: "connector-write",
        id: "write-step",
        connectorId: "github",
        capability: "create-issue",
        input: { title: "Test issue" },
        target: "repo",
        preview: "Creating a test issue",
        riskLevel: "high",
        outputVar: "write_res"
      }
    ]
  } as any as WorkflowDefinition;

  function dependencies(persisted: WorkflowRun[]) {
    return {
      now: () => new Date("2026-06-28T10:00:00Z"),
      persist: async (run: WorkflowRun) => void persisted.push(structuredClone(run)),
      connected: (id: string): boolean => id === "github",
      prompt: vi.fn(),
      connectorRead: createWorkflowConnectorRead(boundary),
      connectorWrite: createWorkflowConnectorWrite(boundary),
      agent: vi.fn(),
      tool: vi.fn()
    };
  }

  it("successfully executes connector tasks using the mock ConnectorRuntime", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const completed = await runWorkflow(definition, { runId: "run-integration", trigger: "manual" }, deps as any);

    expect(completed.status).toBe("completed");
    expect(completed.steps).toHaveLength(2);
    expect(completed.steps[0].status).toBe("succeeded");
    expect(completed.steps[1].status).toBe("succeeded");
  });

  it("redacts sensitive credentials from the connector task results and inputs", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    const completed = await runWorkflow(definition, { runId: "run-redacted", trigger: "manual" }, deps as any);

    // Read result has token in output
    const readStep = completed.steps[0];
    expect(readStep.output).toEqual({
      connectorId: "github",
      capability: "search",
      response: {
        items: [{ id: "issue-1", secretToken: "[REDACTED]" }]
      }
    });

    // Write result has confidential key in output
    const writeStep = completed.steps[1];
    expect(writeStep.output).toEqual({
      connectorId: "github",
      capability: "create-issue",
      response: {
        id: "created-1",
        clientSecret: "[REDACTED]"
      }
    });

    // Input state is also sanitized
    expect(completed.input.read_res).toEqual({
      items: [{ id: "issue-1", secretToken: "[REDACTED]" }]
    });
    expect(completed.input.write_res).toEqual({
      id: "created-1",
      clientSecret: "[REDACTED]"
    });
  });

  it("raises an error when executing a connector task for a disconnected connector", async () => {
    const persisted: WorkflowRun[] = [];
    const deps = dependencies(persisted);
    deps.connected = (id: string) => false;

    const failed = await runWorkflow(definition, { runId: "run-disconnected", trigger: "manual" }, deps as any);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toContain("must be connected before this step can run");
  });
});
