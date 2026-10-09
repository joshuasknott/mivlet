import type { AgentTurnRequest, BackendProvider, ProviderContinuation } from "@mivlet/protocol";
import type { ProviderModelOption } from "./provider-models";
import { planConversationContext } from "./conversation-context";

/** Explicit capability gate, not a promise of provider-native resume. */
export function providerContinuationAvailable(provider: BackendProvider | undefined) {
  return Boolean(provider?.authState === "connected"
    && provider.capabilities.includes("streaming")
    && ["codex-app-server", "claude-agent", "native-api", "antigravity-acp",
      "cursor-acp", "grok-acp", "opencode-server"].includes(provider.backendType));
}

export function applyProviderContinuation(
  request: AgentTurnRequest,
  continuation: ProviderContinuation | undefined,
  provider: BackendProvider,
  model: ProviderModelOption | undefined,
  contextPrefix: string,
): AgentTurnRequest {
  if (!continuation) return request;
  if (!model || !providerContinuationAvailable(provider) || model.id !== continuation.modelOptionId
    || provider.id !== model.providerId || !model.available
    || continuation.strategy !== "portable-fresh-session") {
    throw new Error("This provider or model cannot accept the saved continuation. Review it again.");
  }
  // A new native session has no prior occupancy. Never carry the previous
  // model's usage/window/compaction thresholds into this capacity check.
  const history = providerContinuationHistory(continuation);
  const plan = planConversationContext({
    history, request, contextPrefix, backendType: provider.backendType,
    contextWindowTokens: Math.min(model.capabilities?.contextWindow ?? 32_768, continuation.contextWindow),
  });
  if (!plan.ok) throw new Error(`${plan.message} Review the provider continuation again. Your current request is unchanged.`);
  return { ...request, messages: plan.messages };
}

export function providerContinuationHistory(continuation: ProviderContinuation | undefined): AgentTurnRequest["messages"] {
  if (!continuation) return [];
  return [
    { role: "user", content: continuation.reference },
    ...continuation.messages.map(message => ({
      role: message.role,
      content: `[Saved ${message.role}; ${message.kind}; message=${message.messageId}; revision=${message.revisionId}; sequence=${message.sequence}; state=${message.state}]\n${message.text}`,
    })),
  ];
}
