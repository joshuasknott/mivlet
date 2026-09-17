import type {
  BuiltinPlugins,
  LocalComputerSnapshot,
  LocalComputerTarget,
  LocalComputerEpochRequest,
  LocalComputerFileRequest,
  LocalComputerFilesSnapshot,
  LocalComputerFilePreview,
  LocalComputerAttachmentStageRequest,
  LocalComputerAttachmentReceipt,
  LocalComputerAttachmentDiscardRequest,
} from "@mivlet/protocol";
import { getRuntimeAdapter } from "../adapters/select";
import { toRuntimeError } from "../errors";
async function nativeComputerCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const adapter = getRuntimeAdapter();
  if (adapter.kind !== "native") return null;
  return adapter.invoke<T>(command, args).catch((error: unknown) => {
    throw toRuntimeError(error);
  });
}

export const loadRuntimeLocalComputer = (target: LocalComputerTarget) =>
  nativeComputerCommand<LocalComputerSnapshot>("local_computer_status", {
    ...target,
  });
export const listRuntimeLocalComputerFiles = (target: LocalComputerTarget) =>
  nativeComputerCommand<LocalComputerFilesSnapshot>("local_computer_files", {
    target,
  });
export const previewRuntimeLocalComputerFile = (
  request: LocalComputerFileRequest,
) =>
  nativeComputerCommand<LocalComputerFilePreview>(
    "local_computer_file_preview",
    { request },
  );
export const stageRuntimeLocalComputerAttachment = (
  request: LocalComputerAttachmentStageRequest,
) =>
  nativeComputerCommand<LocalComputerAttachmentReceipt[]>(
    "local_computer_stage_attachment",
    { request },
  );
export const discardRuntimeLocalComputerAttachmentBatch = (
  request: LocalComputerAttachmentDiscardRequest,
) =>
  nativeComputerCommand<void>("local_computer_discard_attachment_batch", {
    request,
  });
export const cancelRuntimeLocalComputer = (
  request: LocalComputerEpochRequest,
) =>
  nativeComputerCommand<LocalComputerSnapshot>("local_computer_cancel", {
    request,
  });
export const stopRuntimeAppControl = () =>
  nativeComputerCommand<void>("local_app_stop", {});
export const loadRuntimeBuiltinPlugins = (workspaceId: string) =>
  nativeComputerCommand<BuiltinPlugins>("builtin_plugins_status", {
    workspaceId,
  });
export const setRuntimeBuiltinPlugin = (
  workspaceId: string,
  plugin: "computer",
  enabled: boolean,
) =>
  nativeComputerCommand<BuiltinPlugins>("builtin_plugin_set", {
    workspaceId,
    plugin,
    enabled,
  });
