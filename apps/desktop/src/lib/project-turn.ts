import type { FableAgentProfile } from "@fable/protocol";
import type { ProviderModelOption } from "./provider-models";

export interface ProjectContribution {
  agentId: string;
  providerId: string;
  modelId: string;
  modelOptionId: string;
  reasoningEffort?: FableAgentProfile["reasoningEffort"];
}

/** Snapshot explicit recipients and their routes before starting any work. */
export function projectContributions(agents: FableAgentProfile[], recipient: string, models: ProviderModelOption[]): ProjectContribution[] {
  const selected = recipient === "all" ? agents : agents.filter((agent) => agent.id === recipient);
  if (!selected.length) throw new Error("Choose an available agent for this project.");
  if (selected.length > 8) throw new Error("Choose one agent when your workspace has more than eight agents.");
  return selected.map((agent) => {
    const model = models.find((candidate) => candidate.id === agent.modelId && candidate.available);
    if (!model) throw new Error(`Choose a connected model for ${agent.name} before sending this project message.`);
    return { agentId: agent.id, providerId: model.providerId, modelId: model.modelId, modelOptionId: model.id,
      reasoningEffort: agent.reasoningEffort && model.reasoning?.supportedEfforts.includes(agent.reasoningEffort) ? agent.reasoningEffort : undefined };
  });
}

export function projectContributionPrompt(prompt: string, index: number): string {
  return index === 0 ? prompt : `Contribute to the user's project request below. Read the preceding project conversation and completed work first. Add your own relevant contribution, avoid repeating completed actions, and identify any remaining work. Do not claim another agent's work as your own.\n\nUser request:\n${prompt}`;
}
