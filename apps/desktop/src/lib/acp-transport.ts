/**
 * Desktop transport factory for the ACP (Cursor/Grok) `AgentBackend`.
 *
 * This is the production `createAcpTransport` implementation: it spawns the
 * provider's CLI child process through the Rust boundary (`spawn_acp_process`),
 * listens for its stdout frames on `arden://acp/<sessionId>`, parses each with
 * the generic `parseAcpLine`, correlates JSON-RPC request/response by id, and
 * writes frames back via `write_acp_frame`. Real cancellation kills the child
 * through `close_acp_process`.
 *
 * It mirrors `createDesktopTransport` (the native-API factory): returns null
 * outside the desktop runtime so the adapter reports no-transport and stays
 * fixture-testable.
 *
 * SECRET INVARIANT: this module handles NO secret. Auth is CLI-owned — the CLI
 * holds its own subscription login and Fable never collects, stores, or passes a
 * token. The Rust side spawns the process; JS only writes/reads JSON-RPC frames.
 */

import {
  parseAcpLine,
  isAcpResponse,
  isAcpNotification,
  type AcpFrame,
  type AcpNotification,
  type AcpReply,
  type AcpRequest,
  type AcpTransport,
  type AcpTransportFactory,
  type AcpTransportProvider
} from "@fable/connectors";
import {
  closeRuntimeAcpProcess,
  listenRuntimeAcpFrames,
  spawnRuntimeAcpProcess,
  writeRuntimeAcpFrame
} from "../runtime";

/** True when the desktop (Tauri) runtime is present. */
function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}

/** A pending JSON-RPC request awaiting its correlated response. */
interface PendingRequest {
  resolve: (reply: AcpReply) => void;
}

/**
 * A live ACP transport bound to a spawned CLI child process. Frames emitted on
 * the session channel are parsed: responses are correlated to pending requests
 * by id, notifications are queued for `frames()`.
 */
class DesktopAcpTransport implements AcpTransport {
  private readonly sessionId: string;
  private readonly unlisten: (() => void) | null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly notificationQueue: AcpNotification[] = [];
  private readonly waiters: Array<(frame: AcpNotification | undefined) => void> = [];
  private closed = false;

  constructor(sessionId: string, unlisten: (() => void) | null) {
    this.sessionId = sessionId;
    this.unlisten = unlisten;
  }

  /** Handle one raw line emitted on the session channel. */
  handleLine(line: string): void {
    // Control markers from the Rust reader.
    if (line === "[ACP-CLOSED]") {
      this.closed = true;
      this.flushWaiters(undefined);
      return;
    }
    // Stderr is surfaced as a control object; ignore it for frame parsing (the
    // CLI's protocol lives on stdout). A future enhancement could surface it.
    if (line.startsWith('{"__fableAcpStderr"')) {
      return;
    }

    const frame = parseAcpLine(line);
    if (!frame) return;

    if (isAcpResponse(frame)) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        if (frame.error) {
          pending.resolve({ ok: false, error: frame.error });
        } else {
          pending.resolve({ ok: true, result: frame.result });
        }
      }
      return;
    }

    if (isAcpNotification(frame)) {
      if (this.waiters.length > 0) {
        this.waiters.shift()?.(frame);
      } else {
        this.notificationQueue.push(frame);
      }
    }
  }

  /** Resolve the next waiter with undefined (end of stream). */
  private flushWaiters(value: AcpNotification | undefined): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(value);
    }
  }

  async send(frame: AcpFrame): Promise<void> {
    await writeRuntimeAcpFrame(this.sessionId, JSON.stringify(frame));
  }

  async request(req: AcpRequest): Promise<AcpReply> {
    return new Promise<AcpReply>((resolve) => {
      this.pending.set(req.id, { resolve });
      // Fire the frame; ignore write errors — the response will simply never
      // arrive and the caller treats that as a transport failure.
      void this.send(req).catch(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          resolve({
            ok: false,
            error: { code: -32000, message: "ACP frame could not be written." }
          });
        }
      });
    });
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

  private takeNext(): Promise<AcpNotification | undefined> {
    if (this.notificationQueue.length > 0) {
      return Promise.resolve(this.notificationQueue.shift());
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<AcpNotification | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.flushWaiters(undefined);
    this.unlisten?.();
    await closeRuntimeAcpProcess(this.sessionId).catch(() => {
      /* best-effort: the child may already have exited */
    });
  }
}

/**
 * The production `createAcpTransport` for the desktop shell. Spawns the
 * provider's CLI, wires its stdout frames into an `AcpTransport`, and returns
 * it. Returns null outside the desktop runtime (browser preview) so the adapter
 * reports no-transport and stays fixture-testable.
 *
 * The spawn happens eagerly: if the CLI is not installed, the factory rejects
 * and the adapter surfaces the failure rather than starting a run.
 */
export const createDesktopAcpTransport: AcpTransportFactory = (
  provider: AcpTransportProvider
): AcpTransport | null => {
  if (!hasDesktopRuntime()) {
    return null;
  }
  // A lazy transport that spawns on first use. The factory itself must be
  // synchronous (the contract returns AcpTransport | null, not a promise), so
  // the spawn is deferred until the adapter calls request()/send(). This keeps
  // the contract shape and lets the adapter fail fast on a missing CLI.
  return new LazyDesktopAcpTransport(provider.id);
};

/**
 * A transport that spawns the CLI on first frame interaction. Until then it
 * holds only the provider id (no process). On first send/request it spawns the
 * process, attaches the listener, and delegates to the real transport.
 */
class LazyDesktopAcpTransport implements AcpTransport {
  private readonly providerId: string;
  private inner: DesktopAcpTransport | null = null;
  private spawnError: Error | null = null;
  private spawning: Promise<DesktopAcpTransport> | null = null;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  /** Ensure the CLI is spawned; returns the real transport or throws. */
  private async ensure(): Promise<DesktopAcpTransport> {
    if (this.inner) return this.inner;
    if (this.spawnError) throw this.spawnError;
    if (!this.spawning) {
      this.spawning = this.spawn();
    }
    this.inner = await this.spawning;
    return this.inner;
  }

  private async spawn(): Promise<DesktopAcpTransport> {
    try {
      const spawned = await spawnRuntimeAcpProcess({
        providerId: this.providerId,
        extraArgs: []
      });
      if (!spawned) {
        this.spawnError = new Error("ACP transport requires the desktop runtime.");
        throw this.spawnError;
      }
      const sessionId = spawned.sessionId;
      let transport: DesktopAcpTransport | null = null;
      const unlisten = await listenRuntimeAcpFrames(sessionId, (line) => {
        transport?.handleLine(line);
      });
      transport = new DesktopAcpTransport(sessionId, unlisten);
      this.inner = transport;
      return transport;
    } catch (error) {
      this.spawnError =
        error instanceof Error ? error : new Error("Fable could not start the ACP CLI.");
      throw this.spawnError;
    }
  }

  async send(frame: AcpFrame): Promise<void> {
    const transport = await this.ensure();
    await transport.send(frame);
  }

  async request(req: AcpRequest): Promise<AcpReply> {
    const transport = await this.ensure();
    return transport.request(req);
  }

  frames(): AsyncIterable<AcpNotification> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AcpNotification>> {
            const transport = await self.ensure();
            const iterator = transport.frames()[Symbol.asyncIterator]();
            return iterator.next();
          }
        };
      }
    };
  }

  async close(): Promise<void> {
    if (this.inner) {
      await this.inner.close();
    }
    this.inner = null;
  }
}
