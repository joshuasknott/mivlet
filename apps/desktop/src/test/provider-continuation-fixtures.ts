import type { BackendProvider, ProviderContinuation } from '@mivlet/protocol';
import type { ProviderModelOption } from '../lib/provider-models';
export const provider = { id: "openai", label: "OpenAI", backendType: "native-api", authState: "connected",
  capabilities: ["streaming"] } as BackendProvider;
export const model = { id: "openai::test", modelId: "test", providerId: "openai", providerLabel: "OpenAI",
  label: "Test model", available: true, capabilities: { contextWindow: 32_768 } } as ProviderModelOption;
export const continuation: ProviderContinuation = {
  version: 1, strategy: "portable-fresh-session", fingerprint: "fingerprint",
  conversationId: "room", modelOptionId: model.id, sourceModelOptionId: "claude::old",
  throughSequence: 2, sourceHistoryDigest: "digest", contextWindow: 32_768, capacitySource: "reported", budgetBytes: 16_000,
  historyBytes: 1_000, omittedCount: 0, attachmentCount: 1, reference: "Saved history; attachments need reattachment.",
  messages: [
    { messageId: "m1", revisionId: "r1", sequence: 1, role: "user", kind: "user", state: "terminal", text: "Keep original constraints." },
    { messageId: "m2", revisionId: "r2", sequence: 2, role: "assistant", kind: "assistant", state: "streaming", text: "Partial public work." },
  ],
};
