import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CloudComputerPanel } from "./CloudComputerPanel";
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
const port = vi.hoisted(() => ({
  open: vi.fn(),
  close: vi.fn(),
  resize: vi.fn(),
}));
vi.mock("../../hooks/useCloudComputer", () => ({
  useCloudComputer: () => ({
    status: {
      connected: true,
      connectionRevision: 4,
      machine: { id: "machine-one", name: "Research", status: "running" },
    },
    pending: false,
    error: null,
    refresh: vi.fn(),
    act: vi.fn(),
  }),
}));
vi.mock("../../hooks/useCloudViewer", () => ({
  useCloudViewer: () => ({
    ...port,
    viewer: null,
    pending: false,
    error: null,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  port.close.mockResolvedValue(true);
});
it("opens the native view at the actual narrow sidebar bounds", () => {
  render(<CloudComputerPanel workspaceId="one" onClose={() => {}} />);
  vi.spyOn(
    screen.getByLabelText("Native desktop viewer"),
    "getBoundingClientRect",
  ).mockReturnValue({ x: 900, y: 150, width: 318, height: 240 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "View desktop" }));
  expect(port.open).toHaveBeenCalledExactlyOnceWith({
    x: 900,
    y: 150,
    width: 318,
    height: 240,
  });
  expect(
    screen.getByText(/revokes all Instabox desktop streams/),
  ).toBeVisible();
});
it("never opens a different selected machine for captured work", () => {
  render(
    <CloudComputerPanel
      workspaceId="one"
      machineId="machine-other"
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("exact machine");
  expect(screen.queryByRole("button", { name: "View desktop" })).toBeNull();
  expect(port.open).not.toHaveBeenCalled();
});
it("keeps the panel available when native stream closure is unconfirmed", async () => {
  port.close.mockResolvedValue(false);
  const onClose = vi.fn();
  render(<CloudComputerPanel workspaceId="one" onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Close computer" }));
  await Promise.resolve();
  expect(port.close).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});
