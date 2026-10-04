import type {
  CodingRepository,
  CodingRepositoryStatus,
  LocalComputerEpochRequest,
  NativeExecutionStatus,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";

export const inspectCodingRepository = (target: LocalComputerEpochRequest) =>
  invokeNative<CodingRepositoryStatus>("coding_repository_status", {
    ...target,
  });
export const attachCodingRepository = (target: LocalComputerEpochRequest) =>
  invokeNative<CodingRepository>("coding_repository_attach", { ...target });
export const inspectNativeExecution = () =>
  invokeNative<NativeExecutionStatus>("native_execution_status");
export const setupNativeExecution = (cleanup: boolean) =>
  invokeNative<void>("native_execution_setup", { cleanup });
