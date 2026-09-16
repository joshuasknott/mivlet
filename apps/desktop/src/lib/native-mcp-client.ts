import type { McpTransport } from "@mivlet/connectors/mcp/client";
import { isMcpNotification, isMcpRequest, type McpFrame, type McpInitializeResult, type McpResource, type McpTool } from "@mivlet/connectors/mcp/protocol";
import { startRuntimeEmbeddedMcp, sendRuntimeEmbeddedMcp, closeRuntimeEmbeddedMcp, listenRuntimeEmbeddedMcp } from "../runtime/domains/embedded-agent";

type HostEvent = { type: "closed" } | { type: "send"; id: number; frame: McpFrame }
  | { type: "result"; id: number; ok: boolean; value?: unknown; message?: string };
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** The SDK validates/correlates discovery inside the native host. This proxy
 * only bridges the existing owner-bound transport; it cannot execute tools.
 */
export class McpClient {
  private readonly id = `mcp-sdk-${crypto.randomUUID()}`;
  private next = 0;
  private closed = false;
  private starting?: Promise<void>;
  private unlisten?: () => void;
  private unsubscribe?: () => void;
  private unsubscribeClose?: () => void;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly transport: McpTransport) {}

  initialize() { return this.request<McpInitializeResult>("initialize"); }
  listTools() { return this.request<readonly McpTool[]>("listTools"); }
  listResources() { return this.request<readonly McpResource[]>("listResources"); }

  private ensureStarted() {
    return this.starting ??= (async () => {
      const unlisten = await listenRuntimeEmbeddedMcp(this.id, frame => { void this.receive(frame as HostEvent).catch(() => this.close()); });
      if (!unlisten) throw new Error("MCP discovery requires the native protocol host.");
      if (this.closed) { unlisten(); throw new Error("MCP transport is closed."); }
      this.unlisten = unlisten;
      this.unsubscribe = this.transport.subscribe(frame => {
        void this.starting?.then(async () => {
          if (!this.closed) await sendRuntimeEmbeddedMcp(this.id, { type: "frame", frame });
        }).catch(() => { void this.close(); });
      });
      this.unsubscribeClose = this.transport.subscribeClose(() => { void this.close(); });
      await startRuntimeEmbeddedMcp(this.id);
      if (this.closed) { await closeRuntimeEmbeddedMcp(this.id); throw new Error("MCP transport is closed."); }
    })();
  }

  private async request<T>(method: "initialize" | "listTools" | "listResources"): Promise<T> {
    if (this.closed) throw new Error("MCP transport is closed.");
    try { await this.ensureStarted(); }
    catch (error) { await this.close(); throw error; }
    if (this.closed) throw new Error("MCP transport is closed.");
    const id = ++this.next;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, 35_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    void result.catch(() => undefined);
    try { await sendRuntimeEmbeddedMcp(this.id, { type: "request", id, method }); }
    catch { void this.close(); }
    return await result as T;
  }

  private async receive(event: HostEvent) {
    if (this.closed) return;
    if (event.type === "closed") { await this.close(); return; }
    if (event.type === "result") {
      const pending = this.pending.get(event.id);
      if (!pending) { await this.close(); return; }
      this.pending.delete(event.id); clearTimeout(pending.timer);
      if (event.ok) pending.resolve(event.value);
      else pending.reject(new Error(event.message ?? "MCP discovery failed."));
      return;
    }
    if (event.type !== "send" || (!isMcpRequest(event.frame) && !isMcpNotification(event.frame))
      || !["initialize", "tools/list", "resources/list", "notifications/initialized", "notifications/cancelled"].includes(event.frame.method)) {
      await this.close(); return;
    }
    try {
      await this.transport.send(event.frame);
      if (!this.closed) await sendRuntimeEmbeddedMcp(this.id, { type: "sent", id: event.id, ok: true });
    } catch {
      if (!this.closed) await sendRuntimeEmbeddedMcp(this.id, { type: "sent", id: event.id, ok: false }).catch(() => undefined);
      await this.close();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.unlisten?.(); this.unsubscribe?.(); this.unsubscribeClose?.();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP transport is closed.")); }
    this.pending.clear();
    await Promise.allSettled([closeRuntimeEmbeddedMcp(this.id), this.transport.close()]);
  }
}
