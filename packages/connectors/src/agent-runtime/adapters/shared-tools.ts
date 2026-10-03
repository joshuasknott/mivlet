import type { AgentTurnOptions, AgentTurnRequest, BackendAgentEvent } from "@mivlet/protocol";
import { buildToolApproval } from "../../native-api/approvals";
import { lookupTool } from "../../native-api/tools";
import { effectForTool, evaluatePermissionPolicy } from "../../permission-policy";
import { redactSecretsFromString } from "../utils/redact";

export interface SharedToolCall {
  callId: string;
  approvalId: string;
  tool: string;
  arguments: string;
}

export interface SharedToolResult {
  callId: string;
  ok: boolean;
  output: string;
}

/** Protocol adapters supply a native call identity; Mivlet owns tools/effects. */
export async function* executeSharedToolCall(
  provider: string,
  call: SharedToolCall,
  advertisedTools: AgentTurnRequest["tools"],
  options: AgentTurnOptions,
): AsyncGenerator<BackendAgentEvent, SharedToolResult> {
  let result: SharedToolResult;
  try {
    if (options.shouldCancel?.()) throw new Error("This task was cancelled.");
    if (!call.approvalId || !lookupTool(call.tool) || !advertisedTools.some(tool => tool.name === call.tool)) {
      throw new Error("Use only the Mivlet tools supplied for this turn. Host commands, files, and inherited provider tools are unavailable.");
    }
    const approval = { ...buildToolApproval(provider, call.tool, call.arguments), id: call.approvalId };
    const effect = effectForTool(call.tool);
    if (!effect || !evaluatePermissionPolicy({
      mode: options.permissionMode ?? "read-only", effect, riskLevel: approval.riskLevel,
    }).allowed) throw new Error(`Blocked by Mivlet's ${options.permissionMode ?? "read-only"} permission mode.`);
    yield { type: "tool-call", callId: call.callId, tool: call.tool, arguments: call.arguments, approval };
    result = { callId: call.callId, ok: true, output: await options.execute(approval, call.arguments) };
  } catch (error) {
    result = { callId: call.callId, ok: false,
      output: error instanceof Error ? redactSecretsFromString(error.message) : "Mivlet tool execution failed." };
  }
  yield { type: "tool-result", ...result };
  return result;
}
