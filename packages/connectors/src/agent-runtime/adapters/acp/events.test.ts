import { describe, expect, it } from "vitest";
import type { BackendAgentEvent } from "@fable/protocol";
import { buildToolApproval } from "../../../native-api/approvals";
import { notification } from "./protocol-fakes";
import { normalizeAcpNotification } from "./events";

const providerId = "cursor";

describe("normalizeAcpNotification → BackendAgentEvent", () => {
  it("maps an assistant text message to a text-delta", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/message", { content: "hello" })
    );
    expect(event).toEqual({ type: "text-delta", text: "hello" });
  });

  it("concatenates multi-part text content", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/message", { parts: [{ type: "text", text: "foo " }, { type: "text", text: "bar" }] })
    );
    expect(event).toEqual({ type: "text-delta", text: "foo bar" });
  });

  it("maps a tool call notification to a tool-call event with an approval", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("tool/call", {
        callId: "call-1",
        tool: "read-file",
        arguments: JSON.stringify({ path: "a.txt" })
      })
    );
    expect(event?.type).toBe("tool-call");
    if (event?.type === "tool-call") {
      expect(event.callId).toBe("call-1");
      expect(event.tool).toBe("read-file");
      expect(event.arguments).toBe(JSON.stringify({ path: "a.txt" }));
      // approval is built via the shared buildToolApproval (byte-compatible with native-API)
      expect(event.approval).toEqual(buildToolApproval("cursor", "read-file", JSON.stringify({ path: "a.txt" })));
    }
  });

  it("maps a tool result notification to a tool-result event", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("tool/result", { callId: "call-1", ok: true, output: "file contents" })
    );
    expect(event).toEqual({ type: "tool-result", callId: "call-1", ok: true, output: "file contents" });
  });

  it("maps a failed tool result (ok false) through", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("tool/result", { callId: "call-2", ok: false, output: "boom" })
    );
    expect(event).toEqual({ type: "tool-result", callId: "call-2", ok: false, output: "boom" });
  });

  it("maps a usage notification to a usage event", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/usage", { inputTokens: 10, outputTokens: 20, costUsd: 0.01 })
    );
    expect(event).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20, costUsd: 0.01 });
  });

  it("defaults costUsd to 0 and marks cost estimated when the CLI omits cost", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/usage", { inputTokens: 5, outputTokens: 7 })
    );
    if (event?.type === "usage") {
      expect(event.costUsd).toBe(0);
      expect(event.costEstimated).toBe(true);
    } else {
      expect.fail("expected a usage event");
    }
  });

  it("maps a done notification to a done event with the stop finish reason", () => {
    const event = normalizeAcpNotification(providerId, notification("session/done", {}));
    expect(event).toEqual({ type: "done", finishReason: "stop" });
  });

  it("maps a done notification with stopReason length to a length finish", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/done", { stopReason: "length" })
    );
    expect(event).toEqual({ type: "done", finishReason: "length" });
  });

  it("maps a tool-calls stopReason to the tool-calls finish", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/done", { stopReason: "tool-calls" })
    );
    expect(event).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("maps an error notification to an error event", () => {
    const event = normalizeAcpNotification(
      providerId,
      notification("session/error", { message: "model overloaded" })
    );
    expect(event).toEqual({ type: "error", message: "model overloaded" });
  });

  it("returns null for an unknown notification method (forward-compatible)", () => {
    expect(normalizeAcpNotification(providerId, notification("future/method", {}))).toBeNull();
  });

  it("returns null for a malformed tool/call (missing callId)", () => {
    expect(
      normalizeAcpNotification(providerId, notification("tool/call", { tool: "read-file" }))
    ).toBeNull();
  });

  it("returns null for a session/message with no extractable text", () => {
    expect(normalizeAcpNotification(providerId, notification("session/message", {}))).toBeNull();
    expect(
      normalizeAcpNotification(providerId, notification("session/message", { parts: [] }))
    ).toBeNull();
  });
});

/** Helper to keep the discriminated union narrowed for type-only checks. */
export type { BackendAgentEvent };
