import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MivletAgentProfile } from "@mivlet/protocol";
import { SidebarCreateMenu } from "./SidebarCreateMenu";

const agent: MivletAgentProfile = { id: "mira", name: "Mira", instructions: "", modelId: "", icon: "agent", iconColor: "#865DFA", connectorIds: [], knowledgeSourceIds: [], permissionLabel: "Ask Me" };

describe("sidebar create picker", () => {
  it("routes creation and agent selection, closing after each choice", async () => {
    const user = userEvent.setup();
    const onCreateAgent = vi.fn(), onCreateProject = vi.fn(), onSelectAgent = vi.fn();
    render(<SidebarCreateMenu agents={[agent]} {...{ onCreateAgent, onCreateProject, onSelectAgent }} />);
    for (const label of ["Create agent", "Create project", "Message Mira"]) {
      await user.click(screen.getByRole("button", { name: "Create or message" }));
      expect(screen.getByRole("searchbox")).toHaveFocus();
      await user.click(screen.getByRole("button", { name: label }));
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(onCreateAgent).toHaveBeenCalledOnce();
    expect(onCreateProject).toHaveBeenCalledOnce();
    expect(onSelectAgent).toHaveBeenCalledWith(agent);
  });

  it("filters agents while retaining creation, and supports keyboard and outside dismissal", async () => {
    const user = userEvent.setup();
    render(<SidebarCreateMenu agents={[agent]} onCreateAgent={vi.fn()} onSelectAgent={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Create or message" });
    await user.click(trigger);
    await user.type(screen.getByRole("searchbox"), "unknown");
    expect(screen.queryByRole("button", { name: "Message Mira" })).toBeNull();
    expect(screen.getByText("No matching agents.")).toBeVisible();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Create agent" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Message Mira" })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
