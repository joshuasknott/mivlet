import type {
  CodingRepository,
  CodingRepositoryStatus,
  LocalComputerEpochRequest,
} from "@mivlet/protocol";
import { invokeNative } from "../bridge";

export const inspectCodingRepository = (target: LocalComputerEpochRequest) =>
  invokeNative<CodingRepositoryStatus>("coding_repository_status", {
    ...target,
  });
export const attachCodingRepository = (target: LocalComputerEpochRequest) =>
  invokeNative<CodingRepository>("coding_repository_attach", { ...target });
