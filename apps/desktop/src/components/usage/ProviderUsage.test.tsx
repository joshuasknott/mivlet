import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAllowance, ProviderUsageReport } from "@mivlet/protocol";
// Use the shipping deferred export for the direct detail renders below.
import { ProviderUsageDetails } from "../pages/SettingsPage";
import { ProviderAllowanceIndicator } from "./ProviderUsage";
import {
  currentAllowance,
  allowanceLabel,
  readProviderUsage,
  readProviderAllowance,
  refreshProviderAllowance,
} from "../../runtime/domains/provider-usage";

vi.mock("../../runtime/domains/provider-usage", async (original) => ({
  ...(await original<typeof import("../../runtime/domains/provider-usage")>()),
  readProviderUsage: vi.fn(),
  readProviderAllowance: vi.fn(),
  refreshProviderAllowance: vi.fn(),
  saveProviderUsagePrice: vi.fn(),
}));
vi.mock("../../runtime/domains/providers", () => ({
  listRuntimeBackends: vi.fn(),
}));
import { listRuntimeBackends } from "../../runtime/domains/providers";
import { listBackendProviders } from "@mivlet/connectors/backends/registry";
const at = new Date().toISOString();
const allowance = (providerId: string): ProviderAllowance => ({
  providerId,
  identity: "opaque",
  identityKind: "managed-connection",
  status: "available",
  checkedAt: at,
  observedAt: at,
  windows: [
    {
      id: "five-hour",
      label: "Five hour",
      usedPercent: 80,
      windowDurationMins: 300,
    },
  ],
});
const report: ProviderUsageReport = {
  checkedAt: at,
  since: at,
  coverage: "saved-mivlet-attempts",
  prices: [],
  allowances: [allowance("codex"), allowance("claude")],
  models: [
    {
      providerId: "openai",
      model: "unknown-model",
      attempts: 1,
      inputTokens: 100,
      outputTokens: 20,
      reportedCostUsd: 0,
      reportedCostAttempts: 0,
      estimatedCostUsd: 0,
      estimatedCostAttempts: 0,
      unpricedAttempts: 1,
      latestObservedAt: at,
    },
    {
      providerId: "openrouter",
      model: "free-model",
      attempts: 1,
      inputTokens: 20,
      outputTokens: 10,
      cachedInputTokens: 0,
      reportedCostUsd: 0,
      reportedCostAttempts: 1,
      estimatedCostUsd: 0,
      estimatedCostAttempts: 0,
      unpricedAttempts: 0,
      latestObservedAt: at,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readProviderUsage).mockResolvedValue(report);
  vi.mocked(readProviderAllowance).mockImplementation(async (id) =>
    allowance(id),
  );
  vi.mocked(listRuntimeBackends).mockResolvedValue(
    listBackendProviders().map((provider) => ({
      ...provider,
      authState: provider.id === "codex" ? "connected" : "needs-auth",
    })),
  );
});
describe("provider usage", () => {
  it("opens subscription usage from the additive control, traps focus and restores the trigger", async () => {
    const user = userEvent.setup();
    render(<ProviderAllowanceIndicator providerId="codex" />);
    const trigger = screen.getByRole("button", { name: /Provider usage/ });
    await user.click(trigger);
    await screen.findByRole("progressbar");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(readProviderUsage).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close usage" })).toHaveFocus(),
    );
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  it("keeps unknown costs distinct from a reported zero and filters model detail", async () => {
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await screen.findByRole("combobox");
    await user.selectOptions(screen.getByRole("combobox"), "openai");
    expect(
      screen.queryByRole("button", { name: /free-model/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /unknown-model/ }));
    const details = screen.getByRole("region", {
      name: "unknown-model usage details",
    });
    expect(within(details).getAllByText("Unavailable")).toHaveLength(5);
    await user.selectOptions(screen.getByRole("combobox"), "openrouter");
    expect(
      screen.queryByRole("region", { name: "unknown-model usage details" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/\$0/)).toBeInTheDocument();
  });
  it("renders warm saved data while one provider refresh is pending or fails", async () => {
    let complete!: (value: ProviderAllowance) => void;
    vi.mocked(refreshProviderAllowance).mockImplementation((id) =>
      id === "codex"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : Promise.reject(new Error("Collection unavailable")),
    );
    const user = userEvent.setup();
    render(<ProviderUsageDetails />);
    await screen.findByRole("combobox");
    const cards = screen.getAllByRole("button", { name: "Refresh allowance" });
    await user.click(cards[0]);
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /unknown-model/ }),
    ).toBeInTheDocument();
    await user.click(cards[1]);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Collection unavailable",
    );
    await act(async () =>
      complete({
        ...allowance("codex"),
        windows: [{ id: "new", label: "Five hour", usedPercent: 95 }],
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("95% used")).toBeInTheDocument(),
    );
    expect(refreshProviderAllowance).toHaveBeenCalledTimes(2);
  });
  it("fails closed in the browser preview", async () => {
    vi.mocked(readProviderUsage).mockResolvedValue(null);
    render(<ProviderUsageDetails />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "installed desktop app",
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
  it("expires measurements and never guesses a reset", () => {
    const measurement = allowance("codex");
    const observed = Date.parse(at);
    expect(allowanceLabel(currentAllowance(measurement, observed))).toBe(
      "80% used",
    );
    expect(currentAllowance(measurement, observed + 300001)?.status).toBe(
      "stale",
    );
    expect(currentAllowance(measurement, observed - 1)?.status).toBe("stale");
    expect(measurement.windows[0].resetsAt).toBeUndefined();
  });
});
