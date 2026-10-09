import type {
  LocalComputerEpochRequest,
  RepositoryCopyCleanupPreview,
  RepositoryCopyInventory,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";

export interface RepositoryCopyAction {
  target: LocalComputerEpochRequest;
  repositoryId: string;
  previewToken: string | null;
}
export const inspectRepositoryCopies = (target: LocalComputerEpochRequest) =>
  invokeNative<RepositoryCopyInventory>("coding_copy_account_inventory", {
    target,
  });
export const previewRepositoryCopyCleanup = (action: RepositoryCopyAction) =>
  invokeNative<RepositoryCopyCleanupPreview>("coding_copy_preview", { action });
export const deleteRepositoryCopy = (action: RepositoryCopyAction) =>
  invokeNative<void>("coding_copy_delete", { action });
export const selectRepositoryCopy = (action: RepositoryCopyAction) =>
  invokeNative<void>("coding_copy_select", { action });
