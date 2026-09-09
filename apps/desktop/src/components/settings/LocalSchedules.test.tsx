import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSchedules } from "./LocalSchedules";
import type { SettingsRuntime } from "./settings-runtime";
import { createLocalSchedule, listLocalSchedules, listLocalScheduleOccurrences, setLocalScheduleStatus, updateLocalSchedule, type LocalSchedule } from "../../runtime/domains/local-schedules";

vi.mock("../../runtime/domains/local-schedules", () => ({
  createLocalSchedule: vi.fn(), listLocalSchedules: vi.fn(),
  listLocalScheduleOccurrences: vi.fn(), setLocalScheduleStatus: vi.fn(), updateLocalSchedule: vi.fn(),
}));

const schedule: LocalSchedule = { id: "schedule", agentId: "agent", providerId: "codex", model: "original", prompt: "Research rainfall", timezone: "Europe/London", trigger: { kind: "daily", localTime: "09:00" }, status: "enabled", revision: 4, promptRevision: 2, createdAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z" };
function runtime(): SettingsRuntime {
  return {
    accountWorkspaceStatus: { activeWorkspace: { localWorkspaceId: "workspace" } },
    agents: [{ id: "agent", name: "Researcher", modelId: "codex::new-model" }],
    allModelOptions: ["original", "new-model"].map((modelId) => ({ id: `codex::${modelId}`, modelId, providerId: "codex", available: true })),
    backendProviders: [{ id: "codex", label: "ChatGPT", backendType: "codex-app-server", authState: "connected" }],
  } as unknown as SettingsRuntime;
}
function mount(value = runtime()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><LocalSchedules runtime={value} /></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listLocalSchedules).mockResolvedValue([]);
  vi.mocked(listLocalScheduleOccurrences).mockResolvedValue([]);
  vi.mocked(createLocalSchedule).mockResolvedValue(schedule);
  vi.mocked(setLocalScheduleStatus).mockResolvedValue(schedule);
  vi.mocked(updateLocalSchedule).mockResolvedValue(schedule);
});
describe("Local schedules", () => {
  it("creates against the chosen agent route and keeps a rejected draft editable", async () => {
    vi.mocked(createLocalSchedule).mockRejectedValueOnce(new Error("The schedule changed. Refresh and try again."));
    mount();
    await waitFor(() => expect((screen.getByRole("button", { name: "New schedule" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Research task"), { target: { value: "Find primary sources on rainfall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(createLocalSchedule).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", agentId: "agent", providerId: "codex", model: "new-model", prompt: "Find primary sources on rainfall", status: "enabled" })));
    await screen.findByText("The schedule changed. Refresh and try again.");
    expect((screen.getByLabelText("Research task") as HTMLTextAreaElement).value).toBe("Find primary sources on rainfall");
  });
  it("retains the saved model after the agent model changes and includes the displayed revision", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([schedule]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Research task"), { target: { value: "Updated research" } });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(updateLocalSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "schedule", expectedRevision: 4, model: "original", prompt: "Updated research" })));
    await waitFor(() => expect(screen.queryByLabelText("Research task")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(setLocalScheduleStatus).toHaveBeenCalledWith({ workspaceId: "workspace", id: "schedule", expectedRevision: 4, status: "paused" }));
  });
  it("does not reroute an unavailable saved model", async () => {
    vi.mocked(listLocalSchedules).mockResolvedValue([schedule]);
    const value = runtime();
    value.allModelOptions = value.allModelOptions.filter((model) => model.modelId !== "original");
    mount(value);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect((screen.getByRole("button", { name: "Save schedule" }) as HTMLButtonElement).disabled).toBe(true);
    expect(updateLocalSchedule).not.toHaveBeenCalled();
  });
});
