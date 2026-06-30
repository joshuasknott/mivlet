/**
 * HTTP server glue: routing, correlation ids, rate limiting, redacted logging,
 * CORS, and structured error responses. The broker logic lives in {@link FableBroker};
 * this module only maps HTTP <-> broker calls and enforces transport policy.
 *
 * Secrets never cross this layer into logs or responses. Provider tokens only
 * appear in the handoff-redeem response body (the one allowed crossing) and are
 * never logged. Every error response is a redacted {@link BrokerErrorResponse}.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  BrokerContractError,
  BROKER_CONTRACT_VERSION,
  type BrokerErrorResponse,
  type BrokerProviderId,
  isBrokerProvider
} from "@fable/connectors";

import { FableBroker } from "./broker.js";
import {
  createRateLimiter,
  newCorrelationId,
  rateLimitKey,
  redactForLog
} from "./rate-limiter.js";

export interface BrokerServerOptions {
  broker: FableBroker;
  /** Bind host. Defaults to 127.0.0.1 for local dev. */
  host?: string;
  port?: number;
  /** Requests per minute per route+peer. Default 60. */
  requestsPerMinute?: number;
  /** Allowed CORS origins. Default: loopback only. */
  allowedOrigins?: string[];
}

const CORRELATION_HEADER = "x-fable-request-id";

export type BrokerRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Build the in-memory request handler (routing, CORS, correlation ids, rate
 * limiting, structured redacted errors). Returned so tests can drive it without
 * binding a socket; {@link createBrokerServer} wraps it in a real `http.Server`.
 */
export function createBrokerHandler(options: BrokerServerOptions): BrokerRequestHandler {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const limiter = createRateLimiter({
    limit: options.requestsPerMinute ?? 60,
    windowMs: 60_000
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? loopbackOrigins(port));

  return async (req, res) => {
    const correlation = req.headers[CORRELATION_HEADER] ?? newCorrelationId();
    res.setHeader(CORRELATION_HEADER, Array.isArray(correlation) ? correlation[0] : correlation);
    res.setHeader("cache-control", "no-store");

    const origin = header(req, "origin");
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `content-type, ${CORRELATION_HEADER}`,
        "access-control-max-age": "600"
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    const segments = url.pathname.split("/").filter(Boolean);

    // Health is exempt from rate limiting so monitoring is always green.
    if (req.method === "GET" && segments[0] === "healthz") {
      const body = options.broker.health();
      writeJson(res, 200, body);
      return;
    }

    // Rate limit every OAuth route per route+peer.
    const limit = limiter.check(rateLimitKey(url.pathname, peer(req)));
    if (!limit.allowed) {
      log(req, "rate-limited", url.pathname, correlation);
      writeJson(res, 429, errorResponse(
        new BrokerContractError("rate-limited", "Too many broker requests.", true)
      ), { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });
      return;
    }

    try {
      await route(req, res, url, segments, options.broker);
    } catch (error) {
      const normalized = error instanceof BrokerContractError
        ? error
        : new BrokerContractError("provider-unavailable", "An unexpected broker error occurred.", true);
      const status = httpStatusFor(normalized);
      log(req, normalized.error, url.pathname, correlation);
      writeJson(res, status, errorResponse(normalized));
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

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
  broker: FableBroker
): Promise<void> {
  // /oauth/{provider}/authorize
  if (req.method === "GET" && segments[0] === "oauth" && segments[2] === "authorize") {
    const provider = parseProvider(segments[1]);
    const request = {
      contractVersion: BROKER_CONTRACT_VERSION,
      provider,
      redirectUri: requireQuery(url, "redirect_uri"),
      state: requireQuery(url, "state"),
      codeChallenge: requireQuery(url, "code_challenge"),
      codeChallengeMethod: "S256" as const
    };
    const { response } = await broker.authorize(request);
    res.writeHead(302, { location: response.authorizationUrl, "cache-control": "no-store" });
    res.end();
    return;
  }

  // /oauth/{provider}/callback (the provider's registered callback)
  if (req.method === "GET" && segments[0] === "oauth" && segments[2] === "callback") {
    const provider = parseProvider(segments[1]);
    const { redirect } = await broker.callback(provider, url.searchParams);
    res.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" });
    res.end();
    return;
  }

  // /oauth/{provider}/handoff
  if (req.method === "POST" && segments[0] === "oauth" && segments[2] === "handoff") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(req);
    const response = await broker.redeem({
      contractVersion: contractVersionOf(body),
      provider,
      handoff: stringRequired(body, "handoff"),
      state: stringRequired(body, "state")
    });
    writeJson(res, 200, response);
    return;
  }

  // /oauth/{provider}/refresh
  if (req.method === "POST" && segments[0] === "oauth" && segments[2] === "refresh") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(req);
    const response = await broker.refresh({
      contractVersion: contractVersionOf(body),
      provider,
      refreshToken: stringRequired(body, "refreshToken")
    });
    writeJson(res, 200, response);
    return;
  }

  // /oauth/{provider}/revoke
  if (req.method === "POST" && segments[0] === "oauth" && segments[2] === "revoke") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(req);
    const response = await broker.revoke({
      contractVersion: contractVersionOf(body),
      provider,
      token: stringRequired(body, "token"),
      tokenTypeHint: tokenTypeHint(body)
    });
    writeJson(res, 200, response);
    return;
  }

  throw new BrokerContractError("invalid-request", "Unknown broker route.", false);
}

function parseProvider(value: string | undefined): BrokerProviderId {
  if (!isBrokerProvider(value)) {
    throw new BrokerContractError("unknown-provider", "Unknown broker provider.", false);
  }
  return value;
}

function requireQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) {
    throw new BrokerContractError("invalid-request", `Missing required "${key}" parameter.`, false);
  }
  return value;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new BrokerContractError("invalid-request", "Request body was not valid JSON.", false);
  }
}

function stringRequired(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) {
    throw new BrokerContractError("invalid-request", `Missing required "${key}".`, false);
  }
  return value;
}

function stringOptional(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value ? value : undefined;
}

function tokenTypeHint(body: Record<string, unknown>): "access_token" | "refresh_token" | undefined {
  const value = body.tokenTypeHint;
  if (value === "access_token" || value === "refresh_token") return value;
  return undefined;
}

/** Parse + validate the contract version against the literal expected value. */
function contractVersionOf(body: Record<string, unknown>): typeof BROKER_CONTRACT_VERSION {
  const value = body.contractVersion;
  if (value !== BROKER_CONTRACT_VERSION) {
    throw new BrokerContractError("unsupported-version", "Unsupported broker contract version.", false);
  }
  return value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new BrokerContractError("invalid-request", "Request body too large.", false));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function errorResponse(error: BrokerContractError): BrokerErrorResponse {
  return error.toResponse();
}

function httpStatusFor(error: BrokerContractError): number {
  switch (error.error) {
    case "configuration-required":
      return 503;
    case "unknown-provider":
    case "unsupported-version":
    case "invalid-request":
    case "invalid-state":
    case "invalid-handoff":
    case "expired-handoff":
      return 400;
    case "needs-auth":
      return 401;
    case "rate-limited":
      return 429;
    case "provider-unavailable":
      return 502;
    default:
      return 500;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function peer(req: IncomingMessage): string | undefined {
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress;
}

function loopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1`,
    `http://localhost`
  ];
}

/** Redact-then-log a request line. Never logs bodies, tokens, or secrets. */
function log(req: IncomingMessage, event: string, path: string, correlation: string | string[]): void {
  const method = req.method ?? "?";
  const id = Array.isArray(correlation) ? correlation[0] : correlation;
  const safe = redactForLog(`${method} ${path}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", event, path: safe, correlationId: id }));
}
