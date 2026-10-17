import type {
  NativePreviewTarget,
  NativePreviewState,
  NativePreviewPick,
  NativePreviewFeedback,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";

export const readNativeAppPreview = (target: NativePreviewTarget) =>
  invokeNative<NativePreviewState>("native_command_preview", { ...target });
export const closeNativeAppPreview = (target: NativePreviewTarget) =>
  invokeNative<NativePreviewState>("native_command_preview", {
    ...target,
    close: true,
  });
export const validateNativePreviewPick = (
  target: NativePreviewTarget,
  pick: NativePreviewPick,
) =>
  invokeNative<NativePreviewFeedback>("native_preview_feedback", {
    ...target,
    pick,
  });
