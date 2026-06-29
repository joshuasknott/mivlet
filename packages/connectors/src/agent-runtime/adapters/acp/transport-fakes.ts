/**
 * Fake ACP transport + scripted responder for the ACP unit tests.
 *
 * Drives the session lifecycle over an in-memory queue — no process, no socket,
 * no live provider account. The responder lets each test script the JSON-RPC
 * responses to specific request methods, while queued notifications model the
 * CLI's streamed output. Test-only; never shipped to consumers.
 */

import type {
  AcpFrame,
  AcpNotification,
  AcpRequest
} from "./protocol";
import type { AcpReply, AcpTransport } from "./transport";

/** A scripted response to a request: return a result or an error. */
export type ScriptedResponder = (
  req: AcpRequest
) => { result?: unknown } | { error: { code: number; message: string } };

/** A queued streamed item: either a notification frame or an end-of-stream marker. */
type PendingItem =
  | { kind: "frame"; frame: AcpNotification }
  | { kind: "close" };

/**
 * An in-memory AcpTransport. Notifications are queued and drained by `frames()`;
 * requests are answered synchronously by the scripted responder.
 */
export class FakeAcpTransport implements AcpTransport {
  private readonly responder: ScriptedResponder;
  private readonly queued: PendingItem[] = [];
  private readonly sent: AcpFrame[] = [];
  private closed = false;
  /** Resolves the next waiter when a notification is queued or the stream ends. */
  private notifyWaiter: ((value: AcpNotification | undefined) => void) | null = null;

  constructor(responder: ScriptedResponder = () => ({ result: {} })) {
    this.responder = responder;
  }

  /** Frames sent to the CLI's stdin, in order (for test assertions). */
  get sentFrames(): readonly AcpFrame[] {
    return this.sent;
  }

  /** Queue a streamed notification for the next `frames()` consumer. */
  queueNotification(method: string, params: unknown): void {
    this.queued.push({ kind: "frame", frame: { jsonrpc: "2.0", method, params } });
    this.kickWaiter();
  }

  /** Convenience: queue a session/done notification. */
  queueDone(stopReason?: string): void {
    this.queueNotification("session/done", stopReason ? { stopReason } : {});
  }

  /** Convenience: queue a session/error notification. */
  queueError(message: string): void {
    this.queueNotification("session/error", { message });
  }

  /**
   * Queue an "end of stream" sentinel: after all queued notifications are
   * drained, `frames()` ends (as if the CLI process exited). Models a CLI that
   * emits its frames and then closes its stdout.
   */
  queueClose(): void {
    this.queued.push({ kind: "close" });
    this.kickWaiter();
  }

  async send(frame: AcpFrame): Promise<void> {
    this.sent.push(frame);
  }

  async request(req: AcpRequest): Promise<AcpReply> {
    this.sent.push(req);
    const outcome = this.responder(req);
    if ("error" in outcome) {
      return { ok: false, error: outcome.error };
    }
    return { ok: true, result: outcome.result };
  }

  frames(): AsyncIterable<AcpNotification> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AcpNotification>> {
            const value = await self.takeNext();
            if (value === undefined) return { done: true, value: undefined };
            return { done: false, value };
          }
        };
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.kickWaiter();
  }

  private takeNext(): Promise<AcpNotification | undefined> {
    const next = this.queued.shift();
    if (next) {
      return Promise.resolve(next.kind === "frame" ? next.frame : undefined);
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<AcpNotification | undefined>((resolve) => {
      this.notifyWaiter = resolve;
    });
  }

  private kickWaiter(): void {
    const waiter = this.notifyWaiter;
    this.notifyWaiter = null;
    if (!waiter) return;
    const next = this.queued.shift();
    if (next) {
      waiter(next.kind === "frame" ? next.frame : undefined);
    } else if (this.closed) {
      waiter(undefined);
    }
  }
}
