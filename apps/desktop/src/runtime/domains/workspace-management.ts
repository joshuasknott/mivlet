import type {
  WorkspaceManageRequest,
  WorkspaceManageResponse,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";

export async function manageWorkspace(
  request: WorkspaceManageRequest,
): Promise<WorkspaceManageResponse> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind === "preview") {
    throw new Error(
      "Managing projects and agents through chat requires the installed desktop app.",
    );
  }
  try {
    return await adapter.invoke<WorkspaceManageResponse>("workspace_manage", {
      request,
    });
  } catch (error) {
    throw toRuntimeError(error);
  }
}
