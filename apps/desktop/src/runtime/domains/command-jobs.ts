import type {
  LocalComputerEpochRequest,
  NativeCommandJob,
  NativeCommandOutput,
  NativeCommandTarget,
  NativeCommandInput,
  NativeCommandInputReceipt,
  NativeCommandRepositoryReview,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";

export const listNativeCommandJobs = (target: LocalComputerEpochRequest) =>
  invokeNative<{ jobs: NativeCommandJob[] }>("native_command_jobs", {
    ...target,
  });
export const readNativeCommandOutput = (
  target: NativeCommandTarget,
  cursor: number,
) =>
  invokeNative<NativeCommandOutput>("native_command_jobs", {
    ...target,
    cursor,
  });
export const stopNativeCommandJob = (target: NativeCommandTarget) =>
  invokeNative<{ job: NativeCommandJob }>("native_command_stop", { ...target });
export const writeNativeCommandInput = (request: NativeCommandInput) =>
  invokeNative<NativeCommandInputReceipt>("native_command_input", {
    ...request,
  });
export const inspectNativeCommandRepository = (target: NativeCommandTarget) =>
  invokeNative<NativeCommandRepositoryReview>("native_command_repository", {
    ...target,
  });
