/**
 * Provider-neutral records for a teammate computer running on the user's PC.
 *
 * These projections are intentionally credential-free. Browser profiles,
 * filesystem paths, cookies, DevTools endpoints, and process handles remain
 * behind the native boundary.
 */

export type LocalComputerLifecycle =
  | "unprovisioned"
  | "provisioning"
  | "ready"
  | "degraded";

export type LocalComputerController = "agent" | "human";

export type LocalComputerCapability =
  | "persistent-files"
  | "browser-observe"
  | "browser-control";

export interface LocalComputerSnapshot {
  computerId: string;
  workspaceId: string;
  agentId: string;
  locality: "local";
  backend: "native-browser";
  isolation: "browser-sandbox";
  lifecycle: LocalComputerLifecycle;
  browserAvailable: boolean;
  browserActive: boolean;
  controller: LocalComputerController;
  generation: number;
  capabilities: readonly LocalComputerCapability[];
  browserProduct?: string;
  message?: string;
  updatedAt: string;
}

export interface LocalBrowserViewportSnapshot {
  width: number;
  height: number;
}

export interface LocalComputerFileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes?: number;
}

/**
 * Bounded, read-only projection for the trusted Fable UI. Paths are relative
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

/**
 * An ephemeral, explicitly selected text-file preview for the trusted Fable UI.
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

/**
 * Ephemeral browser frame. The preview must not be persisted in a runtime
 * snapshot, log, model transcript, or local database.
 */
export interface LocalBrowserSnapshot {
  computerId: string;
  currentUrl: string;
  title: string;
  previewDataUrl: string;
  viewport: LocalBrowserViewportSnapshot;
  controller: LocalComputerController;
  generation: number;
  updatedAt: string;
}

export interface LocalComputerTarget {
  workspaceId: string;
  agentId: string;
}

export interface LocalBrowserNavigateRequest extends LocalComputerTarget {
  url: string;
}

export interface LocalComputerControlRequest extends LocalComputerTarget {
  controller: LocalComputerController;
  expectedGeneration: number;
}

export interface LocalBrowserPointerRequest extends LocalComputerTarget {
  expectedGeneration: number;
  x: number;
  y: number;
  action: "click" | "scroll";
  deltaY?: number;
}

export interface LocalBrowserKeyRequest extends LocalComputerTarget {
  expectedGeneration: number;
  key: string;
}
