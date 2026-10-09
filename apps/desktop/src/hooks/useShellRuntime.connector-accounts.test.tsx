import { renderHook, waitFor } from "@testing-library/react";
import type { ConnectorAccountOption } from "@mivlet/protocol";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectors } from "../data/workspace";
import { mergeConnectorConnections } from "../lib/connector-connections";
import { MivletQueryProvider } from "../lib/query-client";
import { clearActiveRuntimeDataScope } from "../runtime-scope";

const mocks = vi.hoisted(() => ({
  statuses: vi.fn(),
  accounts: vi.fn(),
}));

vi.mock("../lib/load-connector-connections", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/load-connector-connections")
  >();
  return { ...actual, listVerifiedConnectorStatuses: mocks.statuses };
});

vi.mock("../runtime/domains/connectors", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../runtime/domains/connectors")
  >();
  return { ...actual, listRuntimeConnectorAccounts: mocks.accounts };
});

function wrapper({ children }: PropsWithChildren) {
  return <MivletQueryProvider>{children}</MivletQueryProvider>;
}

describe("conversation shell connector account lookup", () => {
  beforeEach(() => {
    clearActiveRuntimeDataScope();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    mocks.statuses.mockReset();
    mocks.accounts.mockReset();
  });

  it("does not resolve account state for a custom MCP manifest", async () => {
    const gmail = {
      ...connectors.find((manifest) => manifest.id === "gmail")!,
      status: "connected" as const,
    };
    const [custom] = mergeConnectorConnections([], [{
      displayName: "Custom MCP",
      launchReference: "custom-mcp",
      authorizationState: "not-required",
      credentialState: "not-required",
      healthState: "healthy",
      discoveryState: "discovered",
      discoveredTools: ["tool"],
      enabledTools: ["tool"],
    }]);
    const account = {
      connectionId: "gmail-connection",
      account: {
        id: "mivlet-gmail-account",
        displayName: "Work",
        email: "work@example.com",
      },
      active: true,
      lifecycle: "authorized",
      authorizationState: "authorized",
      healthState: "healthy",
      credentialCustody: "os-secure-store",
      credentialState: "available",
    } satisfies ConnectorAccountOption;
    mocks.statuses.mockResolvedValue([gmail, custom]);
    mocks.accounts.mockImplementation(async (connectorId: string) => {
      if (connectorId === "gmail") return [account];
      throw new Error("Unknown connector");
    });

    const { useShellRuntime } = await import("./useShellRuntime");
    const { result } = renderHook(() => useShellRuntime(), { wrapper });
    await waitFor(() => {
      expect(result.current.connectorAccounts.gmail).toEqual([account]);
      expect(
        result.current.connectorManifests.find(
          (manifest) => manifest.id === "gmail",
        )?.status,
      ).toBe("connected");
    });

    expect(mocks.accounts).toHaveBeenCalledExactlyOnceWith("gmail");
  });
});
