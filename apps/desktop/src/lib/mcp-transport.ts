/** Desktop adapter for the native owner-bound local STDIO MCP process. */

import {
  parseMcpLine,
  type McpFrame,
  type McpNotification,
  type McpRequest,
  type McpTransport
} from "@fable/connectors";
import {
  closeRuntimeMcpProcess,
  listenRuntimeMcpFrames,
  recordRuntimeMcpDiscovery,
  spawnRuntimeMcpProcess,
  writeRuntimeMcpFrame
} from "../runtime";
import type { RuntimeMcpConnectionDetails } from "../runtime";

export interface DesktopMcpTransportHandle extends McpTransport {
  recordDiscovery(tools: string[], resources: string[]): Promise<RuntimeMcpConnectionDetails>;
}

function hasDesktopRuntime(): boolean {
  return typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

class DesktopMcpTransport implements DesktopMcpTransportHandle {
  private readonly frameHandlers = new Set<(frame: McpFrame) => void>();
  private readonly closeHandlers = new Set<() => void>();
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
