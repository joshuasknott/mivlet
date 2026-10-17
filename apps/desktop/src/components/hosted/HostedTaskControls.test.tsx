import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalResolutionResponse, CollaborationWorkItem, HostedProviderConnection, HostedTaskControlResult, HostedTaskReview } from "@mivlet/protocol";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { HostedTaskControls, type HostedTaskApi } from "./HostedTaskControls";

const item = { id: "work", rootId: "work", workspaceId: "workspace", agentId: "agent", agentName: "Atlas", conversationId: "chat", generation: 3, status: "queued", userRequest: "Summarise the launch notes", runIds: [] } as unknown as CollaborationWorkItem;
const connection: HostedProviderConnection = { credentialId: "cloud-key", providerId: "openai", revision: 4, enabled: true, createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 1_000_000 };
const review = (): HostedTaskReview => ({
  collaboration: { revision: 1 } as unknown as HostedTaskReview["collaboration"], runnerUrl: "https://development.example.test/tasks",
  reviewId: "review", workId: item.id, workGeneration: 4, inputBytes: 75, expiresAt: Date.now() + 60_000, originallyHeld: false,
  approval: { id: "approval", service: "hosted-task", action: "admit work", mode: "read-only", riskLevel: "high", dataUsed: ["Exact captured text"], consequence: "Send this text to the selected cloud provider once.", requestedAt: "2026-10-17T01:00:00Z", decisions: ["once", "deny"], confirmationPhrase: "SEND" },
  admission: { binding: { version: 1, taskId: "cloud-task", admissionId: "admit", runId: "run", workspaceId: "workspace", agentId: "agent", workId: "work", workGeneration: 4, conversationId: "chat", conversationGeneration: 1, expectedSequence: 0, inputSha256: "hash", providerId: "openai", model: "saved-model", credentialId: "cloud-key", credentialRevision: 4, budget: { maxModelCalls: 1, maxOutputTokens: 4096, maxElapsedMs: 120000, maxResultBytes: 65536 }, expiresAt: Date.now() + 60000 }, input: { messages: [{ role: "system", content: "The full agent instructions." }, { role: "user", content: "The exact captured request <script>literal</script>." }, { role: "assistant", content: "An exact disclosed assistant message." }] } },
});
const result = { collaboration: { revision: 1 }, reconcileRequired: false } as unknown as HostedTaskControlResult;
function api(over: Partial<HostedTaskApi> = {}): HostedTaskApi {
  return { list: vi.fn().mockResolvedValue([connection]), prepare: vi.fn().mockImplementation(async () => review()), cancel: vi.fn().mockResolvedValue(result), admit: vi.fn().mockResolvedValue(result), refresh: vi.fn().mockResolvedValue(result), stop: vi.fn().mockResolvedValue(result), approve: vi.fn().mockImplementation(async resolution => ({ persisted: true, auditEntry: { requestId: resolution.request.id, decision: "once" }, effectiveRequest: resolution.request, dismissed: true } as ApprovalResolutionResponse)), ...over };
}
async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud…" }));
  const select = await screen.findByRole("combobox", { name: "Cloud API connection" });
  fireEvent.change(select, { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  return screen.findByRole("dialog");
}
beforeEach(() => setActiveRuntimeDataScope("workspace", "account-a"));
afterEach(() => { clearActiveRuntimeDataScope(); vi.useRealTimers(); });

it("shows all exact text and native limits before one-use approval, across the native hold generation", async () => {
  const actions = api();
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  await openReview();
  expect(screen.getByText("The full agent instructions.")).toBeVisible();
  expect(screen.getByText("The exact captured request <script>literal</script>.")).toBeVisible();
  expect(screen.getByText("An exact disclosed assistant message.")).toBeVisible();
  expect(screen.getByText(/One model call/)).toHaveTextContent("120 seconds");
  expect(screen.getByText(/4,096 output tokens/)).toBeVisible();
  expect(actions.admit).not.toHaveBeenCalled();
  view.rerender(<HostedTaskControls item={{ ...item, generation: 4, hostedTask: { version: 1, binding: review().admission.binding, phase: "review", reviewId: "review" } }} api={actions} onChanged={changed} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "SEND" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue in cloud once" }));
  await waitFor(() => expect(actions.admit).toHaveBeenCalledTimes(1));
  expect(actions.admit).toHaveBeenCalledWith(expect.objectContaining({ workId: "work", expectedGeneration: 4, reviewId: "review", resolution: expect.objectContaining({ decision: "once", confirmationText: "SEND" }) }));
});

it("cancel restores the prior hold through the exact native review", async () => {
  const actions = api();
  render(<HostedTaskControls item={item} api={actions} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await openReview();
  fireEvent.click(screen.getByRole("button", { name: "Keep on this computer" }));
  await waitFor(() => expect(actions.cancel).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "agent", workId: "work", expectedGeneration: 4, reviewId: "review" }));
  expect(actions.admit).not.toHaveBeenCalled();
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
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "cloud-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cloud task" }));
  setActiveRuntimeDataScope("workspace", "account-b");
  await act(async () => finish(review()));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("remounts consent for a different account even when public task IDs are reused", async () => {
  const actions = api();
  const changed = vi.fn().mockResolvedValue(undefined);
  const view = render(<HostedTaskControls item={item} api={actions} onChanged={changed} />);
  await openReview();
  setActiveRuntimeDataScope("workspace", "account-b");
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
  expect(document.querySelector(".hosted-task-outcome script")).toBeNull();
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
