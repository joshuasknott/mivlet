import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorManifest, FableAgentProfile } from "@fable/protocol";
import { MarketplacePage } from "./MarketplacePage";

const github: ConnectorManifest = {
  id: "github",
  name: "GitHub",
  status: "needs-auth",
  permissions: ["Repositories"],
  healthSummary: "Not connected",
  lastCheckedAt: "Not checked",
  authMode: "oauth-broker",
  supportsSearch: false,
  supportsImport: false,
  supportedActions: [],
};

const agent: FableAgentProfile = {
  id: "agent-1",
  name: "Mira",
  instructions: "Help with product work.",
  modelId: "openai::gpt-5",
  icon: "agent",
  iconColor: "#865DFA",
  connectorIds: [],
  knowledgeSourceIds: [],
  permissionLabel: "Ask Me",
  learnedTasks: [
    {
      id: "skill-1",
      title: "Launch brief",
      instruction: "Prepare a concise launch brief with source links.",
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
  ],
};

function renderMarketplace(
  activeTab: React.ComponentProps<typeof MarketplacePage>["activeTab"],
  onTabChange = vi.fn(),
) {
  return render(
    <MarketplacePage
      activeTab={activeTab}
      onTabChange={onTabChange}
      manifests={[github]}
      accounts={{}}
      connectorStatus={null}
      onUseConnector={vi.fn()}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onRefresh={vi.fn()}
      onSelectConnector={vi.fn()}
      onSwitchAccount={vi.fn()}
      agents={[agent]}
      activeAgentId={agent.id}
      onCreateSkill={vi.fn()}
      onManageSkills={vi.fn()}
      onRunSkill={vi.fn()}
    />,
  );
}

describe("MarketplacePage", () => {
  it("uses the Plugins and Skills switcher above the real connector directory", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderMarketplace("plugins", onTabChange);

    expect(screen.getByRole("button", { name: "Plugins" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Connect GitHub" })[0],
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(onTabChange).toHaveBeenCalledWith("skills");
  });

  it("surfaces persisted teammate skills with working run and create actions", async () => {
    const user = userEvent.setup();
    const onRunSkill = vi.fn();
    const onCreateSkill = vi.fn();
    render(
      <MarketplacePage
        activeTab="skills"
        onTabChange={vi.fn()}
        manifests={[github]}
        accounts={{}}
        connectorStatus={null}
        onUseConnector={vi.fn()}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onRefresh={vi.fn()}
        onSelectConnector={vi.fn()}
        onSwitchAccount={vi.fn()}
        agents={[agent]}
        activeAgentId={agent.id}
        onCreateSkill={onCreateSkill}
        onManageSkills={vi.fn()}
        onRunSkill={onRunSkill}
      />,
    );

    expect(screen.getByText("Launch brief")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(onRunSkill).toHaveBeenCalledWith(agent.id, agent.learnedTasks?.[0]);

    await user.click(
      screen.getByRole("button", { name: "Create a skill for Mira" }),
    );
    expect(onCreateSkill).toHaveBeenCalledWith(agent.id);
  });
});
