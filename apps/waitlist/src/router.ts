/**
 * Runtime-neutral router for waitlist Worker.
 * Follows broker pattern: handle(Request) -> Response.
 * All paths under /v1/ ; no overlap with broker.
 */

import { signup, confirm, unsubscribe, requestExport, performExport, requestDelete, doDelete } from "./waitlist.js";
import { createWaitlistDB } from "./db.js";
import { createRateLimiter } from "./rate-limiter.js";
import type { WaitlistEnv } from "./waitlist.js";
import type { WaitlistServices } from "./services.js";
import type { ErrorBody } from "./types.js";

export const WAITLIST_CORRELATION = "x-fable-request-id";

export interface WaitlistRouterOptions {
  env: WaitlistEnv;
  allowedOrigins?: string[];
  /** Test-only: shared capture object so journey tests can read tokens issued by real code paths (e.g. confirm). */
  capture?: { issued: Array<{ type: string; token: string; subscriberId: string }> };
}

export interface WaitlistRouter {
  handle(request: Request, peer?: string): Promise<Response>;
}

function jsonError(status: number, code: string, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function jsonOk(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function verifyTurnstileReal(secret: string, token: string, ip?: string): Promise<boolean> {
  // Test keys short-circuit (documented in README)
  const TEST_SECRET = "1x0000000000000000000000000000000AA";
  if (secret === TEST_SECRET) {
    // Accept only the documented always-pass test response token
    if (token === "XXXX.DUMMY.TOKEN.XXXX" || token.startsWith("1x")) return true;
    return false; // for test, other values fail
  }
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form
    });
    const j: any = await res.json();
    return !!j.success;
  } catch {
    return false;
  }
}

export function createWaitlistRouter(opts: WaitlistRouterOptions): WaitlistRouter {
  const { env } = opts;
  const allowed = new Set(opts.allowedOrigins ?? ["http://localhost:4321", "http://127.0.0.1:4321"]);

  const db = createWaitlistDB(env.DB as any, env.WAITLIST_EMAIL_PEPPER || "dev-pepper");
  const clock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString()
  };

  const services: WaitlistServices = {
    db,
    verifyTurnstile: (tok: string, ip?: string) => verifyTurnstileReal(env.TURNSTILE_SECRET || "", tok, ip),
    clock,
    log: (m: string) => {
      // Production: send to observability without PII
      // Here: console only redacted by caller
    },
    signupLimiter: createRateLimiter({ limit: parseInt(env.RATE_LIMIT_SIGNUP_PER_HOUR || "10", 10), windowMs: 3600_000, clock }),
    emailLimiter: createRateLimiter({ limit: parseInt(env.RATE_LIMIT_EMAIL_PER_DAY || "3", 10), windowMs: 24 * 3600_000, clock }),
    capture: opts.capture
  };

  return {
    async handle(request: Request, peer?: string) {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      // Basic security headers on all responses
      const baseHeaders: Record<string, string> = {
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "content-security-policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com;",
        "permissions-policy": "geolocation=(), microphone=()"
      };

      // CORS limited
      const origin = request.headers.get("origin") || "";
      const cors: Record<string, string> = {};
      if (allowed.has(origin)) {
        cors["access-control-allow-origin"] = origin;
        cors.vary = "origin";
      }
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            ...baseHeaders,
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type, " + WAITLIST_CORRELATION
          }
        });
      }

      try {
        if (path === "/v1/health" && method === "GET") {
          return jsonOk({ ok: true }, 200);
        }

        // Parse body supporting JSON (tests) + form-urlencoded / multipart (native HTML form no-JS POST)
        async function parseBody(req: Request): Promise<Record<string, any>> {
          const ct = req.headers.get("content-type") || "";
          try {
            if (ct.includes("application/json")) {
              return await req.json();
            }
            if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
              const fd = await req.formData();
              const out: Record<string, any> = {};
              fd.forEach((v, k) => { out[k] = typeof v === "string" ? v : ""; });
              // Map Turnstile widget response field to our expected turnstile_token
              if (!out.turnstile_token && out["cf-turnstile-response"]) {
                out.turnstile_token = out["cf-turnstile-response"];
              }
              return out;
            }
            // Fallback try json
            return await req.json();
          } catch {
            return {};
          }
        }

        if (path === "/v1/signup" && method === "POST") {
          const body = await parseBody(request);
          // locale from header
          const locale = request.headers.get("accept-language")?.split(",")[0]?.slice(0, 35);
          const ip = (request as any).cf?.["connecting-ip"] || request.headers.get("cf-connecting-ip") || peer;

          const res = await signup(
            {
              ...(body as any),
              locale
            } as any,
            ip,
            services,
            env
          );
          if ((res as any).error) {
            const e = (res as any).error;
            return jsonError((res as any).status || 400, e.code, e.message);
          }
          return jsonOk((res as any).result, 202);
        }

        if (path === "/v1/confirm" && method === "GET") {
          const token = url.searchParams.get("token") || "";
          const res = await confirm(token, services);
          if ("error" in res) {
            return jsonError(400, res.error.code, res.error.message);
          }
          return jsonOk({ status: res.status });
        }

        if (path === "/v1/unsubscribe" && method === "POST") {
          const body = await parseBody(request);
          const token = (body as any)?.token || "";
          const res: any = await unsubscribe(token, services);
          if (res.error) return jsonError(400, res.error.code, res.error.message);
          return jsonOk({ status: res.status });
        }

        // Real export/delete request + redeem per schema (always 202 on request to avoid enum)
        if (path === "/v1/export-request" && method === "POST") {
          const body = await parseBody(request);
          const email = (body as any).email || "";
          const r = await requestExport(email, services, env);
          return new Response(null, { status: r.status });
        }
        if (path === "/v1/delete-request" && method === "POST") {
          const body = await parseBody(request);
          const email = (body as any).email || "";
          const r = await requestDelete(email, services, env);
          return new Response(null, { status: r.status });
        }
        if (path === "/v1/export" && method === "GET") {
          const tok = url.searchParams.get("token") || "";
          if (!tok) return jsonError(400, "token-invalid", "Missing token");
          const r: any = await performExport(tok, services, env.WAITLIST_EMAIL_PEPPER);
          if (r.error) return jsonError(400, r.error.code, r.error.message);
          return new Response(JSON.stringify(r.data), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/v1/delete" && method === "POST") {
          const body = await parseBody(request);
          const token = (body as any).token;
          if (!token) return jsonError(400, "token-invalid", "Missing");
          const delRes = await doDelete(token, services);
          if ((delRes as any).error) return jsonError(400, (delRes as any).error.code, (delRes as any).error.message);
          return jsonOk({ status: (delRes as any).status || "deleted" });
        }

        return jsonError(404, "not-found", "Not found");
      } catch (e) {
        // Never leak details
        return jsonError(500, "server-error", "Internal error");
      }
    }
  };
}
