import {
  parseMcpLine,
  type McpFrame,
  type McpNotification,
  type McpRequest
} from "@fable/connectors/mcp/protocol";
import { McpClient } from "@fable/connectors/mcp/sdk-client";
import type { McpTransport } from "@fable/connectors/mcp/client";

const MAX_IPC_LINE_CHARACTERS = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type DiscoveryMethod = "initialize" | "listTools" | "listResources";

interface RequestInput {
  type: "request";
  id: number;
  method: DiscoveryMethod;
}

interface FrameInput {
  type: "frame";
  frame: McpFrame;
}

interface SentInput {
  type: "sent";
  id: number;
  ok: boolean;
}

type HostInput = RequestInput | FrameInput | SentInput | { type: "close" };

type HostOutput =
  | { type: "send"; id: number; frame: McpRequest | McpNotification }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; message: string }
  | { type: "closed" };

type OutputWriter = (event: HostOutput) => void;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseInput(line: string): HostInput {
  if (line.length > MAX_IPC_LINE_CHARACTERS) throw new Error("MCP host input exceeds the size limit.");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("MCP host input is invalid JSON.");
  }
  if (!isObject(value) || typeof value.type !== "string") {
    throw new Error("MCP host input is invalid.");
  }
  if (value.type === "request") {
    if (!isSafeInteger(value.id) || !["initialize", "listTools", "listResources"].includes(String(value.method))) {
      throw new Error("MCP host request is invalid.");
    }
    return { type: "request", id: value.id, method: value.method as DiscoveryMethod };
  }
  if (value.type === "frame") {
    if (!isObject(value.frame)) throw new Error("MCP host frame is invalid.");
    const encoded = JSON.stringify(value.frame);
    if (encoded === undefined) throw new Error("MCP host frame is invalid.");
    const frame = parseMcpLine(encoded);
    if (!frame) throw new Error("MCP host frame is invalid.");
    return { type: "frame", frame };
  }
  if (value.type === "sent") {
    if (!isSafeInteger(value.id) || typeof value.ok !== "boolean") {
      throw new Error("MCP host send acknowledgement is invalid.");
    }
    return { type: "sent", id: value.id, ok: value.ok };
  }
  if (value.type === "close") return { type: "close" };
  throw new Error("MCP host input type is unsupported.");
}

function writeEvent(event: HostOutput): void {
  const encoded = JSON.stringify(event);
  if (encoded === undefined || encoded.length > MAX_IPC_LINE_CHARACTERS || encoded.includes("\n")) {
    throw new Error("MCP host output exceeds the size limit.");
  }
  process.stdout.write(`${encoded}\n`);
}

interface PendingSend {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class IpcMcpTransport implements McpTransport {
  private readonly frameHandlers = new Set<(frame: McpFrame) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly pendingSends = new Map<number, PendingSend>();
  private nextSendId = 1;
  private closed = false;

  constructor(private readonly write: OutputWriter) {}

  async send(frame: McpRequest | McpNotification): Promise<void> {
    if (this.closed) throw new Error("MCP transport is closed.");
    const id = this.nextSendId++;
    this.write({ type: "send", id, frame });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(id);
        reject(new Error("MCP host send acknowledgement timed out."));
      }, REQUEST_TIMEOUT_MS);
      this.pendingSends.set(id, { resolve, reject, timeout });
    });
  }

  acknowledge(id: number, ok: boolean): void {
    const pending = this.pendingSends.get(id);
    if (!pending) throw new Error("MCP host send acknowledgement is unexpected.");
    this.pendingSends.delete(id);
    clearTimeout(pending.timeout);
    if (ok) pending.resolve();
    else pending.reject(new Error("MCP host transport rejected the outgoing frame."));
  }

  receive(frame: McpFrame): void {
    if (this.closed) return;
    for (const handler of this.frameHandlers) handler(frame);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingSends.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("MCP transport is closed."));
    }
    this.pendingSends.clear();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
    this.frameHandlers.clear();
  }
}

/** Run the host-only official MCP discovery bridge over newline-delimited JSON. */
export async function runMcpHost(): Promise<void> {
  let terminal = false;
  let closing: Promise<void> | undefined;
  const activeRequests = new Set<Promise<void>>();
  const transport = new IpcMcpTransport(writeEvent);
  const client = new McpClient(transport, {
    requestTimeoutMs: REQUEST_TIMEOUT_MS
  });

  const finish = async (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await client.close().catch(() => undefined);
      await Promise.allSettled([...activeRequests]);
      if (!terminal) {
        terminal = true;
        writeEvent({ type: "closed" });
      }
    })();
    return closing;
  };

  const runRequest = async (request: RequestInput): Promise<void> => {
    try {
      const value = request.method === "initialize"
        ? await client.initialize()
        : request.method === "listTools"
          ? await client.listTools()
          : await client.listResources();
      if (!terminal) writeEvent({ type: "result", id: request.id, ok: true, value });
    } catch (error) {
      if (!terminal) {
        writeEvent({
          type: "result",
          id: request.id,
          ok: false,
          message: error instanceof Error ? error.message : "MCP discovery failed."
        });
      }
    }
  };

  const seenRequestIds = new Set<number>();
  const handle = async (input: HostInput): Promise<void> => {
    if (terminal) return;
    if (input.type === "frame") {
      transport.receive(input.frame);
      return;
    }
    if (input.type === "sent") {
      transport.acknowledge(input.id, input.ok);
      return;
    }
    if (input.type === "close") {
      await finish();
      return;
    }
    if (seenRequestIds.has(input.id)) throw new Error("MCP host request id was reused.");
    seenRequestIds.add(input.id);
    const operation = runRequest(input);
    activeRequests.add(operation);
    void operation.finally(() => activeRequests.delete(operation));
  };

  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    readLoop: for await (const chunk of process.stdin) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_IPC_LINE_CHARACTERS) throw new Error("MCP host input exceeds the size limit.");
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        await handle(parseInput(line));
        if (terminal) break readLoop;
      }
    }
    if (buffer.trim().length > 0) await handle(parseInput(buffer));
  } finally {
    await finish();
  }
}
