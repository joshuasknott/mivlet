import type { BackendProvider, WorkspaceManageResponse } from "@mivlet/protocol";
import type { ProviderModelOption } from "./provider-models";
import { workspaceAgentDirectory } from "./workspace-agent-directory";

/** Native results include profiles for the shell. Only this bounded public
 * projection crosses back to the model; never serialize the native response. */
export function workspaceManagementOutput(
  result: WorkspaceManageResponse,
  models: ProviderModelOption[],
  providers: readonly BackendProvider[],
) {
  return {
    instructionAuthority: "none",
    receipt: result.receipt,
    totalAgents: result.agents.length,
    agents: workspaceAgentDirectory(result.agents, models, providers),
    projects: result.projects.slice(0, 128).map(project => {
      const team = result.collaboration.teams.find(team => team.projectId === project.id);
      return {
        projectId: project.id,
        name: project.name,
        teamRevision: team?.revision,
        participantIds: team?.participantIds ?? [],
        leadAgentId: team?.leadAgentId,
      };
    }),
  };
}
