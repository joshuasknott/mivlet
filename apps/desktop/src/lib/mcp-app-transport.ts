import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

const MAX_SEEN_REQUEST_IDS = 1_024;

/** Source-bound SDK transport without payload logging. The SDK's convenience
 * PostMessageTransport logs raw messages, which is unsuitable for workspace data. */
export class McpAppTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  #started = false;
  #seenRequestIds = new Set<string>();
  #guest: Window;
  #host: Window;
  #receive = (event: MessageEvent) => {
    // The frame is deliberately sandboxed without allow-same-origin, so its
    // protocol origin is opaque (`null`). Source identity alone is insufficient
    // after a guest navigation because WindowProxy can survive navigation.
    if (event.source !== this.#guest || event.origin !== "null" || !boundedMessage(event.data)) return;
    const result = JSONRPCMessageSchema.safeParse(event.data);
    if (result.success) {
      const message = result.data;
      if (isRequestWithId(message)) {
        const id = requestIdKey(message.id);
        if (this.#seenRequestIds.has(id)) {
          this.#fail(new Error("The MCP App reused a JSON-RPC request ID."));
          return;
        }
        if (this.#seenRequestIds.size >= MAX_SEEN_REQUEST_IDS) {
          this.#fail(new Error("The MCP App exceeded the live request limit; reopen the result."));
          return;
        }
        this.#seenRequestIds.add(id);
      }
      this.onmessage?.(message);
    }
    else
      this.onerror?.(
        new Error("The MCP App sent an invalid protocol message."),
      );
  };
  constructor(
    guest: Window,
    host: Window = window,
  ) {
    this.#guest = guest;
    this.#host = host;
  }
  async start() {
    if (!this.#started) {
      this.#seenRequestIds.clear();
      this.#started = true;
      this.#host.addEventListener("message", this.#receive);
    }
  }
  async send(message: JSONRPCMessage) {
    if (!this.#started) throw new Error("The MCP App channel is closed.");
    if (!boundedMessage(message))
      throw new Error("The MCP App message exceeds the supported limit.");
    this.#guest.postMessage(message, "*");
  }
  async close() {
    if (!this.#started) return;
    this.#started = false;
    this.#host.removeEventListener("message", this.#receive);
    this.onclose?.();
  }

  #fail(error: Error) {
    if (!this.#started) return;
    this.#started = false;
    this.#host.removeEventListener("message", this.#receive);
    this.onerror?.(error);
    this.onclose?.();
  }
}

function isRequestWithId(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { method: string; id: string | number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "method" in message &&
    typeof message.method === "string" &&
    "id" in message &&
    (typeof message.id === "string" || typeof message.id === "number")
  );
}

function requestIdKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}

function boundedMessage(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let budget = 256 * 1024;
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8192 || item.depth > 32) return false;
    if (typeof item.value === "string") budget -= item.value.length;
    else if (item.value && typeof item.value === "object") {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      const entries = Object.entries(item.value);
      if (entries.length > 8192) return false;
      for (const [key, child] of entries) {
        budget -= key.length;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else if (
      typeof item.value === "function" ||
      typeof item.value === "bigint"
    )
      return false;
    budget -= 8;
    if (budget < 0) return false;
  }
  return true;
}
