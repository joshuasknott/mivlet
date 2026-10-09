import type { CapturedWorkContext } from "./collaboration";

/** Render-only OpenUI profile; every provider with ordinary text supports the
 * same catalogue, with no provider key or additional gateway in the renderer. */
export interface GeneratedInterfaceCapability {
  format: "openui";
  catalogue: "mivlet-v1";
  actions: "review-in-composer";
  maxCharacters: 48000;
  automaticToolCalls: false;
}
export interface ConversationContextSelection {
  revision: number;
  includeHistory: boolean;
  includeProjectFacts: boolean;
  excludedMemoryIds: string[];
  excludedKnowledgeSourceIds: string[];
}
export interface ConversationContextPreview {
  selection: ConversationContextSelection;
  capture: CapturedWorkContext;
}
export interface GeneratedInterfaceState {
  revision: number;
  values: Record<string, string | boolean>;
  reviewedEvents: string[];
  sourceRevision: string;
}
export interface ConversationUiOwner {
  workspaceId: string;
  conversationId: string;
  agentId: string;
}
export type ConversationUiCommand =
  | { action: "quote-output"; outputId: string; revisionId: string; selection: string }
  | { action: "stage-output-revision"; workId: string; outputId: string; expectedRevisionId: string; expectedRevisionNumber: number; prompt: string }
  | { action: "apply-output-revision"; workId: string }
  | { action: "apply-output-revisions" }
  | { action: "preview-context" }
  | { action: "set-context"; selection: ConversationContextSelection }
  | { action: "load-interface"; runId: string; source: string }
  | { action: "quote-response"; runId: string; source: string; selection: string }
  | { action: "save-interface"; runId: string; source: string; expectedRevision: number; values: Record<string, string | boolean> }
  | { action: "review-interface"; runId: string; source: string; expectedRevision: number; eventId: string; label: string };
