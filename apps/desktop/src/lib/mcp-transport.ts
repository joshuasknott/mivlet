/** Desktop adapter for the native owner-bound local STDIO MCP process. */

import {
  parseMcpLine,
  isMcpResponse,
  type McpFrame,
  type McpNotification,
  type McpRequest,
  type McpTransport
} from "@fable/connectors";
import type { ApprovalResolutionRequest } from "@fable/protocol";
import {
  authorizeRuntimeMcpToolCall,
  closeRuntimeRemoteMcpSession,
  closeRuntimeMcpProcess,
  executeRuntimeApprovedMcpToolCall,
  listenRuntimeMcpFrames,
  openRuntimeRemoteMcpSession,
  pollRuntimeRemoteMcpMessages,
  recordRuntimeMcpDiscovery,
  prepareRuntimeMcpToolCall,
  spawnRuntimeMcpProcess,
  sendRuntimeRemoteMcpFrame,
  writeRuntimeMcpFrame
} from "../runtime";
import type {
  RuntimeAuthorizedMcpToolCall,
  RuntimeMcpConnectionDetails,
  RuntimeMcpToolProposal,
  RuntimePreparedMcpToolCall
} from "../runtime";

export interface DesktopMcpTransportHandle extends McpTransport {
  recordDiscovery(tools: string[], resources: string[]): Promise<RuntimeMcpConnectionDetails>;
  prepareToolCall(toolName: string, args: Record<string, unknown>): Promise<{
    proposal: RuntimeMcpToolProposal;
    prepared: RuntimePreparedMcpToolCall;
  }>;
  authorizeToolCall(
    proposal: RuntimeMcpToolProposal,
    resolution: ApprovalResolutionRequest
  ): Promise<RuntimeAuthorizedMcpToolCall>;
  executeAuthorizedToolCall(
    proposal: RuntimeMcpToolProposal,
    permitId: string
  ): Promise<unknown>;
}

export interface DesktopMcpDiscoveryTransport extends McpTransport {
  recordDiscovery(tools: string[], resources: string[]): Promise<RuntimeMcpConnectionDetails>;
}

interface PendingToolResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function hasDesktopRuntime(): boolean {
  return typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

class DesktopMcpTransport implements DesktopMcpTransportHandle {
  private readonly frameHandlers = new Set<(frame: McpFrame) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly pendingToolResponses = new Map<string, PendingToolResponse>();
  private nextToolRequest = 1;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly workspaceId: string,
    private readonly sessionId: string,
    private readonly unlisten: () => void
  ) {}

  handleLine(line: string): void {
    if (line === "[MCP-CLOSED]") {
      this.markClosed();
      void this.beginNativeClose();
      return;
    }
    if (this.closed) return;
    const frame = parseMcpLine(line);
    if (!frame) return;
    if (isMcpResponse(frame) && typeof frame.id === "string") {
      const pending = this.pendingToolResponses.get(frame.id);
      if (pending) {
        this.pendingToolResponses.delete(frame.id);
        clearTimeout(pending.timeout);
        if (frame.error) pending.reject(new Error(`MCP ${frame.error.code}: ${frame.error.message}`));
        else pending.resolve(frame.result);
      }
    }
    for (const handler of this.frameHandlers) handler(frame);
  }

  async send(frame: McpRequest | McpNotification): Promise<void> {
    if (this.closed) throw new Error("MCP transport is closed.");
    await writeRuntimeMcpFrame(this.workspaceId, this.sessionId, JSON.stringify(frame));
  }

  subscribe(handler: (frame: McpFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  subscribeClose(handler: () => void): () => void {
    if (this.closed) {
      queueMicrotask(handler);
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async recordDiscovery(
    tools: string[],
    resources: string[]
  ): Promise<RuntimeMcpConnectionDetails> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const recorded = await recordRuntimeMcpDiscovery(this.workspaceId, this.sessionId, tools, resources);
    if (!recorded) throw new Error("MCP discovery requires the desktop app.");
    return recorded;
  }

  async prepareToolCall(toolName: string, args: Record<string, unknown>) {
    if (this.closed) throw new Error("MCP transport is closed.");
    const proposal: RuntimeMcpToolProposal = {
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      toolName,
      arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown>
    };
    const prepared = await prepareRuntimeMcpToolCall(proposal);
    if (!prepared) throw new Error("MCP tool approval requires the desktop app.");
    return { proposal, prepared };
  }

  async authorizeToolCall(
    proposal: RuntimeMcpToolProposal,
    resolution: ApprovalResolutionRequest
  ): Promise<RuntimeAuthorizedMcpToolCall> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const authorized = await authorizeRuntimeMcpToolCall(proposal, resolution);
    if (!authorized) throw new Error("MCP tool approval requires the desktop app.");
    return authorized;
  }

  async executeAuthorizedToolCall(
    proposal: RuntimeMcpToolProposal,
    permitId: string
  ): Promise<unknown> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const requestId = `native-mcp-tool-${this.nextToolRequest++}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingToolResponses.delete(requestId);
        reject(new Error("The approved MCP tool call timed out."));
        void writeRuntimeMcpFrame(
          this.workspaceId,
          this.sessionId,
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId, reason: "Fable request timeout" }
          })
        ).catch(() => undefined);
      }, 30_000);
      this.pendingToolResponses.set(requestId, { resolve, reject, timeout });
    });
    try {
      await executeRuntimeApprovedMcpToolCall(proposal, permitId, requestId);
    } catch (error) {
      const pending = this.pendingToolResponses.get(requestId);
      if (pending) clearTimeout(pending.timeout);
      this.pendingToolResponses.delete(requestId);
      throw error;
    }
    return response;
  }

  close(): Promise<void> {
    this.markClosed();
    return this.beginNativeClose();
  }

  private beginNativeClose(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = closeRuntimeMcpProcess(this.workspaceId, this.sessionId)
        .catch(() => undefined)
        .then(() => undefined);
    }
    return this.closePromise;
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    for (const pending of this.pendingToolResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("MCP transport is closed."));
    }
    this.pendingToolResponses.clear();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
    this.frameHandlers.clear();
  }
}

export async function createDesktopMcpTransport(
  workspaceId: string,
  launchReference: string
): Promise<DesktopMcpTransportHandle | null> {
  if (!hasDesktopRuntime()) return null;
  const spawned = await spawnRuntimeMcpProcess(workspaceId, launchReference);
  if (!spawned) return null;
  let transport: DesktopMcpTransport | undefined;
  const buffered: string[] = [];
  const unlisten = await listenRuntimeMcpFrames(spawned.channel, (line) => {
    if (transport) transport.handleLine(line);
    else buffered.push(line);
  });
  if (!unlisten) {
    await closeRuntimeMcpProcess(workspaceId, spawned.sessionId).catch(() => undefined);
    throw new Error("Fable could not listen to the local MCP server.");
  }
  transport = new DesktopMcpTransport(workspaceId, spawned.sessionId, unlisten);
  for (const line of buffered) transport.handleLine(line);
  return transport;
}

class RemoteDesktopMcpTransport implements DesktopMcpDiscoveryTransport {
  private readonly frameHandlers = new Set<(frame: McpFrame) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;
  private closePromise?: Promise<void>;
  private polling = false;

  constructor(
    private readonly workspaceId: string,
    private readonly sessionId: string
  ) {}

  async send(frame: McpRequest | McpNotification): Promise<void> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const lines = await sendRuntimeRemoteMcpFrame(
      this.workspaceId,
      this.sessionId,
      JSON.stringify(frame)
    );
    if (!lines) throw new Error("Remote MCP requires the desktop app.");
    for (const line of lines) {
      const received = parseMcpLine(line);
      if (received) {
        for (const handler of this.frameHandlers) handler(received);
      }
    }
    if ("id" in frame && frame.method === "initialize") this.beginPolling();
  }

  subscribe(handler: (frame: McpFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  subscribeClose(handler: () => void): () => void {
    if (this.closed) {
      queueMicrotask(handler);
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async recordDiscovery(tools: string[], resources: string[]) {
    if (this.closed) throw new Error("MCP transport is closed.");
    const recorded = await recordRuntimeMcpDiscovery(
      this.workspaceId,
      this.sessionId,
      tools,
      resources
    );
    if (!recorded) throw new Error("MCP discovery requires the desktop app.");
    return recorded;
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const handler of this.closeHandlers) handler();
      this.closeHandlers.clear();
      this.frameHandlers.clear();
    }
    if (!this.closePromise) {
      this.closePromise = closeRuntimeRemoteMcpSession(this.workspaceId, this.sessionId)
        .catch(() => undefined)
        .then(() => undefined);
    }
    return this.closePromise;
  }

  private beginPolling(): void {
    if (this.polling || this.closed) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    try {
      while (!this.closed) {
        try {
          const result = await pollRuntimeRemoteMcpMessages(this.workspaceId, this.sessionId);
          if (!result || !result.supported || this.closed) break;
          for (const line of result.frames) {
            const received = parseMcpLine(line);
            if (received) for (const handler of this.frameHandlers) handler(received);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("session expired")) break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

export async function createDesktopRemoteMcpTransport(
  workspaceId: string,
  configurationReference: string
): Promise<DesktopMcpDiscoveryTransport | null> {
  if (!hasDesktopRuntime()) return null;
  const opened = await openRuntimeRemoteMcpSession(workspaceId, configurationReference);
  if (!opened) return null;
  return new RemoteDesktopMcpTransport(workspaceId, opened.sessionId);
}
