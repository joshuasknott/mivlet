/**
 * Native-API `AgentBackend` adapter.
 *
 * This is one adapter among equals — it implements the provider-neutral
 * {@link AgentBackend} contract for direct model APIs. Ordinary OpenAI,
 * Anthropic, xAI, OpenRouter, and custom turns use the embedded SDK host when
 * available; Gemini, image turns, and browser fixtures retain Mivlet's local
 * loop. Both paths keep HTTP egress and credentials behind the injected native
 * boundary.
 *
 * SECRET INVARIANT: the adapter holds no key. The transport it receives owns
 * egress; in production Rust adds the Authorization/x-api-key/x-goog-api-key
 * header from the keychain. The adapter only handles key-free requests.
 */

import type {
  AgentTurnOptions,
  AgentTurnRequest,
  BackendAgentEvent,
  BackendCapability,
  BackendProvider,
  NativeCompletionRequest
} from "@fable/protocol";
import { runAgentLoop, type ToolExecutor } from "../../native-api/agent-loop";
import type { ModelDiscoveryResult } from "../../native-api/discovery";
import { resolveModelCapabilities } from "../../native-api/model-catalogue";
import { computerVisionUnavailableReason, supportsNativeComputerVision } from "../../native-api/computer-vision";
import { validateReasoningEffort } from "../../native-api/reasoning";
import type { BackendDeps, AgentBackend, TransportHandlers } from "../contract";
import { backendErrorEvent, normalizeBackendErrorEvent } from "../utils/errors";
import { createEmbeddedBackend } from "./embedded";

/** One bound native request, keyed by the runtime execution id. */
interface ActiveRun {
  requestId: string | null;
  cancel: (requestId: string) => Promise<void>;
  cancelRequested: boolean;
  shutdown?: () => Promise<void>;
}

/**
 * Build the native-API agent backend for a connected provider.
 *
 * @param provider The connected native-API BackendProvider.
 * @param deps Injected transport + discovery (desktop wires Rust; tests inject fakes).
 */
export function createNativeApiBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  const capabilities: readonly BackendCapability[] = provider.capabilities;
  const embedded = deps.createEmbeddedRuntime ? createEmbeddedBackend(provider, deps) : undefined;

  // Each conversation attempt owns one cancellation handle.
  const active = new Map<string, ActiveRun>();
  let anonymousRunSequence = 0;

  function run(
    request: AgentTurnRequest,
    options: AgentTurnOptions
  ): AsyncIterable<BackendAgentEvent> | null {
    if (!capabilities.includes("streaming")) {
      return null;
    }
    // Keep the audited transient user-image wire route until its SDK admission
    // contract is verified. Ordinary turns and native computer tools use OpenCode.
    if (embedded && ["openai", "anthropic", "xai", "openrouter", "custom"].includes(provider.id)
      && !request.messages.some(message => message.images?.length)) {
      return embedded.run(request, options);
    }
    if (
      request.tools.length > 0 &&
      (!capabilities.includes("tool-requests") || !capabilities.includes("approvals"))
    ) {
      return (async function* unsupportedTools(): AsyncIterable<BackendAgentEvent> {
        yield {
          type: "error",
          message: "Tool calls/approvals are not supported by this backend's capabilities.",
          code: "invalid-request",
          retryable: false
        };
        yield { type: "done", finishReason: "error" };
      })();
    }
    const executionId = options.attemptId ?? `native-anonymous-attempt-${++anonymousRunSequence}`;
    validateReasoningEffort(provider.id, provider.models.find((model) => model.id === request.model) ?? { id: request.model, label: request.model, available: true }, request.reasoningEffort);
    const activeRun: ActiveRun = {
      requestId: null,
      cancel: async () => undefined,
      cancelRequested: false
    };
    const handlers: TransportHandlers = {
      onRequestStarted: (requestId) => {
        activeRun.requestId = requestId;
        if (activeRun.cancelRequested) {
          void activeRun.cancel(requestId).catch(() => undefined);
        }
      },
      onRetry: () => options.onRetry?.()
    };
    const handle = deps.createTransport(provider, handlers);
    if (handle === null) return null;
    activeRun.cancel = handle.cancel;
    activeRun.shutdown = handle.shutdown;
    if (activeRun.cancelRequested && activeRun.requestId) {
      void activeRun.cancel(activeRun.requestId).catch(() => undefined);
    }
    active.set(executionId, activeRun);

    // The contract's execute signature matches the loop's ToolExecutor exactly;
    // the cast is structural and safe (both are (approval, args) => Promise<string>).
    const execute = options.execute as ToolExecutor;
    const selectedModel = provider.models.find((model) => model.id === request.model);
    const modelCapabilities = resolveModelCapabilities(provider.id, selectedModel);
    const nativeRequest: NativeCompletionRequest = {
      providerId: provider.id,
      model: request.model,
      messages: request.messages,
      tools: request.tools.filter(tool => !tool.name.startsWith("local-desktop-")
        || (options.computer && supportsNativeComputerVision(provider.id, selectedModel))),
      maxTokens: request.maxTokens,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      ...(request.providerRoute ? { providerRoute: request.providerRoute } : {}),
      ...(options.computer ? { computer: options.computer } : {})
    };
    const eventStream = runAgentLoop(handle.transport, nativeRequest, {
      execute,
      modelSupportsTools: modelCapabilities?.tools,
      shouldCancel: () => activeRun.cancelRequested || options.shouldCancel?.() === true,
      contextPrefix: [options.contextPrefix, computerVisionUnavailableReason(provider, selectedModel)].filter(Boolean).join("\n\n"),
      permissionMode: options.permissionMode,
      runId: options.attemptId,
      maxTurns: options.maxTurns,
      maxToolCalls: options.maxToolCalls,
      maxToolOutputCharacters: options.maxToolOutputCharacters,
      toolsEnabled: request.tools.length > 0 ? nativeRequest.tools.length > 0 : undefined
    });

    if (!eventStream) return null;

    async function* wrappedStream(): AsyncIterable<BackendAgentEvent> {
      let sawCancelled = false;
      try {
        for await (const event of eventStream) {
          if (event.type === "cancelled") {
            sawCancelled = true;
          }
          if (event.type === "error") {
            yield normalizeBackendErrorEvent(event);
          } else {
            yield event;
          }
        }
      } catch (error) {
        yield backendErrorEvent(error, "Native-API run failed.");
        yield { type: "done", finishReason: "error" };
      } finally {
        if (sawCancelled && capabilities.includes("cancellation") && activeRun.requestId) {
          await activeRun.cancel(activeRun.requestId);
        }
        await activeRun.shutdown?.();
        if (active.get(executionId) === activeRun) active.delete(executionId);
      }
    }

    return wrappedStream();
  }

  async function cancel(runId: string): Promise<void> {
    await embedded?.cancel(runId);
    if (!capabilities.includes("cancellation")) {
      return;
    }
    let matches = [...active.entries()].filter(([key]) =>
      key === runId || key.startsWith(`${runId}:worker:`)
    );
    // Compatibility for callers created before run-scoped cancellation: a
    // single live request remains unambiguous even if they pass a placeholder.
    if (matches.length === 0 && active.size === 1) matches = [...active.entries()];
    for (const [key, run] of matches) {
      run.cancelRequested = true;
      await run.shutdown?.();
      if (run.requestId) {
        await run.cancel(run.requestId);
        if (active.get(key) === run) active.delete(key);
      }
    }
  }

  async function listModels(): Promise<ModelDiscoveryResult> {
    if (!deps.discoverModels) {
      return { outcome: "unsupported", models: [], message: "Model discovery is not wired." };
    }
    const result = await deps.discoverModels(provider.id);
    if (!result) {
      return { outcome: "unsupported", models: [], message: "Model discovery is not wired." };
    }
    return result;
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
