import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsRuntime } from "./settings-runtime";
import type { LocalSchedule } from "../../runtime/domains/local-schedules";
import { setLocalScheduleStatus } from "../../runtime/domains/local-schedules";
import {
  configureEventIngress,
  getEventIngress,
  listEventDeliveries,
  previewEventTemplate,
  saveEventTrigger,
} from "../../runtime/domains/event-automations";
import { EventAutomations } from "./EventAutomations";

vi.mock("../../runtime/domains/event-automations", () => ({
  configureEventIngress: vi.fn(),
  getEventIngress: vi.fn(),
  listEventDeliveries: vi.fn(),
  previewEventTemplate: vi.fn(),
  saveEventTrigger: vi.fn(),
}));
vi.mock("../../runtime/domains/local-schedules", () => ({
  setLocalScheduleStatus: vi.fn(),
}));
const trigger: LocalSchedule = {
  id: "event-test",
  agentId: "agent",
  providerId: "openai",
  model: "model",
  permissionMode: "read-only",
  executionKind: "agent",
  prompt: "Inspect {{body.summary}}",
  timezone: "UTC",
  revision: 3,
  promptRevision: 2,
  status: "paused",
  createdAt: "2026-10-08T12:00:00Z",
  updatedAt: "2026-10-08T12:00:00Z",
  trigger: {
    kind: "event",
    source: { kind: "signed-json", sourceId: "ci.example" },
    fields: ["summary"],
    maxAgeSeconds: 300,
    validUntil: "2030-10-09T12:00:00Z",
    routeId: "ab".repeat(32),
    keyVersion: 1,
    signingKeyId: "webhook-key:configured",
  },
};
function runtime(): SettingsRuntime {
  return {
    agents: [
      {
        id: "agent",
        name: "Scout",
        modelId: "openai::model",
        permissionLabel: "Ask Me",
      },
    ],
    allModelOptions: [
      {
        id: "openai::model",
        providerId: "openai",
        modelId: "model",
        available: true,
      },
    ],
    backendProviders: [
      {
        id: "openai",
        label: "OpenAI",
        backendType: "native-api",
        authState: "connected",
        capabilities: ["streaming", "tool-requests", "approvals"],
      },
    ],
  } as unknown as SettingsRuntime;
}
function openDisclosure(text: string) {
  const details = screen.getByText(text).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
function dropDisabledFocus() {
  // jsdom retains disabled-button focus; model Chromium's focus loss.
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute("tabindex");
  expect(document.body).toHaveFocus();
}
function mount(
  schedules: LocalSchedule[] = [],
  value = runtime(),
  onOpenResult = vi.fn().mockResolvedValue(undefined),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <EventAutomations
        runtime={value}
        workspaceId="workspace"
        schedules={schedules}
        initialAgentId="agent"
        onOpenResult={onOpenResult}
      />
    </QueryClientProvider>,
  );
  openDisclosure("Event triggers");
  return { onOpenResult };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEventIngress).mockResolvedValue({
    enabled: false,
    port: 25139,
    listening: false,
    availability: "app-open",
    cloudHolding: false,
  });
  vi.mocked(configureEventIngress).mockResolvedValue({
    enabled: true,
    port: 25139,
    listening: true,
    baseUrl: "http://127.0.0.1:25139",
    availability: "app-open",
    cloudHolding: false,
  });
  vi.mocked(listEventDeliveries).mockResolvedValue([]);
  vi.mocked(previewEventTemplate).mockResolvedValue({
    prompt: 'Inspect "Example event"',
    selectedFields: { summary: "Example event" },
    missing: [],
  });
  vi.mocked(saveEventTrigger).mockResolvedValue(trigger);
  vi.mocked(setLocalScheduleStatus).mockResolvedValue(trigger);
});
describe("Event automations", () => {
  it("focuses the editor and returns to its opener when closed", async () => {
    mount([trigger]);
    const edit = screen.getByRole("button", { name: "Edit event trigger" });
    edit.focus();
    fireEvent.click(edit);
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close event editor" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(edit).toHaveFocus());
  });
  it("restores a listener action after its pending control loses focus", async () => {
    let resolve!: () => void;
    vi.mocked(configureEventIngress).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = () =>
            done({
              enabled: true,
              port: 25139,
              listening: true,
              baseUrl: "http://127.0.0.1:25139",
              availability: "app-open",
              cloudHolding: false,
            });
        }),
    );
    mount();
    const enable = screen.getByRole("button", { name: "Enable local ingress" });
    await waitFor(() => expect(enable).toBeEnabled());
    enable.focus();
    fireEvent.click(enable);
    dropDisabledFocus();
    await act(async () => resolve());
    await waitFor(() => expect(enable).toHaveFocus());
  });
  it("restores the preview action after pending keyboard focus is lost", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof previewEventTemplate>>,
    ) => void;
    vi.mocked(previewEventTemplate).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount([trigger]);
    fireEvent.click(screen.getByRole("button", { name: "Edit event trigger" }));
    openDisclosure("Preview the produced request");
    const preview = screen.getByRole("button", { name: "Preview event task" });
    preview.focus();
    fireEvent.click(preview);
    dropDisabledFocus();
    await act(async () =>
      resolve({ prompt: "Current preview", selectedFields: {}, missing: [] }),
    );
    await waitFor(() => expect(preview).toHaveFocus());
  });
  it("requires a preview and protected reference, then sends only scoped configuration", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "New event trigger" }));
    fireEvent.change(screen.getByLabelText("Source identity"), {
      target: { value: "ci.example" },
    });
    fireEvent.change(screen.getByLabelText("Protected signing-key reference"), {
      target: { value: "webhook-key:configured" },
    });
    expect(
      screen.getByRole("button", { name: "Save event trigger" }),
    ).toBeDisabled();
    openDisclosure("Preview the produced request");
    fireEvent.click(screen.getByRole("button", { name: "Preview event task" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save event trigger" }),
      ).toBeEnabled(),
    );
    expect(saveEventTrigger).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save event trigger" }));
    await waitFor(() =>
      expect(saveEventTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace",
          agentId: "agent",
          providerId: "openai",
          model: "model",
          permissionMode: "trusted-scope",
          signingKeyId: "webhook-key:configured",
          event: expect.objectContaining({
            source: { kind: "signed-json", sourceId: "ci.example" },
          }),
        }),
      ),
    );
    expect(vi.mocked(saveEventTrigger).mock.calls[0][0]).not.toHaveProperty(
      "secret",
    );
  });
  it("invalidates a late preview after the task changes", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof previewEventTemplate>>,
    ) => void;
    vi.mocked(previewEventTemplate).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mount([trigger]);
    fireEvent.click(screen.getByRole("button", { name: "Edit event trigger" }));
    openDisclosure("Preview the produced request");
    fireEvent.click(screen.getByRole("button", { name: "Preview event task" }));
    const task = screen.getByLabelText("Task template");
    task.focus();
    fireEvent.change(task, {
      target: { value: "Changed task" },
    });
    await act(async () =>
      resolve({ prompt: "Old task", selectedFields: {}, missing: [] }),
    );
    expect(screen.queryByText("Old task")).toBeNull();
    expect(task).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Save event trigger" }),
    ).toBeDisabled();
  });
  it("keeps missing-field and native secret errors editable", async () => {
    vi.mocked(previewEventTemplate).mockResolvedValueOnce({
      prompt: "Inspect [missing]",
      selectedFields: {},
      missing: ["summary"],
    });
    let rejectSave!: (error: Error) => void;
    vi.mocked(saveEventTrigger).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    mount([trigger]);
    fireEvent.click(screen.getByRole("button", { name: "Edit event trigger" }));
    openDisclosure("Preview the produced request");
    fireEvent.click(screen.getByRole("button", { name: "Preview event task" }));
    expect(
      await screen.findByText("Missing selected fields: summary"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Save event trigger" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview event task" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save event trigger" }),
      ).toBeEnabled(),
    );
    const save = screen.getByRole("button", { name: "Save event trigger" });
    save.focus();
    fireEvent.click(save);
    dropDisabledFocus();
    await act(async () => rejectSave(new Error("Signing key was revoked.")));
    const failure = await screen.findByText("Signing key was revoked.");
    expect(failure).toBeVisible();
    await waitFor(() => expect(failure).toHaveFocus());
    expect(screen.getByLabelText("Task template")).toHaveValue(trigger.prompt);
  });
  it("preserves the saved route and refuses a disconnected provider", () => {
    const value = runtime();
    value.backendProviders[0].authState = "needs-auth";
    mount([trigger], value);
    fireEvent.click(screen.getByRole("button", { name: "Edit event trigger" }));
    expect(
      screen.getByRole("button", { name: "Save event trigger" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Choose an agent with a connected provider/),
    ).toBeVisible();
  });
  it("uses the persisted listener port and exact trigger revisions for pause and removal", async () => {
    mount([{ ...trigger, status: "enabled" }]);
    await waitFor(() =>
      expect(screen.getByLabelText("Local port")).toHaveValue(25139),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enable local ingress" }),
    );
    await waitFor(() =>
      expect(configureEventIngress).toHaveBeenCalledWith({
        workspaceId: "workspace",
        enabled: true,
        port: 25139,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Pause trigger" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Pause trigger" }));
    await waitFor(() =>
      expect(setLocalScheduleStatus).toHaveBeenCalledWith({
        workspaceId: "workspace",
        id: "event-test",
        expectedRevision: 3,
        status: "paused",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove trigger" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove trigger" }));
    await waitFor(() =>
      expect(setLocalScheduleStatus).toHaveBeenCalledWith({
        workspaceId: "workspace",
        id: "event-test",
        expectedRevision: 3,
        status: "cancelled",
      }),
    );
  });
  it("shows delivery failures and opens the resulting ordinary Work conversation", async () => {
    vi.mocked(listEventDeliveries).mockResolvedValue([
      {
        id: "delivery",
        scheduleId: trigger.id,
        receivedAt: "2026-10-08T12:00:00Z",
        expiresAt: "2026-10-08T12:05:00Z",
        state: "failed",
        reason: "Provider unavailable",
        source: { kind: "signed-json", sourceId: "ci.example" },
        selectedFields: { summary: "Safe example" },
        prompt: "Inspect safe example",
        workId: "work",
        threadId: "conversation",
      },
    ]);
    const { onOpenResult } = mount([trigger]);
    openDisclosure("Delivery history");
    expect(await screen.findByText("Provider unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open event work" }));
    expect(onOpenResult).toHaveBeenCalledWith("agent", "conversation");
  });
});
