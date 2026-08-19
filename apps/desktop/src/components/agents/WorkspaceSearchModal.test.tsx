import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FableAgentProfile } from "@fable/protocol";
import { WorkspaceSearchModal, type WorkspaceSearchItem } from "./WorkspaceSearchModal";

afterEach(cleanup);

const agent: FableAgentProfile = {
  id: "chief-of-staff",
  name: "Chief of Staff",
  instructions: "Keep priorities clear.",
  modelId: "",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me"
};

const items: WorkspaceSearchItem[] = [
  { id: agent.id, scope: "agents", action: "agent", title: agent.name, description: "Your priorities are ready", agent },
  { id: "launch", scope: "work", action: "project", title: "Launch Fable", description: "Product launch work" },
  { id: "daily-brief", scope: "work", action: "schedule", title: "Daily brief", description: "Weekdays at 08:00" },
  { id: "voice", scope: "knowledge", action: "knowledge", title: "Voice principles", description: "Calm and direct" },
  { id: "gmail", scope: "connections", action: "connection", title: "Gmail", description: "Installed", meta: "Installed" }
];

describe("WorkspaceSearchModal", () => {
  it("searches across workspace entities and filters without exposing conversations as a separate product area", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceSearchModal open items={items} onClose={() => {}} onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search this workspace" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Conversations" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(screen.getByRole("button", { name: /Voice principles/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Chief of Staff/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByRole("button", { name: /Launch Fable/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Daily brief/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Search this workspace" }), "gmail");
    await user.click(screen.getByRole("button", { name: /Gmail/ }));
    expect(onSelect).toHaveBeenCalledWith(items[4]);
  });
});
