import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@mivlet/protocol";
import {
  McpAppApprovalPortal,
  useMcpAppApprovalTarget,
} from "./McpAppApprovalPortal";

const owner = {
  workspaceId: "workspace",
  conversationId: "conversation",
  resultId: "revision",
  generation: 3,
};

const approval = {
  id: "mcp-approval",
  service: "MCP resources",
  action: "Read enabled MCP resource",
  mode: "read-only",
  riskLevel: "medium",
  dataUsed: [],
  consequence: "Loads the interactive result",
  requestedAt: "2026-10-09T00:00:00.000Z",
  decisions: ["once", "deny"],
} as unknown as ApprovalRequest;

describe("MCP App approval portal", () => {
  it("moves the owning approval into a docked panel and removes it on teardown", async () => {
    const target = document.createElement("div");
    target.dataset.mcpAppPanel =
      "mcp-app:workspace:conversation:revision:3";
    const panel = document.createElement("aside");
    panel.hidden = true;
    panel.append(target);
    document.body.append(panel);
    function Fixture() {
      const targetElement = useMcpAppApprovalTarget(
        new Map([[approval.id, owner]]),
      );
      return (
        <McpAppApprovalPortal target={targetElement}>
          <button type="button">Approve MCP request</button>
        </McpAppApprovalPortal>
      );
    }
    render(<Fixture />);
    expect(screen.queryByRole("button", { name: "Approve MCP request" })).not.toBeInTheDocument();
    await act(async () => { panel.hidden = false; });
    await waitFor(() => {
      expect(target).toContainElement(screen.getByRole("button", { name: "Approve MCP request" }));
    });

    await act(async () => { panel.hidden = true; });
    await waitFor(() => {
      expect(target).toBeEmptyDOMElement();
    });
    await act(async () => { panel.hidden = false; });
    await waitFor(() => {
      expect(target).toContainElement(screen.getByRole("button", { name: "Approve MCP request" }));
    });

    await act(async () => { target.remove(); });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Approve MCP request" })).not.toBeInTheDocument();
    });
    panel.remove();
  });
});
