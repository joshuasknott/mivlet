import type { FableAgentProfile } from "@fable/protocol";
import { ProfileAgentAvatar } from "./agent-icons";

export function AgentProgress({ agent, running, transcript, summaries = {}, activity }: {
  agent: FableAgentProfile;
  running: boolean;
  transcript: string;
  summaries?: Record<string, string>;
  activity?: string;
}) {
  const summary = Object.values(summaries).join("\n\n");
  return <>
    {summary ? <details className="conversation-progress" open={running}><summary>Reasoning summary</summary><p>{summary}</p></details> : null}
    {running ? <article className="conversation-message conversation-message--assistant conversation-message--working">
      <div className="conversation-message__author"><ProfileAgentAvatar agent={agent} iconSize={28} thinking /><strong>{agent.name}</strong></div>
      {activity ? <p className="conversation-progress" role="status">{activity}</p> : null}
      <p>{transcript || (summary ? "Working…" : "Thinking…")}</p>
    </article> : null}
  </>;
}
