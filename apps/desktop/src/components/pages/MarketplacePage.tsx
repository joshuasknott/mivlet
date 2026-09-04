import type {
  ConnectorAccountOption,
  ConnectorManifest,
  FableAgentProfile,
  FableLearnedTask,
} from "@fable/protocol";
import { useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { PluginPanel } from "../PluginPanel";
import { ProfileAgentAvatar } from "../agents/agent-icons";

export type MarketplaceTab = "plugins" | "skills";

export function MarketplacePage({
  activeTab,
  onTabChange,
  manifests,
  accounts,
  connectorStatus,
  onUseConnector,
  onConnect,
  onDisconnect,
  onRefresh,
  onSelectConnector,
  onSwitchAccount,
  agents,
  activeAgentId,
  onCreateSkill,
  onManageSkills,
  onRunSkill,
}: {
  activeTab: MarketplaceTab;
  onTabChange: (tab: MarketplaceTab) => void;
  manifests: ConnectorManifest[];
  accounts: Record<string, ConnectorAccountOption[]>;
  connectorStatus: string | null;
  onUseConnector: (connector: ConnectorManifest) => void;
  onConnect: (connector: ConnectorManifest) => void;
  onDisconnect: (connectorId: string) => void;
  onRefresh: (connectorId: string) => void;
  onSelectConnector: (connector: ConnectorManifest) => void;
  onSwitchAccount: (connectorId: string, connectionId: string) => void;
  agents: FableAgentProfile[];
  activeAgentId: string;
  onCreateSkill: (agentId: string) => void;
  onManageSkills: (agentId: string) => void;
  onRunSkill: (agentId: string, task: FableLearnedTask) => void;
}) {
  return (
    <section
      className="workspace marketplace-workspace"
      aria-label="Plugins and skills"
    >
      <nav className="marketplace-switcher" aria-label="Plugins and skills">
        <button
          type="button"
          className={activeTab === "plugins" ? "is-active" : undefined}
          aria-current={activeTab === "plugins" ? "page" : undefined}
          onClick={() => onTabChange("plugins")}
        >
          Plugins
        </button>
        <button
          type="button"
          className={activeTab === "skills" ? "is-active" : undefined}
          aria-current={activeTab === "skills" ? "page" : undefined}
          onClick={() => onTabChange("skills")}
        >
          Skills
        </button>
      </nav>

      <div className="marketplace-scroll">
        <div className="marketplace-content">
          {activeTab === "plugins" ? (
            <PluginPanel
              manifests={manifests}
              onUseConnector={onUseConnector}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRefresh={onRefresh}
              onSelect={onSelectConnector}
              accounts={accounts}
              onSwitchAccount={onSwitchAccount}
            />
          ) : (
            <SkillsPanel
              agents={agents}
              activeAgentId={activeAgentId}
              onCreateSkill={onCreateSkill}
              onManageSkills={onManageSkills}
              onRunSkill={onRunSkill}
            />
          )}
          {connectorStatus && activeTab === "plugins" ? (
            <p className="marketplace-runtime-status" role="status">
              {connectorStatus}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SkillsPanel({
  agents,
  activeAgentId,
  onCreateSkill,
  onManageSkills,
  onRunSkill,
}: {
  agents: FableAgentProfile[];
  activeAgentId: string;
  onCreateSkill: (agentId: string) => void;
  onManageSkills: (agentId: string) => void;
  onRunSkill: (agentId: string, task: FableLearnedTask) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeAgent =
    agents.find((candidate) => candidate.id === activeAgentId) ?? agents[0];
  const learned = agents.flatMap((agent) =>
    (agent.learnedTasks ?? []).map((task) => ({ agent, task })),
  );
  const visible = normalizedQuery
    ? learned.filter(({ agent, task }) =>
        [agent.name, task.title, task.instruction]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : learned;

  return (
    <section className="skills-marketplace" aria-labelledby="skills-title">
      <header className="marketplace-page-header">
        <div>
          <h1 id="skills-title">Skills</h1>
          <p>Repeatable work your teammates have learned from you.</p>
        </div>
        <div className="skills-marketplace__actions">
          <label className="connections-search">
            <MagnifyingGlass size={17} aria-hidden="true" />
            <span className="sr-only">Search skills</span>
            <input
              type="search"
              placeholder="Search skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="skills-marketplace__add"
            disabled={!activeAgent}
            aria-label={
              activeAgent
                ? `Create a skill for ${activeAgent.name}`
                : "Create a skill"
            }
            onClick={() => activeAgent && onCreateSkill(activeAgent.id)}
          >
            <Plus size={20} />
          </button>
        </div>
      </header>

      {visible.length ? (
        <section
          className="marketplace-section"
          aria-labelledby="your-skills-title"
        >
          <h2 id="your-skills-title">Your skills</h2>
          <div className="skills-grid">
            {visible.map(({ agent, task }) => (
              <article className="skill-card" key={`${agent.id}-${task.id}`}>
                <div className="skill-card__owner">
                  <ProfileAgentAvatar agent={agent} iconSize={28} />
                  <span>{agent.name}</span>
                </div>
                <div className="skill-card__copy">
                  <h3>{task.title}</h3>
                  <p>{task.instruction}</p>
                </div>
                <div className="skill-card__actions">
                  <button
                    type="button"
                    onClick={() => onRunSkill(agent.id, task)}
                  >
                    <Play size={15} weight="fill" />
                    Run
                  </button>
                  <button
                    type="button"
                    onClick={() => onManageSkills(agent.id)}
                  >
                    Manage
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <div className="skills-marketplace__empty" role="status">
          <strong>
            {normalizedQuery
              ? "No skills match this search"
              : "You don’t have any skills yet"}
          </strong>
          <p>
            {normalizedQuery
              ? "Try a teammate name, responsibility, or instruction."
              : "Teach a teammate a specific, repeatable task and it will appear here."}
          </p>
          {!normalizedQuery && activeAgent ? (
            <button type="button" onClick={() => onCreateSkill(activeAgent.id)}>
              Create a skill for {activeAgent.name}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
