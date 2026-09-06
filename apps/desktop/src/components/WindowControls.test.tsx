import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";
const mocks = vi.hoisted(() => ({ native: true, invoke: vi.fn(async () => {}) }));
vi.mock("../runtime/adapters/select", () => ({ hasNativeRuntimeAdapter: () => mocks.native, getRuntimeAdapter: () => ({ invoke: mocks.invoke }) }));
beforeEach(() => { mocks.native = true; mocks.invoke.mockReset().mockResolvedValue(undefined); });
it("routes window actions and dragging through the native boundary", () => {
  const view = render(<WindowControls />);
  fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
  fireEvent.click(screen.getByRole("button", { name: "Maximize or restore window" }));
  fireEvent.click(screen.getByRole("button", { name: "Close window" }));
  fireEvent.mouseDown(view.container.querySelector(".window-controls__drag")!, { button: 0, detail: 1 });
  expect(mocks.invoke.mock.calls).toEqual(["minimize", "maximize", "close", "drag"].map((action) => ["control_main_window", { action }]));
});
it("does not display native controls in the web app", () => {
  mocks.native = false;
  const view = render(<WindowControls />);
  expect(view.container).toBeEmptyDOMElement();
});
it("reports a failed window action", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("closed"));
  render(<WindowControls />);
  fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Window control failed"));
});
