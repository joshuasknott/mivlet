import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApprovalGate, type EmbeddedRuntimeEvent } from "@fable/connectors";
import { registeredToolSpecs } from "@fable/connectors/native-api/tools";
import type { AgentTurnRequest, ApprovalRequest, BackendProvider, ExecutionAttempt } from "@fable/protocol";
import { createDesktopToolExecutor } from "../lib/desktop-tool-runtime";
import type { DurableRunWriter } from "../lib/conversation-runtime";
import { useNativeAgent } from "./useNativeAgent";

const native = vi.hoisted(() => ({
  receive: undefined as ((event: EmbeddedRuntimeEvent) => void) | undefined,
  saved: [] as ExecutionAttempt[],
  order: [] as string[],
  saveFailure: false,
  start: vi.fn(async (_input: unknown) => { native.order.push("start"); }),
  cancel: vi.fn(async (_id: string) => undefined),
  reply: vi.fn(async (_id: string, _call: string, _ok: boolean, _output: string) => undefined),
  execute: vi.fn(async (_input: unknown) => ({ ok: true, output: "Approved fixture text." })),
}));

vi.mock("../lib/provider-route-selection", () => ({
  selectNativeProviderRoute: vi.fn(async () => ({ workspaceId: "workspace-1", selection: {
    providerRouteId: "route-openai", selectedAt: "2026-09-10T12:00:00Z", reason: "Fixture route", boundaryPolicyRef: "fixture-boundary",
  } })),
}));
vi.mock("../runtime", () => ({
  listenRuntimeEmbeddedAgent: vi.fn(async (_id: string, receive: (event: EmbeddedRuntimeEvent) => void) => {
    native.receive = receive;
    return () => undefined;
  }),
  startRuntimeEmbeddedAgent: native.start,
  cancelRuntimeEmbeddedAgent: native.cancel,
  replyRuntimeEmbeddedAgent: native.reply,
  saveRuntimeExecutionAttempt: vi.fn(async (attempt: ExecutionAttempt) => {
    if (native.saveFailure) throw new Error("Fixture vault unavailable.");
    native.saved.push(attempt); native.order.push(`save:${attempt.status}`); return attempt;
  }),
  listRuntimeExecutionAttempts: vi.fn(async () => []),
  recoverRuntimeExecutionAttempts: vi.fn(async () => []),
  listRuntimeBackendModels: vi.fn(async () => null),
  executeRuntimeToolCall: native.execute,
}));

const provider: BackendProvider = {
  id: "openai", backendType: "native-api", label: "OpenAI", description: "Fixture provider", authState: "connected",
  capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
  models: [{ id: "gpt-5", label: "GPT-5", available: true }],
};
const request: AgentTurnRequest = {
  model: "gpt-5", messages: [{ role: "user", content: "Read the fixture." }],
  tools: registeredToolSpecs().filter(tool => tool.name === "read-file"), maxTokens: 1024,
};

beforeEach(() => {
  vi.clearAllMocks(); native.receive = undefined; native.saved = []; native.order = []; native.saveFailure = false;
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});
afterEach(() => { delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

function fixture() {
  const gate = createApprovalGate();
  let approval: ApprovalRequest | undefined;
  const record = vi.fn(async (_entry: Parameters<DurableRunWriter["record"]>[0]) => { native.order.push("canonical"); });
  const execute = createDesktopToolExecutor(gate, {
    localComputer: { workspaceId: "workspace-1", agentId: "agent-1", ready: true, generation: 1, controller: "agent" },
    queueApproval: proposed => { approval = proposed; gate.register(proposed); },
  });
  const hook = renderHook(() => useNativeAgent({
    providers: [provider], threadId: "thread-1", execute,
    onCancel: () => gate.cancelPending(),
    createDurableRunWriter: () => ({ record, checkpointAssistant: vi.fn(async () => undefined) }),
  }));
  return { ...hook, gate, record, approval: () => approval };
}

it("joins the hook, embedded bridge and exact approval executor while preserving canonical state", async () => {
  const { result, gate, record, approval } = fixture();
  let running!: Promise<ExecutionAttempt | undefined>;
  act(() => { running = result.current.run(request); });
  await waitFor(() => expect(native.start).toHaveBeenCalledOnce());
  expect(native.order.indexOf("save:queued")).toBeLessThan(native.order.indexOf("canonical"));
  expect(native.order.indexOf("canonical")).toBeLessThan(native.order.indexOf("start"));
  expect(native.start).toHaveBeenCalledWith(expect.objectContaining({
    providerId: "openai", request: expect.objectContaining({ providerRoute: expect.objectContaining({ workspaceId: "workspace-1" }) }),
  }));
  act(() => {
    native.receive!({ type: "text-delta", text: "Reading. " });
    native.receive!({ type: "tool-request", callId: "read-call", tool: "read-file", arguments: '{"path":"README.md"}' });
  });
  await waitFor(() => expect(approval()).toBeDefined());
  expect(native.execute).not.toHaveBeenCalled();
  expect(native.reply).not.toHaveBeenCalled();
  act(() => { gate.resolveGrant(approval()!.id); });
  await waitFor(() => expect(native.reply).toHaveBeenCalledOnce());
  expect(native.execute).toHaveBeenCalledWith(expect.objectContaining({
    tool: "read-file", arguments: { path: "README.md" }, approval: expect.objectContaining({ decision: "once", request: expect.objectContaining({ id: approval()!.id }) }),
  }));
  expect(native.reply).toHaveBeenCalledWith(expect.any(String), "read-call", true, "Approved fixture text.");
  await act(async () => {
    native.receive!({ type: "text-delta", text: "Finished." });
    native.receive!({ type: "done", finishReason: "stop" });
    await running;
  });
  expect(result.current.state.transcript).toBe("Reading. Finished.");
  expect(result.current.state.status).toBe("completed");
  expect(result.current.state.lastError).toBeNull();
  expect(record.mock.calls.filter(([entry]) => entry.kind === "user")).toHaveLength(1);
  expect(native.saved.at(-1)).toMatchObject({ status: "completed", transcript: "Reading. Finished.", pendingApprovalIds: [] });
  expect(gate.pendingCount()).toBe(0);
});

it("persists retries reported by the embedded provider boundary", async () => {
  const { result } = fixture();
  let running!: Promise<ExecutionAttempt | undefined>;
  act(() => { running = result.current.run(request); });
  await waitFor(() => expect(native.start).toHaveBeenCalledOnce());

  act(() => { native.receive!({ type: "retrying" }); });
  await waitFor(() => expect(native.saved).toContainEqual(expect.objectContaining({
    status: "retrying",
    retryCount: 1,
  })));

  await act(async () => {
    native.receive!({ type: "done", finishReason: "stop" });
    await running;
  });
  expect(native.saved.at(-1)).toMatchObject({ status: "completed", retryCount: 1 });
});

it("Stop cancels a pending embedded approval and rejects delayed native events", async () => {
  const { result, gate, approval } = fixture();
  let running!: Promise<ExecutionAttempt | undefined>;
  act(() => { running = result.current.run(request); });
  await waitFor(() => expect(native.start).toHaveBeenCalledOnce());
  act(() => { native.receive!({ type: "tool-request", callId: "late-call", tool: "read-file", arguments: '{"path":"README.md"}' }); });
  await waitFor(() => expect(approval()).toBeDefined());
  await act(async () => { await result.current.cancel(); await running; });
  act(() => {
    native.receive!({ type: "text-delta", text: "Late completion must be dropped." });
    native.receive!({ type: "done", finishReason: "stop" });
  });
  expect(native.cancel).toHaveBeenCalledWith(expect.stringMatching(/^sdk-/));
  expect(native.execute).not.toHaveBeenCalled();
  expect(native.reply).not.toHaveBeenCalled();
  expect(gate.pendingCount()).toBe(0);
  expect(result.current.state.status).toBe("cancelled");
  expect(result.current.state.transcript).toBe("");
  expect(native.saved.at(-1)).toMatchObject({ status: "cancelled" });
});

it("a failed initial vault write prevents embedded execution", async () => {
  native.saveFailure = true;
  const { result } = fixture();
  await act(async () => { await result.current.run(request); });
  expect(native.start).not.toHaveBeenCalled();
  expect(result.current.state.status).toBe("failed");
  expect(result.current.state.lastError).toContain("vault unavailable");
});
