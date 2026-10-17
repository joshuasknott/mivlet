import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalResolutionResponse, CollaborationSnapshot, CollaborationWorkItem, HostedProviderConnection, HostedTaskBinding, HostedTaskControlResult, HostedTaskReview, HostedWorkExecution } from "@mivlet/protocol";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { HostedTaskControls, type HostedTaskApi } from "./HostedTaskControls";
import { assertHostedControl, assertHostedReview } from "./hosted-task-custody";

const item: CollaborationWorkItem = {
  id: "work", rootId: "work", workspaceId: "hosted-local-workspace", agentId: "agent", agentName: "Atlas", conversationId: "chat",
  generation: 3, conversationGeneration: 1, status: "queued", userRequest: "Summarise the launch notes", prompt: "Summarise the launch notes",
  runIds: [], permissionMode: "read-only", dependencies: [], waitingFor: [], prerequisites: [], awaitingUser: false, contextRevision: 1,
  depth: 0, turnCount: 0, tokenUsage: 0, maxTurns: 10, maxTokens: 4096, modelOptionId: "saved-model", outputs: [], createdAt: "now", updatedAt: "now",
};
const connection: HostedProviderConnection = { credentialId: "cloud-key", providerId: "openai", revision: 4, enabled: true, createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 1_000_000 };
let reviewDeadline: number;
function snapshot(binding: HostedTaskBinding, phase: HostedWorkExecution["phase"] = "review", generation = binding.workGeneration): CollaborationSnapshot {
  const held = phase === "review";
  return { conversations: [], authors: [], teams: [], facts: [], layout: null, work: [{ ...item, generation,
    status: held ? "queued" : "running", queue: { held, order: 0 }, executionOwner: held ? undefined : "hosted",
    currentRunId: held ? undefined : binding.runId, runIds: held ? [] : [binding.runId],
    hostedTask: { version: 1, binding, phase, ...(held ? { reviewId: "review" } : {}) },
  }] };
}
const review = (): HostedTaskReview => {
  const value: HostedTaskReview = {
  collaboration: { conversations: [], authors: [], teams: [], work: [], facts: [], layout: null }, runnerUrl: "https://development.example.test/tasks",
  reviewId: "review", workId: item.id, workGeneration: 4, inputBytes: 75, expiresAt: reviewDeadline, originallyHeld: false,
  approval: { id: "approval", service: "hosted-task", action: "admit work", mode: "read-only", riskLevel: "high", dataUsed: ["Exact captured text"], consequence: "Send this text to the selected cloud provider once.", requestedAt: "2026-10-17T01:00:00Z", decisions: ["once", "deny"], confirmationPhrase: "SEND" },
  admission: { binding: { version: 1, taskId: "cloud-task", admissionId: "admit", runId: "run", workspaceId: "cloud-workspace", agentId: "agent", workId: "work", workGeneration: 4, conversationId: "chat", conversationGeneration: 1, expectedSequence: 0, inputSha256: "hash", providerId: "openai", model: "saved-model", credentialId: "cloud-key", credentialRevision: 4, budget: { maxModelCalls: 1, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536 }, expiresAt: reviewDeadline }, input: { messages: [{ role: "system", content: "The full agent instructions." }, { role: "user", content: "The exact captured request <script>literal</script>." }, { role: "assistant", content: "An exact disclosed assistant message." }] } },
  };
  value.collaboration = snapshot(value.admission.binding);
  return value;
};
let result: HostedTaskControlResult;
function released(status: "queued" | "cancelled"): HostedTaskControlResult {
  return { collaboration: { ...result.collaboration, work: [{ ...item, status, generation: 5 }] }, reconcileRequired: false };
}
function completed(binding = review().admission.binding): HostedTaskControlResult {
  const collaboration = snapshot(binding, "reconciled");
  collaboration.work[0].status = "completed";
  collaboration.work[0].currentRunId = undefined;
  return { collaboration, reconcileRequired: false, taskResult: {
    snapshot: { binding, generation: 1, status: "completed", sequence: 2, resultBytes: 18, createdAt: 1, updatedAt: 2, retainedUntil: reviewDeadline },
    text: "Saved cloud answer",
  } };
}
function api(over: Partial<HostedTaskApi> = {}): HostedTaskApi {
  return { list: vi.fn().mockResolvedValue([connection]), prepare: vi.fn().mockImplementation(async () => review()), preparePublicWeb: vi.fn(), cancel: vi.fn().mockResolvedValue(released("queued")), admit: vi.fn().mockResolvedValue(result), refresh: vi.fn().mockResolvedValue(result), stop: vi.fn().mockResolvedValue(released("cancelled")), approve: vi.fn().mockImplementation(async resolution => ({ persisted: true, auditEntry: { requestId: resolution.request.id, decision: "once" }, effectiveRequest: resolution.request, dismissed: true } as ApprovalResolutionResponse)), ...over };
}
async function startReview() {
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox", { name: "Cloud API connection" });
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "cloud-key" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Review cloud task" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
}
async function openReview() {
  await startReview();
  return screen.findByRole("dialog");
}
beforeEach(() => {
  reviewDeadline = Date.now() + 60_000;
  result = { collaboration: snapshot(review().admission.binding, "accepted"), reconcileRequired: false };
  setActiveRuntimeDataScope(item.workspaceId, "account-a");
});
afterEach(() => { clearActiveRuntimeDataScope(); vi.useRealTimers(); });

it("prepares, admits and refreshes distinct local and cloud workspaces across the native hold generation", async () => {
  const actions = api({ refresh: vi.fn().mockResolvedValue(completed()) });
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  await openReview();
  expect(screen.getByText("The full agent instructions.")).toBeVisible();
  expect(screen.getByText("The exact captured request <script>literal</script>.")).toBeVisible();
  expect(screen.getByText("An exact disclosed assistant message.")).toBeVisible();
  expect(screen.getByText(/One model call/)).toHaveTextContent("120 seconds");
  expect(screen.getByText(/4,096 output tokens/)).toBeVisible();
  expect(actions.admit).not.toHaveBeenCalled();
  expect(actions.prepare).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: item.workspaceId, expectedGeneration: 3 }));
  expect(review().admission.binding.workspaceId).toBe("cloud-workspace");
  expect(review().admission.binding.workspaceId).not.toBe(item.workspaceId);
  view.rerender(<HostedTaskControls item={{ ...item, generation: 4, hostedTask: { version: 1, binding: review().admission.binding, phase: "review", reviewId: "review" } }} api={actions} onChanged={changed} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(actions.admit).toHaveBeenCalledTimes(1));
  expect(actions.admit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: item.workspaceId, workId: "work", expectedGeneration: 4, reviewId: "review", resolution: expect.objectContaining({ decision: "once", confirmationText: "SEND" }) }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.rerender(<HostedTaskControls item={result.collaboration.work[0]} api={actions} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  await screen.findByText("Saved cloud answer");
  expect(actions.refresh).toHaveBeenCalledWith({ workspaceId: item.workspaceId, agentId: item.agentId, workId: item.id, expectedGeneration: 4 });
  expect(actions.admit).toHaveBeenCalledTimes(1);
});

it("cancel restores the prior hold through the exact native review", async () => {
  const actions = api();
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.click(screen.getByRole("button", { name: "Keep on this computer" }));
  await waitFor(() => expect(actions.cancel).toHaveBeenCalledWith({ workspaceId: item.workspaceId, agentId: "agent", workId: "work", expectedGeneration: 4, reviewId: "review" }));
  expect(actions.admit).not.toHaveBeenCalled();
});

it("allows a fresh review after a pre-admission prerequisite failure without sending or replaying", async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error("Choose the task’s saved API provider")).mockImplementation(async () => review());
  const actions = api({ prepare });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  await screen.findByText("Choose the task’s saved API provider");
  await waitFor(() => expect(screen.getByRole("button", { name: "Review cloud task" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  await screen.findByRole("dialog");
  expect(actions.prepare).toHaveBeenCalledTimes(2);
  expect(actions.admit).not.toHaveBeenCalled();
  expect(actions.approve).not.toHaveBeenCalled();
});

it("retains evidence after an uncertain admission and never offers the old request again", async () => {
  const actions = api({ admit: vi.fn().mockRejectedValue(new Error("Reply lost")) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(screen.getAllByText("Reply lost").length).toBeGreaterThan(0));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Continue in cloud once" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check cloud outcome" }));
  await waitFor(() => expect(actions.refresh).toHaveBeenCalledTimes(1));
  expect(actions.admit).toHaveBeenCalledTimes(1);
});

it("rejects mismatched or missing native approval without sending text", async () => {
  const actions = api({ approve: vi.fn().mockResolvedValue(null) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(screen.getAllByText(/matching one-time native approval was not recorded/).length).toBeGreaterThan(0));
  expect(actions.admit).not.toHaveBeenCalled();
});

it("drops a late prepared review after an account change", async () => {
  let finish!: (value: HostedTaskReview) => void;
  const actions = api({ prepare: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  setActiveRuntimeDataScope(item.workspaceId, "account-b");
  await act(async () => finish(review()));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("remounts consent for a different account even when public task IDs are reused", async () => {
  const actions = api();
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  await openReview();
  setActiveRuntimeDataScope(item.workspaceId, "account-b");
  view.rerender(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Continue in cloud…" })).toBeEnabled();
  expect(actions.admit).not.toHaveBeenCalled();
  expect(actions.cancel).not.toHaveBeenCalled();
});

it("keeps Stop independent of a stalled refresh", async () => {
  let finish!: (value: HostedTaskControlResult) => void;
  const actions = api({ refresh: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
  const hostedItem = { ...item, status: "running", hostedTask: { version: 1, binding: review().admission.binding, phase: "accepted" } } as CollaborationWorkItem;
  render(<HostedTaskControls item={hostedItem} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop cloud task" }));
  await waitFor(() => expect(actions.stop).toHaveBeenCalledTimes(1));
  await act(async () => finish(result));
});

it("keeps Stop reachable during admission and uses the prepared held generation", async () => {
  let finish!: (value: HostedTaskControlResult) => void;
  const actions = api({ admit: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(actions.admit).toHaveBeenCalledTimes(1));
  const stop = screen.getByRole("button", { name: "Stop task" });
  expect(stop.closest('[role="dialog"]')).not.toBeNull();
  expect(stop).toBeEnabled();
  fireEvent.click(stop);
  await waitFor(() => expect(actions.stop).toHaveBeenCalledWith({ workspaceId: item.workspaceId, agentId: "agent", workId: "work", expectedGeneration: 4 }));
  await act(async () => finish(completed()));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("Saved cloud answer")).toBeNull();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("native task changed"));
  expect(actions.admit).toHaveBeenCalledTimes(1);
});

it("does not dispatch after Stop while one-time approval is still being recorded", async () => {
  let finish!: (value: ApprovalResolutionResponse | null) => void;
  const actions = api({ approve: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(actions.approve).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
  await waitFor(() => expect(actions.stop).toHaveBeenCalledTimes(1));
  await act(async () => finish(null));
  expect(actions.admit).not.toHaveBeenCalled();
});

it("invalidates review after a different task generation and preserves captured text", async () => {
  const actions = api();
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  await openReview();
  view.rerender(<HostedTaskControls item={{ ...item, generation: 5 }} api={actions} onChanged={changed} />);
  expect(screen.getByText("The full agent instructions.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Continue in cloud once" })).toBeNull();
  expect(screen.getByRole("button", { name: "Check cloud outcome" })).toBeEnabled();
  expect(actions.admit).not.toHaveBeenCalled();
});

it("shows retained conflict results as escaped text without resubmitting", async () => {
  const actions = api({ refresh: vi.fn().mockResolvedValue({ ...result, reconcileRequired: true, taskResult: { snapshot: { binding: review().admission.binding, status: "completed" }, text: "<script>retained result</script>" } }) });
  const hostedItem = { ...item, hostedTask: { version: 1, binding: review().admission.binding, phase: "reconcile-required" } } as CollaborationWorkItem;
  render(<HostedTaskControls item={hostedItem} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  await screen.findByText("<script>retained result</script>");
  expect(document.querySelector(".cloud-panel-task-outcome script")).toBeNull();
  expect(actions.admit).not.toHaveBeenCalled();
  expect(screen.getByText(/needs review before the conversation/)).toBeVisible();
});

it("bounds a stalled status read and allows another explicit read", async () => {
  vi.useFakeTimers();
  const actions = api({ refresh: vi.fn().mockImplementation(() => new Promise(() => {})) });
  const hostedItem = { ...item, hostedTask: { version: 1, binding: review().admission.binding, phase: "accepted" } } as CollaborationWorkItem;
  render(<HostedTaskControls item={hostedItem} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh status before trying another action");
  expect(screen.getByRole("button", { name: "Refresh cloud status" })).toBeEnabled();
  expect(actions.admit).not.toHaveBeenCalled();
});

it("prepares an exact public website scope and shows captured research limits before approval", async () => {
  const captured = review();
  captured.admission.binding = { ...captured.admission.binding, version: 2, mode: "public-web-research",
    webScope: { allowedDomains: ["example.com"], initialUrls: ["https://example.com/releases"] },
    budget: { maxModelCalls: 4, maxPageReads: 6, maxSourceBytes: 65536, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536 } };
  captured.collaboration = snapshot(captured.admission.binding);
  const actions = api({ preparePublicWeb: vi.fn().mockResolvedValue(captured) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("radio", { name: "Research public pages" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Starting pages" }), { target: { value: "https://example.com/releases#updates" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  await screen.findByRole("dialog", { name: "Research in cloud" });
  expect(actions.preparePublicWeb).toHaveBeenCalledWith({ workspaceId: item.workspaceId, agentId: "agent", workId: "work", expectedGeneration: 3, credentialId: "cloud-key", credentialRevision: 4, mode: "public-web-research", webScope: { allowedDomains: ["example.com"], initialUrls: ["https://example.com/releases"] } });
  expect(screen.getByRole("region", { name: "Reviewed websites" })).toHaveTextContent("https://example.com/releases");
  expect(screen.getByText(/Up to 4 model calls/)).toHaveTextContent("6 page reads · up to 120 seconds");
  expect(screen.getByText(/4,096 output tokens across all calls/)).toBeVisible();
  expect(actions.prepare).not.toHaveBeenCalled();
  expect(actions.admit).not.toHaveBeenCalled();
});

it("does not hold or send a research task with missing or invalid starting pages", async () => {
  const actions = api();
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox");
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("radio", { name: "Research public pages" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Starting pages" }), { target: { value: "https://user:password@example.com/" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  await screen.findByText(/Starting pages must use public HTTPS/);
  expect(actions.preparePublicWeb).not.toHaveBeenCalled();
  expect(actions.prepare).not.toHaveBeenCalled();
  expect(actions.approve).not.toHaveBeenCalled();
});

it.each<[string, Partial<CollaborationWorkItem>]>([
  ["another Work", { id: "other-work" }],
  ["the cloud workspace in the local Work field", { workspaceId: "cloud-workspace" }],
  ["another local workspace", { workspaceId: "hosted-other-workspace" }],
  ["another agent", { agentId: "other-agent" }],
  ["another conversation", { conversationId: "other-chat" }],
  ["another conversation generation", { conversationGeneration: 2 }],
  ["another root", { rootId: "other-root" }],
  ["a stale generation", { generation: 2 }],
  ["an unrelated later generation", { generation: 6 }],
])("rejects a prepared review with %s before approval", async (_name, patch) => {
  const captured = review();
  captured.collaboration.work[0] = { ...captured.collaboration.work[0], ...patch };
  const actions = api({ prepare: vi.fn().mockResolvedValue(captured) });
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await startReview();
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(actions.approve).not.toHaveBeenCalled();
  expect(actions.admit).not.toHaveBeenCalled();
});

it("rejects absent or duplicate canonical Work and an unheld native review", () => {
  const absent = review();
  absent.collaboration.work = [];
  expect(() => assertHostedReview(item, absent)).toThrow("native task changed");
  const duplicate = review();
  duplicate.collaboration.work.push({ ...duplicate.collaboration.work[0] });
  expect(() => assertHostedReview(item, duplicate)).toThrow("native task changed");
  const unheld = review();
  unheld.collaboration.work[0].queue!.held = false;
  expect(() => assertHostedReview(item, unheld)).toThrow("does not match its native task");
});

it.each<Partial<HostedTaskBinding>>([
  { workspaceId: "other-cloud-workspace" }, { runId: "other-run" }, { admissionId: "other-admission" },
  { inputSha256: "other-input" }, { credentialRevision: 8 }, { expectedSequence: 99 },
  { budget: { maxModelCalls: 1, maxOutputTokens: 12, maxElapsedMs: 120000, maxResultBytes: 65536 } },
])("rejects a review whose full binding differs from the canonical native Work: %j", patch => {
  const captured = review();
  // Same Work and review IDs are insufficient: consent must match every field.
  captured.admission.binding = { ...captured.admission.binding, ...patch } as HostedTaskBinding;
  expect(() => assertHostedReview(item, captured)).toThrow("does not match its native task");
});

it.each(["admit", "refresh"] as const)("rejects a foreign cloud binding returned from %s even when its result and native Work agree", async operation => {
  const foreign = completed({ ...review().admission.binding, workspaceId: "other-cloud-workspace" });
  const actions = api({ [operation]: vi.fn().mockResolvedValue(foreign) });
  if (operation === "admit") {
    render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await openReview();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  } else {
    render(<HostedTaskControls item={result.collaboration.work[0]} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  }
  await waitFor(() => expect(screen.getAllByText(/does not match its native task binding/).length).toBeGreaterThan(0));
  expect(screen.queryByText("Saved cloud answer")).toBeNull();
});

it("rejects a result receipt that differs from its exact native cloud binding", () => {
  const saved = review().admission.binding;
  const response = completed();
  response.taskResult!.snapshot.binding = { ...saved, runId: "other-run" };
  expect(() => assertHostedControl(item, response, saved, 4)).toThrow("does not match its native task binding");
  response.taskResult!.snapshot.binding = saved;
  response.collaboration.work[0].workspaceId = saved.workspaceId;
  expect(() => assertHostedControl(item, response, saved, 4)).toThrow("native task changed");
});

it("uses the newest native generation for Stop after compound refresh effects, before parent state catches up", async () => {
  const refreshed = { collaboration: snapshot(review().admission.binding, "accepted", 6), reconcileRequired: false };
  const stopped = released("cancelled");
  stopped.collaboration.work[0].generation = 7;
  const actions = api({ refresh: vi.fn().mockResolvedValue(refreshed), stop: vi.fn().mockResolvedValue(stopped) });
  const changed = vi.fn().mockResolvedValue(undefined);
  render(<HostedTaskControls item={result.collaboration.work[0]} api={actions} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Refresh cloud status" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Stop cloud task" }));
  await waitFor(() => expect(actions.stop).toHaveBeenCalledWith({ workspaceId: item.workspaceId, agentId: item.agentId, workId: item.id, expectedGeneration: 6 }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("rechecks the full native binding after approval even if the review ID and generation are reused", async () => {
  let finish!: (value: ApprovalResolutionResponse) => void;
  const actions = api({ approve: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) });
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(actions.approve).toHaveBeenCalledTimes(1));
  const changed = snapshot({ ...review().admission.binding, runId: "replacement-run" }).work[0];
  view.rerender(<HostedTaskControls item={changed} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  const request = review().approval;
  await act(async () => finish({ persisted: true, auditEntry: { requestId: request.id, decision: "once" }, effectiveRequest: request, dismissed: true } as ApprovalResolutionResponse));
  await waitFor(() => expect(screen.getAllByText(/task changed during approval/).length).toBeGreaterThan(0));
  expect(actions.admit).not.toHaveBeenCalled();
});
