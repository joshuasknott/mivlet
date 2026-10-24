import type {
  WorkspaceManageRequest,
  WorkspaceManageResponse,
} from "@mivlet/protocol";
import { invokeRequiredNative } from "../required-native";

export async function manageWorkspace(
  request: WorkspaceManageRequest,
): Promise<WorkspaceManageResponse> {
  return invokeRequiredNative<WorkspaceManageResponse>(
    "workspace_manage",
    { request },
    "Managing projects and agents through chat requires the installed desktop app.",
  );
}
