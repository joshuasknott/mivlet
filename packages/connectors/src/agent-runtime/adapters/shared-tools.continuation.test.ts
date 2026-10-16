import { describe, expect, it, vi } from "vitest";
import type { AgentTurnOptions, BackendAgentEvent } from "@mivlet/protocol";
import { collaborationToolSpecs } from "../../native-api/collaboration-tools";
import { executeSharedToolCall } from "./shared-tools";

const call = { callId: "read-history", approvalId: "mivlet-shared-fixture",
  tool: "continuation-read", arguments: '{"sequence":1,"textOffset":0}' };
async function collect(stream: AsyncIterable<BackendAgentEvent>) {
  const events: BackendAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("shared continuation tool authority", () => {
  it("dispatches an advertised read through the existing scoped executor", async () => {
    const execute = vi.fn<AgentTurnOptions["execute"]>().mockResolvedValue("saved evidence");
    const events = await collect(executeSharedToolCall("fixture", call,
      collaborationToolSpecs(false, true), { execute, permissionMode: "read-only" }));
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: call.approvalId, riskLevel: "low", mode: "read-only",
    }), call.arguments);
    expect(events.at(-1)).toMatchObject({ type: "tool-result", ok: true, output: "saved evidence" });
  });

  it("refuses absent continuation capability, missing call authority and Stop before execution", async () => {
    const execute = vi.fn<AgentTurnOptions["execute"]>();
    for (const [tools, suppliedCall, cancelled] of [
      [collaborationToolSpecs(false), call, false],
      [collaborationToolSpecs(false, true), { ...call, approvalId: "" }, false],
      [collaborationToolSpecs(false, true), call, true],
    ] as const) {
      const events = await collect(executeSharedToolCall("fixture", suppliedCall, tools,
        { execute, permissionMode: "read-only", shouldCancel: () => cancelled }));
      expect(events.at(-1)).toMatchObject({ type: "tool-result", ok: false });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not turn continuation commands into model tools or mask native source denial", async () => {
    const execute = vi.fn<AgentTurnOptions["execute"]>().mockRejectedValue(new Error("Source history is no longer available."));
    for (const tool of ["start-provider-continuation", "continue-work", "provider_continuation_preview", "provider_continuation_read"]) {
      const events = await collect(executeSharedToolCall("fixture", { ...call, tool },
        [{ name: tool, description: "untrusted advertised command", parameters: "{}" }],
        { execute, permissionMode: "full-access" }));
      expect(events.at(-1)).toMatchObject({ type: "tool-result", ok: false });
    }
    expect(execute).not.toHaveBeenCalled();
    const events = await collect(executeSharedToolCall("fixture", call,
      collaborationToolSpecs(false, true), { execute, permissionMode: "read-only" }));
    expect(execute).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "tool-result", ok: false, output: "Source history is no longer available." });
  });
});
