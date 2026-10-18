import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";

describe("workspace title bar", () => {
  it("runs useful menu actions and restores keyboard focus on Escape", () => {
    const onNewConversation = vi.fn();
    const onSearch = vi.fn();
    render(<WorkspaceMenuBar canGoBack={false} canGoForward={false} onBack={vi.fn()} onForward={vi.fn()}
      onNewConversation={onNewConversation} onNewProject={vi.fn()} onSettings={vi.fn()}
      onSearch={onSearch} onSingleView={vi.fn()} onTheme={vi.fn()} theme="light" />);
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "View" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Search · Ctrl K" }));
    expect(onSearch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
