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

import type { ApprovalRequest, ApprovalResolutionRequest, MissionWorkerToolExecutionBinding } from "@fable/protocol";
import {
  ACP_PERMISSION_TOOL,
  McpClient,
  normalizeMcpConnectedSourceSearch,
  type ApprovalGate,
  type McpUntrustedToolResult,
  type ToolExecutor
} from "@fable/connectors";
import {
  attestRuntimeMissionMcpConnectedSearch,
  commitRuntimeCapabilityGrant,
  executeRuntimeToolCall,
  prepareRuntimeCapabilityGrant,
  resolveRuntimeMcpCapabilityRoute,
  type RuntimeCapabilityGrantProposal
} from "../runtime";
import type { RuntimeResolvedMcpCapabilityRoute, RuntimeMcpToolProposal } from "../runtime";
import {
  createDesktopMcpTransport,
  createDesktopRemoteMcpTransport,
  type DesktopMcpTransportHandle
} from "./mcp-transport";

export interface DesktopToolExecutorOptions {
  workspaceId?: string;
  projectId?: string;
  missionWorkerToolExecution?: MissionWorkerToolExecutionBinding;
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
    let mcpRoute: RuntimeResolvedMcpCapabilityRoute | null = null;
    if (toolName === "connection-read") {
      try {
        const workspaceId = options.workspaceId;
        const capabilityId = typeof parsed.capability === "string" ? parsed.capability.trim() : "";
        if (workspaceId && capabilityId) {
          mcpRoute = await resolveRuntimeMcpCapabilityRoute(workspaceId, capabilityId);
        }
        await ensureCapabilityGrant(gate, options, parsed, mcpRoute?.connectionId);
      } catch (error) {
        throw contextualConnectedSourceError(error);
      }
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
    if (mcpRoute) {
      return runMcpSemanticRead(approval, parsed, options, mcpRoute);
    }
    return runOnDesktop(approval, parsed, options);
  };
}

function contextualConnectedSourceError(error: unknown): Error {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "connected-source-unavailable";
  const detail = typeof candidate?.message === "string"
    ? candidate.message
    : "Connected-source search is unavailable.";
  const reconnectCodes = new Set([
    "connection-not-authorized",
    "credential-unavailable",
    "scope-denied"
  ]);
  const guidance = code === "no-eligible-connection"
    ? "No eligible Connection is set up for this search. Connect a supported work source or bind an MCP cited-search tool in Settings > Providers, then retry."
    : reconnectCodes.has(code)
      ? "The selected Connection needs attention. Reconnect it in Settings > Providers, confirm the requested read scope, then retry."
      : code === "connection-unhealthy" || candidate?.retryable === true
        ? "The selected Connection is temporarily unavailable. Retry later or choose another eligible Connection; Fable did not silently use a different source."
        : detail;
  return Object.assign(
    new Error(`[connected-source:${code}] ${guidance} No connected source was searched. (${detail})`),
    { code }
  );
}

async function ensureCapabilityGrant(
  gate: ApprovalGate,
  options: DesktopToolExecutorOptions,
  parsed: Record<string, unknown>,
  connectionId?: string
): Promise<void> {
  const workspaceId = options.workspaceId;
  const capabilityId = typeof parsed.capability === "string" ? parsed.capability.trim() : "";
  if (!workspaceId || !capabilityId) {
    throw new Error("Connected-source search requires an active workspace and semantic capability.");
  }
  const proposal: RuntimeCapabilityGrantProposal = {
    workspaceId,
    projectId: options.projectId,
    capabilityId,
    connectionId
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
  options: DesktopToolExecutorOptions,
  mcpSessionId?: string
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
    projectId: options.projectId,
    mcpSessionId,
    ...(options.missionWorkerToolExecution ? { missionWorkerToolExecution: options.missionWorkerToolExecution } : {})
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

interface McpSemanticContinuation {
  kind: "mcp-connected-source-search";
  proposal: RuntimeMcpToolProposal;
  permitId: string;
  workspaceId: string;
  projectId?: string;
  query: string;
  connectionId: string;
  matchedGrantIds: string[];
  degraded: boolean;
  degradationReasons: string[];
}

function parseMcpContinuation(value: string): McpSemanticContinuation {
  const parsed = JSON.parse(value) as Partial<McpSemanticContinuation>;
  if (
    parsed.kind !== "mcp-connected-source-search" ||
    !parsed.proposal ||
    typeof parsed.permitId !== "string" ||
    typeof parsed.workspaceId !== "string" ||
    typeof parsed.query !== "string" ||
    typeof parsed.connectionId !== "string" ||
    !Array.isArray(parsed.matchedGrantIds) ||
    typeof parsed.degraded !== "boolean" ||
    !Array.isArray(parsed.degradationReasons)
  ) {
    throw new Error("Fable returned an invalid MCP semantic continuation.");
  }
  return parsed as McpSemanticContinuation;
}

async function runMcpSemanticRead(
  approval: ApprovalRequest,
  parsed: Record<string, unknown>,
  options: DesktopToolExecutorOptions,
  route: RuntimeResolvedMcpCapabilityRoute
): Promise<string> {
  if (!options.workspaceId) throw new Error("MCP semantic search requires an active workspace.");
  let transport: DesktopMcpTransportHandle | null = null;
  try {
    transport = route.transport === "stdio"
      ? await createDesktopMcpTransport(options.workspaceId, route.configurationReference)
      : await createDesktopRemoteMcpTransport(options.workspaceId, route.configurationReference);
    if (!transport) throw new Error("MCP semantic search requires the desktop runtime.");
    const client = new McpClient(transport, { authorizeToolCall: async () => false });
    const initialized = await client.initialize();
    const tools = initialized.capabilities.tools ? await client.listTools() : [];
    const resources = initialized.capabilities.resources ? await client.listResources() : [];
    const discovery = await transport.recordDiscovery(
      tools.map((tool) => tool.name),
      resources.map((resource) => resource.uri)
    );
    const binding = discovery.capabilityBindings.find(
      (candidate) => candidate.capabilityId === "knowledge.content.search"
    );
    if (!binding || binding.toolName !== route.toolName) {
      throw new Error("The MCP connected-source binding changed during discovery.");
    }
    const prepared = await runOnDesktop(
      approval,
      parsed,
      options,
      transport.sessionId
    );
    const continuation = parseMcpContinuation(prepared);
    const untrusted = await transport.executeAuthorizedToolCall(
      continuation.proposal,
      continuation.permitId
    ) as McpUntrustedToolResult;
    if (options.missionWorkerToolExecution) {
      if (!untrusted.structuredJson || untrusted.structuredTruncated) {
        throw new Error("MCP mission evidence requires one complete structured cited-search result.");
      }
      const attested = await attestRuntimeMissionMcpConnectedSearch(continuation.permitId);
      if (!attested) throw new Error("Mission MCP evidence requires the desktop runtime.");
      return JSON.stringify(attested);
    }
    const result = normalizeMcpConnectedSourceSearch(untrusted, {
      workspaceId: continuation.workspaceId,
      projectId: continuation.projectId,
      query: continuation.query,
      connectionId: continuation.connectionId,
      matchedGrantIds: continuation.matchedGrantIds,
      degraded: continuation.degraded,
      degradationReasons: continuation.degradationReasons
    });
    return JSON.stringify({
      capabilityId: "knowledge.content.search",
      availability: continuation.degraded ? "degraded" : "available",
      connectionId: continuation.connectionId,
      connectorId: "mcp",
      implementationEvidence: "adapter-validated",
      matchedGrantIds: continuation.matchedGrantIds,
      result
    });
  } finally {
    await transport?.close().catch(() => undefined);
  }
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
