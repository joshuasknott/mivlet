import type { MivletAgentProfile } from "@mivlet/protocol";
import { NativeExecutionSetup } from "./NativeExecutionSetup";
import { NativeCommandJobs } from "./NativeCommandJobs";
import { RepositoryFiles } from "./RepositoryFiles";

export function LibraryNativeTools({
  workspaceId,
  agents,
}: {
  workspaceId: string;
  agents: MivletAgentProfile[];
}) {
  return (
    <>
      <NativeExecutionSetup />
      <NativeCommandJobs workspaceId={workspaceId} agents={agents} />
      <RepositoryFiles workspaceId={workspaceId} agents={agents} />
    </>
  );
}
