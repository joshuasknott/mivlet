import { Buffer } from "node:buffer";
import { assertPublicHttpsUrl, type PublicHttpsTarget } from "./contracts";

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
  fulfill(response: { status?: number; headers?: Record<string, string>; body?: Buffer | string }): Promise<void>;
};
export type PinnedBrowserTransport = (target: PublicHttpsTarget, request: HostedBrowserRouteRequest) => Promise<{
  status: number; headers: Record<string, string>; body: Buffer;
}>;
const unavailableTransport: PinnedBrowserTransport = async () => { throw new Error("hosted-browser-network-prerequisite"); };
let pinnedBrowserTransport = unavailableTransport;
/** Node fixtures only: these callbacks do not prove edge TCP peer pinning. */
export function setPinnedBrowserTransportForTests(transport?: PinnedBrowserTransport): void {
  pinnedBrowserTransport = transport ?? unavailableTransport;
}
/** Workers node:https ignores lookup. Keep production fail-closed until a
 * supported dynamic-browser boundary has passed actual edge conformance. */
export async function settleHostedBrowserRoute(route: HostedBrowserRoute): Promise<void> {
  const request = route.request();
  if (LOCAL_SCHEMES.test(request.url())) { await route.continue(); return; }
  if (request.resourceType?.() === "websocket" || (request.headers().upgrade ?? "").toLowerCase() === "websocket") {
    await route.abort("blockedbyclient"); return;
  }
  try {
    const target = await assertPublicHttpsUrl(request.url());
    await route.fulfill(await pinnedBrowserTransport(target, request));
  } catch { await route.abort("blockedbyclient"); }
}
