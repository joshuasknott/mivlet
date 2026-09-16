import https from "node:https";
import type { LookupFunction } from "node:net";
import { Buffer } from "node:buffer";
import {
  assertPublicHttpsUrl,
  createPinnedDnsLookup,
  type PublicHttpsTarget
} from "./contracts";

const MAX_ROUTE_BODY_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_SCHEMES = /^(?:about|blob|data):/u;

type HostedBrowserRouteRequest = {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  postDataBuffer?(): Buffer | Uint8Array | null;
  resourceType?(): string;
};

export type HostedBrowserRoute = {
  request(): HostedBrowserRouteRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: {
    status?: number;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<void>;
};

export type PinnedBrowserTransport = (
  target: PublicHttpsTarget,
  request: HostedBrowserRouteRequest
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

let pinnedBrowserTransport: PinnedBrowserTransport = completePinnedHttpsRequest;

/** Test-only transport so rebinding cases never open a real socket. */
export function setPinnedBrowserTransportForTests(transport?: PinnedBrowserTransport): void {
  pinnedBrowserTransport = transport ?? completePinnedHttpsRequest;
}

/**
 * Intercept a Browser Rendering request. Chromium `route.continue()` would
 * resolve DNS again (TOCTOU) and this stack has no `resolve_to_addrs`. HTTPS
 * is completed from the Worker with a lookup that returns only the validated
 * public address set, then fulfilled so Chromium never chooses the TCP peer.
 */
export async function settleHostedBrowserRoute(route: HostedBrowserRoute): Promise<void> {
  const request = route.request();
  const url = request.url();
  if (LOCAL_SCHEMES.test(url)) {
    await route.continue();
    return;
  }
  if (isWebsocketUpgrade(request)) {
    await route.abort("blockedbyclient");
    return;
  }
  let target: PublicHttpsTarget;
  try {
    target = await assertPublicHttpsUrl(url);
  } catch {
    await route.abort("blockedbyclient");
    return;
  }
  try {
    const response = await pinnedBrowserTransport(target, request);
    await route.fulfill({
      status: response.status,
      headers: response.headers,
      body: response.body
    });
  } catch {
    await route.abort("blockedbyclient");
  }
}

function completePinnedHttpsRequest(
  target: PublicHttpsTarget,
  request: HostedBrowserRouteRequest
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = new URL(target.href);
  const method = request.method();
  const body = method === "GET" || method === "HEAD" ? undefined : request.postDataBuffer?.() ?? undefined;
  const headers = outboundHeaders(request.headers());
  const lookup = createPinnedDnsLookup(target.addresses);
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: "https:",
      hostname: url.hostname,
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: lookup as LookupFunction,
      timeout: REQUEST_TIMEOUT_MS,
      servername: url.hostname
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += bytes.byteLength;
        if (size > MAX_ROUTE_BODY_BYTES) {
          req.destroy();
          reject(new Error("browser-route-too-large"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode && response.statusCode > 0 ? response.statusCode : 502,
          headers: inboundHeaders(response.headers),
          body: Buffer.concat(chunks)
        });
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("browser-route-timeout"));
    });
    if (body && body.byteLength > 0) req.write(body);
    req.end();
  });
}

function isWebsocketUpgrade(request: HostedBrowserRouteRequest): boolean {
  if (request.resourceType?.() === "websocket") return true;
  return (request.headers().upgrade ?? "").toLowerCase() === "websocket";
}

function outboundHeaders(headers: Record<string, string>): Record<string, string> {
  const outbound: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      key === "host"
      || key === "connection"
      || key === "keep-alive"
      || key === "proxy-connection"
      || key === "transfer-encoding"
      || key === "upgrade"
      || key === "te"
      || key === "trailer"
    ) {
      continue;
    }
    outbound[name] = value;
  }
  return outbound;
}

function inboundHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const inbound: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    inbound[name] = Array.isArray(value) ? value.join("\n") : value;
  }
  return inbound;
}
