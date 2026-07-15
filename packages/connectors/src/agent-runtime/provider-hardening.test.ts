import { describe, expect, it, vi } from "vitest";
import type { BackendProvider, BackendAgentEvent } from "@fable/protocol";
import { createNativeApiBackend } from "./adapters/native-api";
import { createCodexBackend } from "./adapters/codex";
import { MockCodexAppServer } from "./testing/fake-backend-utils";
import type { AgentRunRequest } from "@fable/protocol";

function mockNativeProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "connected",
    capabilities: ["authentication", "streaming", "cancellation"],
    models: [{ id: "gpt-5", label: "GPT-5", available: true }],
    ...overrides
  };
}

function mockCodexProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "Codex app-server",
    authState: "connected",
    capabilities: ["authentication", "streaming", "cancellation"],
    models: [],
    ...overrides
  };
}

const baseRequest: AgentRunRequest = {
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

describe("Provider Hardening Tests", () => {
  // 1. Validation & Auth Errors
  describe("Config/Key Validation", () => {
    it("handles missing config/key error in native-api backend", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Missing api_key in environment or configuration.");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "authentication",
        retryable: false
      });
    });

    it("handles invalid config/key error in native-api backend", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Authentication failed: invalid token sk-12345678901234567890abc123.");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "authentication",
        message: "Authentication failed: invalid token [REDACTED].",
        retryable: false
      });
    });
  });

  // 2. Provider Unavailable / Degraded States
  describe("Provider Degraded States", () => {
    it("handles rate limiting (429/quota exceeded) in native-api", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Rate limit exceeded. Quota reached (429).");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "rate-limited",
        retryable: true
      });
    });

    it("handles provider overload/503 service unavailable", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Service temporarily unavailable or overloaded (503).");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "provider-unavailable",
        retryable: true
      });
    });

    it("handles connection/network disconnect abruptly mid-stream", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          yield 'data: {"choices":[{"delta":{"content":"ok"}}]}';
          throw new Error("Connection dropped mid-stream.");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "provider-unavailable",
        retryable: true
      });
    });

    it.each([
      ["This model is not included in your subscription plan.", "entitlement", false],
      ["DNS resolution failed: network unreachable.", "offline", true],
      ["Connection timed out waiting for gateway response.", "timeout", true]
    ])("normalizes %s", async (message, code, retryable) => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error(message);
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      expect(events.find(event => event.type === "error")).toMatchObject({
        type: "error",
        code,
        retryable
      });
    });
  });

  // 3. Model Listing States
  describe("Model Listing", () => {
    it("returns unsupported when discoverModels returns null", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => null
      });
      const result = await backend?.listModels?.();
      expect(result).toEqual({
        outcome: "unsupported",
        models: [],
        message: "Model discovery is not wired."
      });
    });

    it("handles successful model discovery returning empty list", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => ({
          outcome: "success",
          models: []
        })
      });
      const result = await backend?.listModels?.();
      expect(result).toEqual({
        outcome: "success",
        models: []
      });
    });

    it("handles failed model discovery outcome", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => ({
          outcome: "failed",
          models: [],
          message: "API keys invalid or not found."
        })
      });
      const result = await backend?.listModels?.();
      expect(result).toEqual({
        outcome: "failed",
        models: [],
        message: "API keys invalid or not found."
      });
    });

    it("handles offline discovery outcome", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => ({
          outcome: "offline",
          models: []
        })
      });
      const result = await backend?.listModels?.();
      expect(result?.outcome).toBe("offline");
    });

    it("propagates throw from discoverModels", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null,
        discoverModels: async () => {
          throw new Error("Unexpected discovery crash");
        }
      });
      await expect(backend?.listModels?.()).rejects.toThrow("Unexpected discovery crash");
    });
  });

  // 4. Cancellation Behavior
  describe("Cancellation Behavior", () => {
    it("invokes transport cancel callback on active run", async () => {
      const cancelSpy = vi.fn();
      let onRequestStartedCallback: ((id: string) => void) | undefined;
      const transport = {
        async *stream(): AsyncIterable<string> {
          if (onRequestStartedCallback) {
            onRequestStartedCallback("mock-request-id-123");
          }
          yield 'data: {"choices":[{"delta":{"content":"streaming..."}}]}';
          // sleep or wait so we stay active
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: (provider, handlers) => {
          onRequestStartedCallback = handlers.onRequestStarted;
          return { transport, cancel: cancelSpy };
        }
      });

      const runIter = backend?.run(baseRequest, { execute: async () => "" });
      const reader = runIter?.[Symbol.asyncIterator]();

      // consume first chunk to trigger onRequestStarted
      await reader?.next();

      await backend?.cancel("ignored-run-id");
      expect(cancelSpy).toHaveBeenCalledWith("mock-request-id-123");
    });

    it("keeps parallel child requests distinct and cancels both from the parent run", async () => {
      const cancelA = vi.fn(async () => undefined);
      const cancelB = vi.fn(async () => undefined);
      const cancels = [cancelA, cancelB];
      let transportIndex = 0;
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: (_provider, handlers) => {
          const index = transportIndex++;
          return {
            transport: {
              async *stream(): AsyncIterable<string> {
                handlers.onRequestStarted(`request-${index === 0 ? "a" : "b"}`);
                yield 'data: {"choices":[{"delta":{"content":"working"}}]}';
                await new Promise((resolve) => setTimeout(resolve, 50));
                yield 'data: {"choices":[{"finish_reason":"stop"}]}';
              }
            },
            cancel: cancels[index]
          };
        }
      });
      const streamA = backend?.run(baseRequest, { runId: "mission-1:worker:a", execute: async () => "" });
      const streamB = backend?.run(baseRequest, { runId: "mission-1:worker:b", execute: async () => "" });
      const readerA = streamA?.[Symbol.asyncIterator]();
      const readerB = streamB?.[Symbol.asyncIterator]();
      await Promise.all([readerA?.next(), readerB?.next()]);

      await backend?.cancel("mission-1");

      expect(cancelA).toHaveBeenCalledOnce();
      expect(cancelA).toHaveBeenCalledWith("request-a");
      expect(cancelB).toHaveBeenCalledOnce();
      expect(cancelB).toHaveBeenCalledWith("request-b");
      await Promise.all([readerA?.return?.(), readerB?.return?.()]);
    });

    it("remembers cancellation requested before the provider assigns a request id", async () => {
      const cancelSpy = vi.fn(async () => undefined);
      let started: ((id: string) => void) | undefined;
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: (_provider, handlers) => {
          started = handlers.onRequestStarted;
          return {
            transport: {
              async *stream(): AsyncIterable<string> {
                started?.("late-request");
                yield 'data: {"choices":[{"delta":{"content":"working"}}]}';
                yield 'data: {"choices":[{"finish_reason":"stop"}]}';
              }
            },
            cancel: cancelSpy
          };
        }
      });
      const stream = backend?.run(baseRequest, {
        runId: "mission-early:worker:a", execute: async () => ""
      });
      const reader = stream?.[Symbol.asyncIterator]();

      await backend?.cancel("mission-early");
      await reader?.next();
      await Promise.resolve();

      expect(cancelSpy).toHaveBeenCalledOnce();
      expect(cancelSpy).toHaveBeenCalledWith("late-request");
      await reader?.return?.();
    });

    it("safe no-op when cancel called with no active run", async () => {
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => null
      });
      await expect(backend?.cancel("any-id")).resolves.toBeUndefined();
    });

    it("gates cancel when cancellation capability is missing from provider", async () => {
      const cancelSpy = vi.fn();
      let onRequestStartedCallback: ((id: string) => void) | undefined;
      const transport = {
        async *stream(): AsyncIterable<string> {
          if (onRequestStartedCallback) {
            onRequestStartedCallback("mock-request-id-123");
          }
          yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        }
      };
      // provider without 'cancellation' capability
      const providerWithoutCancel = mockNativeProvider({
        capabilities: ["streaming"]
      });
      const backend = createNativeApiBackend(providerWithoutCancel, {
        createTransport: (provider, handlers) => {
          onRequestStartedCallback = handlers.onRequestStarted;
          return { transport, cancel: cancelSpy };
        }
      });

      const runIter = backend?.run(baseRequest, { execute: async () => "" });
      const reader = runIter?.[Symbol.asyncIterator]();
      await reader?.next();

      await backend?.cancel("ignored-run-id");
      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  // 5. Retry & Timeout Behavior
  describe("Retry and Timeout Behavior", () => {
    it("normalizes timeout error messages to timeout code and retryable true", async () => {
      const transport = {
        async *stream(): AsyncIterable<string> {
          throw new Error("Connection timed out waiting for gateway response.");
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: () => ({ transport, cancel: async () => {} })
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toMatchObject({
        type: "error",
        code: "timeout",
        retryable: true
      });
    });

    it("propagates retry callback triggers to options.onRetry", async () => {
      const onRetrySpy = vi.fn();
      const transport = {
        async *stream(): AsyncIterable<string> {
          yield 'data: {"choices":[{"finish_reason":"stop"}]}';
        }
      };
      const backend = createNativeApiBackend(mockNativeProvider(), {
        createTransport: (prov, handlers) => {
          // manually trigger retry to simulate what boundary/transport does
          handlers.onRetry();
          return { transport, cancel: async () => {} };
        }
      });
      await collectEvents(backend?.run(baseRequest, { execute: async () => "", onRetry: onRetrySpy }));
      expect(onRetrySpy).toHaveBeenCalled();
    });
  });

  // 6. Safe User-Facing Error Messages (redaction check)
  describe("Safe User-Facing Error Messages", () => {
    it("redacts secrets from errors thrown during Codex run lifecycle", async () => {
      const handle = new MockCodexAppServer({
        shouldFailInitialize: true
      });
      // Mock class or prototype message throwing a key
      vi.spyOn(handle, "initialize").mockRejectedValue(new Error("Init failed: token=sk-ant-45678901234567890abc123"));

      const backend = createCodexBackend(mockCodexProvider(), {
        createTransport: () => null,
        createCodexAppServer: () => handle
      });
      const events = await collectEvents(backend?.run(baseRequest, { execute: async () => "" }));
      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).not.toContain("sk-ant-");
      expect(errorEvent?.message).toContain("[REDACTED]");
    });
  });
});
