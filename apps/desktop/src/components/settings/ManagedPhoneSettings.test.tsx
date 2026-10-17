import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PhoneRelayStatus } from "@mivlet/protocol";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { ManagedPhoneSettings, type ManagedPhoneApi } from "./ManagedPhoneSettings";

const stopped: PhoneRelayStatus = { state: "stopped", workspaceId: "workspace", deviceId: "device", cloudWorkspaceId: "cloud-workspace" };
const connected: PhoneRelayStatus = { ...stopped, state: "connected", connectionId: "native-connection", epoch: "native-epoch", phoneUrl: "https://phone.example/phone/native-link" };
function api(): ManagedPhoneApi {
  return { status: vi.fn().mockResolvedValue(stopped), connect: vi.fn().mockResolvedValue(connected), disconnect: vi.fn().mockResolvedValue(stopped) };
}
beforeEach(() => setActiveRuntimeDataScope("workspace", "account-a"));
afterEach(() => { clearActiveRuntimeDataScope(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("connects deliberately with native scope only, copies the native link, and disconnects its exact identity", async () => {
  const native = api();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect phone" })).toBeEnabled());
  expect(native.connect).not.toHaveBeenCalled();
  expect(screen.getByText(/Keep this computer awake/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
  expect(await screen.findByLabelText("Phone link")).toHaveValue(connected.phoneUrl);
  expect(native.connect).toHaveBeenCalledWith({ workspaceId: stopped.workspaceId, cloudWorkspaceId: stopped.cloudWorkspaceId, deviceId: stopped.deviceId });
  fireEvent.click(screen.getByRole("button", { name: "Copy phone link" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(connected.phoneUrl));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect phone" }));
  await waitFor(() => expect(native.disconnect).toHaveBeenCalledWith({ connectionId: connected.connectionId, epoch: connected.epoch }));
  await waitFor(() => expect(screen.queryByLabelText("Phone link")).toBeNull());
});

it("requires native cloud workspace and device provenance before Connect", async () => {
  const native = api();
  vi.mocked(native.status).mockResolvedValue({ state: "stopped", workspaceId: "workspace" });
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  expect(await screen.findByRole("status")).toHaveTextContent("Connect this computer to the selected account workspace");
  expect(screen.getByRole("button", { name: "Connect phone" })).toBeDisabled();
  expect(native.connect).not.toHaveBeenCalled();
});

it("fails closed when native status belongs to another workspace", async () => {
  const native = api();
  vi.mocked(native.status).mockResolvedValue({ ...connected, workspaceId: "another-workspace" });
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Select this workspace");
  expect(screen.getByRole("button", { name: "Connect phone" })).toBeDisabled();
  expect(screen.queryByLabelText("Phone link")).toBeNull();
  expect(native.connect).not.toHaveBeenCalled();
});

it("discards an old account reply even when the public workspace id is unchanged", async () => {
  const native = api();
  let finish!: (status: PhoneRelayStatus) => void;
  vi.mocked(native.status).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  setActiveRuntimeDataScope("workspace", "account-b");
  view.rerender(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect phone" })).toBeEnabled());
  await act(async () => finish(connected));
  expect(screen.queryByLabelText("Phone link")).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect phone" })).toBeNull();
});

it("does not let an older read replace a newly connected native session", async () => {
  const native = api();
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect phone" })).toBeEnabled());
  let finish!: (status: PhoneRelayStatus) => void;
  vi.mocked(native.status).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Check phone status" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
  expect(await screen.findByLabelText("Phone link")).toHaveValue(connected.phoneUrl);
  await act(async () => finish(stopped));
  expect(screen.getByLabelText("Phone link")).toHaveValue(connected.phoneUrl);
});

it("bounds lost mutation replies and requires a fresh read without replaying Connect", async () => {
  vi.useFakeTimers();
  const native = api();
  let finish!: (status: PhoneRelayStatus) => void;
  vi.mocked(native.connect).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
  expect(screen.getByRole("alert")).toHaveTextContent("may have completed");
  expect(screen.getByRole("button", { name: "Connect phone" })).toBeDisabled();
  await act(async () => finish(connected));
  expect(screen.queryByLabelText("Phone link")).toBeNull();
  vi.mocked(native.status).mockResolvedValue(connected);
  fireEvent.click(screen.getByRole("button", { name: "Check phone status" }));
  await act(async () => {});
  expect(screen.getByLabelText("Phone link")).toHaveValue(connected.phoneUrl);
  expect(native.connect).toHaveBeenCalledTimes(1);
});

it("shows transport conflicts without stopping or replacing another connection", async () => {
  const native = api();
  vi.mocked(native.connect).mockRejectedValue(new Error("Stop the manual MCP server before connecting your phone."));
  render(<ManagedPhoneSettings workspaceId="workspace" api={native} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect phone" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Stop the manual MCP server");
  expect(native.disconnect).not.toHaveBeenCalled();
  expect(native.connect).toHaveBeenCalledTimes(1);
});
