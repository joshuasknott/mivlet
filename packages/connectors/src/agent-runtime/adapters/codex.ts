/**
 * Codex app-server `AgentBackend` adapter.
 *
 * Codex is one provider-neutral adapter. It supervises the Codex-owned
 * app-server process through an injected client and reuses Codex-owned auth
 * only. This adapter never reads, copies, logs, stores, or transports ChatGPT
 * subscription tokens.
 */

import type {
  AgentTurnOptions,
  AgentTurnRequest,
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
import { buildToolApproval } from "../../native-api/approvals";
import { effectForTool, evaluatePermissionPolicy } from "../../permission-policy";

function requestedThreadId(request: AgentTurnRequest): string | null {
  const candidate = (request as AgentTurnRequest & { threadId?: unknown; codexThreadId?: unknown })
    .threadId;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  const legacyCandidate = (
    request as AgentTurnRequest & { threadId?: unknown; codexThreadId?: unknown }
  ).codexThreadId;
  return typeof legacyCandidate === "string" && legacyCandidate.trim()
    ? legacyCandidate.trim()
    : null;
}

async function* mapCodexEvents(
  handle: CodexAppServerHandle,
  threadId: string,
  events: AsyncIterable<CodexAppServerEvent>,
  options: AgentTurnOptions,
  capabilities: readonly BackendCapability[],
  advertisedTools: AgentTurnRequest["tools"]
): AsyncIterable<BackendAgentEvent> {
  let toolCalls = 0;
  const maxToolCalls = Math.max(1, Math.min(80, options.maxToolCalls ?? 80));
  for await (const event of events) {
    if (options.shouldCancel?.()) {
      await handle.cancel(threadId);
      yield { type: "cancelled" };
      return;
    }

    if (event.type === "text-delta") {
      yield { type: "text-delta", text: event.text };
    } else if (event.type === "reasoning-summary") {
      yield { ...event, text: redactSecretsFromString(event.text) };
    } else if (event.type === "provider-tool") {
      yield {
        ...event,
        arguments: redactSecretsFromString(event.arguments),
        ...(event.output === undefined
          ? {}
          : { output: redactSecretsFromString(event.output) })
      };
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
      if (++toolCalls > maxToolCalls) {
        await handle.respondApproval(event.requestId, { callId: event.callId, ok: false, output: "Mivlet stopped this turn at its tool-call limit. Report current progress to the user." });
        await handle.cancel(threadId);
        yield { type: "error", message: "Computer work reached this turn's action limit. Review the current state before continuing." };
        yield { type: "done", finishReason: "error" };
        return;
      }
      const dynamicTool = advertisedTools.some((tool) => tool.name === event.tool);
      const approval = dynamicTool ? { ...buildToolApproval("Codex", event.tool, event.arguments), id: event.approval.id } : event.approval;
      if (!capabilities.includes("tool-requests") || !capabilities.includes("approvals")) {
        yield { type: "error", message: "Tool calls/approvals are not supported by this backend's capabilities." };
        yield { type: "done", finishReason: "error" };
        return;
      }
      try {
        if (!dynamicTool) {
          throw new Error("Use only the Mivlet tools supplied for this turn. Host commands, files, and inherited provider tools are unavailable.");
        }
        if (dynamicTool) {
          const effect = effectForTool(event.tool);
          if (!effect || !evaluatePermissionPolicy({ mode: options.permissionMode ?? "read-only", effect, riskLevel: approval.riskLevel }).allowed) {
            throw new Error(`Blocked by Mivlet's ${options.permissionMode ?? "read-only"} permission mode.`);
          }
        }
        yield { type: "tool-call", callId: event.callId, tool: event.tool, arguments: event.arguments, approval };
        const output = await options.execute(approval, event.arguments);
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
    request: AgentTurnRequest,
    options: AgentTurnOptions
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
            attemptId: options.attemptId,
            computer: options.computer
          }
        });
        yield* mapCodexEvents(liveHandle, thread.threadId, codexEvents, options, capabilities, request.tools);
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
