import { describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, BackendAgentEvent } from "@fable/protocol";
import { FakeAcpTransport, type ScriptedResponder } from "./transport-fakes";
import { runAcpSession } from "./session";

const baseRequest: AgentRunRequest = {
  model: "provider-default",
  messages: [{ role: "user", content: "say hi" }],
  tools: [],
  maxTokens: 1024
};

const okResponder: ScriptedResponder = (request) => {
  switch (request.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: []
        }
      };
    case "session/new":
      return { result: { sessionId: "session-1" } };
    case "session/prompt":
      return { result: { stopReason: "end_turn" } };
    default:
      return { error: { code: -32601, message: `unexpected ${request.method}` } };
  }
};

async function collect(
  iterable: AsyncIterable<BackendAgentEvent>
): Promise<BackendAgentEvent[]> {
  const events: BackendAgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function queueText(transport: FakeAcpTransport, text: string): void {
  transport.queueNotification("session/update", {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text }
    }
  });
}

function permissionParams(callId = "tool-1") {
  return {
    sessionId: "session-1",
    toolCall: {
      toolCallId: callId,
      title: "Edit src/app.ts",
      kind: "edit",
      rawInput: { path: "src/app.ts" }
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" }
    ]
  };
}

describe("ACP v1 lifecycle", () => {
  it("uses the official initialize, session/new, prompt, and update shapes", async () => {
    const transport = new FakeAcpTransport(okResponder);
    queueText(transport, "Hello");
    queueText(transport, " world");

    const events = await collect(
      runAcpSession(transport, "cursor", baseRequest, { execute: async () => "ok" })
    );

    expect(
      events
        .filter(
          (event): event is Extract<BackendAgentEvent, { type: "text-delta" }> =>
            event.type === "text-delta"
        )
        .map((event) => event.text)
        .join("")
    ).toBe("Hello world");
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });

    const requests = transport.sentFrames.filter(
      (frame): frame is Extract<typeof frame, { id: string | number; method: string }> =>
        "id" in frame && "method" in frame
    );
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt"
    ]);
    expect(requests[0].params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "fable" }
    });
    expect(requests[1].params).toEqual({ cwd: "/workspace", mcpServers: [] });
    expect(requests[2].params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "say hi" }]
    });
    expect(transport.isClosed).toBe(true);
  });

  it("authenticates with an advertised Grok method before creating a session", async () => {
    const responder: ScriptedResponder = (request) => {
      if (request.method === "initialize") {
        return {
          result: {
            protocolVersion: 1,
            authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }]
          }
        };
      }
      if (request.method === "authenticate") return { result: {} };
      if (request.method === "session/new") return { result: { sessionId: "session-1" } };
      return { result: { stopReason: "end_turn" } };
    };
    const transport = new FakeAcpTransport(responder);
    await collect(
      runAcpSession(transport, "grok", baseRequest, { execute: async () => "ok" })
    );
    const auth = transport.sentFrames.find(
      (frame) => "method" in frame && frame.method === "authenticate"
    );
    expect(auth && "params" in auth ? auth.params : null).toEqual({
      methodId: "cached_token",
      _meta: { headless: true }
    });
  });

  it("authenticates other agents only after session/new reports auth_required", async () => {
    let newSessionCalls = 0;
    const responder: ScriptedResponder = (request) => {
      if (request.method === "initialize") {
        return {
          result: { protocolVersion: 1, authMethods: [{ id: "agent-login" }] }
        };
      }
      if (request.method === "session/new" && ++newSessionCalls === 1) {
        return { error: { code: -32000, message: "auth_required" } };
      }
      if (request.method === "session/new") {
        return { result: { sessionId: "session-1" } };
      }
      if (request.method === "authenticate") return { result: {} };
      return { result: { stopReason: "end_turn" } };
    };
    const transport = new FakeAcpTransport(responder);
    await collect(
      runAcpSession(transport, "cursor", baseRequest, { execute: async () => "ok" })
    );
    expect(
      transport.sentFrames
        .filter((frame) => "method" in frame)
        .map((frame) => ("method" in frame ? frame.method : ""))
    ).toEqual([
      "initialize",
      "session/new",
      "authenticate",
      "session/new",
      "session/prompt"
    ]);
  });

  it("fails closed when initialization negotiates another protocol version", async () => {
    const transport = new FakeAcpTransport(() => ({
      result: { protocolVersion: 2, authMethods: [] }
    }));
    const events = await collect(
      runAcpSession(transport, "cursor", baseRequest, { execute: async () => "ok" })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringMatching(/protocol version/i) })
    );
  });
});

describe("ACP permission gating", () => {
  it("routes a server permission request through Fable and selects allow_once only", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueRequest(41, "session/request_permission", permissionParams());
    transport.queueNotification("session/update", {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "edited"
      }
    });
    const execute = vi.fn(async () => "ACP permission granted once.");

    const events = await collect(
      runAcpSession(transport, "copilot", baseRequest, { execute })
    );
    const toolCall = events.find((event) => event.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      callId: "tool-1",
      tool: "acp-permission"
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "tool-1",
      ok: true,
      output: "edited"
    });
    const response = transport.sentFrames.find(
      (frame) => "id" in frame && frame.id === 41 && !("method" in frame)
    );
    expect(response && "result" in response ? response.result : null).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" }
    });
    expect(JSON.stringify(response)).not.toContain("allow-always");
  });

  it("selects reject_once and yields a failed result when the gate denies", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueRequest("permission-1", "session/request_permission", permissionParams());
    const events = await collect(
      runAcpSession(transport, "opencode", baseRequest, {
        execute: async () => {
          throw new Error("denied");
        }
      })
    );
    expect(events).toContainEqual({
      type: "tool-result",
      callId: "tool-1",
      ok: false,
      output: "Permission denied."
    });
    const response = transport.sentFrames.find(
      (frame) => "id" in frame && frame.id === "permission-1" && !("method" in frame)
    );
    expect(response && "result" in response ? response.result : null).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" }
    });
  });

  it("refuses replayed permission call ids and enforces the request cap", async () => {
    const replay = new FakeAcpTransport(okResponder);
    replay.queueRequest(1, "session/request_permission", permissionParams("same-call"));
    replay.queueRequest(2, "session/request_permission", permissionParams("same-call"));
    const replayEvents = await collect(
      runAcpSession(replay, "cursor", baseRequest, { execute: async () => "ok" })
    );
    expect(replayEvents.filter((event) => event.type === "tool-call")).toHaveLength(1);
    expect(replayEvents.some((event) => event.type === "error")).toBe(true);

    const capped = new FakeAcpTransport(okResponder);
    capped.queueRequest(3, "session/request_permission", permissionParams("one"));
    capped.queueRequest(4, "session/request_permission", permissionParams("two"));
    const cappedEvents = await collect(
      runAcpSession(capped, "cursor", baseRequest, {
        execute: async () => "ok",
        maxToolCalls: 1
      })
    );
    expect(cappedEvents.filter((event) => event.type === "tool-call")).toHaveLength(1);
    expect(cappedEvents.some((event) => event.type === "error")).toBe(true);
  });

  it("rejects unknown server requests instead of leaving the agent blocked", async () => {
    const transport = new FakeAcpTransport(okResponder);
    transport.queueRequest(77, "terminal/create", {});
    await collect(
      runAcpSession(transport, "cursor", baseRequest, { execute: async () => "ok" })
    );
    const response = transport.sentFrames.find(
      (frame) => "id" in frame && frame.id === 77 && !("method" in frame)
    );
    expect(response && "error" in response ? response.error : null).toMatchObject({
      code: -32601
    });
  });
});

describe("ACP cancellation", () => {
  it("sends session/cancel and yields cancelled", async () => {
    const transport = new FakeAcpTransport(okResponder);
    const events = await collect(
      runAcpSession(transport, "cursor", baseRequest, {
        execute: async () => "ok",
        shouldCancel: () => true
      })
    );
    expect(events).toContainEqual({ type: "cancelled" });
    expect(
      transport.sentFrames.some(
        (frame) => "method" in frame && frame.method === "session/cancel"
      )
    ).toBe(true);
  });
});
