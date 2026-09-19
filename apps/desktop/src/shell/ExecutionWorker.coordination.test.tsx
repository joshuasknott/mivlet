import { act, cleanup, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalRequest,
  BackendProvider,
  CollaborationWorkItem,
  LocalProject,
  MivletAgentProfile,
} from "@mivlet/protocol";
import type { ShellRuntime } from "../hooks/useShellRuntime";

const harness = vi.hoisted(() => {
  const run = vi.fn(async (_request: unknown, _context: unknown, _mode: unknown, _unused: unknown, control: { afterAttemptQueued?: (context: { attemptId: string; threadId: string }) => Promise<void> }) => {
    await control.afterAttemptQueued?.({ attemptId: "attempt-lead", threadId: "conversation-direct" });
    return { status: "completed" };
  });
  const controller = {
    agent: {
      state: { status: "idle", running: false, lastError: null },
      run,
    },
    localComputer: {
      refreshFiles: vi.fn(async () => ({ entries: [] })),
    },
    resetCancellation: vi.fn(),
    beginConnectorTurn: vi.fn(async () => ({ ids: [], tools: [] })),
    endConnectorTurn: vi.fn(),
    stopCurrentWork: vi.fn(async () => true),
  };
  return {
    controller,
    run,
    prepareExecutionAttachments: vi.fn(async (attachments: unknown[]) => ({
      attachments,
      batch: undefined,
      node: undefined,
    })),
    resolveWorkAttachments: vi.fn(
      (_sessionAttachments?: unknown[], _work?: unknown): { attachments: unknown[] } => ({
        attachments: [],
      }),
    ),
    options: undefined as { wrapExecutor: (base: (approval: ApprovalRequest, args: string) => Promise<string>) => (approval: ApprovalRequest, args: string) => Promise<string> } | undefined,
  };
});

vi.mock("./useExecutionController", () => ({
  useExecutionController: (options: typeof harness.options) => {
    harness.options = options;
    return harness.controller;
  },
}));

vi.mock("../lib/attachment-previews", () => ({
  retainAttachmentPreviews: vi.fn(),
}));

vi.mock("../lib/collaboration-context", () => ({
  attributeConversation: (history: unknown) => history,
  collaborationContext: (work: CollaborationWorkItem) =>
    `Configured agent ${work.agentName} instructions are scoped to this request.`,
}));

vi.mock("../lib/agent-run", () => ({
  buildAgentRequest: (input: unknown) => input,
  validateModelSelection: () => ({ ok: true, maxTokens: 4096 }),
}));

vi.mock("../lib/agent-learning", () => ({
  agentExecutionInstructions: (profile: MivletAgentProfile) =>
    `Profile instructions: ${profile.instructions ?? ""}`,
}));

vi.mock("../lib/conversation-presentation", () => ({
  CONVERSATION_STYLE_INSTRUCTIONS: "Keep the response concise.",
}));

vi.mock("../lib/computer-tools", () => ({
  computerToolsReady: () => false,
  conversationToolsForModel: () => [],
  COMPUTER_WORK_INSTRUCTIONS: "Computer tools are unavailable.",
}));

vi.mock("../lib/builtin-plugins", () => ({
  builtinPluginInstructions: () => "",
}));

vi.mock("../lib/composer-images", () => ({
  composerImageInputs: () => ({ ok: true, images: [] }),
}));

vi.mock("../lib/execution-attachments", () => ({
  prepareExecutionAttachments: (attachments: unknown[]) => harness.prepareExecutionAttachments(attachments),
  attachmentMessageMetadata: () => [],
  attachmentRunInstructions: () => "",
  missingRestagedPaths: () => [],
  resolveWorkAttachments: (sessionAttachments: unknown[], work: unknown) =>
    harness.resolveWorkAttachments(sessionAttachments, work),
}));

vi.mock("../runtime/domains/local-computer", () => ({
  discardRuntimeLocalComputerAttachmentBatch: vi.fn(async () => undefined),
}));

import { collaborationToolSpecs } from "@mivlet/connectors/native-api/tools";
import { providerModelOptions, type ProviderModelOption } from "../lib/provider-models";
import { ExecutionWorker } from "./ExecutionWorker";

const provider: BackendProvider = {
  id: "fixture",
  label: "Fixture Provider",
  description: "A provider used by the coordination harness.",
  backendType: "native-api",
  authState: "connected",
  capabilities: ["streaming", "tool-requests", "approvals"],
  models: [
    { id: "lead-model", label: "Lead model", available: true, capabilities: { tools: true } },
    { id: "review-model", label: "Review model", available: true, capabilities: { tools: true } },
  ],
};
const modelOptions = providerModelOptions([{ provider, models: provider.models }]);

function profile(id: string, name: string, instructions: string, modelId: string): MivletAgentProfile {
  return {
    id,
    name,
    instructions,
    modelId: `fixture::${modelId}`,
    permissionLabel: "Ask Me",
    learnedTasks: [],
    icon: "agent",
    iconColor: "#64748b",
    connectorIds: [],
    knowledgeSourceIds: [],
  } as unknown as MivletAgentProfile;
}

function work(
  projectId?: string,
  agentId = "lead",
  agentName = "Lead",
  modelId = "lead-model",
): CollaborationWorkItem {
  return {
    id: "work-lead",
    rootId: "work-lead",
    workspaceId: "workspace-local",
    conversationId: "conversation-direct",
    projectId,
    agentId,
    agentName,
    prompt: "Review the implementation",
    userRequest: "Review the implementation",
    status: "queued",
    dependencies: [],
    waitingFor: [],
    prerequisites: [],
    awaitingUser: false,
    generation: 1,
    conversationGeneration: 1,
    contextRevision: 0,
    depth: 0,
    turnCount: 0,
    tokenUsage: 0,
    maxTurns: 6,
    maxTokens: 4096,
    runIds: [],
    modelOptionId: `fixture::${modelId}`,
    outputs: [],
    permissionMode: "trusted-scope",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

function runtime(activeProvider: BackendProvider = provider): ShellRuntime {
  const activeModelOptions = providerModelOptions([{ provider: activeProvider, models: activeProvider.models }]);
  return {
    accountWorkspacePending: false,
    backendProviders: [activeProvider],
    modelOptions: activeModelOptions,
    agents: [
      profile("lead", "Lead", "LEAD_PRIVATE_INSTRUCTIONS", "lead-model"),
      profile("reviewer", "Reviewer", "REVIEWER_PRIVATE_INSTRUCTIONS", "review-model"),
    ],
    openApprovals: [],
    clearBackendToolApprovals: vi.fn(),
    accountWorkspaceStatus: { state: "ready", accountBound: true, activeWorkspace: { source: "local", localWorkspaceId: "workspace-local" } },
    assembleConversationContext: vi.fn(async () => ({ messages: [{ role: "user", content: "CURRENT_REQUEST_ONLY" }] })),
    recordBackendToolCall: vi.fn(),
  } as unknown as ShellRuntime;
}

function makeHarness(options: {
  projectId?: string;
  projectMembers?: string[];
  agentId?: string;
} = {}) {
  const agentId = options.agentId ?? "lead";
  const agentName = agentId === "reviewer" ? "Reviewer" : "Lead";
  const modelId = agentId === "reviewer" ? "review-model" : "lead-model";
  let current = true;
  const snapshot = {
    data: {
      conversations: [{
        id: "conversation-direct",
        workspaceId: "workspace-local",
        kind: "direct",
        title: "Direct conversation",
        projectId: options.projectId,
        participants: [{ agentId: "lead", name: "Lead" }],
        revision: 1,
        generation: 1,
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z",
      }],
      authors: [],
      teams: options.projectId ? [{ projectId: options.projectId, leadAgentId: "lead", participantIds: options.projectMembers ?? ["lead"], revision: 1 }] : [],
      work: [work(options.projectId, agentId, agentName, modelId)],
      facts: [],
      layout: null,
    },
  };
  const commands: unknown[] = [];
  const service = {
    workspaceId: "workspace-local",
    approvals: { acquire: vi.fn(() => ({})) },
    current: vi.fn(() => current),
    getSnapshot: vi.fn(() => snapshot),
    command: vi.fn(async (command: unknown) => {
      commands.push(command);
      return snapshot.data;
    }),
    publish: vi.fn(),
    approval: vi.fn(),
    released: vi.fn(async () => undefined),
    report: vi.fn(),
  };
  const session = {
    key: "work-lead:1:0",
    work: work(options.projectId, agentId, agentName, modelId),
    profile: profile(agentId, agentName, agentId === "reviewer" ? "REVIEWER_PRIVATE_INSTRUCTIONS" : "LEAD_PRIVATE_INSTRUCTIONS", modelId),
    model: modelOptions.find((option) => option.id === `fixture::${modelId}`) as ProviderModelOption,
    permissionMode: "trusted-scope",
    attachments: [],
    cancelled: false,
    started: false,
    approvalIds: new Set<string>(),
  };
  return { service, session, commands, setCurrent: (value: boolean) => { current = value; } };
}

async function renderWorker(options: {
  projectId?: string;
  projectMembers?: string[];
  agentId?: string;
  activeProvider?: BackendProvider;
  projects?: LocalProject[];
} = {}) {
  const setup = makeHarness(options);
  const activeRuntime = runtime(options.activeProvider);
  await act(async () => {
    render(
      <ExecutionWorker
        session={setup.session as never}
        service={setup.service as never}
        runtime={activeRuntime}
        projects={options.projects ?? []}
      />,
    );
  });
  await waitFor(() => expect(harness.run).toHaveBeenCalled());
  return { ...setup, runtime: activeRuntime };
}

function approval(tool: string, id = "call-1"): ApprovalRequest {
  return {
    id,
    service: "fixture",
    action: `${tool} call`,
    mode: "read-only",
    riskLevel: "low",
    dataUsed: [],
    consequence: `Execute ${tool}`,
    requestedAt: new Date(0).toISOString(),
    decisions: ["once", "deny"],
  };
}

describe("ExecutionWorker coordination reachability", () => {
  beforeEach(() => {
    harness.run.mockClear();
    harness.options = undefined;
    harness.resolveWorkAttachments.mockReset();
    harness.resolveWorkAttachments.mockReturnValue({ attachments: [] });
  });
  afterEach(() => {
    cleanup();
  });

  it("advertises collaboration tools in an ordinary direct conversation and scopes the recipient run", async () => {
    const setup = await renderWorker();
    const request = harness.run.mock.calls[0]?.[0] as { model: string; instructions: string; tools: Array<{ name: string }> };
    expect(request.model).toBe("lead-model");
    expect(request.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(collaborationToolSpecs(false).map((tool) => tool.name)),
    );
    expect(request.instructions).toContain("LEAD_PRIVATE_INSTRUCTIONS");
    expect(request.instructions).not.toContain("REVIEWER_PRIVATE_INSTRUCTIONS");
    expect(setup.service.command).toHaveBeenCalledWith(expect.objectContaining({ action: "bind-work" }));
    expect(setup.runtime.assembleConversationContext).toHaveBeenCalledWith(
      "Review the implementation",
      expect.objectContaining({ threadId: "conversation-direct" }),
    );
    const context = harness.run.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> };
    expect(context.messages?.map((message) => message.content)).toEqual(["CURRENT_REQUEST_ONLY"]);
    expect(JSON.stringify(context)).not.toContain("UNRELATED");
  });

  it("maps teammate-message to the durable task-scoped native command", async () => {
    const setup = await renderWorker();
    const execute = harness.options!.wrapExecutor(async () => "base");
    await execute(
      approval("teammate-message"),
      JSON.stringify({ assignmentId: "work-reviewer", message: "Please clarify the failing test.", question: true }),
    );
    expect(setup.commands).toContainEqual(expect.objectContaining({
      action: "agent-command",
      command: {
        kind: "message",
        assignmentId: "work-reviewer",
        message: "Please clarify the failing test.",
        question: true,
      },
    }));
  });

  it("returns safe workspace-agent metadata without private profile material", async () => {
    const setup = await renderWorker();
    const execute = harness.options!.wrapExecutor(async () => "base");
    const output = JSON.parse(await execute(approval("workspace-agents"), "{}")) as {
      instructionAuthority: string;
      agents: Array<Record<string, unknown>>;
    };
    expect(output.instructionAuthority).toBe("none");
    expect(output.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "reviewer", name: "Reviewer", available: true }),
    ]));
    expect(JSON.stringify(output)).not.toContain("PRIVATE_INSTRUCTIONS");
    expect(setup.commands).toContainEqual(expect.objectContaining({
      action: "check-work",
      id: "work-lead",
      generation: 1,
      runId: "attempt-lead",
    }));
  });

  it("refuses a stale or cancelled turn before dispatching collaboration work", async () => {
    const setup = await renderWorker();
    const execute = harness.options!.wrapExecutor(async () => "base");
    setup.setCurrent(false);
    await expect(execute(
      approval("teammate-message", "stale-call"),
      JSON.stringify({ assignmentId: "work-reviewer", message: "late", question: false }),
    )).rejects.toThrow(/stopped before the tool could run/i);
    expect(setup.commands).not.toContainEqual(expect.objectContaining({
      action: "agent-command",
      callId: "stale-call",
    }));
  });

  it("reserves a file resource before the write executor and rechecks the native assignment", async () => {
    const setup = await renderWorker();
    const order: string[] = [];
    const base = vi.fn(async () => {
      order.push("write-executor");
      return "saved";
    });
    const execute = harness.options!.wrapExecutor(base);
    await execute(
      approval("write-file", "write-call"),
      JSON.stringify({ path: "reports/output.md", content: "result" }),
    );
    const resourceIndex = setup.commands.findIndex((command) =>
      JSON.stringify(command).includes('"callId":"write-call:resource"'),
    );
    expect(resourceIndex).toBeGreaterThanOrEqual(0);
    expect(base).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["write-executor"]);
    expect(setup.commands.slice(resourceIndex + 1)).toContainEqual(
      expect.objectContaining({ action: "check-work", id: "work-lead", runId: "attempt-lead" }),
    );
  });

  it("keeps project knowledge sources for members and only explicit attachments for workspace outsiders", async () => {
    const project: LocalProject = {
      id: "project-1",
      workspaceId: "workspace-local",
      name: "Project",
      instructions: "Project instructions",
      knowledgeSourceIds: ["project-source"],
      shares: [],
      threadId: "conversation-direct",
      revision: 1,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    const selectedAttachment = {
      id: "attachment-brief",
      name: "brief.md",
      type: "text/markdown",
      sizeBytes: 128,
      sourceId: "explicit-source",
    };
    harness.resolveWorkAttachments.mockReturnValue({ attachments: [selectedAttachment] });
    const outsider = await renderWorker({
      projectId: project.id,
      projectMembers: ["lead"],
      agentId: "reviewer",
      projects: [project],
    });
    const outsiderContext = (outsider.runtime.assembleConversationContext as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      allowedKnowledgeSourceIds: string[];
    };
    expect(outsiderContext.allowedKnowledgeSourceIds).toEqual(["explicit-source"]);
    expect((harness.run.mock.calls.at(-1)?.[0] as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).not.toContain("project-record");
    cleanup();

    harness.resolveWorkAttachments.mockReturnValue({ attachments: [selectedAttachment] });
    const member = await renderWorker({
      projectId: project.id,
      projectMembers: ["lead"],
      agentId: "lead",
      projects: [project],
    });
    const memberContext = (member.runtime.assembleConversationContext as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      allowedKnowledgeSourceIds: string[];
    };
    expect(memberContext.allowedKnowledgeSourceIds).toEqual(["project-source", "explicit-source"]);
    expect((harness.run.mock.calls.at(-1)?.[0] as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toContain("project-record");
  });

  it("does not advertise collaboration when the provider lacks approval support", async () => {
    const noApprovals = {
      ...provider,
      capabilities: provider.capabilities.filter((capability) => capability !== "approvals"),
    } satisfies BackendProvider;
    await renderWorker({ activeProvider: noApprovals });
    const request = harness.run.mock.calls[0]?.[0] as { tools: Array<{ name: string }> };
    expect(request.tools.map((tool) => tool.name)).not.toContain("workspace-agents");
    expect(request.tools.map((tool) => tool.name)).not.toContain("teammate-message");
  });
});
