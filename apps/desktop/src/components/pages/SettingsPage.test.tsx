import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionHistoryEvent, BackendProvider } from "@fable/protocol";
import { SettingsPage } from "./SettingsPage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Focused Settings → Providers UX coverage. These exercise the *display* layer
 * that turns real provider/runtime state into honest, recoverable UI, without
 * driving the full Tauri boundary (the hook tests own the runtime path).
 *
 * Only the ShellRuntime fields ProviderAccessView reads are stubbed; the rest
 * is cast through Partial so the component sees a well-typed runtime.
 */
function stubRuntime(over: Partial<ShellRuntime> = {}): ShellRuntime {
  return {
    memoryDisabled: false,
    toggleMemoryDisabled: () => {},
    connectorManifests: [],
    backendProviders: [],
    connectedBackendIds: [],
    backendStatus: null,
    modelDiscoveryByProvider: {},
    connectBackendWithVerify: vi.fn(),
    disconnectBackend: vi.fn(),
    refreshModels: vi.fn(),
    refreshConnector: vi.fn(),
    disconnectConnector: vi.fn(),
    exportMemory: vi.fn(),
    ...over
  } as unknown as ShellRuntime;
}

const nativeProvider = (over: Partial<BackendProvider> = {}): BackendProvider => ({
  id: "openai",
  backendType: "native-api",
  label: "OpenAI",
  description: "OpenAI native",
  authState: "needs-auth",
  capabilities: [],
  models: [],
  ...over
});

function renderProviders(runtime: ShellRuntime) {
  return render(
    <SettingsPage
      runtime={runtime}
      theme="dark"
      onThemeChange={() => {}}
      activeTab="providers"
      workspaceName="Fable"
    />
  );
}

/** Provider rows are keyed by data-provider-id (not data-testid). */
function providerRow(id: string): HTMLElement {
  const el = document.querySelector(`[data-provider-id="${id}"]`);
  if (!el) throw new Error(`No provider row for ${id}`);
  return el as HTMLElement;
}

describe("Settings → Providers UX states", () => {
  it("shows 'Needs API key' for a connected-missing provider (missing key)", () => {
    const provider = nativeProvider({ authState: "needs-auth" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: [],
        backendStatus: null,
        modelDiscoveryByProvider: {},
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai");
    expect(row.textContent).toMatch(/needs api key/i);
    // Not connected: no Refresh models affordance yet.
    expect(screen.queryByLabelText(/refresh models for openai/i)).toBeNull();
  });

  it("renders connected + capability-bearing with a model refresh affordance", () => {
    const provider = nativeProvider({
      authState: "connected",
      capabilities: ["streaming", "threads"],
      models: [{ id: "gpt-4o", label: "GPT-4o", available: true }]
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "success" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: refresh
      })
    );

    expect(providerRow("openai").textContent).toMatch(/connected/i);
    const refreshBtn = screen.getByLabelText(/refresh models for openai/i);
    fireEvent.click(refreshBtn);
    expect(refresh).toHaveBeenCalledWith("openai");
  });

  it("shows a refresh spinner and disables retry while discovery is loading", () => {
    const provider = nativeProvider({ authState: "connected" });
    const refresh = vi.fn();
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "loading" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: refresh
      })
    );

    const refreshBtn = screen.getByLabelText(
      /refresh models for openai/i
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
    expect(providerRow("openai").textContent).toMatch(/refreshing models/i);
  });

  it("surfaces a recoverable, non-alarming hint when discovery failed (degraded)", () => {
    const provider = nativeProvider({ authState: "connected" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "offline" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai").textContent ?? "";
    // Degraded is recoverable: the hint must reassure the key is fine and offer retry.
    expect(row).toMatch(/your key is fine/i);
    expect(row.toLowerCase()).toMatch(/refresh|retry|try again/);
    // The refresh button becomes "Retry" for a degraded provider.
    expect(screen.getByRole("button", { name: /refresh models for openai/i })).toBeTruthy();
  });

  it("does not blame the key for an empty model list (account, not auth)", () => {
    const provider = nativeProvider({ authState: "connected" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "empty" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai").textContent ?? "";
    // Empty is an account/plan condition, not a key problem.
    expect(row.toLowerCase()).not.toMatch(/key (was |is )?(rejected|invalid|wrong)/);
  });

  it("distinguishes a missing key from a rejected key in the connect status", async () => {
    const provider = nativeProvider({ authState: "needs-auth" });
    const { rerender } = renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: [],
        backendStatus: null,
        modelDiscoveryByProvider: {},
        connectBackendWithVerify: vi.fn(async () => ({
          providerId: "openai",
          outcome: "auth-failed" as const,
          // The Rust boundary's missing_key_message signature.
          message: "Add an openai API key to connect."
        })),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    // Reveal the key form, enter a key, and submit. The key input is
    // uncontrolled on purpose; set the DOM value directly like a user.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const keyInput = screen.getByLabelText(/api key for openai/i) as HTMLInputElement;
    keyInput.value = "sk-test";
    fireEvent.submit(keyInput.closest("form")!);

    // Missing key: the status must read as a configuration gap, NOT a rejected
    // key — it should not say "rejected"/"invalid"/"expired".
    const status = await screen.findByRole("status");
    expect(status.textContent?.toLowerCase()).toMatch(/no api key stored|add a key/);
    expect(status.textContent?.toLowerCase()).not.toMatch(/reject|invalid|expired/);

    // Now a rejected key must read the opposite.
    rerender(
      <SettingsPage
        runtime={stubRuntime({
          backendProviders: [provider],
          connectedBackendIds: [],
          backendStatus: null,
          modelDiscoveryByProvider: {},
          connectBackendWithVerify: vi.fn(async () => ({
            providerId: "openai",
            outcome: "auth-failed" as const,
            message: "401 Unauthorized"
          })),
          disconnectBackend: vi.fn(),
          refreshModels: vi.fn()
        })}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="providers"
        workspaceName="Fable"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const keyInput2 = screen.getByLabelText(/api key for openai/i) as HTMLInputElement;
    keyInput2.value = "sk-bad";
    fireEvent.submit(keyInput2.closest("form")!);
    const rejectedStatus = await screen.findByRole("status");
    expect(rejectedStatus.textContent?.toLowerCase()).toMatch(/reject|expired/);
  });
});

describe("Settings → Privacy UX states", () => {
  const googleConnector = {
    id: "google-drive",
    name: "Google Drive",
    status: "connected" as const,
    permissions: [],
    healthSummary: "Healthy",
    lastCheckedAt: "2026-06-30T10:00:00Z",
    account: { id: "user-1", email: "user@example.com", displayName: "User One" }
  };

  function renderPrivacy(runtime: ShellRuntime) {
    return render(
      <SettingsPage
        runtime={runtime}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="privacy"
        workspaceName="Fable"
      />
    );
  }

  it("renders privacy settings controls and lists active connectors", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const exportMemory = vi.fn().mockResolvedValue(undefined);
    const toggleMemoryDisabled = vi.fn();

    renderPrivacy(
      stubRuntime({
        connectorManifests: [googleConnector],
        refreshConnector: refresh,
        disconnectConnector: disconnect,
        exportMemory: exportMemory,
        memoryDisabled: false,
        toggleMemoryDisabled: toggleMemoryDisabled
      })
    );

    expect(screen.getByRole("heading", { name: "Privacy" })).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    expect(screen.getByText("Active: user@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Toggle personal memory")).toBeTruthy();
  });

  it("handles connector resync and disconnect", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);

    renderPrivacy(
      stubRuntime({
        connectorManifests: [googleConnector],
        refreshConnector: refresh,
        disconnectConnector: disconnect
      })
    );

    const resyncBtn = screen.getByRole("button", { name: /resync google drive/i });
    await act(async () => {
      fireEvent.click(resyncBtn);
    });
    expect(refresh).toHaveBeenCalledWith("google-drive");

    const disconnectBtn = screen.getByRole("button", { name: /disconnect google drive/i });
    await act(async () => {
      fireEvent.click(disconnectBtn);
    });
    expect(disconnect).toHaveBeenCalledWith("google-drive");
  });

  it("handles memory toggle and export actions", async () => {
    const exportMemory = vi.fn().mockResolvedValue(undefined);
    const toggleMemoryDisabled = vi.fn();

    renderPrivacy(
      stubRuntime({
        connectorManifests: [],
        exportMemory: exportMemory,
        memoryDisabled: false,
        toggleMemoryDisabled: toggleMemoryDisabled
      })
    );

    const checkbox = screen.getByLabelText("Toggle personal memory");
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(toggleMemoryDisabled).toHaveBeenCalled();

    const exportBtn = screen.getByRole("button", { name: /export memory/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    expect(exportMemory).toHaveBeenCalled();
  });

  it("handles bulk disconnect of all connectors", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPrivacy(
      stubRuntime({
        connectorManifests: [
          googleConnector,
          {
            id: "slack",
            name: "Slack",
            status: "connected" as const,
            permissions: [],
            healthSummary: "Healthy",
            lastCheckedAt: "2026-06-30T10:00:00Z"
          }
        ],
        disconnectConnector: disconnect
      })
    );

    const bulkBtn = screen.getByRole("button", { name: /disconnect all connectors/i });
    await act(async () => {
      fireEvent.click(bulkBtn);
    });

    await screen.findByText("Successfully disconnected all connectors.");

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenNthCalledWith(1, "google-drive");
    expect(disconnect).toHaveBeenNthCalledWith(2, "slack");
  });
});

describe("Settings → History (inspectable action history)", () => {
  function renderHistory(runtime: ShellRuntime) {
    return render(
      <SettingsPage
        runtime={runtime}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="history"
        workspaceName="Fable"
      />
    );
  }

  const historyEvents: ActionHistoryEvent[] = [
    {
      id: "ah-1",
      category: "tool-action",
      service: "tool",
      action: "read-file",
      status: "ok",
      actor: "system",
      createdAt: "2026-06-30T10:00:00.000Z",
      riskLevel: "low",
      mode: "read-only",
      correlationId: "req-1",
      errorCode: "",
      summary: "read-file src/index.ts",
      detail: { tool: "read-file", preview: "src/index.ts" }
    },
    {
      id: "ah-2",
      category: "approval",
      service: "github",
      action: "github.comment",
      status: "approved",
      actor: "user",
      createdAt: "2026-06-30T11:00:00.000Z",
      riskLevel: "medium",
      mode: "trusted-scope",
      correlationId: "req-2",
      errorCode: "",
      summary: "github github.comment",
      detail: { requestId: "req-2", consequence: "Posts a comment." }
    },
    {
      id: "ah-3",
      category: "policy-block",
      service: "tool",
      action: "run-shell",
      status: "blocked",
      actor: "system",
      createdAt: "2026-06-30T12:00:00.000Z",
      riskLevel: "critical",
      mode: "full-access",
      correlationId: "req-3",
      errorCode: "permit",
      summary: "run-shell: approval metadata changed after the user decision",
      detail: { tool: "run-shell" }
    }
  ];

  it("renders type, summary, status, time, actor, and safe details for each event", () => {
    renderHistory(
      stubRuntime({
        actionHistory: historyEvents,
        refreshActionHistory: vi.fn()
      })
    );

    // Category + action (type).
    expect(screen.getByText(/Tool \/ shell · read-file/)).toBeInTheDocument();
    // Summary.
    expect(screen.getByText("read-file src/index.ts")).toBeInTheDocument();
    // Status.
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
    // Actor + correlation id (safe details).
    expect(screen.getAllByText(/actor: system/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/id: req-1/i).length).toBeGreaterThan(0);
    // Safe detail payload (requestId) is surfaced.
    expect(screen.getAllByText("req-2").length).toBeGreaterThan(0);
  });

  it("filters events by category using the plaintext category chips", () => {
    renderHistory(
      stubRuntime({
        actionHistory: historyEvents,
        refreshActionHistory: vi.fn()
      })
    );

    // Initially all three events are present.
    expect(screen.getAllByRole("listitem").length).toBe(3);

    // Filter to approvals only.
    fireEvent.click(screen.getByRole("button", { name: "Approvals" }));

    const approvalRows = screen.getAllByRole("listitem");
    expect(approvalRows.length).toBe(1);
    expect(approvalRows[0]).toHaveAttribute(
      "data-action-history-category",
      "approval"
    );
  });

  it("shows an empty state when no actions are recorded", () => {
    renderHistory(
      stubRuntime({
        actionHistory: [],
        refreshActionHistory: vi.fn()
      })
    );

    expect(screen.getByTestId("action-history-empty")).toBeInTheDocument();
  });

  it("invokes refreshActionHistory when the refresh button is clicked", () => {
    const refreshActionHistory = vi.fn();
    renderHistory(
      stubRuntime({
        actionHistory: historyEvents,
        refreshActionHistory
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh action history/i }));
    expect(refreshActionHistory).toHaveBeenCalledTimes(1);
  });

  it("renders a redacted detail value without leaking secret-shaped data", () => {
    // The Rust boundary redacts secrets before they reach the UI; this asserts
    // the UI renders the (already-redacted) "[redacted]" placeholder faithfully
    // rather than dropping the row.
    const event: ActionHistoryEvent = {
      id: "ah-redacted",
      category: "tool-action",
      service: "tool",
      action: "run-shell",
      status: "ok",
      actor: "system",
      createdAt: "2026-06-30T13:00:00.000Z",
      riskLevel: "critical",
      mode: "full-access",
      correlationId: "req-r",
      errorCode: "",
      summary: "run-shell echo hi",
      detail: { token: "[redacted]", command: "echo hi" }
    };

    renderHistory(
      stubRuntime({
        actionHistory: [event],
        refreshActionHistory: vi.fn()
      })
    );

    const detailValues = screen.getAllByTestId("action-history-detail-value").map((node) => node.textContent);
    expect(detailValues).toContain("[redacted]");
    expect(detailValues).toContain("echo hi");
  });
});
