import type { BackendProvider } from "@mivlet/protocol";
import {
  resolveAgentBackend,
  type AgentBackend,
  type BackendDeps,
} from "@mivlet/connectors";
import { createDesktopAntigravityAcp } from "../../lib/antigravity-acp";
import { createDesktopCodexAppServer } from "../../lib/codex-app-server";
import { createDesktopEmbeddedRuntime } from "../../lib/embedded-agent";
import { createDesktopManagedRuntime } from "../../lib/managed-runtime";
import { createDesktopTransport } from "../../lib/native-transport";
import { selectNativeProviderRoute } from "../../lib/provider-route-selection";
import { listRuntimeBackendModels } from "../../runtime/domains/providers";
import type { AgentTurnRequest } from "@mivlet/protocol";
import type { ConversationContextPlan } from "../../lib/conversation-context";

export function createNativeAgentBackendDeps(): BackendDeps {
  return {
    createTransport: createDesktopTransport,
    createEmbeddedRuntime: createDesktopEmbeddedRuntime,
    createCodexAppServer: createDesktopCodexAppServer,
    createAntigravityAcp: createDesktopAntigravityAcp,
    createManagedRuntime: createDesktopManagedRuntime,
    discoverModels: async (providerId) => {
      const result = await listRuntimeBackendModels(providerId);
      return result;
    },
  };
}

export function resolveStreamingBackend(
  providers: BackendProvider[],
  activeProviderId: string | undefined,
  deps: BackendDeps,
): AgentBackend | null {
  return resolveAgentBackend(
    providers.find(
      (provider) =>
        (!activeProviderId || provider.id === activeProviderId) &&
        provider.authState === "connected" &&
        provider.capabilities.includes("streaming"),
    ),
    deps,
  );
}

export function resolveStreamingBackendById(
  providers: BackendProvider[],
  providerId: string,
  deps: BackendDeps,
): AgentBackend | null {
  return resolveAgentBackend(
    providers.find(
      (provider) =>
        provider.id === providerId &&
        provider.authState === "connected" &&
        provider.capabilities.includes("streaming"),
    ),
    deps,
  );
}

export async function selectAttemptProviderRoute(input: {
  provider?: BackendProvider;
  providerId: string;
  model: string;
  request: AgentTurnRequest;
  contextPlan: Extract<ConversationContextPlan, { ok: true }>;
}): Promise<
  | { ok: true; route: Awaited<ReturnType<typeof selectNativeProviderRoute>> | undefined }
  | { ok: false; message: string }
> {
  if (input.provider?.backendType !== "native-api") {
    return { ok: true, route: undefined };
  }
  try {
    const route = await selectNativeProviderRoute({
      providerId: input.providerId,
      model: input.model,
      requiredInputTokens: input.contextPlan.estimatedInputTokens,
      requiredOutputTokens: input.request.maxTokens,
      requiresTools: input.request.tools.length > 0,
    });
    return { ok: true, route };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Mivlet could not select an authorized provider route.",
    };
  }
}
