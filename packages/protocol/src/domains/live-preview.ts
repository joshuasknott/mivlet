import type { NativeCommandTarget } from "./command-jobs.js";

/** Native-owned route into one exact restricted command session. The renderer
 * never discovers local ports or derives this URL from terminal output. */
export interface NativePreviewDescriptor {
  id: string;
  jobId: string;
  jobGeneration: number;
  repositoryId: string;
  generation: number;
  revision: string;
  url: string;
  origin: string;
  expiresAt: string;
  pickerSupported: boolean;
}
export type NativePreviewState =
  | { status: "ready"; preview: NativePreviewDescriptor }
  | { status: "unavailable" | "closed"; message: string };
export interface NativePreviewTarget extends NativeCommandTarget {
  previewId?: string;
}
/** Public element evidence from the isolated guest. It remains untrusted and
 * becomes a chat draft only after native session/revision validation. */
export interface NativePreviewPick {
  kind: "mivlet-preview-pick";
  previewId: string;
  jobId: string;
  jobGeneration: number;
  revision: string;
  path: string;
  tag: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface NativePreviewFeedback {
  previewId: string;
  revision: string;
  path: string;
  tag: string;
  label: string;
  bounds: NativePreviewPick["bounds"];
  trust: "external-untrusted";
}
