import type { ProjectSourceFolderImport } from "@mivlet/protocol";
import { activeDataScope, hasTauriRuntime, invokeNative } from "../bridge";

export type { ProjectSourceFolderImport } from "@mivlet/protocol";

/**
 * Ask the native desktop boundary to choose and snapshot a local source folder.
 * Preview/browser runtimes report the desktop prerequisite; null means cancellation.
 */
export async function importProjectSourceFolder(
  workspaceId: string,
): Promise<ProjectSourceFolderImport | null> {
  const scope = activeDataScope();
  if (!hasTauriRuntime() || !scope) {
    throw new Error("Source folder imports require the installed desktop app.");
  }
  if (scope.workspaceId !== workspaceId) {
    throw new Error("The active workspace changed before folder selection.");
  }
  return invokeNative<ProjectSourceFolderImport>(
    "import_project_source_folder",
    {
      workspaceId,
    },
  );
}
