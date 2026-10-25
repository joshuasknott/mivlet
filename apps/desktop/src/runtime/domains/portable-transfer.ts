import type {
  PortableTransferImportReport,
  PortableTransferReceipt,
} from "@mivlet/protocol";
import { getActiveRuntimeDataScope } from "../../runtime-scope";
import { invokeRequiredNative } from "../required-native";

function transfer<T>(command: string): Promise<T> {
  const scope = getActiveRuntimeDataScope();
  if (!scope)
    return Promise.reject(new Error("Sign in to your Mivlet workspace first."));
  return invokeRequiredNative<T>(
    command,
    { workspaceId: scope.workspaceId },
    "Portable transfer requires the signed-in Mivlet desktop app.",
  );
}

export const exportPortableTransfer = () =>
  transfer<PortableTransferReceipt>("portable_transfer_export");
export const importPortableTransfer = () =>
  transfer<PortableTransferImportReport>("portable_transfer_import");
