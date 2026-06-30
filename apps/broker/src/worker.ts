/**
 * Cloudflare Workers transport for the Fable auth broker.
 *
 * Workers receive a standard Web `Request` and an `env` object (bindings +
 * vars), so this transport is a thin glue layer: it builds a {@link FableBroker}
 * from the Worker `env` and routes every fetch event through the same
 * runtime-neutral {@link createBrokerRouter} the Node transport uses. The two
 * runtimes therefore share one implementation of routing, CORS, rate limiting,
 * contract validation, redacted error handling, and the entire confidential
 * OAuth lifecycle.
 *
 * Secrets: provider client id/secret are configured as Worker secrets (or
 * encrypted vars) named exactly as in `.env.example` (FABLE_BROKER_<PROVIDER>_*).
 * They are read into broker memory only and sent solely to provider token/
 * revocation endpoints over TLS — never logged, returned, or persisted. The
 * Worker itself stores nothing: pending exchanges and handoff tickets live in
 * the per-isolate in-process stores for their short (<60s) lifetimes, which
 * matches the broker's stateless-across-restart design (an in-flight OAuth flow
 * simply restarts).
 */

import { FableBroker } from "./broker.js";
import { createBrokerRouter } from "./router.js";
import type { BrokerEnv } from "./provider-profiles.js";

/**
 * Worker environment bindings. Plain text/secret vars are strings; secrets are
 * set via `wrangler secret put` and surface identically here. Only the provider
 * credential vars and broker config vars are read; both satisfy BrokerEnv.
 */
export interface FableBrokerEnv extends BrokerEnv {
  /** Public HTTPS origin registered in every provider console. Required. */
  FABLE_BROKER_PUBLIC_URL?: string;
  /** Requests per minute per route+peer. Default 60. */
  FABLE_BROKER_RATE_LIMIT_PER_MINUTE?: string;
  /** Comma-separated exact HTTPS desktop callbacks (loopback allowed by rule). */
  FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS?: string;
}

/** Lazy per-isolate broker + router; built once per Worker isolate. */
interface BrokerRuntime {
  broker: FableBroker;
  router: ReturnType<typeof createBrokerRouter>;
}

let runtime: BrokerRuntime | undefined;

function runtimeFor(env: FableBrokerEnv): BrokerRuntime {
  if (runtime) return runtime;
  const broker = new FableBroker({
    env,
    // Workers are always HTTPS-fronted; the public URL must be configured.
    publicBaseUrl: env.FABLE_BROKER_PUBLIC_URL,
    // Use the Workers runtime fetch for provider calls.
    fetch: fetch.bind(globalThis)
  });
  const requestsPerMinute = parsePositiveInt(env.FABLE_BROKER_RATE_LIMIT_PER_MINUTE, 60);
  const router = createBrokerRouter({
    broker,
    requestsPerMinute,
    allowedOrigins: loopbackOrigins()
  });
  runtime = { broker, router };
  return runtime;
}

/**
 * The Worker fetch handler. `request` is the inbound browser/provider request;
 * `env` carries the provider secrets + config. The peer address (used only for
 * per-peer rate-limit keying, never logged) is taken from the standard
 * `CF-Connecting-IP` header Workers set for HTTP requests.
 */
export default {
  async fetch(request: Request, env: FableBrokerEnv): Promise<Response> {
    const { router } = runtimeFor(env);
    const peer = request.headers.get("cf-connecting-ip") ?? undefined;
    return router.handle(request, peer);
  }
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Loopback origins permitted for local desktop development CORS. */
function loopbackOrigins(): string[] {
  return ["http://127.0.0.1", "http://localhost", "http://127.0.0.1:8788", "http://localhost:8788"];
}
