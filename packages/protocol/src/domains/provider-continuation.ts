/** Portable context is saved evidence, never tool state or additional authority. */
export interface ProviderContinuationInput {
  conversationId: string;
  agentId: string;
  modelOptionId: string;
  prompt: string;
  /** Advisory discovery metadata; dispatch rechecks the current model envelope. */
  contextWindow?: number;
}

export interface ProviderContinuationMessage {
  messageId: string;
  revisionId: string;
  sequence: number;
  role: "user" | "assistant";
  kind: string;
  state: string;
  text: string;
}

export interface ProviderContinuation {
  version: 1;
  strategy: "portable-fresh-session";
  fingerprint: string;
  conversationId: string;
  modelOptionId: string;
  sourceModelOptionId?: string;
  throughSequence: number;
  sourceHistoryDigest: string;
  contextWindow: number;
  capacitySource: "reported" | "conservative-fallback";
  budgetBytes: number;
  historyBytes: number;
  omittedCount: number;
  attachmentCount: number;
  messages: ProviderContinuationMessage[];
  reference: string;
}
