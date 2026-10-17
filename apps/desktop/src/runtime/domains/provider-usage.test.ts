import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAllowance } from "@mivlet/protocol";

const bridge = vi.hoisted(() => ({
  scope: { workspaceId: "first" } as object | null,
  invoke: vi.fn(),
}));
vi.mock("../bridge", () => ({
  activeDataScope: () => bridge.scope,
  invokeNative: bridge.invoke,
}));
let usage: typeof import("./provider-usage");
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  bridge.scope = { workspaceId: "first" };
  usage = await import("./provider-usage");
});
afterEach(() => vi.useRealTimers());
const report: ProviderAllowance = {
  providerId: "codex",
  identity: "opaque",
  identityKind: "managed-connection",
  status: "available",
  windows: [],
  checkedAt: "2026-10-17T12:00:00Z",
  observedAt: "2026-10-17T12:00:00Z",
};

describe("usage request ownership", () => {
  it("coalesces a native probe even after a renderer deadline, then permits retry after completion", async () => {
    vi.useFakeTimers();
    let complete!: (value: ProviderAllowance) => void;
    bridge.invoke
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(report);
    const first = usage.refreshProviderAllowance("codex");
    const expired = expect(usage.boundedUsageRead(first)).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(10001);
    await expired;
    const retry = usage.refreshProviderAllowance("codex");
    expect(bridge.invoke).toHaveBeenCalledOnce();
    complete(report);
    expect(await retry).toBe(report);
    await usage.refreshProviderAllowance("codex");
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
  });
  it("rejects delayed results after an account or workspace scope change", async () => {
    let complete!: (value: ProviderAllowance) => void;
    bridge.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = usage.refreshProviderAllowance("codex");
    bridge.scope = { workspaceId: "second" };
    const rejected = expect(pending).rejects.toThrow(
      "account or workspace changed",
    );
    complete(report);
    await rejected;
    bridge.invoke.mockResolvedValue(report);
    await usage.refreshProviderAllowance("codex");
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
  });
  it("refreshes absent and stale readings while respecting recent unsuccessful checks", () => {
    const now = Date.parse(report.checkedAt);
    expect(usage.allowanceNeedsRefresh(null, now)).toBe(true);
    expect(usage.allowanceNeedsRefresh(report, now)).toBe(false);
    expect(usage.allowanceNeedsRefresh(report, now + 300001)).toBe(true);
    expect(
      usage.allowanceNeedsRefresh(
        {
          ...report,
          status: "stale",
          checkedAt: new Date(now + 300001).toISOString(),
        },
        now + 300001,
      ),
    ).toBe(false);
    expect(
      usage.allowanceNeedsRefresh(
        { ...report, status: "unavailable", checkedAt: "", windows: [] },
        now,
      ),
    ).toBe(true);
  });
});
