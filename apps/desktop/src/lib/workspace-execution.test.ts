import { describe, expect, it, vi } from "vitest";
import type {
  BackendProvider,
  CollaborationSnapshot,
  CollaborationWorkItem,
  FableAgentProfile,
} from "@fable/protocol";
import {
  WorkspaceExecution,
  restrictedPermission,
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
    }) as FableAgentProfile,
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
    service.dispose();
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
  it("delegation can only narrow the effective permission mode", () => {
    expect(
      restrictedPermission("full-access", "read-only", "trusted-scope"),
    ).toBe("read-only");
    expect(restrictedPermission("full-access", "trusted-scope")).toBe(
      "trusted-scope",
    );
  });
});
