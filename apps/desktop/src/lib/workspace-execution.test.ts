import { describe, expect, it, vi } from "vitest";
import type {
  BackendProvider,
  CollaborationSnapshot,
  CollaborationWorkItem,
  MivletAgentProfile,
} from "@mivlet/protocol";
import {
  WorkspaceExecution,
  restrictedPermission,
  enqueueWorkspaceDispose,
} from "./workspace-execution";
import { providerModelOptions } from "./provider-models";

const reads = vi.hoisted(() => ({ load: vi.fn(async () => null) }));
vi.mock("../hooks/useDurableConversation", () => ({
  loadDesktopConversation: reads.load,
}));

const fixtureWork = (
  id: string,
  agentId = id,
  patch: Partial<CollaborationWorkItem> = {},
): CollaborationWorkItem => ({
  id,
  agentId,
  agentName: agentId,
  workspaceId: "fixture",
  conversationId: `conversation-${id}`,
  rootId: id,
  permissionMode: "trusted-scope",
  prompt: "Fixture assignment",
  userRequest: "Fixture user request",
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
  maxTurns: 12,
  maxTokens: 64000,
  runIds: [],
  modelOptionId: "fixture::model",
  outputs: [],
  createdAt: "2026-09-12T00:00:00Z",
  updatedAt: "2026-09-12T00:00:00Z",
  ...patch,
});
const provider: BackendProvider = {
  id: "fixture",
  label: "Fixture",
  backendType: "native-api",
  authState: "connected",
  capabilities: ["streaming", "tool-requests"],
  models: [{ id: "model", label: "Fixture model", available: true }],
} as BackendProvider;
const models = providerModelOptions([{ provider, models: provider.models }]);
const agents = ["a", "b", "c", "d"].map(
  (id) =>
    ({
      id,
      name: id,
      modelId: models[0].id,
      instructions: "Fixture",
      permissionLabel: "Ask Me",
    }) as MivletAgentProfile,
);

function fixture(work: CollaborationWorkItem[]) {
  let data: CollaborationSnapshot = {
    conversations: [],
    authors: [],
    teams: [],
    facts: [],
    work,
    layout: null,
  };
  const command = vi.fn(
    async (_workspace: string, input: { action: string }) => {
      if (input.action === "stop-work") {
        const id = (input as { id?: string }).id;
        data = {
          ...data,
          work: data.work.map((work) =>
            work.id === id || work.rootId === id
              ? {
                  ...work,
                  status: "cancelled",
                  generation: work.generation + 1,
                }
              : work,
          ),
        };
      }
      return data;
    },
  );
  const service = new WorkspaceExecution("fixture", {
    load: async () => data,
    command,
  });
  return {
    service,
    command,
    update: (next: CollaborationWorkItem[]) => {
      data = { ...data, work: next };
    },
  };
}

describe("workspace execution (deterministic fixtures, no live provider)", () => {
  it("persists explicit recipient IDs and shares request attachments only within their effort", async () => {
    const { service, command, update } = fixture([]);
    await service.refresh();
    const attachment = { id: "brief", name: "brief.txt", type: "text/plain", sizeBytes: 4, transientBytes: new Uint8Array([1, 2, 3, 4]) };
    const rootId = await service.submit("ordinary", "a", "Review this", false, [attachment], ["a", "b"]);
    expect(command).toHaveBeenCalledWith("fixture", expect.objectContaining({ action: "start-work", conversationId: "ordinary", recipientIds: ["a", "b"] }));
    update([
      fixtureWork(rootId, "a", { status: "waiting", conversationId: "ordinary" }),
      fixtureWork("child", "b", { rootId, parentId: rootId, conversationId: "ordinary" }),
      fixtureWork("other", "c", { conversationId: "ordinary" }),
    ]);
    await service.refresh();
    service.admit(agents, models, [provider], "trusted-scope");
    expect(service.getSnapshot().sessions.find(session => session.work.id === "child")?.attachments).toEqual([attachment]);
    expect(service.getSnapshot().sessions.find(session => session.work.id === "other")?.attachments).toEqual([]);
    await service.dispose();
  });
  it("serializes the same agent across efforts while other participants work independently", async () => {
    const first = fixtureWork("first", "a");
    const second = fixtureWork("second", "a");
    const peer = fixtureWork("peer", "b");
    const { service, update } = fixture([first, second, peer]);
    await service.refresh();
    service.admit(agents, models, [provider], "trusted-scope");
    expect(service.getSnapshot().sessions.map(session => session.work.id)).toEqual(["first", "peer"]);
    const original = service.getSnapshot().sessions[0];
    update([{ ...first, status: "completed", runIds: ["first-run"] }, second, peer]);
    await service.refresh();
    await service.released(original);
    service.admit(agents, models, [provider], "trusted-scope");
    expect(service.getSnapshot().sessions.map(session => session.work.id)).toEqual(["peer", "second"]);
    expect(service.current(original)).toBe(false);
    await service.dispose();
  });
  it("keeps attachments for an unstarted retry and releases them after a durable run", async () => {
    const { service, update } = fixture([]);
    await service.refresh();
    const attachment = { id: "file", name: "brief.txt", type: "text/plain", sizeBytes: 4, transientBytes: new Uint8Array([116, 101, 115, 116]) };
    const id = await service.submit("conversation-a", "a", "Read the brief", false, [attachment]);
    let work = fixtureWork(id, "a", { conversationId: "conversation-a" });
    update([work]); await service.refresh(); service.admit(agents, models, [provider], "trusted-scope");
    const first = service.getSnapshot().sessions[0];
    expect(first.attachments).toEqual([attachment]);
    update([{ ...work, status: "failed" }]); await service.refresh(); await service.released(first);
    work = { ...work, generation: 2 }; update([work]); await service.refresh(); service.admit(agents, models, [provider], "trusted-scope");
    const retry = service.getSnapshot().sessions[0];
    expect(retry.attachments).toEqual([attachment]);
    update([{ ...work, status: "failed", runIds: ["durable-run"] }]); await service.refresh(); await service.released(retry);
    update([{ ...work, generation: 3, runIds: ["durable-run"] }]); await service.refresh(); service.admit(agents, models, [provider], "trusted-scope");
    expect(service.getSnapshot().sessions[0].attachments).toEqual([]);
    service.dispose();
  });
  it("captures durable attachment references with the handoff request", async () => {
    const { service, command } = fixture([]);
    await service.refresh();
    const attachment = {
      id: "file",
      name: "brief.txt",
      type: "text/plain",
      sizeBytes: 4,
      transientBytes: new Uint8Array([116, 101, 115, 116]),
    };
    await service.submit("conversation-a", "a", "Read the brief", false, [
      attachment,
      {
        id: "source",
        name: "catalog.pdf",
        type: "application/pdf",
        sizeBytes: 9,
        sourceId: "knowledge-1",
      },
    ]);
    expect(command).toHaveBeenCalledWith("fixture", {
      action: "start-work",
      id: expect.any(String),
      conversationId: "conversation-a",
      agentId: "a",
      prompt: "Read the brief",
      discussion: false,
      attachments: [
        { id: "file", name: "brief.txt", mimeType: "text/plain", sizeBytes: 4, availability: "transient" },
        { id: "source", name: "catalog.pdf", mimeType: "application/pdf", sizeBytes: 9, availability: "knowledge-context", sourceId: "knowledge-1" },
      ],
    });
    service.dispose();
  });
  it("keeps two same-agent conversations distinct and queues only that agent", async () => {
    const { service } = fixture([
      fixtureWork("one", "a"),
      fixtureWork("two", "a"),
      fixtureWork("three", "b"),
    ]);
    await service.refresh();
    service.admit(agents, models, [provider], "full-access");
    expect(
      service
        .getSnapshot()
        .sessions.map((session) => session.work.conversationId),
    ).toEqual(["conversation-one", "conversation-three"]);
    expect(service.getSnapshot().sessions[0].permissionMode).toBe(
      "trusted-scope",
    );
    const first = service.getSnapshot().sessions[0];
    await service.stop("one");
    await service.released(first);
    service.admit(agents, models, [provider], "full-access");
    expect(
      service.getSnapshot().sessions.map((session) => session.work.id),
    ).toEqual(["three", "two"]);
    service.dispose();
  });
  it("limits native provider concurrency and serializes unsupported providers", async () => {
    const { service } = fixture([
      fixtureWork("one", "a"),
      fixtureWork("two", "b"),
      fixtureWork("three", "c"),
    ]);
    await service.refresh();
    service.admit(
      agents,
      models,
      [{ ...provider, backendType: "claude-agent" } as BackendProvider],
      "read-only",
    );
    expect(service.getSnapshot().sessions).toHaveLength(1);
    service.dispose();
    const parallel = fixture([
      fixtureWork("one", "a"),
      fixtureWork("two", "b"),
      fixtureWork("three", "c"),
    ]).service;
    await parallel.refresh();
    parallel.admit(agents, models, [provider], "full-access");
    expect(parallel.getSnapshot().sessions).toHaveLength(2);
    parallel.dispose();
  });
  it("freezes descendants before awaiting cancellation and leaves unrelated work current", async () => {
    const { service, command } = fixture([
      fixtureWork("root", "a"),
      fixtureWork("child", "b", { rootId: "root", parentId: "root" }),
      fixtureWork("other", "c", { modelOptionId: "other::model" }),
    ]);
    const other = { ...provider, id: "other" };
    await service.refresh();
    service.admit(
      agents,
      [
        ...models,
        ...providerModelOptions([{ provider: other, models: other.models }]),
      ],
      [provider, other],
      "trusted-scope",
    );
    const [root, child, unrelated] = service.getSnapshot().sessions;
    let finish!: () => void;
    root.cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    child.cancel = vi.fn(async () => {});
    unrelated.cancel = vi.fn(async () => {});
    const stopped = service.stop("root");
    expect(service.current(root)).toBe(false);
    expect(service.current(child)).toBe(false);
    expect(service.current(unrelated)).toBe(true);
    expect(unrelated.cancel).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(command).toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "root",
    });
    root.cancel = vi.fn(async () => {});
    service.dispose();
  });
  it("dispose freezes like Stop then issues generation-fenced stop-work for executing work", async () => {
    const { service, command } = fixture([
      fixtureWork("run", "a", { status: "running", generation: 4 }),
      fixtureWork("queued", "b"),
    ]);
    await service.refresh();
    service.admit(agents, models, [provider], "trusted-scope");
    const session = service.getSnapshot().sessions.find((item) => item.work.id === "queued")!;
    let finish!: () => void;
    session.cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const closed = service.dispose();
    expect(service.current(session)).toBe(false);
    expect(service.canSchedule("c", "fixture")).toBe(false);
    await expect(service.refresh()).rejects.toThrow("This workspace has closed.");
    await Promise.resolve();
    expect(command).toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "run",
      expectedGeneration: 4,
    });
    expect(session.cancel).toHaveBeenCalledOnce();
    finish();
    await closed;
    expect(command).not.toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "queued",
    });
    expect(command).not.toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "run",
    });
  });
  it("dispose issues generation-fenced stop-work for executing orphans with no session", async () => {
    const { service, command } = fixture([
      fixtureWork("orphan-run", "a", { status: "running", generation: 3 }),
      fixtureWork("orphan-approval", "b", {
        status: "awaiting-approval",
        generation: 2,
      }),
      fixtureWork("queued", "c"),
    ]);
    await service.refresh();
    expect(service.getSnapshot().sessions).toEqual([]);
    await service.dispose();
    expect(command).toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "orphan-run",
      expectedGeneration: 3,
    });
    expect(command).toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "orphan-approval",
      expectedGeneration: 2,
    });
    expect(command).not.toHaveBeenCalledWith("fixture", {
      action: "stop-work",
      id: "queued",
    });
    expect(command.mock.calls).toHaveLength(2);
  });
  it("rejects stale published streams after a membership generation changes", async () => {
    const { service, update } = fixture([fixtureWork("one", "a")]);
    await service.refresh();
    service.admit(agents, models, [provider], "read-only");
    const session = service.getSnapshot().sessions[0];
    session.cancel = vi.fn(async () => {});
    update([
      fixtureWork("one", "a", { generation: 2, status: "awaiting-user" }),
    ]);
    await service.refresh();
    const revision = service.getSnapshot().revision;
    service.publish(session, { transcript: "late output" } as NonNullable<
      typeof session.state
    >);
    expect(service.getSnapshot().revision).toBe(revision);
    expect(session.cancel).toHaveBeenCalledOnce();
    service.dispose();
  });
  it("does not dispatch restored waiting, failed, or uncertain work", async () => {
    const { service } = fixture([
      fixtureWork("one", "a", { status: "awaiting-user" }),
      fixtureWork("two", "b", { status: "waiting", waitingFor: ["one"] }),
      fixtureWork("three", "c", { status: "failed" }),
    ]);
    await service.refresh();
    service.admit(agents, models, [provider], "full-access");
    expect(service.getSnapshot().sessions).toEqual([]);
    service.dispose();
  });
  it("counts scheduled research against provider capacity and cancels its exact owner", async () => {
    const { service } = fixture([
      fixtureWork("scheduled", "a", { status: "running" }),
      fixtureWork("interactive", "b"),
      fixtureWork("queued", "c"),
    ]);
    const cancel = vi.fn(async () => {});
    service.registerScheduled("scheduled", cancel);
    await service.refresh();
    service.admit(agents, models, [provider], "read-only");
    expect(
      service.getSnapshot().sessions.map((session) => session.work.id),
    ).toEqual(["interactive"]);
    expect(service.canSchedule("a", "fixture")).toBe(false);
    await service.stop("scheduled");
    expect(cancel).toHaveBeenCalled();
    service.dispose();
  });
  it("shares one history read between duplicate views without starting work", async () => {
    const { service, command } = fixture([]);
    reads.load.mockClear();
    await Promise.all([
      service.loadHistory("room"),
      service.loadHistory("room"),
    ]);
    await service.loadHistory("room");
    expect(reads.load).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(service.getSnapshot().sessions).toEqual([]);
    service.dispose();
  });
  it("caps queued work by the recipient's current permissions", async () => {
    const { service } = fixture([fixtureWork("a", "a", { permissionMode: "full-access" })]);
    await service.refresh();
    service.admit([{ ...agents[0], permissionLabel: "Read Only" }], models, [provider], "full-access");
    expect(service.getSnapshot().sessions[0].permissionMode).toBe("read-only");
  });

  it("delegation can only narrow the effective permission mode", () => {
    expect(
      restrictedPermission("full-access", "read-only", "trusted-scope"),
    ).toBe("read-only");
    expect(restrictedPermission("full-access", "trusted-scope")).toBe(
      "trusted-scope",
    );
  });
  it("enqueueWorkspaceDispose waits for the previous owner before the next dispose", async () => {
    let released = false;
    const first = {
      dispose: () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            released = true;
            resolve();
          });
        }),
    };
    const second = {
      dispose: vi.fn(async () => {
        expect(released).toBe(true);
      }),
    };
    const gate = enqueueWorkspaceDispose(Promise.resolve(), first);
    await enqueueWorkspaceDispose(gate, second);
    expect(second.dispose).toHaveBeenCalledOnce();
  });
  it("enqueueWorkspaceDispose ignores a missing owner and a rejected previous close", async () => {
    await expect(
      enqueueWorkspaceDispose(Promise.reject(new Error("prior")), null),
    ).resolves.toBeUndefined();
    const service = { dispose: vi.fn(async () => {}) };
    await enqueueWorkspaceDispose(Promise.reject(new Error("prior")), service);
    expect(service.dispose).toHaveBeenCalledOnce();
  });
});
