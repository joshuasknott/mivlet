#!/usr/bin/env node
/**
 * Fable auth broker entry point.
 *
 * Deployable, not deployed. Run locally with `pnpm --filter @fable/broker dev`,
 * which serves `http://127.0.0.1:8788`. Point the desktop at it with
 * `FABLE_AUTH_BROKER_URL=http://127.0.0.1:8788`. Production must be served behind
 * HTTPS with the provider callbacks registered in each provider console.
 *
 * Provider client secrets come from the environment. See `.env.example`.
 */

import { FableBroker } from "./broker.js";
import { createBrokerServer } from "./http.js";

const port = Number(process.env.FABLE_BROKER_PORT ?? 8788);
const host = process.env.FABLE_BROKER_HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const requestsPerMinute = Number(process.env.FABLE_BROKER_RATE_LIMIT_PER_MINUTE ?? 60);

if (process.env.NODE_ENV === "production" && host === "127.0.0.1") {
  // Defensive: production should bind an externally reachable host behind HTTPS.
  // We do not refuse to start (the proxy may bind loopback), but we warn.
  // eslint-disable-next-line no-console
  console.warn("[fable-broker] production host defaults to loopback; ensure an HTTPS reverse proxy fronts it.");
}

const broker = new FableBroker({ env: process.env });
const server = createBrokerServer({ broker, host, port, requestsPerMinute });

server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: "error", event: "server-error", message: error.message }));
  process.exit(1);
});

server.on("listening", () => {
  const address = server.address();
  const bound = typeof address === "object" && address ? `${address.address}:${address.port}` : "?";
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", event: "listening", host: bound }));
});

// Clean shutdown.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
