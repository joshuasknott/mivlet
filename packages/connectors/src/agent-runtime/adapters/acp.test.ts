import { describe, expect, it } from "vitest";
import type {
  AgentTurnRequest,
  BackendAgentEvent,
  BackendProvider
} from "@fable/protocol";
import { resolveAcpBackend } from "./acp";
import { FakeAcpTransport, type ScriptedResponder } from "./acp/transport-fakes";
import type { AcpTransportFactory } from "./acp/transport";

/** A connected, streaming ACP (Cursor) provider. */
function acpProvider(overrides: Partial<BackendProvider> = {}): BackendProvider {
  return {
    id: "cursor",
    backendType: "acp",
    label: "Cursor",
    description: "ACP CLI",
    authState: "connected",
    capabilities: ["authentication", "threads", "streaming", "tool-requests", "approvals", "file-changes", "cancellation"],
    models: [{ id: "cursor-default", label: "Cursor default", available: true }],
    ...overrides
  };
}

const okResponder: ScriptedResponder = (req) => {
  if (req.method === "initialize") {
    return { result: { protocolVersion: 1, authMethods: [] } };
  }
  if (req.method === "session/new") {
    return { result: { sessionId: "session-1" } };
  }
  if (req.method === "session/prompt") {
    return { result: { stopReason: "end_turn" } };
  }
  return { error: { code: -32601, message: "not found" } };
};

const baseRunRequest: AgentTurnRequest = {
  model: "cursor-default",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  maxTokens: 1024
};

async function collect(iter: AsyncIterable<BackendAgentEvent>): Promise<BackendAgentEvent[]> {
  const out: BackendAgentEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

/** Build an AcpTransportFactory that always serves the same scripted transport
 *  (created eagerly so the test can seed its stream before calling run()). */
function scriptedFactory(): {
  factory: AcpTransportFactory;
  transport: FakeAcpTransport;
} {
  const transport = new FakeAcpTransport(okResponder);
  return {
    factory: () => transport,
    transport
  };
}

describe("resolveAcpBackend", () => {
  it("returns null when the provider is not connected", () => {
    const { factory } = scriptedFactory();
    const backend = resolveAcpBackend(acpProvider({ authState: "install-required" }), {
      createTransport: () => null,
      createAcpTransport: factory
    });
    expect(backend).toBeNull();
  });

  it("returns null when the provider lacks the streaming capability", () => {
    const { factory } = scriptedFactory();
    const backend = resolveAcpBackend(
      acpProvider({ capabilities: ["authentication"] }),
      { createTransport: () => null, createAcpTransport: factory }
    );
    expect(backend).toBeNull();
  });

  it("returns null when createAcpTransport is absent (no egress wiring)", () => {
    const backend = resolveAcpBackend(acpProvider(), {
      createTransport: () => null
    });
    expect(backend).toBeNull();
  });

  it("returns null when createAcpTransport returns null (no CLI process)", () => {
    const backend = resolveAcpBackend(acpProvider(), {
      createTransport: () => null,
      createAcpTransport: () => null
    });
    expect(backend).not.toBeNull();
    // The backend exists but run() returns null when no transport can be built.
    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    expect(iter).toBeNull();
  });

  it("builds a backend whose run() streams events over the ACP transport", async () => {
    const { factory, transport } = scriptedFactory();
    const backend = resolveAcpBackend(acpProvider(), {
      createTransport: () => null,
      createAcpTransport: factory
    });
    expect(backend).not.toBeNull();
    expect(backend?.providerId).toBe("cursor");

    // Pre-seed the scripted stream; run() drains it over the transport.
    transport.queueNotification("session/update", {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" }
      }
    });
    transport.queueNotification("session/update", {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " there" }
      }
    });

    const iter = backend?.run(baseRunRequest, { execute: async () => "ok" });
    expect(iter).not.toBeNull();
    const events = await collect(iter as AsyncIterable<BackendAgentEvent>);
    const text = events
      .filter((e): e is Extract<BackendAgentEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Hello there");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });

  it("cancel() closes the active transport without throwing", async () => {
    const { factory, transport } = scriptedFactory();
    const backend = resolveAcpBackend(acpProvider(), {
      createTransport: () => null,
      createAcpTransport: factory
    });
    await collect(backend?.run(baseRunRequest, { execute: async () => "ok" })!);
    await expect(backend?.cancel("run-1")).resolves.toBeUndefined();
  });

  it("listModels() returns unsupported when discovery is not wired", async () => {
    const { factory } = scriptedFactory();
    const backend = resolveAcpBackend(acpProvider(), {
      createTransport: () => null,
      createAcpTransport: factory
    });
    const result = await backend?.listModels?.();
    expect(result?.outcome).toBe("unsupported");
  });
});
