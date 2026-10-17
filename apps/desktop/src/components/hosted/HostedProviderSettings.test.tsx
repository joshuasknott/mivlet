import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedProviderConnection } from "@mivlet/protocol";
import { clearActiveRuntimeDataScope, setActiveRuntimeDataScope } from "../../runtime-scope";
import { HostedProviderSettings, type HostedProviderApi } from "./HostedProviderSettings";

const agents = [{ id: "atlas", name: "Atlas" }, { id: "nova", name: "Nova" }];
const connection: HostedProviderConnection = { credentialId: "cloud", providerId: "openai", revision: 7, enabled: true, createdAt: 1, updatedAt: 2, expiresAt: Date.now() + 1_000_000 };
beforeEach(() => setActiveRuntimeDataScope("workspace", "account-a"));
afterEach(() => clearActiveRuntimeDataScope());
it("sends only native masked enrollment metadata and revokes the exact current revision", async () => {
  const api: HostedProviderApi = { list: vi.fn().mockResolvedValue([connection]), enroll: vi.fn().mockResolvedValue(connection), revoke: vi.fn().mockResolvedValue({ ...connection, enabled: false }) };
  render(<HostedProviderSettings workspaceId="workspace" agents={agents} api={api} />);
  const replace = await screen.findByRole("button", { name: "Replace key" });
  await waitFor(() => expect(replace).toBeEnabled());
  fireEvent.click(replace);
  await waitFor(() => expect(api.enroll).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "atlas", providerId: "openai", credentialId: "cloud", expectedRevision: 7 }));
  expect(screen.queryByLabelText(/API key/i)).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(api.revoke).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "atlas", credentialId: "cloud", revision: 7 }));
});
it("does not show the previous agent's late connection read in the new agent", async () => {
  let finish!: (connections: HostedProviderConnection[]) => void;
  const api: HostedProviderApi = { list: vi.fn().mockImplementation(scope => scope.agentId === "atlas" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([])), enroll: vi.fn(), revoke: vi.fn() };
  render(<HostedProviderSettings workspaceId="workspace" agents={agents} api={api} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Cloud connection agent" }), { target: { value: "nova" } });
  await waitFor(() => expect(screen.getAllByText("Not connected")).toHaveLength(5));
  await act(async () => finish([connection]));
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Connect hosted API key" })[0]);
  await waitFor(() => expect(api.enroll).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "nova", providerId: "openai" }));
});

it("keeps every enabled connection reachable for exact revocation", async () => {
  const older = { ...connection, credentialId: "older-key", revision: 2, updatedAt: 1 };
  const api: HostedProviderApi = { list: vi.fn().mockResolvedValue([older, connection]), enroll: vi.fn(), revoke: vi.fn().mockResolvedValue({ ...older, enabled: false }) };
  render(<HostedProviderSettings workspaceId="workspace" agents={agents} api={api} />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
  await waitFor(() => expect(api.revoke).toHaveBeenCalledWith({ workspaceId: "workspace", agentId: "atlas", credentialId: "older-key", revision: 2 }));
});
