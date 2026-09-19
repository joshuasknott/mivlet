import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBackendProviders } from "@mivlet/connectors";
import { GrokBotPanel } from "./GrokBotPanel";
import { ProviderCatalogue } from "./ProviderCatalogue";
import { grokBotTransport } from "../../runtime/domains/grok-bot";

vi.mock("../../runtime/domains/grok-bot", () => ({
  grokBotSetupScope: vi.fn(async () => "account-workspace-scope"),
  grokBotTransport: {
    connect: vi.fn(),
    read: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(async () => {}),
  },
}));
const history = {
  bot_id: "bot-a",
  activity_state: "awaiting_user",
  messages: [{ speaker: "bot", text: "Which folder?", timestamp_ms: null }],
  next_cursor: null,
  truncated: false,
  correlation: "not_claimed",
  completion_boundary: "activity_snapshot_not_task_completion",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(grokBotTransport.connect).mockResolvedValue({
    sessionId: "session",
    bots: [{ id: "bot-a", name: "Research Bot" }],
  });
  vi.mocked(grokBotTransport.read).mockResolvedValue(history);
  vi.mocked(grokBotTransport.send).mockResolvedValue({
    bot_id: "bot-a",
    accepted: true,
    completion_boundary: "gateway_accepted_not_bot_reply",
  });
});
async function connected() {
  const user = userEvent.setup();
  const view = render(<GrokBotPanel onBack={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Connect bridge" }));
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Remote Bot" }),
    "bot-a",
  );
  await screen.findByText("Which folder?");
  return { user, ...view };
}
describe("Grok Bot connection UI", () => {
  it("is reachable under Grok while preserving account CLI and API choices", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCatalogue
        providers={listBackendProviders()}
        connectedBackendIds={[]}
        onConnect={vi.fn()}
      />,
    );
    await user.type(screen.getByRole("searchbox"), "Grok");
    await user.click(screen.getByRole("button", { name: /^Grok/ }));
    expect(screen.getByRole("button", { name: /Grok account/ })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Use an API key/ }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: /Grok Bot \(Experimental\)/ }),
    );
    expect(
      screen.getByRole("button", { name: "Connect bridge" }),
    ).toBeVisible();
    expect(
      screen.getByText(/Promotional credit.*not been verified/),
    ).toBeVisible();
  });
  it("shows existing remote history and waiting-for-user without claiming completion", async () => {
    await connected();
    expect(screen.getByText("Waiting for you")).toBeVisible();
    expect(screen.getByText(/cannot link a reply/)).toBeVisible();
    expect(screen.queryByText("Completed")).toBeNull();
  });
  it("clears the draft before an uncertain send and never retries it", async () => {
    const { user } = await connected();
    vi.mocked(grokBotTransport.send).mockRejectedValue(new Error("timeout"));
    await user.type(
      screen.getByRole("textbox", { name: "Message this Bot" }),
      "A harmless question",
    );
    await user.click(screen.getByRole("button", { name: "Send to Bot" }));
    expect(await screen.findByText(/Send outcome unknown/)).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(grokBotTransport.send).toHaveBeenCalledTimes(1);
  });
  it("Stop watching discards late results and makes continued remote execution clear", async () => {
    const { user } = await connected();
    let resolve!: (value: unknown) => void;
    vi.mocked(grokBotTransport.send).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send to Bot" }));
    await user.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(screen.getByText(/Bot may still be running/)).toBeVisible();
    await act(async () => {
      resolve({ accepted: true });
    });
    expect(screen.queryByText("Which folder?")).toBeNull();
    expect(grokBotTransport.disconnect).toHaveBeenCalledWith("session");
  });
  it("scope unmount closes the connection and suppresses in-flight history", async () => {
    const view = await connected();
    let resolve!: (value: unknown) => void;
    vi.mocked(grokBotTransport.read).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Latest history" }));
    view.unmount();
    await act(async () => {
      resolve(history);
    });
    expect(grokBotTransport.disconnect).toHaveBeenCalledWith("session");
  });
  it("fails closed and clears old history when the native scope or connection expires", async () => {
    const { user } = await connected();
    vi.mocked(grokBotTransport.read).mockRejectedValue(
      new Error("Connection no longer current. Reconnect."),
    );
    await user.click(screen.getByRole("button", { name: "Latest history" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("no longer current"),
    );
    expect(screen.queryByText("Which folder?")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect bridge" }),
    ).toBeEnabled();
  });
  it("surfaces unavailable companion setup without substituting an API route", async () => {
    vi.mocked(grokBotTransport.connect).mockRejectedValue(
      "Companion unavailable; start it in the VM.",
    );
    render(<GrokBotPanel onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect bridge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Companion unavailable",
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(grokBotTransport.send).not.toHaveBeenCalled();
  });
});
