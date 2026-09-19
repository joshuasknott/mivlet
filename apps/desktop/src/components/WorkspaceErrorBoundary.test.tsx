import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";

describe("workspace recovery", () => {
  it("renders the workspace normally", () => {
    render(
      <WorkspaceErrorBoundary>
        <p>Conversation</p>
      </WorkspaceErrorBoundary>,
    );
    expect(screen.getByText("Conversation")).toBeInTheDocument();
  });

  it("replaces a render crash with recovery without showing error contents", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenWorkspace(): never {
      throw new Error("private conversation canary");
    }
    try {
      render(
        <WorkspaceErrorBoundary>
          <BrokenWorkspace />
        </WorkspaceErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your workspace could not be displayed",
      );
      expect(
        screen.getByRole("button", { name: "Reload Mivlet" }),
      ).toBeEnabled();
      expect(
        screen.queryByText(/private conversation canary/),
      ).not.toBeInTheDocument();
    } finally {
      log.mockRestore();
    }
  });
});
