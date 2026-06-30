/**
 * Fetch transport for the auth broker. This is the Cloudflare Workers-native
 * path and is also useful for tests because it avoids Node's http server shape.
 */

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

export interface BrokerFetchHandlerOptions {
  broker: FableBroker;
  /** Requests per minute per route+peer. Default 60. */
  requestsPerMinute?: number;
  /** Allowed CORS origins. Default: loopback only. */
  allowedOrigins?: string[];
  /** Loopback port used only to build default CORS origins. */
  port?: number;
}

const CORRELATION_HEADER = "x-fable-request-id";
const MAX_JSON_BODY_BYTES = 64 * 1024;

export type BrokerFetchHandler = (request: Request) => Promise<Response>;

export function createBrokerFetchHandler(options: BrokerFetchHandlerOptions): BrokerFetchHandler {
  const port = options.port ?? 8788;
  const limiter = createRateLimiter({
    limit: options.requestsPerMinute ?? 60,
    windowMs: 60_000
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? loopbackOrigins(port));

  return async (request) => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const correlation = request.headers.get(CORRELATION_HEADER) ?? newCorrelationId();
    const baseHeaders = new Headers({
      [CORRELATION_HEADER]: correlation,
      "cache-control": "no-store"
    });

    const origin = request.headers.get("origin");
    if (origin && allowedOrigins.has(origin)) {
      baseHeaders.set("access-control-allow-origin", origin);
      baseHeaders.set("vary", "origin");
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: withHeaders(baseHeaders, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": `content-type, ${CORRELATION_HEADER}`,
          "access-control-max-age": "600"
        })
      });
    }

    if (request.method === "GET" && segments[0] === "healthz") {
      return jsonResponse(200, options.broker.health(), baseHeaders);
    }

    const limit = limiter.check(rateLimitKey(url.pathname, peer(request)));
    if (!limit.allowed) {
      log(request, "rate-limited", url.pathname, correlation);
      return jsonResponse(
        429,
        errorResponse(new BrokerContractError("rate-limited", "Too many broker requests.", true)),
        baseHeaders,
        { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) }
      );
    }

    try {
      return await route(request, url, segments, options.broker, baseHeaders);
    } catch (error) {
      const normalized = error instanceof BrokerContractError
        ? error
        : new BrokerContractError("provider-unavailable", "An unexpected broker error occurred.", true);
      log(request, normalized.error, url.pathname, correlation);
      return jsonResponse(httpStatusFor(normalized), errorResponse(normalized), baseHeaders);
    }
  };
}

async function route(
  request: Request,
  url: URL,
  segments: string[],
  broker: FableBroker,
  baseHeaders: Headers
): Promise<Response> {
  if (request.method === "GET" && segments[0] === "oauth" && segments[2] === "authorize") {
    const provider = parseProvider(segments[1]);
    const { response } = await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider,
      redirectUri: requireQuery(url, "redirect_uri"),
      state: requireQuery(url, "state"),
      codeChallenge: requireQuery(url, "code_challenge"),
      codeChallengeMethod: "S256"
    });
    return redirectResponse(response.authorizationUrl, baseHeaders);
  }

  if (request.method === "GET" && segments[0] === "oauth" && segments[2] === "callback") {
    const provider = parseProvider(segments[1]);
    const { redirect } = await broker.callback(provider, url.searchParams);
    return redirectResponse(redirect.toString(), baseHeaders);
  }

  if (request.method === "POST" && segments[0] === "oauth" && segments[2] === "handoff") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.redeem({
      contractVersion: contractVersionOf(body),
      provider,
      handoff: stringRequired(body, "handoff"),
      state: stringRequired(body, "state")
    });
    return jsonResponse(200, response, baseHeaders);
  }

  if (request.method === "POST" && segments[0] === "oauth" && segments[2] === "refresh") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.refresh({
      contractVersion: contractVersionOf(body),
      provider,
      refreshToken: stringRequired(body, "refreshToken")
    });
    return jsonResponse(200, response, baseHeaders);
  }

  if (request.method === "POST" && segments[0] === "oauth" && segments[2] === "revoke") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.revoke({
      contractVersion: contractVersionOf(body),
      provider,
      token: stringRequired(body, "token"),
      tokenTypeHint: tokenTypeHint(body)
    });
    return jsonResponse(200, response, baseHeaders);
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_JSON_BODY_BYTES) {
    throw new BrokerContractError("invalid-request", "Request body too large.", false);
  }

  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw new BrokerContractError("invalid-request", "Request body too large.", false);
  }

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

function tokenTypeHint(body: Record<string, unknown>): "access_token" | "refresh_token" | undefined {
  const value = body.tokenTypeHint;
  if (value === "access_token" || value === "refresh_token") return value;
  return undefined;
}

function contractVersionOf(body: Record<string, unknown>): typeof BROKER_CONTRACT_VERSION {
  const value = body.contractVersion;
  if (value !== BROKER_CONTRACT_VERSION) {
    throw new BrokerContractError("unsupported-version", "Unsupported broker contract version.", false);
  }
  return value;
}

function redirectResponse(location: string, baseHeaders: Headers): Response {
  return new Response(null, {
    status: 302,
    headers: withHeaders(baseHeaders, { location })
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  baseHeaders: Headers,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withHeaders(baseHeaders, {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    })
  });
}

function withHeaders(base: Headers, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
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

function peer(request: Request): string | undefined {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? undefined;
}

function loopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1",
    "http://localhost"
  ];
}

function log(request: Request, event: string, path: string, correlation: string): void {
  const safe = redactForLog(`${request.method} ${path}`);
  console.log(JSON.stringify({ level: "info", event, path: safe, correlationId: correlation }));
}
