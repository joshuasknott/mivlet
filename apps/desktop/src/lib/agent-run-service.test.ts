import type { AgentBackend } from "@mivlet/connectors";
import type {
  BackendAgentEvent,
  BackendModel,
  BackendProvider,
  MivletAgentProfile,
} from "@mivlet/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backend: null as AgentBackend | null,
  saved: [] as Array<Record<string, unknown>>,
  records: [] as Array<Record<string, unknown>>,
  checkpoints: [] as Array<{ content: string; terminal?: boolean }>,
  request: null as Record<string, unknown> | null,
  options: null as Record<string, unknown> | null,
  cancelled: [] as string[],
  scopeWorkspaceId: "default",
  createThread: vi.fn(async () => ({ id: "thread-scheduled" })),
}));

vi.mock("@mivlet/connectors", () => ({
  resolveAgentBackend: () => mocks.backend,
}));
vi.mock("../hooks/useDurableConversation", () => ({
  createDesktopDurableRunWriter: () => ({
    record: async (record: Record<string, unknown>) => {
      mocks.records.push(record);
    },
    checkpointAssistant: async (content: string, terminal?: boolean) => {
      mocks.checkpoints.push({ content, terminal });
    },
  }),
}));
vi.mock("../runtime/domains/conversations", () => ({
createRuntimeConversationThread: mocks.createThread
}));
vi.mock("../runtime/domains/providers", () => ({
listRuntimeBackendModels: async () => null
}));
vi.mock("../runtime/domains/workspace", () => ({
saveRuntimeExecutionAttempt: async (attempt: Record<string, unknown>) => {
    mocks.saved.push(structuredClone(attempt));
    return attempt;
  }
}));
vi.mock("../runtime-scope", () => ({
  getActiveRuntimeDataScope: () => ({ workspaceId: mocks.scopeWorkspaceId }),
}));
vi.mock("./codex-app-server", () => ({ createDesktopCodexAppServer: vi.fn() }));
vi.mock("./native-transport", () => ({ createDesktopTransport: vi.fn() }));
vi.mock("./antigravity-acp", () => ({ createDesktopAntigravityAcp: vi.fn() }));
vi.mock("./managed-runtime", () => ({ createDesktopManagedRuntime: vi.fn() }));

import { AgentRunService } from "./agent-run-service";

const provider = {
  id: "codex",
  backendType: "codex-app-server",
  authState: "connected",
  capabilities: [
    "authentication",
    "streaming",
    "threads",
    "tool-requests",
    "approvals",
  ],
  models: [
    {
      id: "gpt-test",
      label: "GPT Test",
      available: true,
      capabilities: { streaming: true, contextWindow: 32_768 },
    },
  ],
} as BackendProvider;
const modelDefinition = provider.models[0] as BackendModel;
const agent = {
  id: "researcher",
  name: "Researcher",
  instructions: "Research carefully.",
  modelId: "gpt-test",
  icon: "agent",
  iconColor: "blue",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
} as MivletAgentProfile;

function backendFor(events: BackendAgentEvent[]): AgentBackend {
  return {
    backend: provider,
    providerId: provider.id,
    capabilities: provider.capabilities,
    run: (request, options) => {
      mocks.request = request as unknown as Record<string, unknown>;
      mocks.options = options as unknown as Record<string, unknown>;
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    cancel: async (attemptId) => {
      mocks.cancelled.push(attemptId);
    },
  };
}

function input(onQueued = vi.fn(async () => undefined)) {
  return {
    attemptId: "schedule-run-occurrence-1",
    workspaceId: "default",
    scheduleId: "schedule-1",
    occurrenceId: "occurrence-1",
    prompt: "Find the latest official release notes.",
    providerId: "codex",
    model: "gpt-test",
    agent,
    provider,
    modelDefinition,
    onQueued,
    isCurrent: () => true,
  };
}

describe("AgentRunService scheduled research", () => {
  beforeEach(() => {
    mocks.saved = [];
    mocks.records = [];
    mocks.checkpoints = [];
    mocks.request = null;
    mocks.options = null;
    mocks.cancelled = [];
    mocks.scopeWorkspaceId = "default";
    mocks.createThread.mockReset();
    mocks.createThread.mockResolvedValue({ id: "thread-scheduled" });
  });

  it("binds a durable queued attempt before a tool-free Codex web research run", async () => {
    mocks.backend = backendFor([
      {
        type: "provider-tool",
        callId: "web-1",
        tool: "web-search",
        arguments: '{"query":"release notes"}',
        status: "running",
      },
      {
        type: "provider-tool",
        callId: "web-1",
        tool: "web-search",
        arguments: '{"query":"release notes"}',
        status: "succeeded",
        output: "Official result",
      },
      { type: "text-delta", text: "The release is available." },
      { type: "done", finishReason: "stop" },
    ]);
    const onQueued = vi.fn(async () => undefined);
    const result = await new AgentRunService().runScheduledResearch(
      input(onQueued),
    );

    expect(result.terminal).toBe("completed");
    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "schedule-run-occurrence-1",
        status: "queued",
        threadId: "thread-scheduled",
      }),
    );
    expect(mocks.request).toMatchObject({ model: "gpt-test", tools: [] });
    expect(mocks.options).toMatchObject({
      permissionMode: "read-only",
      attemptId: "schedule-run-occurrence-1",
    });
    expect(mocks.saved.at(-1)).toMatchObject({
      status: "completed",
      transcript: "The release is available.",
    });
    expect(mocks.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user" }),
        expect.objectContaining({ kind: "tool-call", toolName: "web-search" }),
        expect.objectContaining({
          kind: "tool-result",
          toolName: "web-search",
          ok: true,
        }),
      ]),
    );
  });

  it("interrupts and reports needs-user when any approval-bearing tool appears", async () => {
    mocks.backend = backendFor([
      {
        type: "tool-call",
        callId: "shell-1",
        tool: "run-shell",
        arguments: "{}",
        approval: {
          id: "approval-1",
          service: "codex",
          action: "run-shell",
          mode: "full-access",
          consequence: "Run a command.",
          confirmationPhrase: "approve",
          riskLevel: "high",
          dataUsed: [],
          requestedAt: "2026-09-07T12:00:00.000Z",
          decisions: ["once", "deny"],
        },
      },
    ]);
    const result = await new AgentRunService().runScheduledResearch(input());

    expect(result.terminal).toBe("needs-user");
    expect(result.attempt.status).toBe("interrupted");
    expect(result.message).toContain("needs your approval");
    expect(mocks.cancelled).toEqual(["schedule-run-occurrence-1"]);
    expect(mocks.saved.at(-1)).toMatchObject({ status: "interrupted" });
  });

  it("does not persist a prompt or start egress after its mount generation changes", async () => {
    let resolveThread!: (value: { id: string }) => void;
    mocks.createThread.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveThread = resolve;
      }),
    );
    mocks.backend = backendFor([{ type: "done", finishReason: "stop" }]);
    let current = true;
    const onThreadCreated = vi.fn();
    const run = new AgentRunService().runScheduledResearch({
      ...input(),
      isCurrent: () => current,
      onThreadCreated,
    });
    current = false;
    resolveThread({ id: "thread-stale" });

    await expect(run).rejects.toThrow("workspace changed");
    expect(onThreadCreated).not.toHaveBeenCalled();
    expect(mocks.saved).toEqual([]);
    expect(mocks.records).toEqual([]);
    expect(mocks.request).toBeNull();
  });
});
