import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile, WorkspaceManageRequest, WorkspaceManageResponse } from "@mivlet/protocol";
import { defaultShellState } from "./defaults";
import { shellStateToRuntimeSnapshot } from "../../lib/persistence";
import { useWorkspaceSnapshot } from "./useWorkspaceSnapshot";

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), manage: vi.fn() }));
vi.mock("../../runtime/domains/workspace", () => ({ loadRuntimeSnapshot: api.load, saveRuntimeSnapshot: api.save }));
vi.mock("../../runtime/domains/workspace-management", () => ({ manageWorkspace: api.manage }));

const lead: MivletAgentProfile = { ...defaultShellState.agents![0], modelId: "provider::model" };
const initial = { ...defaultShellState, agents: [lead], activeAgentId: lead.id, agentRevision: 0 };
const request: Omit<WorkspaceManageRequest, "workspaceId" | "expectedAgentRevision"> = {
  workId: "work", generation: 1, runId: "run", callId: "call", tool: "agent-create",
  arguments: '{"name":"Researcher","instructions":"Research"}',
  approval: { request: { id: "call", service: "test", action: "agent-create", mode: "full-access", riskLevel: "high",
    requestedAt: "2026-10-19T12:00:00Z", dataUsed: [], consequence: "Create", decisions: ["once", "deny"] }, decision: "once", decidedAt: "2026-10-19T12:00:00Z" },
};
const response = (): WorkspaceManageResponse => ({
  agents: [lead, { ...lead, id: "researcher", name: "Researcher", instructions: "Research" }], agentRevision: 1, activeAgentId: lead.id,
  collaboration: { conversations: [], authors: [], teams: [], work: [], facts: [], layout: null }, projects: [],
  receipt: { id: "receipt", operation: "create-agent", summary: "Created Researcher", replayed: false },
});
function useHarness() {
  const [state, setState] = useState(initial);
  const [generation, setGeneration] = useState(1);
  const identity = useRef<string | null>("owner:workspace");
  const snapshot = useWorkspaceSnapshot({ shellState: state, workspaceIdentityRef: identity,
    workspaceScopeGeneration: generation, activeWorkspaceScope: { workspaceId: "workspace" },
    onReset: vi.fn(), onHydrate: recovered => setState({ ...recovered, agents: recovered.agents ?? [], activeAgentId: recovered.activeAgentId ?? lead.id, agentRevision: recovered.agentRevision ?? 0 }),
    onAgentsChanged: (agents, agentRevision, activeAgentId) => setState(current => ({ ...current, agents, agentRevision, activeAgentId })),
    setLastAction: vi.fn(),
  });
  return { ...snapshot.runtime, state, setState, setGeneration, identity };
}

describe("chat workspace snapshot writes", () => {
  beforeEach(() => {
    api.load.mockResolvedValue(shellStateToRuntimeSnapshot(initial));
    api.save.mockReset().mockImplementation(async snapshot => snapshot);
    api.manage.mockReset().mockResolvedValue(response());
  });
  afterEach(() => cleanup());

  it("serializes chat mutations with pending snapshot writes and preserves a simultaneous settings edit", async () => {
    let finish!: (result: WorkspaceManageResponse) => void;
    api.manage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    let mutation!: ReturnType<typeof result.current.manageWorkspaceFromChat>;
    act(() => { mutation = result.current.manageWorkspaceFromChat(request); });
    await waitFor(() => expect(api.manage).toHaveBeenCalled());
    act(() => result.current.setState(current => ({ ...current, voiceEnabled: false,
      agents: [{ ...current.agents[0], iconColor: "#123456" }] })));
    let trailing!: Promise<void>;
    act(() => { trailing = result.current.flushSnapshot(); });
    await act(async () => { finish(response()); await mutation; await trailing; });
    expect(result.current.state.agents.map(agent => agent.id)).toEqual([lead.id, "researcher"]);
    expect(result.current.state.agents[0].iconColor).toBe("#123456");
    expect(api.manage).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", expectedAgentRevision: 0 }));
    expect(api.save.mock.calls.at(-1)![0]).toMatchObject({ agentRevision: 1, voiceEnabled: false,
      agents: [expect.objectContaining({ id: lead.id, iconColor: "#123456" }), expect.objectContaining({ id: "researcher" })] });
  });

  it("does not adopt a late mutation response after the account changes", async () => {
    let finish!: (result: WorkspaceManageResponse) => void;
    api.manage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    let mutation!: ReturnType<typeof result.current.manageWorkspaceFromChat>;
    act(() => { mutation = result.current.manageWorkspaceFromChat(request); });
    await waitFor(() => expect(api.manage).toHaveBeenCalled());
    const rejected = expect(mutation).rejects.toThrow(/workspace changed/i);
    await act(async () => { result.current.identity.current = "another-account"; finish(response()); await rejected; });
    expect(result.current.state.agents).toHaveLength(1);
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a late mutation response after the same workspace is re-entered", async () => {
    let finish!: (result: WorkspaceManageResponse) => void;
    api.manage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useHarness);
    await waitFor(() => expect(result.current.runtimeSnapshotReady).toBe(true));
    let mutation!: ReturnType<typeof result.current.manageWorkspaceFromChat>;
    act(() => { mutation = result.current.manageWorkspaceFromChat(request); });
    await waitFor(() => expect(api.manage).toHaveBeenCalled());
    act(() => result.current.setGeneration(2));
    const rejected = expect(mutation).rejects.toThrow(/workspace changed/i);
    await act(async () => { finish(response()); await rejected; });
    expect(result.current.state.agents).toHaveLength(1);
    expect(api.save).toHaveBeenCalledTimes(1);
  });
});
