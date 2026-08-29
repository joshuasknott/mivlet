import { describe, expect, it, vi } from "vitest";
import type { BackendProvider, BackendAgentEvent, BackendCapability } from "@fable/protocol";
import { resolveAgentBackend, type BackendDeps } from "./index";
import { createCodexBackend } from "./adapters/codex";
import { createNativeApiBackend } from "./adapters/native-api";
import { MockCodexAppServer, MockHttpTransport } from "./testing/fake-backend-utils";
import { redactSecretsFromString, redactSecretsFromObject } from "./utils/redact";
import type { AgentTurnRequest, AgentTurnOptions } from "@fable/protocol";

/** Connected, streaming native-API provider. */
function mockNativeProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: ["authentication", "streaming", "tool-requests", "approvals", "cancellation"],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
    ...overrides
  };
}

/** Connected, streaming Codex provider. */
function mockCodexProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "Codex app-server",
    authState: "connected",
    capabilities: ["authentication", "threads", "streaming", "tool-requests", "approvals", "cancellation"],
    models: [],
    installHint: "ChatGPT subscription or OpenAI API key",
    ...overrides
  };
}

const baseRequest: AgentTurnRequest = {
  model: "gpt-5",
  messages: [{ role: "user", content: "say hi" }],
  tools: [],
  maxTokens: 1024
};

async function collectEvents(
  iter: AsyncIterable<BackendAgentEvent> | null | undefined
): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  if (!iter) return events;
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

function mockCodexDeps(handle: MockCodexAppServer | null): BackendDeps {
  return {
    createTransport: () => null,
    createCodexAppServer: () => handle
  };
}

describe("AgentBackend Conformance Tests", () => {
  // ==========================================
  // Area 1: Secret Redaction
  // ==========================================
  describe("Secret Redaction", () => {
    it("redacts credentials from raw strings", () => {
      expect(redactSecretsFromString("my key is sk-12345678901234567890abc123")).toBe("my key is [REDACTED]");
      expect(redactSecretsFromString("bearer sk-ant-12345678901234567890abc123")).toBe("bearer [REDACTED]");
      expect(redactSecretsFromString("Gemini key is AIzaSy123456789012345678901234567890abc")).toBe("Gemini key is [REDACTED]");
      expect(redactSecretsFromString("Bearer my-session-token-value-here")).toBe("Bearer [REDACTED]");
      expect(redactSecretsFromString("token=my-secret-token")).toBe("token=[REDACTED]");
      expect(redactSecretsFromString("api_key: \"super_secret_value\"")).toBe("api_key: \"[REDACTED]\"");
    });

    it("redacts credentials from nested objects recursively", () => {
      const sensitive = {
        api_key: "sk-12345678901234567890abc123",
        token: "session_token_value",
        messages: [{ role: "user", content: "sk-ant-12345678901234567890abc123" }],
        metadata: {
          key: "AIzaSy123456789012345678901234567890abc",
          safeValue: 42
        }
      };

      const redacted = redactSecretsFromObject(sensitive);
      expect(redacted.api_key).toBe("[REDACTED]");
      expect(redacted.token).toBe("[REDACTED]");
      expect(redacted.messages[0].content).toBe("[REDACTED]");
      expect(redacted.metadata.key).toBe("[REDACTED]");
      expect(redacted.metadata.safeValue).toBe(42);
    });

    it("ensures Codex errors containing keys are redacted", async () => {
      const handle = new MockCodexAppServer({
        events: [{ type: "error", message: "Failed: token=sk-12345678901234567890abc123" }]
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);
      expect(events).toContainEqual({
        type: "error",
        message: "Failed: token=[REDACTED]",
        code: "authentication",
        retryable: false
      });
    });

    it("ensures Native-API errors containing keys are redacted", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Invalid key: sk-12345678901234567890abc123");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);
      expect(events).toContainEqual({
        type: "error",
        message: "Invalid key: [REDACTED]",
        code: "authentication",
        retryable: false
      });
    });

  });

  // ==========================================
  // Area 2: Connection/Auth State Transitions
  // ==========================================
  describe("Connection and Auth State Transitions", () => {
    it("gating: resolveAgentBackend returns null for needs-auth and install-required", () => {
      const needsAuth = mockNativeProvider({ authState: "needs-auth" });
      const installRequired = mockNativeProvider({ authState: "install-required" });

      expect(resolveAgentBackend(needsAuth, { createTransport: () => null })).toBeNull();
      expect(resolveAgentBackend(installRequired, { createTransport: () => null })).toBeNull();
    });

    it("resolves backend successfully when auth state is connected", () => {
      const connected = mockNativeProvider({ authState: "connected" });
      const backend = resolveAgentBackend(connected, {
        createTransport: () => ({ transport: new MockHttpTransport({}), cancel: async () => {} })
      });
      expect(backend).not.toBeNull();
      expect(backend?.providerId).toBe("openai");
    });
  });

  // ==========================================
  // Area 2b: Error Normalization
  // ==========================================
  describe("Error Normalization", () => {
    it("normalizes blocked-auth errors across Native API and Codex", async () => {
      const nativeTransport = {
        async *stream(): AsyncIterable<string> {
          const error = new Error("Provider returned HTTP 401.");
          (error as Error & { code: string; retryable: boolean }).code = "authentication";
          (error as Error & { code: string; retryable: boolean }).retryable = false;
          throw error;
        }
      };
      const native = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport: nativeTransport, cancel: async () => {} })
      });
      const codex = createCodexBackend(
        mockCodexProvider(),
        mockCodexDeps(new MockCodexAppServer({
          events: [{ type: "error", message: "Codex sign-in required." }]
        }))
      );
      const eventSets = await Promise.all([
        collectEvents(native?.run(baseRequest, { execute: async () => "" })),
        collectEvents(codex?.run(baseRequest, { execute: async () => "" }))
      ]);

      for (const events of eventSets) {
        const error = events.find((event) => event.type === "error");
        expect(error).toMatchObject({
          type: "error",
          code: "authentication",
          retryable: false
        });
      }
    });

    it("normalizes retryable runtime errors across Native API and Codex", async () => {
      const nativeTransport = {
        async *stream(): AsyncIterable<string> {
          const error = new Error("Provider stream ended unexpectedly.");
          (error as Error & { code: string; retryable: boolean }).code = "transport";
          (error as Error & { code: string; retryable: boolean }).retryable = true;
          throw error;
        }
      };
      const native = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport: nativeTransport, cancel: async () => {} })
      });
      const codex = createCodexBackend(
        mockCodexProvider(),
        mockCodexDeps(new MockCodexAppServer({
          events: [{ type: "error", message: "Codex connection unavailable." }]
        }))
      );
      const eventSets = await Promise.all([
        collectEvents(native?.run(baseRequest, { execute: async () => "" })),
        collectEvents(codex?.run(baseRequest, { execute: async () => "" }))
      ]);

      for (const events of eventSets) {
        const error = events.find((event) => event.type === "error");
        expect(error).toMatchObject({
          type: "error",
          retryable: true
        });
        expect(error).not.toMatchObject({ code: "authentication" });
      }
    });
  });

  // ==========================================
  // Area 3: Model Discovery and Selection
  // ==========================================
  describe("Model Discovery and Selection", () => {
    it("Codex: discovers models successfully via process listModels", async () => {
      const handle = new MockCodexAppServer({
        listModelsResult: {
          outcome: "success",
          models: [{ id: "mock-gpt-5", available: true }]
        }
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      const result = await backend?.listModels?.();
      expect(result?.outcome).toBe("success");
      expect(result?.models).toEqual([{ id: "mock-gpt-5", available: true }]);
    });

    it("Codex: handles listModels error gracefully", async () => {
      const handle = new MockCodexAppServer({ shouldFailListModels: true });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      await expect(backend?.listModels?.()).rejects.toThrow();
    });

    it("Native-API: listModels outcome matches discovery wire", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => ({
          outcome: "success",
          models: [{ id: "discovered-model", available: true }]
        })
      });
      const result = await backend?.listModels?.();
      expect(result?.outcome).toBe("success");
      expect(result?.models).toEqual([{ id: "discovered-model", available: true }]);
    });
  });

  // ==========================================
  // Area 4: Streaming & Ordering
  // ==========================================
  describe("Prompt Submission & Streaming", () => {
    it("Codex: yields events in correct sequence", async () => {
      const handle = new MockCodexAppServer({
        events: [
          { type: "text-delta", text: "Part 1" },
          { type: "text-delta", text: "Part 2" },
          { type: "usage", inputTokens: 5, outputTokens: 10 },
          { type: "done", finishReason: "stop" }
        ]
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);

      expect(events).toEqual([
        { type: "text-delta", text: "Part 1" },
        { type: "text-delta", text: "Part 2" },
        {
          type: "usage",
          inputTokens: 5,
          outputTokens: 10,
          costUsd: 0,
          costEstimated: true,
          costUnknown: true
        },
        { type: "done", finishReason: "stop" }
      ]);
    });

    it("Native-API: yields events in correct sequence", async () => {
      const transport = new MockHttpTransport({
        lines: [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: {"choices":[{"delta":{"content":" World"}}]}',
          'data: {"choices":[{"finish_reason":"stop"}]}'
        ]
      });
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);

      const texts = events
        .filter((e): e is Extract<BackendAgentEvent, { type: "text-delta" }> => e.type === "text-delta")
        .map((e) => e.text)
        .join("");
      expect(texts).toBe("Hello World");
      expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
    });
  });

  // ==========================================
  // Area 5: Cancellation
  // ==========================================
  describe("Cancellation", () => {
    it("Codex: supports explicit cancel() on threadId", async () => {
      const handle = new MockCodexAppServer({
        events: [{ type: "text-delta", text: "Word" }]
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      const stream = backend?.run(baseRequest, { execute: async () => "" });

      // Run stream and cancel
      const reader = stream?.[Symbol.asyncIterator]();
      await reader?.next(); // consume the first yield (text-delta or initialize)
      await backend?.cancel("run-id");

      expect(handle.cancelledThreadId).toBe("codex-thread-mock-1");
    });

    it("Codex: supports cooperative cancellation", async () => {
      const handle = new MockCodexAppServer({
        events: [
          { type: "text-delta", text: "First" },
          { type: "text-delta", text: "Second" }
        ]
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));

      let shouldCancel = false;
      const stream = backend?.run(baseRequest, {
        execute: async () => "",
        shouldCancel: () => shouldCancel
      });

      const events: BackendAgentEvent[] = [];
      for await (const event of stream!) {
        events.push(event);
        shouldCancel = true; // cancel after first event
      }

      expect(events).toContainEqual({ type: "cancelled" });
      expect(handle.cancelledThreadId).toBe("codex-thread-mock-1");
    });

    it("Native-API: supports cooperative cancellation", async () => {
      const transport = new MockHttpTransport({
        lines: [
          'data: {"choices":[{"delta":{"content":"Hi"}}]}',
          'data: {"choices":[{"delta":{"content":" there"}}]}'
        ]
      });
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });

      let shouldCancel = false;
      const stream = backend?.run(baseRequest, {
        execute: async () => "",
        shouldCancel: () => shouldCancel
      });

      const events: BackendAgentEvent[] = [];
      for await (const event of stream!) {
        events.push(event);
        shouldCancel = true;
      }
      expect(events).toContainEqual({ type: "cancelled" });
    });
  });

  // ==========================================
  // Area 6: Approval Requests & Response Loops
  // ==========================================
  describe("Approval Requests & Tool Execution", () => {
    it("Codex: routes approval request to options.execute and returns tool-result", async () => {
      const handle = new MockCodexAppServer({
        events: [
          {
            type: "approval-request",
            requestId: "codex-req-id",
            callId: "call-1",
            tool: "run-shell",
            arguments: "{\"command\":\"echo 1\"}",
            approval: {
              id: "app-id",
              service: "codex",
              action: "shell",
              mode: "full-access",
              riskLevel: "high",
              dataUsed: [],
              consequence: "runs shell",
              requestedAt: "",
              decisions: []
            }
          },
          { type: "done", finishReason: "stop" }
        ]
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));

      const executeSpy = vi.fn().mockResolvedValue("tool response text");
      const stream = backend?.run(baseRequest, { execute: executeSpy });
      const events = await collectEvents(stream);

      expect(executeSpy).toHaveBeenCalled();
      expect(events).toContainEqual({
        type: "tool-result",
        callId: "call-1",
        ok: true,
        output: "tool response text"
      });
      expect(handle.approvalResponses).toContainEqual({
        requestId: "codex-req-id",
        ok: true,
        output: "tool response text"
      });
    });
  });

  // ==========================================
  // Area 7: Provider Crashes & Cleanup
  // ==========================================
  describe("Provider Crashes & Cleanup", () => {
    it("Codex: catch app-server process crash mid-stream and shutdown cleanly", async () => {
      const handle = new MockCodexAppServer({
        events: [
          { type: "text-delta", text: "Normal text" },
          { type: "text-delta", text: "More text" }
        ],
        shouldCrashMidStream: true
      });
      const backend = createCodexBackend(mockCodexProvider(), mockCodexDeps(handle));
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);

      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
      expect(handle.shutdownCalled).toBe(true);
    });

    it("Native-API: catch transport connection drop mid-stream", async () => {
      const transport = new MockHttpTransport({
        lines: [
          'data: {"choices":[{"delta":{"content":"chunk1"}}]}',
          'data: {"choices":[{"delta":{"content":"chunk2"}}]}'
        ],
        shouldCrashMidStream: true
      });
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);

      expect(events.some((e) => e.type === "error")).toBe(true);
      expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
    });
  });

  // ==========================================
  // Area 8: Malformed Events
  // ==========================================
  describe("Malformed Events", () => {
    it("Native-API: ignores or maps invalid JSON SSE streams gracefully", async () => {
      const transport = new MockHttpTransport({
        lines: [
          'data: {"choices":[{"delta":{"content":"good"}}]}',
          "data: { malformed json here }",
          'data: {"choices":[{"finish_reason":"stop"}]}'
        ]
      });
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const events = await collectEvents(stream);

      expect(events).toContainEqual({ type: "text-delta", text: "good" });
      expect(events.some((e) => e.type === "error")).toBe(true);
    });
  });

  // ==========================================
  // Area 9: Reconnect / Retry Behavior
  // ==========================================
  describe("Reconnect / Retry Behavior", () => {
    it("Codex: triggers options.onRetry when process signals retry", async () => {
      const handle = new MockCodexAppServer({
        events: [{ type: "done", finishReason: "stop" }],
        shouldTriggerRetry: true
      });
      const retrySpy = vi.fn();
      const backend = createCodexBackend(mockCodexProvider(), {
        createTransport: () => null,
        createCodexAppServer: (prov, handlers) => {
          // hook the handler back into mock configuration
          handle.config.onRetry = handlers.onRetry;
          return handle;
        }
      });
      const stream = backend?.run(baseRequest, { execute: async () => "", onRetry: retrySpy });
      await collectEvents(stream);

      expect(retrySpy).toHaveBeenCalled();
    });

    it("Native-API: triggers options.onRetry when transport signals retry", async () => {
      const transport = new MockHttpTransport({
        lines: ['data: {"choices":[{"finish_reason":"stop"}]}'],
        shouldTriggerRetry: true
      });
      const retrySpy = vi.fn();
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: (prov, handlers) => {
          transport.config.onRetry = handlers.onRetry;
          return { transport, cancel: async () => {} };
        }
      });
      const stream = backend?.run(baseRequest, { execute: async () => "", onRetry: retrySpy });
      await collectEvents(stream);

      expect(retrySpy).toHaveBeenCalled();
    });
  });

  // ==========================================
  // Area 10: Capability Gating
  // ==========================================
  describe("Capability Gating", () => {
    it("Codex: run fails-closed if streaming capability is missing", async () => {
      const provider = mockCodexProvider({ capabilities: ["authentication"] });
      const handle = new MockCodexAppServer({});
      const backend = createCodexBackend(provider, mockCodexDeps(handle));

      const stream = backend?.run(baseRequest, { execute: async () => "" });
      expect(stream).toBeNull();
    });

    it("Codex: cancel is no-op if cancellation capability is missing", async () => {
      const provider = mockCodexProvider({ capabilities: ["streaming"] }); // lacks cancellation
      const handle = new MockCodexAppServer({});
      const backend = createCodexBackend(provider, mockCodexDeps(handle));

      // Run to set active session
      const stream = backend?.run(baseRequest, { execute: async () => "" });
      const reader = stream?.[Symbol.asyncIterator]();
      await reader?.next();

      await backend?.cancel("run-id");
      expect(handle.cancelledThreadId).toBeNull(); // was not called due to gating
    });

    it("Codex: gates tool execution if approvals or tool-requests is missing", async () => {
      const provider = mockCodexProvider({ capabilities: ["streaming", "cancellation"] }); // lacks tools
      const handle = new MockCodexAppServer({
        events: [
          {
            type: "approval-request",
            requestId: "codex-req-id",
            callId: "call-1",
            tool: "run-shell",
            arguments: "{}",
            approval: {
              id: "app-id",
              service: "codex",
              action: "shell",
              mode: "full-access",
              riskLevel: "high",
              dataUsed: [],
              consequence: "",
              requestedAt: "",
              decisions: []
            }
          }
        ]
      });
      const backend = createCodexBackend(provider, mockCodexDeps(handle));
      const stream = backend?.run(baseRequest, { execute: async () => "tool-res" });
      const events = await collectEvents(stream);

      expect(events.some((e) => e.type === "error" && e.message.includes("capabilities"))).toBe(true);
    });
  });
});
