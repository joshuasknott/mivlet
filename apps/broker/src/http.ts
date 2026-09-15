/**
 * Node.js HTTP transport for the auth broker.
 *
 * This module is now a thin adapter: it bridges Node's `http.IncomingMessage` /
 * `http.ServerResponse` to the runtime-neutral {@link createBrokerRouter},
 * which owns all routing, CORS, rate limiting, correlation ids, body parsing,
 * and structured redacted error handling. The same router backs the Cloudflare
 * Workers transport (`worker.ts`), so the two runtimes share one implementation.
 *
 * Secrets never cross this layer into logs or responses. Provider tokens only
 * appear in the handoff-redeem response body (the one allowed crossing) and are
 * never logged. Every error response is a redacted {@link BrokerErrorResponse}.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BrokerContractError } from "@fable/connectors";

import type { FableBroker } from "./broker.js";
import {
  createBrokerRouter,
  type BrokerRouterOptions,
  CORRELATION_HEADER,
  toBrokerErrorPayload
} from "./router.js";

/** Mirror of the router's body-size guard, enforced while reading the Node body. */
const MAX_BODY_BYTES = 64 * 1024;

export interface BrokerServerOptions extends BrokerRouterOptions {
  /** Bind host. Defaults to 127.0.0.1 for local dev. */
  host?: string;
  port?: number;
}

export type BrokerRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Build the in-memory request handler that adapts Node's streams to the shared
 * router. Returned so tests can drive it without binding a socket;
 * {@link createBrokerServer} wraps it in a real `http.Server`.
 */
export function createBrokerHandler(options: BrokerServerOptions): BrokerRequestHandler {
  const router = createBrokerRouter({
    broker: options.broker,
    requestsPerMinute: options.requestsPerMinute,
    allowedOrigins: options.allowedOrigins,
    trustProxy: options.trustProxy,
    rateLimiter: options.rateLimiter
  });
  const trustProxy = options.trustProxy ?? false;

  return async (req, res) => {
    try {
      const request = await nodeRequestToWeb(req);
      const response = await router.handle(request, peerOf(req, trustProxy));
      await writeWebResponse(res, response);
    } catch (error) {
      // The router never throws for normal handling (it returns error Responses),
      // but an error can surface here while reading the Node stream. A
      // BrokerContractError (e.g. an oversize body rejected by readNodeBody) must be
      // routed through the same redacted error shape the router emits — otherwise an
      // oversize body would collapse to a 500 provider-unavailable retryable, an
      // infinite-retry footgun. Only a genuinely unexpected stream error falls back
      // to the generic 500.
      const { status, response } = toBrokerErrorPayload(error);
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(response));
      }
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
  };
}

export function createBrokerServer(options: BrokerServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const server = createServer(createBrokerHandler({ ...options, host, port }));
  server.listen(port, host);
  return server;
}

/**
 * Build a standard Web `Request` from a Node `IncomingMessage`, reading the body
 * via the stream's event interface (which works for both real Node sockets and
 * the in-memory test doubles). The body is read here (not streamed lazily) so the
 * router's `request.text()` works uniformly across runtimes and the 64 KiB guard
 * can reject oversize bodies before they reach the broker. Node 18+ provides the
 * global `Request`; we only adapt the shape.
 */
async function nodeRequestToWeb(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: nodeHeadersToWeb(req.headers)
  };
  if (method !== "GET" && method !== "HEAD") {
    const body = await readNodeBody(req);
    if (body.length > 0) init.body = body;
  }
  return new Request(`http://${host}${url}`, init);
}

/**
 * Read a Node `IncomingMessage` body as a string with an oversize guard. Uses the
 * event interface so it works against the in-memory test doubles (which fire
 * `data`/`end` synchronously) as well as real socket streams.
 */
function readNodeBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new BrokerContractError("invalid-request", "Request body too large.", false));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function nodeHeadersToWeb(headers: IncomingMessage["headers"]): Headers {
  const web = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) web.append(key, v);
    } else {
      web.set(key, value);
    }
  }
  return web;
}

/** Stream a standard Web `Response` back onto a Node `ServerResponse`. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

/**
 * Resolve the rate-limit peer for a Node request. The socket address is the
 * default: it is not client-controllable, so rotating a header per request cannot
 * bypass the per-peer limit. `X-Forwarded-For` is honored ONLY when an explicit
 * `trustProxy` configuration is present (the broker runs behind a trusted proxy
 * that overwrites the header); otherwise the header is ignored, defeating the
 * classic header-rotation bypass. The peer is used solely as a rate-limit key and
 * is never logged.
 */
function peerOf(req: IncomingMessage, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return req.socket?.remoteAddress;
}
