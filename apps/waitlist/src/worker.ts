/**
 * Cloudflare Worker transport for waitlist.
 * Thin glue + env binding. No waitlist data ever touches apps/broker.
 */

import { createWaitlistRouter } from "./router.js";

export interface Env extends Record<string, any> {
  DB: D1Database;
  TURNSTILE_SECRET: string;
  WAITLIST_EMAIL_PEPPER: string;
  WAITLIST_SIGNING_KEY: string;
  MARKETING_ORIGIN?: string;
  CONFIRM_URL_BASE?: string;
  RATE_LIMIT_SIGNUP_PER_HOUR?: string;
  RATE_LIMIT_EMAIL_PER_DAY?: string;
}

let routerSingleton: ReturnType<typeof createWaitlistRouter> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!routerSingleton) {
      routerSingleton = createWaitlistRouter({
        env: env as any,
        allowedOrigins: env.MARKETING_ORIGIN ? [env.MARKETING_ORIGIN] : undefined
      });
    }
    const peer = (request as any).cf?.["connecting-ip"] as string | undefined;
    const resp = await routerSingleton.handle(request, peer);
    // Add security headers if not present
    const h = new Headers(resp.headers);
    if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
    if (!h.has("referrer-policy")) h.set("referrer-policy", "strict-origin-when-cross-origin");
    return new Response(resp.body, { status: resp.status, headers: h });
  }
};
