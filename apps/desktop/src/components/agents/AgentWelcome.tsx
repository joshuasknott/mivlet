import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

const newAgentSuggestions = [
  "Keep me on top of daily work",
  "Research and prepare briefs",
  "Own a specific project"
];

const returningAgentSuggestions = [
  "Plan my priorities",
  "Research something",
  "Draft an update"
];

export function AgentWelcome({
  agent,
  onChoose
}: {
  agent: FableAgentProfile;
  onChoose: (prompt: string) => void;
}) {
  const needsPurpose = !agent.instructions.trim();
  const suggestions = needsPurpose ? newAgentSuggestions : returningAgentSuggestions;

  return (
    <section className="agent-welcome" aria-labelledby="agent-welcome-title">
      <div className="agent-welcome__message">
        <ProfileAgentAvatar agent={agent} iconSize={34} />
        <div>
          <strong id="agent-welcome-title">{agent.name}</strong>
          <p>
            {needsPurpose
              ? "Hey. Fresh start — what do you want me around for? Daily work, a project, research, or something else?"
              : "What should we work on? Give me the outcome and I’ll take it from there."}
          </p>
        </div>
      </div>
      <div className="agent-welcome__suggestions" role="group" aria-label="Conversation starters">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onChoose(suggestion)}>
            {suggestion}
          </button>
        ))}
        <button type="button" onClick={() => onChoose("")}>Something else</button>
      </div>
    </section>
  );
}
