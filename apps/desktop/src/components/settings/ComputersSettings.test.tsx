import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComputersSettings } from "./ComputersSettings";
import type { CloudComputerStatus } from "../../runtime/domains/cloud-computers";

const port = vi.hoisted(() => ({ cloudComputerStatus: vi.fn(), changeCloudComputer: vi.fn() }));
vi.mock("../../runtime/domains/cloud-computers", () => port);
const empty: CloudComputerStatus = { connected: false, provider: "instabox", connectionRevision: 0, selectedMachineId: null, machine: null, machines: [], usage: null, pendingAction: null, capabilities: [], error: null };
const machine = { id: "machine-one", name: "Research computer", status: "running" };
const connected: CloudComputerStatus = { ...empty, connected: true, connectionRevision: 2, machine, selectedMachineId: machine.id, machines: [machine], usage: { machineCount: 1, machineLimit: 1, snapshotCount: 0, snapshotLimit: 5 } };

beforeEach(() => { vi.resetAllMocks(); port.cloudComputerStatus.mockResolvedValue(empty); });

describe("Computers settings", () => {
  it("uses protected native entry without rendering an API-key field or creating a machine", async () => {
    port.changeCloudComputer.mockResolvedValue({ ...connected, machine: null });
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Instabox" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Connect Instabox" }));
    expect(port.changeCloudComputer).toHaveBeenCalledExactlyOnceWith("workspace-one", 0, { kind: "connect", agentId: "agent-one" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(await screen.findByLabelText("Existing machine")).toBeVisible();
  });

  it("keeps creation explicit and enforces observed account capacity", async () => {
    port.cloudComputerStatus.mockResolvedValue({ ...connected, machine: null });
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    expect(await screen.findByRole("button", { name: "Create a machine…" })).toBeDisabled();
    expect(screen.getByText(/no free machine slots/)).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText("Existing machine"), machine.id);
    port.changeCloudComputer.mockResolvedValue(connected);
    await userEvent.click(screen.getByRole("button", { name: "Use this machine" }));
    expect(port.changeCloudComputer).toHaveBeenCalledWith("workspace-one", 2, { kind: "select", machineId: machine.id });
  });

  it("returns from cancelled key entry without an error or refresh and permits another attempt", async () => {
    port.changeCloudComputer.mockResolvedValue(null);
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    const connect = await screen.findByRole("button", { name: "Connect Instabox" });
    await waitFor(() => expect(connect).toBeEnabled());
    await userEvent.click(connect);
    await waitFor(() => expect(connect).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Checking your computer…")).toBeNull();
    expect(port.cloudComputerStatus).toHaveBeenCalledOnce();
    await userEvent.click(connect);
    expect(port.changeCloudComputer).toHaveBeenCalledTimes(2);
    expect(port.changeCloudComputer).toHaveBeenLastCalledWith("workspace-one", 0, { kind: "connect", agentId: "agent-one" });
  });

  it("keeps the current machine, error and pending operation when replacement key entry is cancelled", async () => {
    port.cloudComputerStatus.mockResolvedValue({ ...connected, pendingAction: "pause", error: "Instabox rejected this API key." });
    port.changeCloudComputer.mockResolvedValueOnce(null).mockResolvedValue(connected);
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace API key" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace API key" })).toBeEnabled());
    expect(screen.getByText("Research computer · running", { selector: "small" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Instabox rejected this API key.");
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(port.cloudComputerStatus).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Check operation result" }));
    expect(port.changeCloudComputer).toHaveBeenLastCalledWith("workspace-one", 2, { kind: "reconcile" });
  });

  it("requires a separate acknowledgement and submits creation only once", async () => {
    port.cloudComputerStatus.mockResolvedValue({ ...connected, machine: null, machines: [], usage: { ...connected.usage!, machineCount: 0 } });
    port.changeCloudComputer.mockReturnValue(new Promise(() => {}));
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    await userEvent.click(await screen.findByRole("button", { name: "Create a machine…" }));
    expect(screen.getByRole("button", { name: "Create computer" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Create this machine in my own account." }));
    await userEvent.dblClick(screen.getByRole("button", { name: "Create computer" }));
    expect(port.changeCloudComputer).toHaveBeenCalledTimes(1);
    expect(port.changeCloudComputer).toHaveBeenCalledWith("workspace-one", 2, { kind: "create", name: "Mivlet computer" });
  });

  it("opens the existing panel and disconnects without deleting the machine", async () => {
    port.cloudComputerStatus.mockResolvedValue(connected);
    port.changeCloudComputer.mockResolvedValue(empty);
    const open = vi.fn();
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" onOpenComputer={open} />);
    await userEvent.click(await screen.findByRole("button", { name: "Open computer" }));
    expect(open).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(port.changeCloudComputer).toHaveBeenCalledWith("workspace-one", 2, { kind: "disconnect" });
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("keeps uncertain effects pending and offers reconciliation instead of duplicate changes", async () => {
    port.cloudComputerStatus.mockResolvedValue({ ...connected, pendingAction: "create" });
    port.changeCloudComputer.mockResolvedValue(connected);
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    expect(await screen.findByRole("button", { name: "Pause" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check operation result" }));
    expect(port.changeCloudComputer).toHaveBeenCalledWith("workspace-one", 2, { kind: "reconcile" });
  });

  it("offers a refresh after a failed check", async () => {
    port.cloudComputerStatus.mockRejectedValueOnce(new Error("Reconnect your revoked Instabox key."));
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("revoked");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("allows key recovery while an operation still needs reconciliation", async () => {
    port.cloudComputerStatus.mockResolvedValue({ ...connected, machine: null, pendingAction: "create", error: "Instabox rejected this API key." });
    port.changeCloudComputer.mockResolvedValue(connected);
    render(<ComputersSettings workspaceId="workspace-one" agentId="agent-one" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replace API key" }));
    expect(port.changeCloudComputer).toHaveBeenCalledExactlyOnceWith("workspace-one", 2, { kind: "connect", agentId: "agent-one" });
  });
});
