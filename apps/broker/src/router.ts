/**
 * Runtime-neutral request router for the auth broker.
 *
 * Everything transport-specific in the old `http.ts` that is NOT tied to a
 * particular I/O API — routing, contract version gating, CORS, rate limiting,
 * correlation ids, body parsing, and structured redacted error responses — lives
 * here, expressed against the standard Web `Request`/`Response` types. Those are
 * available on both Node.js (>= 18) and the Cloudflare Workers runtime, so the
 * same handler backs both transports.
 *
 * Security invariants (unchanged from the Node-only version):
 *   - Secrets and provider tokens never cross this layer into logs or responses.
 *     The token set appears only in the handoff-redeem response body (the one
 *     allowed crossing) and is never logged.
 *   - Every error response is a redacted {@link BrokerErrorResponse}.
 *   - `state` is single-use and consumed before any token exchange (enforced in
 *     the broker service, not here).
 */

import {
  BrokerContractError,
  BROKER_CONTRACT_VERSION,
  BROKER_PKCE_CHALLENGE_METHOD,
  type BrokerErrorResponse,
  type BrokerProviderId,
  isBrokerProvider
} from "@mivlet/connectors";

import type { MivletBroker } from "./broker.js";
import {
  createRateLimiter,
  newCorrelationId,
  rateLimitKey,
  redactForLog,
  type RateLimiter
} from "./rate-limiter.js";

export type { RateLimiter };

export const CORRELATION_HEADER = "x-mivlet-request-id";

export interface BrokerRouterOptions {
  broker: MivletBroker;
  /** Requests per minute per route. Default 60. */
  requestsPerMinute?: number;
  /** Allowed CORS origins. Default: loopback only. */
  allowedOrigins?: string[];
  /**
   * Whether to honor the client-controllable `X-Forwarded-For` header for the
   * rate-limit peer on the Node transport. Default false: the peer is taken from
   * the socket address, so rotating the header per request cannot bypass the
   * per-peer limit. Set true only behind a trusted proxy that overwrites the
   * header. The Workers transport always reads `cf-connecting-ip` (set by
   * Cloudflare) and ignores this flag.
   */
  trustProxy?: boolean;
  /** Optional pre-created RateLimiter (for durable adapter injection or tests). Defaults to in-memory. */
  rateLimiter?: RateLimiter;
}

/** A logger sink the transports can supply; never receives bodies or secrets. */
type BrokerLogger = (line: string) => void;

export interface BrokerRouter {
  /**
   * Handle a standard Web Request. The peer address (for rate-limit keying) is
   * supplied by the transport, since the Workers fetch handler reads it from the
   * request CF metadata while Node reads it from the socket.
   */
  handle(request: Request, peer: string | undefined, log?: BrokerLogger): Promise<Response>;
}

/**
 * Build the runtime-neutral handler. Exposed so tests can drive it directly with
 * a `Request` without binding any socket, and so both Node and Workers transports
 * share one implementation.
 */
export function createBrokerRouter(options: BrokerRouterOptions): BrokerRouter {
  const limiter = options.rateLimiter ?? createRateLimiter({
    limit: options.requestsPerMinute ?? 60,
    windowMs: 60_000
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? loopbackOrigins());

  return {
    async handle(request, peer, log = defaultLog) {
      const correlation = request.headers.get(CORRELATION_HEADER) ?? newCorrelationId();

      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);

      // CORS preflight + origin reflection. Safe-listed origins only.
      const origin = request.headers.get("origin") ?? undefined;
      const corsHeaders: Record<string, string> = {};
      if (origin && allowedOrigins.has(origin)) {
        corsHeaders["access-control-allow-origin"] = origin;
        corsHeaders.vary = "origin";
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": `content-type, ${CORRELATION_HEADER}`,
            "access-control-max-age": "600",
            "cache-control": "no-store"
          }
        });
      }

      // Health is exempt from rate limiting so monitoring is always green.
      if (request.method === "GET" && segments[0] === "healthz") {
        return jsonResponse(
          200,
          options.broker.health(),
          { [CORRELATION_HEADER]: correlation },
          corsHeaders
        );
      }

      // Rate limit every OAuth route per route+peer.
      try {
        const limit = await limiter.check(rateLimitKey(url.pathname, peer));
        if (!limit.allowed) {
          log(redactLog("rate-limited", request.method, url.pathname, correlation));
          return jsonResponse(
            429,
            new BrokerContractError("rate-limited", "Too many broker requests.", true).toResponse(),
            {
              [CORRELATION_HEADER]: correlation,
              "retry-after": String(Math.ceil(limit.retryAfterMs / 1000))
            },
            corsHeaders
          );
        }

        return await route(request, url, segments, options.broker, corsHeaders, correlation);
      } catch (error) {
        const { status, response } = toBrokerErrorPayload(error);
        log(redactLog(response.error, request.method, url.pathname, correlation));
        return jsonResponse(
          status,
          response,
          { [CORRELATION_HEADER]: correlation },
          corsHeaders
        );
      }
    }
  };
}

async function route(
  request: Request,
  url: URL,
  segments: string[],
  broker: MivletBroker,
  corsHeaders: Record<string, string>,
  correlation: string
): Promise<Response> {
  const headers = { [CORRELATION_HEADER]: correlation };

  // /oauth/{provider}/authorize
  if (request.method === "GET" && segments.length === 3 && segments[0] === "oauth" && segments[2] === "authorize") {
    const provider = parseProvider(segments[1]);
    rejectDuplicateQueryParams(url.searchParams, [
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method"
    ]);
    const codeChallenge = requireQuery(url, "code_challenge");
    const codeChallengeMethod = requireQuery(url, "code_challenge_method");
    if (codeChallengeMethod !== BROKER_PKCE_CHALLENGE_METHOD) {
      throw new BrokerContractError("invalid-request", "PKCE challenge method must be S256.", false);
    }
    const { response } = await broker.authorize({
      contractVersion: BROKER_CONTRACT_VERSION,
      provider,
      redirectUri: requireQuery(url, "redirect_uri"),
      state: requireQuery(url, "state"),
      codeChallenge,
      codeChallengeMethod: BROKER_PKCE_CHALLENGE_METHOD
    });
    return new Response(null, {
      status: 302,
      headers: { ...headers, ...corsHeaders, location: response.authorizationUrl, "cache-control": "no-store" }
    });
  }

  // /oauth/{provider}/callback (the provider's registered callback)
  if (request.method === "GET" && segments.length === 3 && segments[0] === "oauth" && segments[2] === "callback") {
    const provider = parseProvider(segments[1]);
    const { redirect } = await broker.callback(provider, url.searchParams);
    return new Response(null, {
      status: 302,
      headers: { ...headers, ...corsHeaders, location: redirect.toString(), "cache-control": "no-store" }
    });
  }

  // /oauth/{provider}/handoff
  if (request.method === "POST" && segments.length === 3 && segments[0] === "oauth" && segments[2] === "handoff") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.redeem({
      contractVersion: contractVersionOf(body),
      provider,
      handoff: stringRequired(body, "handoff"),
      state: stringRequired(body, "state"),
      codeVerifier: stringRequired(body, "codeVerifier")
    });
    return jsonResponse(200, response, headers, corsHeaders);
  }

  // /oauth/{provider}/refresh
  if (request.method === "POST" && segments.length === 3 && segments[0] === "oauth" && segments[2] === "refresh") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.refresh({
      contractVersion: contractVersionOf(body),
      provider,
      refreshToken: stringRequired(body, "refreshToken")
    });
    return jsonResponse(200, response, headers, corsHeaders);
  }

  // /oauth/{provider}/revoke
  if (request.method === "POST" && segments.length === 3 && segments[0] === "oauth" && segments[2] === "revoke") {
    const provider = parseProvider(segments[1]);
    const body = await readJson(request);
    const response = await broker.revoke({
      contractVersion: contractVersionOf(body),
      provider,
      token: stringRequired(body, "token"),
      tokenTypeHint: tokenTypeHint(body)
    });
    return jsonResponse(200, response, headers, corsHeaders);
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

function rejectDuplicateQueryParams(query: URLSearchParams, keys: readonly string[]): void {
  for (const key of keys) {
    if (query.getAll(key).length > 1) {
      throw new BrokerContractError(
        "invalid-request",
        "Authorization request contains duplicate parameters.",
        false
      );
    }
  }
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  // Pre-check content-length so a static oversize payload is rejected before any
  // body bytes are materialized. The header is client-controllable, so the
  // streaming cap below is the real enforcement; this just blocks the common case.
  const declared = request.headers.get("content-length");
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES) {
    throw new BrokerContractError("invalid-request", "Request body too large.", false);
  }
  // Stream the body, aborting the moment the accumulated byte length exceeds the
  // cap. This bounds memory on the Workers runtime where `request.text()` would
  // otherwise buffer the whole body before the size check runs. A chunked or lying
  // content-length is caught here. Raw byte length is tracked from the chunks so
  // no Node `Buffer` global is needed (absent on the Workers runtime).
  const reader = request.body?.getReader();
  let text: string;
  if (!reader) {
    text = "";
  } else {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* already gone */
        }
        throw new BrokerContractError("invalid-request", "Request body too large.", false);
      }
      chunks.push(value);
    }
    text = chunksToText(chunks, totalBytes);
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

/** Decode a list of byte chunks into a UTF-8 string (no Node Buffer dependency). */
function chunksToText(chunks: Uint8Array[], totalBytes: number): string {
  if (chunks.length === 0) return "";
  // A single chunk is the common case; decode it directly without copying.
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
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

/** Parse + validate the contract version against the literal expected value. */
function contractVersionOf(body: Record<string, unknown>): typeof BROKER_CONTRACT_VERSION {
  const value = body.contractVersion;
  if (value !== BROKER_CONTRACT_VERSION) {
    throw new BrokerContractError("unsupported-version", "Unsupported broker contract version.", false);
  }
  return value;
}

function jsonResponse(
  status: number,
  body: unknown,
  ...headerSets: Record<string, string>[]
): Response {
  const payload = JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...Object.assign({}, ...headerSets)
    }
  });
}

/**
 * Normalize a caught error into the HTTP status + redacted {@link BrokerErrorResponse}
 * shape every broker route emits. A {@link BrokerContractError} is surfaced with its
 * own code/status/retryability; any other (unexpected) error collapses to
 * provider-unavailable (502, retryable) so provider diagnostics or caught messages
 * never reach the client. Exposed so the Node transport's stream-error catch can
 * route contract errors (e.g. an oversize body) through the identical path instead
 * of emitting a generic 500.
 */
export function toBrokerErrorPayload(error: unknown): { status: number; response: BrokerErrorResponse } {
  const normalized = error instanceof BrokerContractError
    ? error
    : new BrokerContractError("provider-unavailable", "An unexpected broker error occurred.", true);
  return { status: httpStatusFor(normalized), response: normalized.toResponse() };
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

function loopbackOrigins(): string[] {
  return [
    "http://127.0.0.1",
    "http://localhost",
    "http://127.0.0.1:8788",
    "http://localhost:8788"
  ];
}

/** Redact-then-log a request line as structured JSON. Never logs bodies/tokens. */
function redactLog(event: string, method: string | undefined, path: string, correlation: string): string {
  const safe = redactForLog(`${method ?? "?"} ${path}`);
  return JSON.stringify({ level: "info", event, path: safe, correlationId: correlation });
}

const defaultLog: BrokerLogger = (line) => {
  console.log(line);
};
