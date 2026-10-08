import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProvider, ProviderAllowance } from "@mivlet/protocol";
import { listBackendProviders } from "@mivlet/connectors/backends/registry";
import { AccountDialog } from "../agents/AccountDialog";
import { SettingsPage } from "../pages/SettingsPage";
import { SettingsModal } from "../settings/SettingsModal";
import type { SettingsRuntime } from "../settings/settings-runtime";
import { connectedSubscriptions, SubscriptionUsage } from "./SubscriptionUsage";
import { listRuntimeBackends } from "../../runtime/domains/providers";
import {
  readProviderAllowance,
  readProviderUsage,
  refreshProviderAllowance,
} from "../../runtime/domains/provider-usage";

vi.mock("../../runtime/domains/providers", () => ({
  listRuntimeBackends: vi.fn(),
}));
vi.mock("../../runtime/domains/provider-usage", async (original) => ({
  ...(await original<typeof import("../../runtime/domains/provider-usage")>()),
  readProviderAllowance: vi.fn(),
  readProviderUsage: vi.fn(),
  refreshProviderAllowance: vi.fn(),
}));

const provider = (
  id: string,
  authState: BackendProvider["authState"] = "connected",
) => {
  const definition = listBackendProviders().find((entry) => entry.id === id);
  if (!definition) throw new Error(`Missing fixture provider: ${id}`);
  return { ...definition, authState };
};
const codex = provider("codex");
const claude = provider("claude");
const providers = [codex, claude];
const allowance = (id: string, usedPercent = 80): ProviderAllowance => ({
  providerId: id,
  identity: "opaque",
  identityKind: "managed-connection",
  status: "available",
  checkedAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  windows: [
    { id: "primary", label: "Five hour", windowDurationMins: 300, usedPercent },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listRuntimeBackends).mockResolvedValue(providers);
  vi.mocked(readProviderAllowance).mockImplementation(async (id) =>
    allowance(id),
  );
});

describe("connected subscription usage", () => {
  it("rechecks native connection metadata on refresh and excludes disconnected accounts", async () => {
    const user = userEvent.setup();
    render(<SubscriptionUsage />);
    await screen.findAllByRole("progressbar");
    vi.mocked(listRuntimeBackends).mockResolvedValue([
      codex,
      provider("claude", "needs-auth"),
    ]);
    vi.mocked(refreshProviderAllowance).mockImplementation(async (id) =>
      allowance(id, 62),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("62% used")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", {
        name: `${claude.label} subscription usage`,
      }),
    ).not.toBeInTheDocument();
    expect(refreshProviderAllowance).toHaveBeenCalledExactlyOnceWith("codex");
    expect(listRuntimeBackends).toHaveBeenCalledTimes(2);
  });

  it("excludes disconnected, API-key, custom and connection-list mismatches", () => {
    const inventory = [
      codex,
      claude,
      provider("antigravity", "needs-auth"),
      provider("openai"),
      provider("custom"),
    ];
    expect(connectedSubscriptions(inventory).map((entry) => entry.id)).toEqual([
      "codex",
      "claude",
    ]);
    expect(
      connectedSubscriptions(inventory, ["codex", "openai"]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["codex"]);
    expect(
      connectedSubscriptions([
        { ...codex, setup: { ...codex.setup!, kind: "api-key" } },
      ]),
    ).toEqual([]);
  });

  it("uses reported percent used, including zero, without loading the saved ledger", async () => {
    const inventory = [
      ...providers,
      provider("openai"),
      provider("antigravity", "needs-auth"),
    ];
    vi.mocked(readProviderAllowance).mockImplementation(async (id) => ({
      ...allowance(id, id === "codex" ? 0 : 80),
      windows: [
        {
          ...allowance(id).windows[0],
          usedPercent: id === "codex" ? 0 : 80,
          resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
        },
      ],
    }));
    render(<SubscriptionUsage providers={inventory} />);
    await waitFor(() =>
      expect(screen.getAllByRole("progressbar")).toHaveLength(2),
    );
    expect(screen.getByText("0% used")).toBeInTheDocument();
    expect(screen.getByText("80% used")).toBeInTheDocument();
    expect(screen.getAllByText("Resets in 2 hours")).toHaveLength(2);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens|cost|attempts/i)).not.toBeInTheDocument();
    expect(readProviderUsage).not.toHaveBeenCalled();
    expect(readProviderAllowance).toHaveBeenCalledTimes(2);
  });

  it("keeps missing metadata and unknown allowance distinct from an empty connection list", async () => {
    vi.mocked(listRuntimeBackends).mockResolvedValue(null);
    const view = render(<SubscriptionUsage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connected subscriptions could not be loaded.",
    );
    expect(
      screen.queryByText(/No connected subscriptions/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    view.rerender(<SubscriptionUsage providers={[]} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "No connected subscriptions",
    );
    vi.mocked(readProviderAllowance).mockResolvedValue(null);
    view.rerender(<SubscriptionUsage providers={[codex]} />);
    expect(await screen.findByText("Usage unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0% used")).not.toBeInTheDocument();
  });

  it("recovers a failed cache read through refresh and retries unavailable metadata", async () => {
    vi.mocked(listRuntimeBackends).mockResolvedValue([codex]);
    vi.mocked(readProviderAllowance).mockRejectedValue(
      new Error("Cache unavailable"),
    );
    vi.mocked(refreshProviderAllowance).mockResolvedValue(
      allowance("codex", 62),
    );
    const user = userEvent.setup();
    render(<SubscriptionUsage />);
    expect(await screen.findByText("Usage unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("0% used")).not.toBeInTheDocument();
    vi.mocked(listRuntimeBackends).mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connected subscriptions could not be loaded.",
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(refreshProviderAllowance).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("62% used")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readProviderAllowance).toHaveBeenCalledOnce();
    expect(refreshProviderAllowance).toHaveBeenCalledExactlyOnceWith("codex");
    expect(listRuntimeBackends).toHaveBeenCalledTimes(3);
  });

  it("marks expired data stale, retains distinct provider windows and never invents reset times", async () => {
    vi.mocked(readProviderAllowance).mockResolvedValue({
      ...allowance("codex"),
      observedAt: new Date(Date.now() - 600_000).toISOString(),
      windows: [
        {
          id: "codex:primary",
          label: "Primary",
          usedPercent: 62,
          windowDurationMins: 300,
        },
        {
          id: "codex:secondary",
          label: "Secondary",
          usedPercent: 28,
          windowDurationMins: 10080,
        },
        {
          id: "model:0",
          label: "Weekly Sonnet",
          usedPercent: 71,
          windowDurationMins: 10080,
        },
        { id: "invalid", label: "Invalid measurement", usedPercent: 101 },
      ],
    });
    render(<SubscriptionUsage providers={[codex]} />);
    expect(
      await screen.findByText("62% used · last measured"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Measurement stale/)).toBeInTheDocument();
    expect(screen.getByText("Weekly limit")).toBeInTheDocument();
    expect(screen.getByText("Weekly Sonnet")).toBeInTheDocument();
    expect(screen.getAllByText("Reset time unavailable")).toHaveLength(3);
    expect(screen.queryByText("Invalid measurement")).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });

  it("refreshes independently, retaining failed measurements while another refresh finishes", async () => {
    let complete!: (value: ProviderAllowance) => void;
    vi.mocked(refreshProviderAllowance).mockImplementation((id) =>
      id === "codex"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.reject(new Error("Unavailable")),
    );
    const user = userEvent.setup();
    render(<SubscriptionUsage providers={providers} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Last measurements remain visible",
    );
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(
      within(
        screen.getByRole("region", {
          name: `${claude.label} subscription usage`,
        }),
      ).getByText("80% used · last measured"),
    ).toBeInTheDocument();
    await act(async () => complete(allowance("codex", 95)));
    expect(await screen.findByText("95% used")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(refreshProviderAllowance).toHaveBeenCalledTimes(2);
  });

  it("discards late reads and refreshes after disconnect or reconnection", async () => {
    let completeRead!: (value: ProviderAllowance) => void;
    vi.mocked(readProviderAllowance).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRead = resolve;
        }),
    );
    const connected = [codex];
    const view = render(<SubscriptionUsage providers={connected} />);
    await waitFor(() => expect(readProviderAllowance).toHaveBeenCalledOnce());
    view.rerender(<SubscriptionUsage providers={[]} />);
    await act(async () => completeRead(allowance("codex", 91)));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    view.rerender(<SubscriptionUsage providers={connected} />);
    expect(await screen.findByText("80% used")).toBeInTheDocument();
    let completeRefresh!: (value: ProviderAllowance) => void;
    vi.mocked(refreshProviderAllowance).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRefresh = resolve;
        }),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    view.rerender(<SubscriptionUsage providers={[]} />);
    await act(async () => completeRefresh(allowance("codex", 92)));
    view.rerender(<SubscriptionUsage providers={connected} />);
    expect(await screen.findByText("80% used")).toBeInTheDocument();
    expect(screen.queryByText("92% used")).not.toBeInTheDocument();
  });

  it("opens the existing Settings breakdowns and reads history only there", async () => {
    vi.mocked(readProviderUsage).mockResolvedValue({
      checkedAt: new Date().toISOString(),
      since: new Date().toISOString(),
      coverage: "saved-mivlet-attempts",
      prices: [],
      models: [],
      allowances: [],
    });
    function Navigation() {
      const [breakdowns, setBreakdowns] = useState(false);
      return breakdowns ? (
        <SettingsModal
          activeTab="usage"
          onSelectTab={() => {}}
          onClose={() => {}}
        >
          <SettingsPage
            activeTab="usage"
            runtime={{} as SettingsRuntime}
            workspaceName="Fixture"
            theme="light"
            onThemeChange={() => {}}
            titleId="settings-modal-title"
          />
        </SettingsModal>
      ) : (
        <AccountDialog
          kind="usage"
          name="Fixture"
          providers={providers}
          onOpenBreakdowns={() => setBreakdowns(true)}
          onSignOut={vi.fn()}
          onClose={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Navigation />);
    await screen.findAllByRole("progressbar");
    expect(readProviderUsage).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "View breakdowns in Settings" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Usage breakdowns" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(readProviderUsage).toHaveBeenCalledOnce();
  });
});
