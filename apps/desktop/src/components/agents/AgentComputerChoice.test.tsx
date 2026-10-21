import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentComputerChoice } from "./AgentComputerChoice";
const port = vi.hoisted(() => ({ cloudComputerStatus: vi.fn(), changeCloudComputer: vi.fn() }));
vi.mock("../../runtime/domains/cloud-computers", () => port);
beforeEach(() => { vi.resetAllMocks(); port.cloudComputerStatus.mockResolvedValue({connected:true,connectionRevision:4,machine:{id:"machine-one",name:"Research",status:"running"}}); });
it("defaults to This PC until the user explicitly selects a connected exact machine", async () => {
  const change = vi.fn();
  render(<AgentComputerChoice workspaceId="one" onChange={change} />);
  expect(screen.getByLabelText("Computer")).toHaveValue("local");
  await waitFor(() => expect(screen.getByRole("option", {name:"Cloud · Instabox"})).toBeEnabled());
  await userEvent.selectOptions(screen.getByLabelText("Computer"),"instabox");
  expect(change).toHaveBeenCalledWith({kind:"instabox",machineId:"machine-one",connectionRevision:4});
});
it("preserves an unavailable cloud selection without silently selecting This PC", async () => {
  port.cloudComputerStatus.mockResolvedValue({connected:false,connectionRevision:5,machine:null});
  const change = vi.fn();
  render(<AgentComputerChoice workspaceId="one" value={{kind:"instabox",machineId:"machine-one",connectionRevision:4}} onChange={change} />);
  expect(await screen.findByRole("option",{name:/reconnect in Settings/})).toBeDisabled();
  expect(screen.getByLabelText("Computer")).toHaveValue("instabox");
  expect(change).not.toHaveBeenCalled();
});
it("keeps malformed saved preferences visibly invalid until the user chooses", async () => {
  const change = vi.fn();
  render(<AgentComputerChoice workspaceId="one" invalid value={{kind:"local"}} onChange={change} />);
  expect(screen.getByLabelText("Computer")).toHaveValue("invalid");
  expect(screen.getByRole("alert")).toHaveTextContent("invalid");
  expect(change).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText("Computer"), "local");
  expect(change).toHaveBeenCalledExactlyOnceWith({kind:"local"});
});
