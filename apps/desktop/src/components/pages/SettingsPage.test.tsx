import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    identityStatus: {
      enabled: false,
      state: "disabled",
      message: "Fable account setup is not configured.",
      scopes: []
    },
    identityPending: false,
    accountWorkspaceStatus: {
      configured: false,
      state: "disabled",
      message: "Fable account setup is not configured.",
      accountBound: false,
      workspaces: [],
      activeWorkspace: { localWorkspaceId: "default", name: "Fable workspace", source: "legacy-default" },
      devices: []
    },
    accountWorkspacePending: false,
    signInIdentity: vi.fn().mockResolvedValue(undefined),
    recoverIdentity: vi.fn().mockResolvedValue(undefined),
    refreshIdentity: vi.fn().mockResolvedValue(undefined),
    signOutIdentity: vi.fn().mockResolvedValue(undefined),
    reconcileAccountWorkspace: vi.fn().mockResolvedValue(undefined),
    revokeAccountDevice: vi.fn().mockResolvedValue(undefined),
    modelDiscoveryByProvider: {},
    workflowRuns: [],
    schedulerQueue: [],
    scheduledJobs: [],
    workflowDefinitions: [],
    notificationHistory: [],
    retryingRunIds: [],
    runHistoryJobId: null,
    clearRunHistoryJobId: vi.fn(),
    refreshWorkflowRuns: vi.fn().mockResolvedValue(undefined),
    connectBackendWithVerify: vi.fn(),
    checkBackendConnection: vi.fn(async (providerId: string) => ({ providerId, outcome: "ready" as const })),
    disconnectBackend: vi.fn(),
    refreshBackendProviders: vi.fn().mockResolvedValue([]),
    refreshModels: vi.fn(),
    refreshConnector: vi.fn(),
    disconnectConnector: vi.fn(),
    exportMemory: vi.fn(),
    permissionLabel: "Ask Me",
    selectPermissionLabel: vi.fn(),
    customApprovalSettings: {
      allowSmallLocalEdits: false,
      allowPowerfulCommands: false
    },
    updateCustomApprovalSetting: vi.fn(),
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

describe("Settings -> General identity", () => {
  it("shows the Fable account configuration state when Clerk is not configured", () => {
    render(
      <SettingsPage
        runtime={stubRuntime()}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="general"
        workspaceName="Fable"
      />
    );

    expect(screen.getByText("Fable account")).toBeTruthy();
    expect(screen.getByText(/Fable account setup is not configured/)).toBeTruthy();
  });

  it("uses verified account details and can remove a device", async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPage
        runtime={stubRuntime({
          identityStatus: {
            enabled: true,
            state: "signed-in",
            message: "Signed in.",
            scopes: [],
            authentication: {
              provider: "clerk", normalizedIssuer: "https://accounts.fable.test", subject: "user-1", authenticationEventRef: "event-1", sessionRef: "session-1",
              authenticatedAt: "2026-07-10T12:00:00Z", expiresAt: "2026-07-11T12:00:00Z", verifiedAttributes: [],
              verifiedDisplayAttributes: { displayName: "Ari", email: "ari@example.test" }
            }
          },
          accountWorkspaceStatus: {
            configured: true, state: "ready", message: "Workspace ready.", accountBound: true, workspaces: [],
            activeWorkspace: { localWorkspaceId: "local-1", name: "Ari's work", source: "hosted" },
            devices: [{ deviceId: "device-1", kind: "desktop", label: "Ari's laptop", status: "active", registeredAt: "2026-07-10T12:00:00Z" }]
          },
          revokeAccountDevice: revoke
        })}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="general"
        workspaceName="Ari's work"
      />
    );

    expect(screen.getByText("Ari")).toBeTruthy();
    expect(screen.getByText("Ari's laptop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove device" }));
    expect(screen.getByRole("dialog", { name: "Remove Ari's laptop?" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep device" })).toHaveFocus());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove device" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("device-1"));
  });
});

describe("Settings -> Approvals", () => {
  function renderApprovals(runtime = stubRuntime()) {
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

  it("shows four plain choices with Ask Me selected", async () => {
    renderApprovals();
    await screen.findByText(/not available outside the desktop runtime/i);
    expect(screen.getByRole("radio", { name: /Read Only/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Ask Me/ }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(screen.getByRole("radio", { name: /Work Freely/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Custom/ })).toBeTruthy();
  });

  it("uses two meaningful plain-language Custom toggles", async () => {
    const update = vi.fn();
    renderApprovals(stubRuntime({ updateCustomApprovalSetting: update }));
    await screen.findByText(/not available outside the desktop runtime/i);

    fireEvent.click(screen.getByRole("button", { name: /prepare small local edits/i }));
    expect(update).toHaveBeenCalledWith("allowSmallLocalEdits", true);

    fireEvent.click(screen.getByRole("button", { name: /use powerful commands/i }));
    expect(update).toHaveBeenCalledWith("allowPowerfulCommands", true);
  });

  it("does not expose internal approval jargon", async () => {
    const { container } = renderApprovals();
    await screen.findByText(/not available outside the desktop runtime/i);
    expect(container.textContent?.toLowerCase()).not.toMatch(
      /trusted-scope|full-access|permission profile|execution policy|mcp|egress/
    );
  });

  it("states that mobile approval cannot run an action", async () => {
    renderApprovals();
    expect(
      screen.getByText(/only this computer can run the action/i)
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/not available outside the desktop runtime/i)).toBeTruthy()
    );
  });
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

describe("Settings -> Providers", () => {
  it("renders one provider-first catalogue with grouped connection methods", () => {
    const codex: BackendProvider = {
      id: "codex",
      backendType: "codex-app-server",
      label: "Codex",
      description: "ChatGPT subscription",
      authState: "sign-in-required",
      capabilities: [],
      models: []
    };
    renderProviders(stubRuntime({ backendProviders: [codex, nativeProvider()] }));

    expect(screen.queryByText("Subscriptions")).toBeNull();
    expect(screen.queryByText("API keys")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));

    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(dialog).toHaveTextContent("ChatGPT subscription");
    expect(dialog).toHaveTextContent("ChatGPT subscription with a device code");
    expect(dialog).toHaveTextContent("OpenAI API key");
  });

  it("submits API keys through the verified boundary without keeping them in UI state", async () => {
    const connect = vi.fn(async () => ({ providerId: "openai", outcome: "ready" as const }));
    renderProviders(
      stubRuntime({
        backendProviders: [nativeProvider()],
        connectBackendWithVerify: connect
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    fireEvent.click(within(dialog).getByRole("button", { name: /OpenAI API key/ }));
    const keyInput = within(dialog).getByLabelText(/api key for openai \/ chatgpt/i) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "sk-settings-secret" } });
    fireEvent.submit(keyInput.closest("form")!);

    await waitFor(() => expect(connect).toHaveBeenCalledWith("openai", "sk-settings-secret"));
    expect(keyInput.value).toBe("");
    expect(dialog).not.toHaveTextContent("sk-settings-secret");
  });

  it("shows exact provider-owned login commands and rechecks the runtime", async () => {
    const checkBackendConnection = vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "failed" as const,
      message: "Sign in through the provider CLI."
    }));
    const codex: BackendProvider = {
      id: "codex",
      backendType: "codex-app-server",
      label: "Codex",
      description: "ChatGPT subscription",
      authState: "sign-in-required",
      capabilities: [],
      models: []
    };
    renderProviders(
      stubRuntime({
        backendProviders: [codex],
        checkBackendConnection
      })
    );

    fireEvent.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    fireEvent.click(within(dialog).getByRole("button", { name: /ChatGPT subscription Use/ }));
    expect(dialog).toHaveTextContent("codex login");
    fireEvent.click(within(dialog).getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(checkBackendConnection).toHaveBeenCalledWith("codex"));
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

  it("renders privacy settings controls and lists active connectors", async () => {
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

    expect(screen.getByRole("heading", { name: "Privacy & Permissions" })).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    expect(screen.getByText("Active: user@example.com")).toBeTruthy();
    expect(screen.getByLabelText("Toggle personal memory")).toBeTruthy();
    expect(
      await screen.findByText("Live mobile approvals are not available outside the desktop runtime.")
    ).toBeTruthy();
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

  it("keeps local restore explicit and truthful outside the desktop runtime", async () => {
    renderPrivacy(stubRuntime());

    const portablePath = screen.getByLabelText("New workspace-copy file");
    const portableExport = screen.getByRole("button", { name: "Export workspace copy" });
    expect(portableExport).toBeDisabled();
    fireEvent.change(portablePath, { target: { value: "C:\\Backups\\workspace.json" } });
    expect(portableExport).toBeEnabled();
    await act(async () => {
      fireEvent.click(portableExport);
    });
    expect(
      await screen.findByText("Portable workspace export is available only in the Fable desktop app.")
    ).toBeTruthy();

    const portableImportPath = screen.getByLabelText("Import workspace-copy file");
    const portableConfirmation = screen.getByLabelText(/Type import workspace copy to confirm/i);
    const portableImport = screen.getByRole("button", { name: "Import workspace copy" });
    expect(portableImport).toBeDisabled();
    fireEvent.change(portableImportPath, { target: { value: "C:\\Backups\\workspace.json" } });
    fireEvent.change(portableConfirmation, { target: { value: "import workspace copy" } });
    expect(portableImport).toBeEnabled();
    await act(async () => {
      fireEvent.click(portableImport);
    });
    expect(
      await screen.findByText("Portable workspace import is available only in the Fable desktop app.")
    ).toBeTruthy();

    const backupPath = screen.getByLabelText("New backup file");
    const restorePath = screen.getByLabelText("Restore from backup");
    const confirmation = screen.getByLabelText(/Type restore local data to confirm/i);
    const restore = screen.getByRole("button", { name: "Verify and prepare restore" });
    expect(restore).toBeDisabled();

    fireEvent.change(restorePath, { target: { value: "C:\\Backups\\fable.db" } });
    fireEvent.change(confirmation, { target: { value: "restore local data" } });
    expect(restore).toBeEnabled();
    await act(async () => {
      fireEvent.click(restore);
    });
    expect(await screen.findByText("Local restore is available only in the Fable desktop app.")).toBeTruthy();

    fireEvent.change(backupPath, { target: { value: "C:\\Backups\\new-fable.db" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create verified backup" }));
    });
    expect(await screen.findByText("Encrypted recovery backups are available only in the Fable desktop app.")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run local health check" }));
    });
    expect(await screen.findByText("Local health checks are available only in the Fable desktop app.")).toBeTruthy();
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
    const result = render(
      <SettingsPage
        runtime={runtime}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="history"
        workspaceName="Fable"
      />
    );
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    return result;
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
