import type {
  AgentRunOptions,
  AgentRunRequest,
  BackendAgentEvent,
  BackendCapability,
  BackendProvider,
  NativeCompletionRequest
} from "@fable/protocol";
import { runAgentLoop, type ToolExecutor } from "../../native-api/agent-loop";
import type { ModelDiscoveryResult } from "../../native-api/discovery";
import type { AgentBackend, BackendDeps, TransportHandlers } from "../contract";
import { backendErrorEvent, normalizeBackendErrorEvent } from "../utils/errors";

interface ActiveRun {
  requestId: string | null;
  cancel: (requestId: string) => Promise<void>;
}

export function createLocalLoopbackBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  const capabilities: readonly BackendCapability[] = provider.capabilities;
  let active: ActiveRun | null = null;

  function run(
    request: AgentRunRequest,
    options: AgentRunOptions
  ): AsyncIterable<BackendAgentEvent> | null {
    if (!capabilities.includes("streaming")) return null;
    const selectedModel = provider.models.find((model) => model.id === request.model);
    const supportsTools =
      capabilities.includes("tool-requests") &&
      capabilities.includes("approvals") &&
      selectedModel?.capabilities?.tools === true;
    if (
      request.tools.length > 0 &&
      !supportsTools
    ) {
      return (async function* unsupportedTools(): AsyncIterable<BackendAgentEvent> {
        yield {
          type: "error",
          message: "This local model has not reported tool-use support.",
          code: "invalid-request",
          retryable: false
        };
        yield { type: "done", finishReason: "error" };
      })();
    }
    if (!deps.createLocalModelTransport) return null;
    const handlers: TransportHandlers = {
      onRequestStarted: (requestId) => {
        if (active) active.requestId = requestId;
      },
      onRetry: () => options.onRetry?.()
    };
    const handle = deps.createLocalModelTransport(provider, handlers);
    if (handle === null) return null;
    active = { requestId: null, cancel: handle.cancel };

    const nativeRequest: NativeCompletionRequest = {
      providerId: provider.id,
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      maxTokens: request.maxTokens
    };
    const eventStream = runAgentLoop(handle.transport, nativeRequest, {
      execute: options.execute as ToolExecutor,
      shouldCancel: options.shouldCancel,
      contextPrefix: options.contextPrefix,
      permissionMode: options.permissionMode,
      runId: options.runId,
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
      maxToolOutputCharacters: options.maxToolOutputCharacters,
      toolsEnabled: supportsTools
    });

    async function* wrappedStream(): AsyncIterable<BackendAgentEvent> {
      let sawCancelled = false;
      try {
        for await (const event of eventStream) {
          if (event.type === "cancelled") sawCancelled = true;
          yield event.type === "error" ? normalizeBackendErrorEvent(event) : event;
        }
      } catch (error) {
        yield backendErrorEvent(error, "Local model run failed.");
        yield { type: "done", finishReason: "error" };
      } finally {
        if (sawCancelled && capabilities.includes("cancellation") && active?.requestId) {
          await active.cancel(active.requestId);
        }
        active = null;
      }
    }

    return wrappedStream();
  }

  async function cancel(_runId: string): Promise<void> {
    if (capabilities.includes("cancellation") && active?.requestId) {
      await active.cancel(active.requestId);
    }
    active = null;
  }

  async function listModels(): Promise<ModelDiscoveryResult> {
    if (!deps.discoverModels) {
      return { outcome: "unsupported", models: [], message: "Model discovery is not wired." };
    }
    return (
      (await deps.discoverModels(provider.id)) ?? {
        outcome: "unsupported",
        models: [],
        message: "Model discovery is not wired."
      }
    );
  }

  return {
    backend: provider,
    providerId: provider.id,
    capabilities,
    run,
    cancel,
    listModels
  };
}
