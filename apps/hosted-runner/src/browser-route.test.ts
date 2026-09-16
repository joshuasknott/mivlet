import { afterEach, describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  settleHostedBrowserRoute,
  setPinnedBrowserTransportForTests,
  type HostedBrowserRoute
} from "./browser-route";
import { setPublicAddressLookupForTests } from "./contracts";

describe("hosted browser route pin", () => {
  afterEach(() => {
    setPublicAddressLookupForTests();
    setPinnedBrowserTransportForTests();
  });

  it("fulfills a public target with the pinned address set and never continues Chromium DNS", async () => {
    const seen: string[][] = [];
    setPublicAddressLookupForTests(async () => ["93.184.216.34"]);
    setPinnedBrowserTransportForTests(async (target) => {
      seen.push([...target.addresses]);
      return { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("ok") };
    });
    const probe = fakeRoute("https://example.com/path");
    await settleHostedBrowserRoute(probe.route);
    expect(probe.events).toEqual(["fulfill"]);
    expect(seen).toEqual([["93.184.216.34"]]);
    expect(probe.fulfilled).toEqual([{ status: 200, body: "ok" }]);
  });

  it("aborts after DNS rebinds to private, loopback, or metadata and never continues or transports", async () => {
    let answers: readonly string[] = ["93.184.216.34"];
    const transported: string[] = [];
    setPublicAddressLookupForTests(async () => answers);
    setPinnedBrowserTransportForTests(async (target) => {
      transported.push(target.hostname);
      return { status: 200, headers: {}, body: Buffer.from("ok") };
    });

    const publicRoute = fakeRoute("https://rebind.example/");
    await settleHostedBrowserRoute(publicRoute.route);
    expect(publicRoute.events).toEqual(["fulfill"]);

    for (const rebound of ["169.254.169.254", "10.1.2.3", "192.168.1.8", "127.0.0.1", "100.100.100.200", "::ffff:169.254.169.254"]) {
      answers = [rebound];
      const probe = fakeRoute("https://rebind.example/");
      await settleHostedBrowserRoute(probe.route);
      expect(probe.events, rebound).toEqual(["abort"]);
    }
    expect(transported).toEqual(["rebind.example"]);
  });

  it("does not continue Chromium when a pinned connect fails after a public check", async () => {
    setPublicAddressLookupForTests(async () => ["93.184.216.34"]);
    setPinnedBrowserTransportForTests(async () => {
      throw new Error("connect to 169.254.169.254 refused");
    });
    const probe = fakeRoute("https://rebind.example/metadata");
    await settleHostedBrowserRoute(probe.route);
    expect(probe.events).toEqual(["abort"]);
  });

  it("continues only non-network local documents and aborts websocket upgrades", async () => {
    const blank = fakeRoute("about:blank");
    await settleHostedBrowserRoute(blank.route);
    expect(blank.events).toEqual(["continue"]);

    const data = fakeRoute("data:text/plain,hi");
    await settleHostedBrowserRoute(data.route);
    expect(data.events).toEqual(["continue"]);

    const socket = fakeRoute("https://example.com/ws", { upgrade: "websocket", resourceType: "websocket" });
    await settleHostedBrowserRoute(socket.route);
    expect(socket.events).toEqual(["abort"]);
  });
});

function fakeRoute(url: string, options: { upgrade?: string; resourceType?: string } = {}): {
  events: string[];
  fulfilled: Array<{ status?: number; body: string }>;
  route: HostedBrowserRoute;
} {
  const events: string[] = [];
  const fulfilled: Array<{ status?: number; body: string }> = [];
  return {
    events,
    fulfilled,
    route: {
      request() {
        return {
          url: () => url,
          method: () => "GET",
          headers: () => (options.upgrade ? { upgrade: options.upgrade } : {}),
          postDataBuffer: () => null,
          resourceType: () => options.resourceType ?? "document"
        };
      },
      async continue() {
        events.push("continue");
      },
      async abort() {
        events.push("abort");
      },
      async fulfill(response) {
        events.push("fulfill");
        const body = response.body === undefined
          ? ""
          : typeof response.body === "string"
            ? response.body
            : Buffer.from(response.body).toString("utf8");
        fulfilled.push({ status: response.status, body });
      }
    }
  };
}
