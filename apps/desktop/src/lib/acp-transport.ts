/**
 * Desktop transport factory for catalog-declared ACP `AgentBackend`s.
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
  isAcpRequest,
  type AcpFrame,
  type AcpInboundFrame,
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
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Lifecycle requests should fail quickly when a CLI stops responding, while a
 * prompt turn needs enough time for a real coding task. Both limits stay
 * bounded and can be shortened by tests or a future runtime setting.
 */
export const DEFAULT_ACP_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_ACP_PROMPT_REQUEST_TIMEOUT_MS = 30 * 60_000;

export interface DesktopAcpTransportOptions {
  /** Timeout for initialize, authenticate, session/new, and other requests. */
  controlRequestTimeoutMs?: number;
  /** Timeout for the long-running session/prompt request. */
  promptRequestTimeoutMs?: number;
}

interface ResolvedDesktopAcpTransportOptions {
  controlRequestTimeoutMs: number;
  promptRequestTimeoutMs: number;
}

const ACP_TRANSPORT_CLOSED_ERROR = {
  code: -32001,
  message: "The ACP process closed before replying."
} as const;

function boundedTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function resolveOptions(
  options: DesktopAcpTransportOptions = {}
): ResolvedDesktopAcpTransportOptions {
  return {
    controlRequestTimeoutMs: boundedTimeout(
      options.controlRequestTimeoutMs,
      DEFAULT_ACP_CONTROL_REQUEST_TIMEOUT_MS
    ),
    promptRequestTimeoutMs: boundedTimeout(
      options.promptRequestTimeoutMs,
      DEFAULT_ACP_PROMPT_REQUEST_TIMEOUT_MS
    )
  };
}

/**
 * A live ACP transport bound to a spawned CLI child process. Frames emitted on
 * the session channel are parsed: responses are correlated to pending requests
 * by id, notifications are queued for `frames()`.
 */
class DesktopAcpTransport implements AcpTransport {
  readonly cwd: string;
  private readonly sessionId: string;
  private readonly unlisten: (() => void) | null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly inboundQueue: AcpInboundFrame[] = [];
  private readonly waiters: Array<(frame: AcpInboundFrame | undefined) => void> = [];
  private readonly options: ResolvedDesktopAcpTransportOptions;
  private closed = false;
  private didUnlisten = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    sessionId: string,
    cwd: string,
    unlisten: (() => void) | null,
    options: ResolvedDesktopAcpTransportOptions
  ) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.unlisten = unlisten;
    this.options = options;
  }

  /** Handle one raw line emitted on the session channel. */
  handleLine(line: string): void {
    // Control markers from the Rust reader.
    if (line === "[ACP-CLOSED]") {
      this.markClosed();
      this.detachListener();
      void this.beginProcessClose();
      return;
    }
    if (this.closed) return;
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
        clearTimeout(pending.timeout);
        if (frame.error) {
          pending.resolve({ ok: false, error: frame.error });
        } else {
          pending.resolve({ ok: true, result: frame.result });
        }
      }
      return;
    }

    if (isAcpNotification(frame) || isAcpRequest(frame)) {
      if (this.waiters.length > 0) {
        this.waiters.shift()?.(frame);
      } else {
        this.inboundQueue.push(frame);
      }
    }
  }

  /** Resolve the next waiter with undefined (end of stream). */
  private flushWaiters(value: AcpInboundFrame | undefined): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(value);
    }
  }

  /** Fail every outstanding request and end the inbound stream exactly once. */
  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ ok: false, error: ACP_TRANSPORT_CLOSED_ERROR });
    }
    this.pending.clear();
    this.flushWaiters(undefined);
  }

  private detachListener(): void {
    if (this.didUnlisten) return;
    this.didUnlisten = true;
    this.unlisten?.();
  }

  private beginProcessClose(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = closeRuntimeAcpProcess(this.sessionId)
        .catch(() => {
          /* best-effort: the child may already have exited */
        })
        .then(() => undefined);
    }
    return this.closePromise;
  }

  private requestTimeoutMs(req: AcpRequest): number {
    return req.method === "session/prompt"
      ? this.options.promptRequestTimeoutMs
      : this.options.controlRequestTimeoutMs;
  }

  async send(frame: AcpFrame): Promise<void> {
    if (this.closed) {
      throw new Error(ACP_TRANSPORT_CLOSED_ERROR.message);
    }
    await writeRuntimeAcpFrame(this.sessionId, JSON.stringify(frame));
  }

  async request(req: AcpRequest): Promise<AcpReply> {
    if (this.closed) {
      return { ok: false, error: ACP_TRANSPORT_CLOSED_ERROR };
    }
    if (this.pending.has(req.id)) {
      return {
        ok: false,
        error: {
          code: -32600,
          message: `An ACP request with id ${String(req.id)} is already pending.`
        }
      };
    }

    return new Promise<AcpReply>((resolve) => {
      const timeoutMs = this.requestTimeoutMs(req);
      const timeout = setTimeout(() => {
        if (!this.pending.delete(req.id)) return;
        resolve({
          ok: false,
          error: {
            code: -32002,
            message: `ACP ${req.method} timed out after ${timeoutMs} ms.`
          }
        });
      }, timeoutMs);
      this.pending.set(req.id, { resolve, timeout });
      // Write failure settles this request immediately; the timeout is the
      // fallback only when the process stays open but never replies.
      void this.send(req).catch(() => {
        const pending = this.pending.get(req.id);
        if (pending) {
          this.pending.delete(req.id);
          clearTimeout(pending.timeout);
          resolve({
            ok: false,
            error: { code: -32000, message: "ACP frame could not be written." }
          });
        }
      });
    });
  }

  frames(): AsyncIterable<AcpInboundFrame> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AcpInboundFrame>> {
            const value = await self.takeNext();
            if (value === undefined) return { done: true, value: undefined };
            return { done: false, value };
          }
        };
      }
    };
  }

  private takeNext(): Promise<AcpInboundFrame | undefined> {
    if (this.inboundQueue.length > 0) {
      return Promise.resolve(this.inboundQueue.shift());
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<AcpInboundFrame | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): Promise<void> {
    this.markClosed();
    this.detachListener();
    return this.beginProcessClose();
  }
}

/**
 * The production `createAcpTransport` for the desktop shell. Spawns the
 * provider's CLI, wires its stdout frames into an `AcpTransport`, and returns
 * it. Returns null outside the desktop runtime (browser preview) so the adapter
 * reports no-transport and stays fixture-testable.
 *
 * The spawn happens on first use: if the CLI is not installed, that operation
 * rejects and the adapter surfaces the failure rather than starting a run.
 */
export function createDesktopAcpTransportFactory(
  options: DesktopAcpTransportOptions = {}
): AcpTransportFactory {
  const resolvedOptions = resolveOptions(options);
  return (provider: AcpTransportProvider): AcpTransport | null => {
    if (!hasDesktopRuntime()) {
      return null;
    }
    // A lazy transport that spawns on first use. The factory itself must be
    // synchronous (the contract returns AcpTransport | null, not a promise), so
    // the spawn is deferred until the adapter calls request()/send(). This keeps
    // the contract shape and lets the adapter fail fast on a missing CLI.
    return new LazyDesktopAcpTransport(provider.id, resolvedOptions);
  };
}

export const createDesktopAcpTransport = createDesktopAcpTransportFactory();

/**
 * A transport that spawns the CLI on first frame interaction. Until then it
 * holds only the provider id (no process). On first send/request it spawns the
 * process, attaches the listener, and delegates to the real transport.
 */
class LazyDesktopAcpTransport implements AcpTransport {
  private readonly providerId: string;
  private readonly options: ResolvedDesktopAcpTransportOptions;
  private inner: DesktopAcpTransport | null = null;
  private spawnError: Error | null = null;
  private spawning: Promise<DesktopAcpTransport> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(providerId: string, options: ResolvedDesktopAcpTransportOptions) {
    this.providerId = providerId;
    this.options = options;
  }

  get cwd(): string {
    return this.inner?.cwd ?? "";
  }

  /** Ensure the CLI is spawned; returns the real transport or throws. */
  private async ensure(): Promise<DesktopAcpTransport> {
    if (this.closed) {
      throw new Error(ACP_TRANSPORT_CLOSED_ERROR.message);
    }
    if (this.inner) return this.inner;
    if (this.spawnError) throw this.spawnError;
    if (!this.spawning) {
      this.spawning = this.spawn();
    }
    this.inner = await this.spawning;
    return this.inner;
  }

  private async spawn(): Promise<DesktopAcpTransport> {
    let spawnedSessionId: string | null = null;
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
      spawnedSessionId = sessionId;
      let transport: DesktopAcpTransport | null = null;
      const bufferedLines: string[] = [];
      const unlisten = await listenRuntimeAcpFrames(sessionId, (line) => {
        if (transport) {
          transport.handleLine(line);
        } else {
          bufferedLines.push(line);
        }
      });
      if (!unlisten) {
        throw new Error("Fable could not listen to the ACP CLI.");
      }
      transport = new DesktopAcpTransport(sessionId, spawned.cwd, unlisten, this.options);
      for (const line of bufferedLines) {
        transport.handleLine(line);
      }
      if (this.closed) {
        await transport.close();
        spawnedSessionId = null;
        throw new Error(ACP_TRANSPORT_CLOSED_ERROR.message);
      }
      this.inner = transport;
      spawnedSessionId = null;
      return transport;
    } catch (error) {
      if (spawnedSessionId) {
        await closeRuntimeAcpProcess(spawnedSessionId).catch(() => undefined);
      }
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

  frames(): AsyncIterable<AcpInboundFrame> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AcpInboundFrame>> {
            const transport = await self.ensure();
            const iterator = transport.frames()[Symbol.asyncIterator]();
            return iterator.next();
          }
        };
      }
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const transport =
        this.inner ?? (this.spawning ? await this.spawning.catch(() => null) : null);
      if (transport) {
        await transport.close();
      }
      this.inner = null;
    })();
    return this.closePromise;
  }
}
