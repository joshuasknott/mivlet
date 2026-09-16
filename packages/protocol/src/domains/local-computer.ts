/** Credential-free projections of native Windows control and scoped files. */
export type LocalComputerController = "agent" | "human" | "paused";
export type LocalComputerLifecycle = "ready";
export type LocalComputerCapability = "persistent-files" | "app-observe" | "app-control";
export interface BuiltinPlugins { computer: boolean }
export interface LocalComputerTarget { workspaceId: string; agentId: string }
export interface LocalComputerEpochRequest extends LocalComputerTarget { expectedGeneration: number }
export interface NativeWindowChoice { id: string; application: string; title: string }
export type NativeComputerDeliveryMode = "background" | "foreground";
export interface NativeControlSnapshot {
  status: "idle" | "connecting" | "active" | "busy";
  requestId: string | null;
  generation: number | null;
  application: string | null;
  title: string | null;
  message: string | null;
  /** Absent in older snapshots; mode is fixed by the exactly approved selection. */
  deliveryMode?: NativeComputerDeliveryMode | null;
}
export interface NativeAppAction {
  observationId: string;
  action: "click" | "type" | "scroll" | "key";
  elementRef?: string;
  x?: number;
  y?: number;
  deltaY?: number;
  text?: string;
  key?: string;
  modifiers?: readonly "Shift"[];
}
export interface LocalComputerSnapshot extends LocalComputerTarget {
  plugins?: BuiltinPlugins;
  computerId: string;
  locality: "local";
  backend: "cua-driver";
  isolation: "windows-session";
  lifecycle: LocalComputerLifecycle;
  controller: LocalComputerController;
  generation: number;
  capabilities: readonly LocalComputerCapability[];
  runtimeAvailable: boolean;
  control: NativeControlSnapshot;
  retiredComputer: boolean;
  message?: string | null;
  updatedAt: string;
}
export interface LocalComputerFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes?: number;
}

/**
 * Bounded, read-only projection for the trusted Mivlet UI. Paths are relative
 * to this teammate's private workspace; this listing never includes host paths
 * or file contents.
 */
export interface LocalComputerFilesSnapshot {
  computerId: string;
  entries: readonly LocalComputerFileEntry[];
  truncated: boolean;
  updatedAt: string;
}

export interface LocalComputerFileRequest extends LocalComputerTarget {
  path: string;
}

/** One bounded user-authorized upload copied into an exact agent workspace. */
export interface LocalComputerAttachmentStageInput {
  attachmentId: string;
  name: string;
  mimeType: string;
  contentBase64: string;
}

/** One cancellable batch captured for a single agent run. */
export interface LocalComputerAttachmentStageRequest extends LocalComputerTarget {
  expectedGeneration: number;
  attachments: readonly LocalComputerAttachmentStageInput[];
}

/** Credential-free proof of the exact bytes and relative path staged. */
export interface LocalComputerAttachmentReceipt {
  computerId: string;
  batchId: string;
  attachmentId: string;
  originalName: string;
  mimeType: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  stagedAt: string;
}

/** Exact native batch capability used only to discard an unadopted upload. */
export interface LocalComputerAttachmentDiscardRequest extends LocalComputerTarget {
  computerId: string;
  batchId: string;
}

/**
 * An ephemeral, explicitly selected text-file preview for the trusted Mivlet UI.
 * The content must not enter model context, logs, or persisted runtime state.
 */
export interface LocalComputerFilePreview {
  computerId: string;
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  updatedAt: string;
}


/** Receipt for an explicitly published, native-owned copy of a generated file. */
export interface LocalComputerArtifact {
  kind: "computer-artifact";
  version: 1;
  id: string;
  computerId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
  createdAt: string;
}

export interface LocalComputerArtifactPreview {
  artifactId: string;
  mimeType: string;
  text: string | null;
  imageDataUrl: string | null;
  truncated: boolean;
}

export interface LocalComputerOpenArtifactRequest extends LocalComputerTarget {
  artifactId: string;
  expectedGeneration: number;
}
