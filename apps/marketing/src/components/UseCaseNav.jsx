import { getScenario, scenarioOrder } from "./demo-data.js";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { agentCast } from "./agent-cast.js";
import "./use-case-nav.css";

const examples = scenarioOrder.map(getScenario);

export function AgentPortraits({
  className = "",
  activeAgent,
  isTyping = false,
  onSelect,
  replayKey = 0,
}) {
  const Portrait = onSelect ? "button" : "span";
  return (
    <div
      className={`agent-portraits ${className}`}
      data-active-agent={activeAgent || undefined}
      aria-hidden={onSelect ? undefined : true}
      role={onSelect ? "group" : undefined}
      aria-label={onSelect ? "Choose an example prompt" : undefined}
    >
      {examples.map(({ id, agent, accent }) => (
        <Portrait
          key={agent}
          type={onSelect ? "button" : undefined}
          aria-label={onSelect ? `Show ${agent}'s example` : undefined}
          aria-pressed={onSelect ? activeAgent === agent : undefined}
          title={onSelect ? `${agent}'s example` : undefined}
          onClick={
            onSelect
              ? (event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  onSelect(id);
                }
              : undefined
          }
          className="agent-portrait"
          data-agent={agent}
          data-active={activeAgent === agent || undefined}
          data-typing={(activeAgent === agent && isTyping) || undefined}
          style={{ "--portrait-accent": accent }}
        >
          <AgentAvatar
            key={replayKey}
            name={agent}
            size={96}
            className="agent-portrait__avatar"
          />
        </Portrait>
      ))}
    </div>
  );
}

export function UseCaseNav({ scenario, onChange }) {
  const moveFocus = (event, index) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % examples.length;
    if (event.key === "ArrowLeft")
      next = (index + examples.length - 1) % examples.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = examples.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onChange(examples[next].id);
    const selectedTab = document.getElementById(
      `use-case-${examples[next].id}`,
    );
    selectedTab.focus({ preventScroll: true });
    selectedTab.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <div
      className="use-case-nav"
      role="tablist"
      aria-label="Explore Mivlet with an agent"
    >
      {examples.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`use-case-${item.id}`}
          aria-controls="product-scene"
          aria-selected={scenario === item.id}
          tabIndex={scenario === item.id ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => moveFocus(event, index)}
          style={{ "--agent-accent": item.accent }}
        >
          <AgentAvatar
            name={item.agent}
            size={64}
            className="use-case-avatar"
          />
          <span className="use-case-copy">
            <strong>{item.agent}</strong>
            <span>
              {agentCast.find((agent) => agent.name === item.agent)?.role}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
