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
import {
  ACP_PERMISSION_TOOL,
  type ApprovalGate,
  type ToolExecutor
} from "@fable/connectors";
import {
  commitRuntimeCapabilityGrant,
  executeRuntimeToolCall,
  prepareRuntimeCapabilityGrant,
  type RuntimeCapabilityGrantProposal
} from "../runtime";

export interface DesktopToolExecutorOptions {
  workspaceId?: string;
  projectId?: string;
  queueApproval?: (
    approval: ApprovalRequest,
    tool: string,
    argumentsJson: string
  ) => void;
}

/**
 * Build the desktop ToolExecutor from a shared approval gate. The executor
 * awaits the gate (blocking until the shell grants/denies), then runs the
 * granted tool through the Rust boundary — which re-validates the approval and
 * performs the side effect. Returns the agent-loop ToolExecutor contract.
 */
export function createDesktopToolExecutor(
  gate: ApprovalGate,
  options: DesktopToolExecutorOptions = {}
): ToolExecutor {
  return async (approval, args) => {
    const toolName = approval.action.split(/\s+/)[0];
    const parsed = safeParseArgs(args);
    if (toolName === "connection-read") {
      await ensureCapabilityGrant(gate, options, parsed);
    }
    const decision = await gate.waitForDecision(approval);
    if (decision !== "granted") {
      throw new Error(`Tool call denied: ${approval.action}.`);
    }
    // ACP agents execute their own tools. This reserved approval-only action
    // must never cross into Rust's Fable-owned tool dispatcher (which would
    // duplicate the side effect). Resolving here tells the ACP session that the
    // existing gate granted one permission; it then selects only `allow_once`.
    if (approval.action.split(/\s+/)[0] === ACP_PERMISSION_TOOL) {
      return "ACP permission granted once.";
    }
    return runOnDesktop(approval, parsed, options);
  };
}

async function ensureCapabilityGrant(
  gate: ApprovalGate,
  options: DesktopToolExecutorOptions,
  parsed: Record<string, unknown>
): Promise<void> {
  const workspaceId = options.workspaceId;
  const capabilityId = typeof parsed.capability === "string" ? parsed.capability.trim() : "";
  if (!workspaceId || !capabilityId) {
    throw new Error("Connected-source search requires an active workspace and semantic capability.");
  }
  const proposal: RuntimeCapabilityGrantProposal = {
    workspaceId,
    projectId: options.projectId,
    capabilityId
  };
  const prepared = await prepareRuntimeCapabilityGrant(proposal);
  if (prepared === null) {
    throw new Error("Capability grants require the desktop runtime.");
  }
  if (prepared.status === "granted") return;
  options.queueApproval?.(
    prepared.approval,
    "capability-grant",
    JSON.stringify(proposal)
  );
  const decision = await gate.waitForDecision(prepared.approval);
  if (decision !== "granted") {
    throw new Error(`Capability grant denied: ${capabilityId}.`);
  }
  const resolution: ApprovalResolutionRequest = {
    request: prepared.approval,
    decision: "once",
    decidedAt: new Date().toISOString(),
    // The UI already validated this phrase before persisting the one-time
    // execution permit. Replaying the exact expected value lets Rust validate
    // the same immutable request while the persisted permit remains authority.
    confirmationText: prepared.approval.confirmationPhrase
  };
  const committed = await commitRuntimeCapabilityGrant(proposal, resolution);
  if (committed === null) {
    throw new Error("Capability grants require the desktop runtime.");
  }
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
async function runOnDesktop(
  approval: ApprovalRequest,
  parsed: Record<string, unknown>,
  options: DesktopToolExecutorOptions
): Promise<string> {
  const toolName = approval.action.split(/\s+/)[0];
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
    approval: resolution,
    workspaceId: options.workspaceId,
    projectId: options.projectId
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
