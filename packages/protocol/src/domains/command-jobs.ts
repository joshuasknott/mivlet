import type { LocalComputerEpochRequest } from "./local-computer.js";

export type NativeCommandJobStatus =
  | "preparing"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed-out"
  | "interrupted";
/** Nonsecret durable metadata. Raw commands, local paths and output are absent. */
export interface NativeCommandJob {
  id: string;
  repositoryId: string | null;
  generation: number;
  operationId: number;
  commandId: string;
  persistent: boolean;
  /** Legacy records default to false/zero; input is never replayed. */
  interactive?: boolean;
  inputSequence?: number;
  previewPort?: number | null;
  network: boolean;
  timeoutSeconds: number;
  status: NativeCommandJobStatus;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  executionId: string | null;
  message: string | null;
}
export interface NativeCommandFrame {
  sequence: number;
  stream: "stdout" | "stderr";
  text: string;
}
export interface NativeCommandOutput {
  job: NativeCommandJob;
  output: {
    frames: NativeCommandFrame[];
    nextCursor: number;
    dropped: boolean;
    closed: boolean;
    redacted: boolean;
  } | null;
  outputUnavailable: boolean;
}
export interface NativeCommandTarget extends LocalComputerEpochRequest {
  jobId: string;
  jobGeneration: number;
}
export interface NativeCommandInput extends NativeCommandTarget {
  inputSequence: number;
  /** Exact UTF-8 payload including any explicit newline, at most 4096 bytes. */
  text: string;
}
export interface NativeCommandInputReceipt {
  jobId: string;
  jobGeneration: number;
  inputSequence: number;
  /** Pipe delivery only; application success still requires observed output. */
  delivery: "accepted" | "uncertain";
}
