import type { BackendProvider, MivletAgentProfile } from "@mivlet/protocol";
import { supportsSharedComputerTools } from "@mivlet/connectors/native-api/computer-vision";
import { resolveProviderModelOption, type ProviderModelOption } from "./provider-models";

/** Public profile metadata only. Never expose private instructions, learned
 * memory, conversation IDs, credential material or another agent's files. */
export function workspaceAgentDirectory(
  agents: readonly MivletAgentProfile[],
  models: ProviderModelOption[],
  providers: readonly BackendProvider[],
) {
  return agents.slice(0, 100).map((agent) => {
    const model = resolveProviderModelOption(models, agent.modelId);
    const provider = providers.find((item) => item.id === model?.providerId);
    const available = Boolean(model && model.available !== false && provider?.authState === "connected");
    return {
      agentId: agent.id,
      name: agent.name,
      model: model?.label ?? "Unavailable model",
      permissions: agent.permissionLabel,
      skills: (agent.learnedTasks ?? []).slice(0, 12).map((task) => task.title.slice(0, 120)),
      available,
      coordination: available && supportsSharedComputerTools(provider) && provider?.capabilities.includes("approvals") === true && model?.capabilities?.tools !== false,
      prerequisite: available ? undefined : "Connect this agent's configured provider and select an available model.",
    };
  });
}
