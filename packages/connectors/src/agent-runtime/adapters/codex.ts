/**
 * Codex app-server `AgentBackend` adapter.
 *
 * Codex is one provider-neutral adapter. It supervises the Codex-owned
 * app-server process through an injected client and reuses Codex-owned auth
 * only. This adapter never reads, copies, logs, stores, or transports ChatGPT
 * subscription tokens.
 */

import type {
  AgentRunOptions,
  AgentRunRequest,
  BackendAgentEvent,
  BackendCapability,
  BackendProvider
} from "@fable/protocol";
import type {
  AgentBackend,
  BackendDeps,
  CodexAppServerEvent,
  CodexAppServerHandle
} from "../contract";
import type { ModelDiscoveryResult } from "../../native-api/discovery";
import { backendErrorEvent, normalizeBackendErrorEvent } from "../utils/errors";
import { redactSecretsFromString } from "../utils/redact";

function requestedThreadId(request: AgentRunRequest): string | null {
  const candidate = (request as AgentRunRequest & { threadId?: unknown; codexThreadId?: unknown })
    .threadId;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  const legacyCandidate = (
    request as AgentRunRequest & { threadId?: unknown; codexThreadId?: unknown }
  ).codexThreadId;
  return typeof legacyCandidate === "string" && legacyCandidate.trim()
    ? legacyCandidate.trim()
    : null;
}

async function* mapCodexEvents(
  handle: CodexAppServerHandle,
  threadId: string,
  events: AsyncIterable<CodexAppServerEvent>,
  options: AgentRunOptions,
  capabilities: readonly BackendCapability[]
): AsyncIterable<BackendAgentEvent> {
  for await (const event of events) {
    if (options.shouldCancel?.()) {
      await handle.cancel(threadId);
      yield { type: "cancelled" };
      return;
    }

    if (event.type === "text-delta") {
      yield { type: "text-delta", text: event.text };
    } else if (event.type === "usage") {
      yield {
        type: "usage",
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd ?? 0,
        costEstimated: event.costUsd === undefined,
        costUnknown: event.costUsd === undefined
      };
    } else if (event.type === "approval-request") {
      if (!capabilities.includes("tool-requests") || !capabilities.includes("approvals")) {
        yield { type: "error", message: "Tool calls/approvals are not supported by this backend's capabilities." };
        yield { type: "done", finishReason: "error" };
        return;
      }
      yield {
        type: "tool-call",
        callId: event.callId,
        tool: event.tool,
        arguments: event.arguments,
        approval: event.approval
      };
      try {
        const output = await options.execute(event.approval, event.arguments);
        await handle.respondApproval(event.requestId, {
          callId: event.callId,
          ok: true,
          output
        });
        yield { type: "tool-result", callId: event.callId, ok: true, output };
      } catch (error) {
        const output = error instanceof Error ? redactSecretsFromString(error.message) : "Codex approval was not granted.";
        await handle.respondApproval(event.requestId, {
          callId: event.callId,
          ok: false,
          output
        });
        yield { type: "tool-result", callId: event.callId, ok: false, output };
      }
    } else if (event.type === "approval-result") {
      yield {
        type: "tool-result",
        callId: event.callId,
        ok: event.ok,
        output: event.output
      };
    } else if (event.type === "done") {
      yield { type: "done", finishReason: event.finishReason };
      return;
    } else if (event.type === "error") {
      yield normalizeBackendErrorEvent({ type: "error", message: event.message });
      yield { type: "done", finishReason: "error" };
      return;
    } else if (event.type === "cancelled") {
      yield { type: "cancelled" };
      return;
    }
  }
}

export function createCodexBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  const capabilities: readonly BackendCapability[] = provider.capabilities;
  let active: { handle: CodexAppServerHandle; threadId: string | null } | null = null;

  function run(
    request: AgentRunRequest,
    options: AgentRunOptions
  ): AsyncIterable<BackendAgentEvent> | null {
    if (!capabilities.includes("streaming")) {
      return null;
    }
    const handle = deps.createCodexAppServer?.(provider, {
      onRequestStarted: () => {},
      onRetry: () => options.onRetry?.()
    });
    if (!handle) return null;
    const liveHandle: CodexAppServerHandle = handle;

    async function* stream(): AsyncIterable<BackendAgentEvent> {
      try {
        await liveHandle.initialize();
        const existingThreadId = requestedThreadId(request);
        const thread = existingThreadId
          ? await liveHandle.resumeThread(existingThreadId, request)
          : await liveHandle.startThread(request);
        active = { handle: liveHandle, threadId: thread.threadId };
        const codexEvents = liveHandle.submitTurn({
          threadId: thread.threadId,
          request,
          options: {
            contextPrefix: options.contextPrefix,
            permissionMode: options.permissionMode,
            runId: options.runId
          }
        });
        yield* mapCodexEvents(liveHandle, thread.threadId, codexEvents, options, capabilities);
      } catch (error) {
        yield backendErrorEvent(error, "Codex app-server run failed.");
        yield { type: "done", finishReason: "error" };
      } finally {
        await liveHandle.shutdown();
        if (active?.handle === liveHandle) active = null;
      }
    }

    return stream();
  }

  async function cancel(_runId: string): Promise<void> {
    if (!capabilities.includes("cancellation")) {
      return;
    }
    if (active?.threadId) {
      await active.handle.cancel(active.threadId);
    }
    active = null;
  }

  async function listModels(): Promise<ModelDiscoveryResult> {
    const handle = deps.createCodexAppServer?.(provider, {
      onRequestStarted: () => {},
      onRetry: () => {}
    });
    if (!handle?.listModels) {
      return { outcome: "unsupported", models: [], message: "Codex model discovery is not wired." };
    }
    try {
      await handle.initialize();
      return await handle.listModels();
    } finally {
      await handle.shutdown();
    }
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

export function resolveCodexBackend(
  provider: BackendProvider,
  deps: BackendDeps
): AgentBackend | null {
  return createCodexBackend(provider, deps);
}
