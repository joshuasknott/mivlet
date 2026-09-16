import { invokeNative } from "../bridge";

import type { ApprovalResolutionRequest } from "@mivlet/protocol";

// Rust revalidates the exact approval and native scope before executing a tool.
// This renderer module never grants host-shell access or performs file writes.

export interface RuntimeToolRequest {
  /** The registered tool name, including bounded file and Office operations. */
  tool: string;
  /** The tool-call arguments as a parsed JSON value. */
  arguments: unknown;
  /** The approval resolution request the shell used to grant the call. Rust
   *  re-validates it before running the tool (defense in depth). */
  approval: ApprovalResolutionRequest;
  /** Authenticated scope assertion; Rust re-resolves it from active account state. */
  workspaceId?: string;
  /** Active teammate scope used by native code to resolve isolated local files. */
  agentId?: string;
  /** Native-owned live MCP session selected from an explicit semantic binding. */
  mcpSessionId?: string;
  /** Computer authority captured before approval; never refreshed to replay a stale action. */
  computerGeneration?: number;
  /** Test-only compatibility field. Production Rust ignores caller-supplied roots. */
  workspaceRoot?: string;
}

export interface RuntimeToolResult {
  ok: boolean;
  output: string;
}

/** Execute an approved tool call through the Rust boundary. Null outside Tauri. */
export async function executeRuntimeToolCall(request: RuntimeToolRequest) {
  return invokeNative<RuntimeToolResult>("execute_tool_call", { request });
}
