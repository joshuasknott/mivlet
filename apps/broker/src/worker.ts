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
 * The default memory backend keeps short-lived pending exchanges and handoff
 * tickets per isolate. The opt-in durable backend routes those values through
 * encrypted, SQLite-backed Durable Objects and coordinates rate limits across
 * isolates.
 */

import { FableBroker } from "./broker.js";
import { createBrokerRouter, type RateLimiter } from "./router.js";
import type { BrokerEnv } from "./provider-profiles.js";
import { createStores } from "./stores.js";
import {
  createDurableRateLimiter,
  BrokerPending,
  BrokerHandoff,
  BrokerRateLimit
} from "./durable-stores.js";
import { createEphemeralOps } from "./ephemeral-rpc.js";

/**
 * Worker environment bindings. Plain text/secret vars are strings; secrets are
 * set via `wrangler secret put` and surface identically here. Only the provider
 * credential vars and broker config vars are read; both satisfy BrokerEnv.
 */
export interface Env {
  /** Public HTTPS origin registered in every provider console. Required. */
  FABLE_BROKER_PUBLIC_URL?: string;
  /** Requests per minute per route+peer. Default 60. */
  FABLE_BROKER_RATE_LIMIT_PER_MINUTE?: string;
  /** Comma-separated exact HTTPS desktop callbacks (loopback allowed by rule). */
  FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS?: string;

  /** Storage backend: "memory" (default, for Node + local) or "durable" (Worker with DO). */
  FABLE_BROKER_STORAGE_BACKEND?: string;
  /** Required only when backend=durable. 32-byte base64url secret. Never in code. */
  FABLE_BROKER_STORE_ENCRYPTION_KEY?: string;

  /** Typed Durable Object bindings (wired in wrangler.jsonc; not used on memory path). */
  BROKER_PENDING?: DurableObjectNamespace<BrokerPending>;
  BROKER_HANDOFF?: DurableObjectNamespace<BrokerHandoff>;
  BROKER_RATELIMIT?: DurableObjectNamespace<BrokerRateLimit>;

  FABLE_BROKER_GITHUB_CLIENT_ID?: string;
  FABLE_BROKER_GITHUB_CLIENT_SECRET?: string;
  FABLE_BROKER_VERCEL_CLIENT_ID?: string;
  FABLE_BROKER_VERCEL_CLIENT_SECRET?: string;
  FABLE_BROKER_LINEAR_CLIENT_ID?: string;
  FABLE_BROKER_LINEAR_CLIENT_SECRET?: string;
  FABLE_BROKER_NOTION_CLIENT_ID?: string;
  FABLE_BROKER_NOTION_CLIENT_SECRET?: string;
  FABLE_BROKER_SLACK_CLIENT_ID?: string;
  FABLE_BROKER_SLACK_CLIENT_SECRET?: string;
}

/** Lazy per-isolate broker + router; built once per Worker isolate. */
interface BrokerRuntime {
  broker: FableBroker;
  router: ReturnType<typeof createBrokerRouter>;
}

let runtime: BrokerRuntime | undefined;

function runtimeFor(env: Env): BrokerRuntime {
  if (runtime) return runtime;
  const backend = (env.FABLE_BROKER_STORAGE_BACKEND ?? "memory").toLowerCase();
  const useDurable = backend === "durable";

  // Default to memory adapters for Node/local determinism. Durable mode uses
  // awaited DO RPCs for pending exchanges, handoffs, and rate limits.
  let rateLimiter: RateLimiter | undefined;
  const clock = { nowMs: () => Date.now() };

  let ephemeralOps: import("./ephemeral-rpc.js").EphemeralOps | undefined;
  let pendingForBroker: any;
  let handoffForBroker: any;
  if (useDurable) {
    const secret = env.FABLE_BROKER_STORE_ENCRYPTION_KEY;
    if (!secret) {
      // Guarded earlier in fetch; here provide no-op ops (will not be reached for real use)
      ephemeralOps = {
        async createPending() {},
        async consumePending() { return undefined; },
        async issueHandoff() { return ""; },
        async redeemHandoff() { return undefined; },
      };
    } else {
      ephemeralOps = createEphemeralOps(
        {
          BROKER_PENDING: (env as any).BROKER_PENDING,
          BROKER_HANDOFF: (env as any).BROKER_HANDOFF,
        },
        secret,
        clock
      );
    }
    rateLimiter = createDurableRateLimiter(env.BROKER_RATELIMIT!, {
      limit: parsePositiveInt(env.FABLE_BROKER_RATE_LIMIT_PER_MINUTE, 60),
      windowMs: 60_000,
      clock
    });
    // For durable we pass ephemeralOps; do not pass sync stores (they would be ignored anyway)
  } else {
    const stores = createStores(clock);
    pendingForBroker = stores.pending;
    handoffForBroker = stores.handoff;
  }

  const broker = new FableBroker({
    env: stringBindings(env),
    publicBaseUrl: env.FABLE_BROKER_PUBLIC_URL,
    requirePublicBaseUrl: true,
    fetch: fetch.bind(globalThis),
    pending: pendingForBroker,
    handoff: handoffForBroker,
    ephemeralOps,
  });
  const requestsPerMinute = parsePositiveInt(env.FABLE_BROKER_RATE_LIMIT_PER_MINUTE, 60);
  const router = createBrokerRouter({
    broker,
    requestsPerMinute,
    allowedOrigins: loopbackOrigins(),
    rateLimiter
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const backend = (env.FABLE_BROKER_STORAGE_BACKEND ?? 'memory').toLowerCase();
    if (backend === 'durable' && !env.FABLE_BROKER_STORE_ENCRYPTION_KEY) {
      return new Response(JSON.stringify({ error: 'configuration-required', message: 'Encryption key required for durable backend.' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    if (
      backend === "durable"
      && (!env.BROKER_PENDING || !env.BROKER_HANDOFF || !env.BROKER_RATELIMIT)
    ) {
      return new Response(
        JSON.stringify({
          error: "configuration-required",
          message: "Durable Object bindings are required for durable backend."
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      );
    }
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

/** Copy only string vars/secrets into the runtime-neutral broker environment. */
function stringBindings(env: Env): BrokerEnv {
  const bindings: BrokerEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") bindings[name] = value;
  }
  return bindings;
}

/** Loopback origins permitted for local desktop development CORS. */
function loopbackOrigins(): string[] {
  return ["http://127.0.0.1", "http://localhost", "http://127.0.0.1:8788", "http://localhost:8788"];
}

// Re-export DO classes so wrangler can discover them from the Worker entry for bindings.
// (Classes are no-ops on memory paths and never constructed in Node tests.)
export { BrokerPending, BrokerHandoff, BrokerRateLimit };
