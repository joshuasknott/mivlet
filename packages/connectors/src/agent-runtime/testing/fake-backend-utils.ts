/**
 * Fake Backend and Transport Testing Utilities.
 *
 * Provides configurable mock processes and transport handles for testing
 * AgentBackend adapters without requiring live egress connections or process daemons.
 */

import type {
  CodexAppServerHandle,
  CodexAppServerEvent,
  CodexThreadRef,
  CodexTurnRequest
} from "../contract";
import type { ModelDiscoveryResult } from "../../native-api/discovery";
import type { HttpTransport } from "../../native-api/transport";
import type { AgentTurnRequest, NativeCompletionRequest } from "@mivlet/protocol";

/**
 * A highly configurable mock implementation of CodexAppServerHandle.
 * Simulates threads, streaming events, cancellation, tool execution, and process failures.
 */
export class MockCodexAppServer implements CodexAppServerHandle {
  initialized = false;
  started = false;
  shutdownCalled = false;
  resumedThreadId: string | null = null;
  cancelledThreadId: string | null = null;
  submitted = false;
  approvalResponses: Array<{ requestId: string; ok: boolean; output: string }> = [];

  constructor(
    public config: {
      events?: readonly CodexAppServerEvent[];
      listModelsResult?: ModelDiscoveryResult;
      shouldFailInitialize?: boolean;
      shouldFailListModels?: boolean;
      shouldCrashMidStream?: boolean;
      shouldTriggerRetry?: boolean;
      onRetry?: () => void;
    } = {}
  ) {}

  async initialize(): Promise<void> {
    if (this.config.shouldFailInitialize) {
      throw new Error("Codex app-server initialization failed.");
    }
    this.initialized = true;
  }

  async startThread(request: AgentTurnRequest): Promise<CodexThreadRef> {
    this.started = true;
    return { threadId: "codex-thread-mock-1" };
  }

  async resumeThread(threadId: string, request: AgentTurnRequest): Promise<CodexThreadRef> {
    this.resumedThreadId = threadId;
    return { threadId };
  }

  async *submitTurn(request: CodexTurnRequest): AsyncIterable<CodexAppServerEvent> {
    this.submitted = true;
    if (this.config.shouldTriggerRetry) {
      this.config.onRetry?.();
    }

    const events = this.config.events ?? [];
    for (let i = 0; i < events.length; i++) {
      if (this.config.shouldCrashMidStream && i === Math.floor(events.length / 2)) {
        throw new Error("Codex process crashed mid-stream.");
      }
      yield events[i];
    }
  }

  async respondApproval(
    requestId: string,
    result: { callId: string; ok: boolean; output: string }
  ): Promise<void> {
    this.approvalResponses.push({ requestId, ok: result.ok, output: result.output });
  }

  async cancel(threadId: string): Promise<void> {
    this.cancelledThreadId = threadId;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }

  async listModels(): Promise<ModelDiscoveryResult> {
    if (this.config.shouldFailListModels) {
      throw new Error("Codex model discovery failed.");
    }
    return (
      this.config.listModelsResult ?? {
        outcome: "success",
        models: [{ id: "gpt-5", available: true }]
      }
    );
  }
}

/**
 * A configurable mock implementation of HttpTransport.
 * Simulates lines replay, stream failures, and retry events.
 */
export class MockHttpTransport implements HttpTransport {
  constructor(
    public config: {
      lines?: readonly string[];
      shouldCrashMidStream?: boolean;
      shouldTriggerRetry?: boolean;
      onRetry?: () => void;
    } = {}
  ) {}

  async *stream(request: NativeCompletionRequest): AsyncIterable<string> {
    if (this.config.shouldTriggerRetry) {
      this.config.onRetry?.();
    }

    const lines = this.config.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      if (this.config.shouldCrashMidStream && i === Math.floor(lines.length / 2)) {
        throw new Error("HTTP/SSE stream disconnected abruptly.");
      }
      const trimmed = lines[i].trim();
      if (trimmed.length > 0) {
        yield trimmed;
      }
    }
  }
}
