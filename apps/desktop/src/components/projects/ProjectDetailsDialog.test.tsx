import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectDetailsDialog } from "./ProjectDetailsDialog";
vi.mock("../../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("./ProjectContextPanel", () => ({ ProjectContextPanel: () => <input aria-label="Project name" /> }));
it("opens in the right panel without blocking the conversation and closes with Escape or Close", () => {
  const onClose = vi.fn();
  const props = { project: { name: "Launch" }, onClose } as unknown as ComponentProps<typeof ProjectDetailsDialog>;
  render(<><button>Conversation</button><ProjectDetailsDialog {...props} /></>);
  const panel = screen.getByRole("dialog", { name: "Launch settings" });
  expect(panel).not.toHaveAttribute("aria-modal");
  expect(panel.parentElement).toHaveClass("workspace-context", "agent-settings-panel");
  expect(screen.getByRole("button", { name: "Conversation" })).not.toHaveAttribute("inert");
  fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Close project settings" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
