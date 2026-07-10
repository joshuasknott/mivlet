import { describe, expect, it } from "vitest";
import { notification } from "./protocol-fakes";
import {
  ACP_PERMISSION_TOOL,
  buildAcpPermissionToolCall,
  finishReasonForAcpStopReason,
  normalizeAcpNotification
} from "./events";

const update = (value: Record<string, unknown>) =>
  notification("session/update", { sessionId: "s-1", update: value });

describe("ACP v1 session/update normalization", () => {
  it("maps an agent message chunk to a text delta", () => {
    expect(
      normalizeAcpNotification(
        "cursor",
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" }
        })
      )
    ).toEqual({ type: "text-delta", text: "hello" });
  });

  it("maps completed and failed tool-call updates to results", () => {
    expect(
      normalizeAcpNotification(
        "cursor",
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          rawOutput: { changed: true }
        })
      )
    ).toEqual({
      type: "tool-result",
      callId: "call-1",
      ok: true,
      output: JSON.stringify({ changed: true })
    });
    expect(
      normalizeAcpNotification(
        "cursor",
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-2",
          status: "failed",
          rawOutput: "boom"
        })
      )
    ).toMatchObject({ type: "tool-result", callId: "call-2", ok: false });
  });

  it("maps ACP usage updates without inventing subscription cost", () => {
    expect(
      normalizeAcpNotification(
        "grok",
        update({ sessionUpdate: "usage_update", used: 42, size: 128 })
      )
    ).toEqual({
      type: "usage",
      inputTokens: 42,
      outputTokens: 0,
      costUsd: 0,
      costEstimated: true,
      costUnknown: true
    });
  });

  it("ignores unknown and malformed update variants", () => {
    expect(
      normalizeAcpNotification("cursor", update({ sessionUpdate: "plan" }))
    ).toBeNull();
    expect(
      normalizeAcpNotification("cursor", notification("legacy/message", {}))
    ).toBeNull();
  });
});

describe("ACP permission approvals", () => {
  it("builds an approval-only Fable request for a provider tool", () => {
    const result = buildAcpPermissionToolCall("copilot", "session-1", 9, {
      toolCallId: "tool-1",
      title: "Edit src/app.ts",
      kind: "edit",
      rawInput: { path: "src/app.ts" }
    });
    expect(result).not.toBeNull();
    expect(result?.approval.action.startsWith(ACP_PERMISSION_TOOL)).toBe(true);
    expect(result?.approval.mode).toBe("full-access");
    expect(result?.approval.riskLevel).toBe("high");
    expect(result?.approval.decisions).toEqual(["once", "modify", "deny"]);
    expect(result?.approval.consequence).toContain("Fable only returns the permission decision");
  });

  it("treats unknown tool kinds as critical full-access and rejects malformed ids", () => {
    const unknown = buildAcpPermissionToolCall("opencode", "s", "r", {
      toolCallId: "tool-2",
      title: "Mystery action",
      kind: "future_kind"
    });
    expect(unknown?.approval.riskLevel).toBe("critical");
    expect(unknown?.approval.mode).toBe("full-access");
    expect(
      buildAcpPermissionToolCall("opencode", "s", "r", {
        toolCallId: "bad\ncall",
        title: "bad"
      })
    ).toBeNull();
  });
});

describe("ACP prompt completion", () => {
  it("maps end_turn and max_tokens stop reasons", () => {
    expect(finishReasonForAcpStopReason("end_turn")).toBe("stop");
    expect(finishReasonForAcpStopReason("max_tokens")).toBe("length");
  });
});
