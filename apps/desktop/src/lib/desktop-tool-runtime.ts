/**
 * The desktop tool executor: wires the shared approval gate to the Rust tool
 * boundary so an approved tool call actually runs and its result returns to the
 * agent loop.
 *
 * Architecture:
 *   - The agent loop calls this executor once per tool-call event.
 *   - The executor first awaits the {@link ApprovalGate} — it blocks until the
 *     shell grants (once/session/rule) or denies the call, or auto-satisfies it
 *     from a standing session/rule grant. Nothing runs before a grant.
 *   - On a grant, the executor hands the call to Rust (`execute_tool_call`),
 *     which RE-VALIDATES the approval, confines file paths to the workspace, and
 *     performs the side effect. The shell never spawns or writes files from JS.
 *   - A deny rejects (the loop turns it into a tool-role error message and
 *     continues); a Rust error rejects too.
 *
 * The gate is shared with the shell (useShellRuntime) so the user's grant/deny
 * decision in the approval UI drives the executor the loop is awaiting. Outside
 * Tauri the Rust boundary returns null and the executor rejects (fail-closed) —
 * keeping the desktop testable without a live runtime.
 */

import type { ApprovalRequest, ApprovalResolutionRequest } from "@fable/protocol";
import type { ApprovalGate, ToolExecutor } from "@fable/connectors";
import { executeRuntimeToolCall, type RuntimeToolResult } from "../runtime";

/**
 * Build the desktop ToolExecutor from a shared approval gate. The executor
 * awaits the gate (blocking until the shell grants/denies), then runs the
 * granted tool through the Rust boundary — which re-validates the approval and
 * performs the side effect. Returns the agent-loop ToolExecutor contract.
 */
export function createDesktopToolExecutor(gate: ApprovalGate): ToolExecutor {
  return async (approval, args) => {
    const decision = await gate.waitForDecision(approval);
    if (decision !== "granted") {
      throw new Error(`Tool call denied: ${approval.action}.`);
    }
    return runOnDesktop(approval, args);
  };
}

/**
 * Run a granted tool on the desktop via the Rust boundary. The shell NEVER
 * spawns a shell or writes a file from JavaScript — `execute_tool_call` owns
 * every side effect after re-validating the approval (defense in depth).
 *
 * Outside Tauri the wrapper returns null and we reject (fail-closed) so the loop
 * records a tool-role error message and continues, rather than pretending a
 * side effect happened.
 */
async function runOnDesktop(approval: ApprovalRequest, args: string): Promise<string> {
  const toolName = approval.action.split(/\s+/)[0];
  const parsed = safeParseArgs(args);
  // The gate already guaranteed a grant; synthesize the resolution request Rust
  // re-validates (decision "once" — the standing session/rule grants are
  // tracked separately on the gate and auto-satisfied before this point).
  const resolution: ApprovalResolutionRequest = {
    request: approval,
    decision: "once",
    decidedAt: new Date().toISOString()
  };

  const result = await executeRuntimeToolCall({
    tool: toolName,
    arguments: parsed,
    approval: resolution
  });
  if (result === null) {
    // No Tauri runtime: nothing executed (preview/test path).
    throw new Error(
      `Tool ${toolName} requires the desktop runtime to execute (no side effect in preview).`
    );
  }
  if (!result.ok) {
    throw new Error(result.output);
  }
  return result.output;
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Re-export the types App.tsx needs to construct the shared gate + executor.
export type { ApprovalGate };
