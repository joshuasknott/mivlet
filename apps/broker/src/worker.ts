/**
 * Cloudflare Workers transport for the Mivlet auth broker.
 *
 * Workers receive a standard Web `Request` and an `env` object (bindings +
 * vars), so this transport is a thin glue layer: it builds a {@link MivletBroker}
 * from the Worker `env` and routes every fetch event through the same
 * runtime-neutral {@link createBrokerRouter} the Node transport uses. The two
 * runtimes therefore share one implementation of routing, CORS, rate limiting,
 * contract validation, redacted error handling, and the entire confidential
 * OAuth lifecycle.
 *
 * Secrets: provider client id/secret are configured as Worker secrets (or
 * encrypted vars) named exactly as in `.env.example` (MIVLET_BROKER_<PROVIDER>_*).
 * Missing MIVLET_* values fall back once to legacy FABLE_* aliases.
 * They are read into broker memory only and sent solely to provider token/
 * revocation endpoints over TLS; never logged, returned, or persisted. The
 * default memory backend keeps short-lived pending exchanges and handoff
 * tickets per isolate and is refused whenever the public URL is public HTTPS
 * (HTTPS and not loopback). Unlabeled or `local` Workers with a public URL
 * fail closed. The opt-in durable backend routes those values through
 * encrypted, SQLite-backed Durable Objects and coordinates rate limits across
 * isolates.
 */

import { MivletBroker } from "./broker.js";
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
import { StoreCryptoError, assertStoreEncryptionKey } from "./store-crypto.js";
import { withLegacyFableEnv } from "@mivlet/protocol";

/**
 * Worker environment bindings. Plain text/secret vars are strings; secrets are
 * set via `wrangler secret put` and surface identically here. Only the provider
 * credential vars and broker config vars are read; both satisfy BrokerEnv.
 */
export interface Env {
  /** Public HTTPS origin registered in every provider console. Required. */
  MIVLET_BROKER_PUBLIC_URL?: string;
  /** Requests per minute per route+peer. Default 60. */
  MIVLET_BROKER_RATE_LIMIT_PER_MINUTE?: string;
  /** Declared deploy environment: local, staging, or production. */
  MIVLET_BROKER_ENVIRONMENT?: string;
  /** Comma-separated exact HTTPS desktop callbacks (loopback allowed by rule). */
  MIVLET_BROKER_ALLOWED_DESKTOP_REDIRECTS?: string;

  /** Storage backend: "memory" (default, for Node + local) or "durable" (Worker with DO). */
  MIVLET_BROKER_STORAGE_BACKEND?: string;
  /** Required only when backend=durable. 32-byte base64url secret. Never in code. */
  MIVLET_BROKER_STORE_ENCRYPTION_KEY?: string;

  /** Typed Durable Object bindings (wired in wrangler.jsonc; not used on memory path). */
  BROKER_PENDING?: DurableObjectNamespace<BrokerPending>;
  BROKER_HANDOFF?: DurableObjectNamespace<BrokerHandoff>;
  BROKER_RATELIMIT?: DurableObjectNamespace<BrokerRateLimit>;

  MIVLET_BROKER_GITHUB_CLIENT_ID?: string;
  MIVLET_BROKER_GITHUB_CLIENT_SECRET?: string;
  MIVLET_BROKER_VERCEL_CLIENT_ID?: string;
  MIVLET_BROKER_VERCEL_CLIENT_SECRET?: string;
  MIVLET_BROKER_LINEAR_CLIENT_ID?: string;
  MIVLET_BROKER_LINEAR_CLIENT_SECRET?: string;
  MIVLET_BROKER_NOTION_CLIENT_ID?: string;
  MIVLET_BROKER_NOTION_CLIENT_SECRET?: string;
  MIVLET_BROKER_SLACK_CLIENT_ID?: string;
  MIVLET_BROKER_SLACK_CLIENT_SECRET?: string;
}

/** Lazy per-isolate broker + router; built once per Worker isolate. */
interface BrokerRuntime {
  broker: MivletBroker;
  router: ReturnType<typeof createBrokerRouter>;
}

const runtimes = new WeakMap<Env, BrokerRuntime>();

function runtimeFor(env: Env): BrokerRuntime {
  const cached = runtimes.get(env);
  if (cached) return cached;
  const vars = withLegacyFableEnv(stringBindings(env));
  const backend = (vars.MIVLET_BROKER_STORAGE_BACKEND ?? "memory").toLowerCase();
  const useDurable = backend === "durable";

  // Default to memory adapters for Node/local determinism. Durable mode uses
  // awaited DO RPCs for pending exchanges, handoffs, and rate limits.
  let rateLimiter: RateLimiter | undefined;
  const clock = { nowMs: () => Date.now() };

  let ephemeralOps: import("./ephemeral-rpc.js").EphemeralOps | undefined;
  let pendingForBroker: any;
  let handoffForBroker: any;
  if (useDurable) {
    const secret = vars.MIVLET_BROKER_STORE_ENCRYPTION_KEY;
    assertStoreEncryptionKey(secret ?? "");
    ephemeralOps = createEphemeralOps(
      {
        BROKER_PENDING: (env as any).BROKER_PENDING,
        BROKER_HANDOFF: (env as any).BROKER_HANDOFF,
      },
      secret!,
      clock
    );
    rateLimiter = createDurableRateLimiter(env.BROKER_RATELIMIT!, {
      limit: parsePositiveInt(vars.MIVLET_BROKER_RATE_LIMIT_PER_MINUTE, 60),
      windowMs: 60_000,
      clock
    });
    // For durable we pass ephemeralOps; do not pass sync stores (they would be ignored anyway)
  } else {
    const stores = createStores(clock);
    pendingForBroker = stores.pending;
    handoffForBroker = stores.handoff;
  }

  const broker = new MivletBroker({
    env: vars,
    publicBaseUrl: vars.MIVLET_BROKER_PUBLIC_URL,
    requirePublicBaseUrl: true,
    fetch: fetch.bind(globalThis),
    pending: pendingForBroker,
    handoff: handoffForBroker,
    ephemeralOps,
  });
  const requestsPerMinute = parsePositiveInt(vars.MIVLET_BROKER_RATE_LIMIT_PER_MINUTE, 60);
  const router = createBrokerRouter({
    broker,
    requestsPerMinute,
    allowedOrigins: loopbackOrigins(),
    rateLimiter
  });
  const runtime = { broker, router };
  runtimes.set(env, runtime);
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
    const configError = validateWorkerConfig(env);
    if (configError) return configurationRequired(configError);
    try {
      const { router } = runtimeFor(env);
      const peer = request.headers.get("cf-connecting-ip") ?? undefined;
      return router.handle(request, peer);
    } catch (error) {
      if (error instanceof StoreCryptoError) {
        return configurationRequired("Durable storage encryption key is invalid.");
      }
      return configurationRequired("Broker Worker configuration is invalid.");
    }
  }
};

function validateWorkerConfig(env: Env): string | undefined {
  const vars = withLegacyFableEnv(stringBindings(env));
  const backend = (vars.MIVLET_BROKER_STORAGE_BACKEND ?? "memory").toLowerCase();
  const rawDeployment = vars.MIVLET_BROKER_ENVIRONMENT;
  const deployment = (rawDeployment ?? "local").toLowerCase();
  const unlabeledOrLocal = !rawDeployment?.trim() || deployment === "local";
  if (backend !== "memory" && backend !== "durable") {
    return "Storage backend must be memory or durable.";
  }
  // Label is not a reachability control. Public callback URLs cannot use the
  // local/unlabeled environment, and in-memory OAuth state cannot back public HTTPS.
  if (unlabeledOrLocal && isPublicUrl(vars.MIVLET_BROKER_PUBLIC_URL)) {
    return "Local Workers cannot use a public URL.";
  }
  if (backend === "memory" && isPublicHttpsUrl(vars.MIVLET_BROKER_PUBLIC_URL)) {
    return "Public HTTPS Workers require durable storage.";
  }
  if ((deployment === "staging" || deployment === "production") && backend !== "durable") {
    return "Staging and production Workers require durable storage.";
  }
  if (backend === "durable") {
    if (!env.BROKER_PENDING || !env.BROKER_HANDOFF || !env.BROKER_RATELIMIT) {
      return "Durable Object bindings are required for durable backend.";
    }
    if (!vars.MIVLET_BROKER_STORE_ENCRYPTION_KEY) {
      return "Encryption key required for durable backend.";
    }
    try {
      assertStoreEncryptionKey(vars.MIVLET_BROKER_STORE_ENCRYPTION_KEY);
    } catch {
      return "Durable storage encryption key is invalid.";
    }
    if (!isHttpsUrl(vars.MIVLET_BROKER_PUBLIC_URL)) {
      return "Durable Worker deployments require an explicit HTTPS public URL.";
    }
  }
  return undefined;
}

function parseBrokerUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Any non-loopback origin, including public HTTP. */
function isPublicUrl(value: string | undefined): boolean {
  const url = parseBrokerUrl(value);
  return Boolean(url && !isLoopbackHostname(url.hostname));
}

/** HTTPS origin that is not loopback — the public Internet callback case. */
function isPublicHttpsUrl(value: string | undefined): boolean {
  const url = parseBrokerUrl(value);
  return Boolean(url && url.protocol === "https:" && !isLoopbackHostname(url.hostname));
}

function isHttpsUrl(value: string | undefined): boolean {
  const url = parseBrokerUrl(value);
  return Boolean(url && url.protocol === "https:");
}

function configurationRequired(message: string): Response {
  return new Response(
    JSON.stringify({ error: "configuration-required", message }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

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
