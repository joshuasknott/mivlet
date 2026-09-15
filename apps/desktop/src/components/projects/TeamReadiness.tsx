import type { BackendProvider, FableAgentProfile } from "@fable/protocol";
import { supportsSharedComputerTools } from "@fable/connectors/native-api/computer-vision";
import {
  resolveProviderModelOption,
  type ProviderModelOption,
} from "../../lib/provider-models";
import "./projects.css";

type TeamRouteState =
  | "ready"
  | "agent-missing"
  | "model-missing"
  | "provider-disconnected"
  | "route-unsupported";

export interface TeamRouteReadiness {
  agentId: string;
  name: string;
  state: TeamRouteState;
  summary: string;
  prerequisite?: string;
}

/**
 * Resolve each participant's exact reply route before work is admitted. A
 * provider-owned route without Mivlet's collaboration bridge is reported as an
 * accurate prerequisite instead of a silent fallback.
 */
export function teamRouteReadiness(
  participantIds: string[],
  agents: FableAgentProfile[],
  models: ProviderModelOption[],
  providers: BackendProvider[],
): TeamRouteReadiness[] {
  return participantIds.map((agentId) => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent)
      return {
        agentId,
        name: "Removed agent",
        state: "agent-missing",
        summary: "This participant is no longer a persisted agent.",
        prerequisite: "Choose a current agent for this Project Team.",
      };
    if (!agent.modelId)
      return {
        agentId,
        name: agent.name,
        state: "model-missing",
        summary: `${agent.name} has no saved model.`,
        prerequisite: `Choose a model for ${agent.name}.`,
      };
    const model = resolveProviderModelOption(models, agent.modelId);
    if (!model || !model.available)
      return {
        agentId,
        name: agent.name,
        state: "model-missing",
        summary: `${agent.name}'s saved model is unavailable.`,
        prerequisite: `Choose a current model for ${agent.name}.`,
      };
    const provider = providers.find((candidate) => candidate.id === model.providerId);
    if (!provider || provider.authState !== "connected")
      return {
        agentId,
        name: agent.name,
        state: "provider-disconnected",
        summary: `${agent.name} uses ${model.providerLabel} · ${model.label}, which is not connected.`,
        prerequisite: `Connect ${model.providerLabel} before ${agent.name} can reply.`,
      };
    if (!supportsSharedComputerTools(provider) || model.capabilities?.tools === false)
      return {
        agentId,
        name: agent.name,
        state: "route-unsupported",
        summary: `${agent.name} replies through ${provider.label}, which has no Mivlet collaboration-tool bridge.`,
        prerequisite:
          "Choose a provider route that supports Mivlet collaboration tools, or keep this teammate in a direct Chat without delegation.",
      };
    return {
      agentId,
      name: agent.name,
      state: "ready",
      summary: `${agent.name} is ready on ${model.label} through ${provider.label}.`,
    };
  });
}

export function TeamReadiness({
  participantIds,
  agents,
  models,
  providers,
  compact = false,
}: {
  participantIds: string[];
  agents: FableAgentProfile[];
  models: ProviderModelOption[];
  providers: BackendProvider[];
  compact?: boolean;
}) {
  const readiness = teamRouteReadiness(participantIds, agents, models, providers);
  if (!readiness.length) return null;
  return (
    <ul
      className={`team-readiness${compact ? " team-readiness--compact" : ""}`}
      aria-label="Participant route readiness"
    >
      {readiness.map((entry) => (
        <li key={entry.agentId} data-state={entry.state}>
          <strong>{entry.name}</strong>
          <small>{entry.prerequisite ?? entry.summary}</small>
        </li>
      ))}
    </ul>
  );
}
