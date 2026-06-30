/**
 * Cloudflare Workers entrypoint for the Fable auth broker.
 *
 * Secrets are supplied as Worker secret bindings. Non-secret operational values
 * come from wrangler vars. The broker intentionally exposes only health and
 * OAuth routes; it is not a connector data proxy.
 */

import { FableBroker, type BrokerEnvironment } from "./broker.js";
import { createBrokerFetchHandler } from "./fetch-handler.js";

export interface Env extends BrokerEnvironment {
  FABLE_BROKER_PUBLIC_URL?: string;
  FABLE_BROKER_ALLOWED_DESKTOP_REDIRECTS?: string;
  FABLE_BROKER_RATE_LIMIT_PER_MINUTE?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const broker = new FableBroker({
      env,
      publicBaseUrl: env.FABLE_BROKER_PUBLIC_URL,
      requirePublicBaseUrl: true,
      fetch: globalThis.fetch.bind(globalThis)
    });
    const handler = createBrokerFetchHandler({
      broker,
      requestsPerMinute: numberFromEnv(env.FABLE_BROKER_RATE_LIMIT_PER_MINUTE, 60)
    });
    return handler(request);
  }
};

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
