import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import type { ShellRuntime } from "../../hooks/useShellRuntime";
import { SettingsPage } from "./SettingsPage";

function stubRuntime(overrides: Partial<ShellRuntime> = {}): ShellRuntime {
  return {
    memoryDisabled: false,
    toggleMemoryDisabled: vi.fn(),
    exportMemory: vi.fn().mockResolvedValue(undefined),
    voiceEnabled: false,
    setVoiceEnabled: vi.fn(),
    connectorManifests: [],
    connectorAccounts: {},
    useConnector: vi.fn(),
    connectConnector: vi.fn().mockResolvedValue(undefined),
    disconnectConnector: vi.fn().mockResolvedValue(undefined),
    refreshConnector: vi.fn().mockResolvedValue(undefined),
    loadConnectorAccounts: vi.fn().mockResolvedValue(undefined),
    switchConnectorAccount: vi.fn().mockResolvedValue(undefined),
    prepareConnectorAction: vi.fn().mockResolvedValue(undefined),
    backendProviders: [],
    connectedBackendIds: [],
    connectBackendWithVerify: vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const
    })),
    checkBackendConnection: vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const
    })),
    startBackendBrowserLogin: vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const
    })),
    disconnectBackend: vi.fn().mockResolvedValue(undefined),
    refreshModels: vi.fn().mockResolvedValue(undefined),
    identityStatus: {
      enabled: false,
      state: "disabled",
      message: "Account features are not configured.",
      scopes: []
    },
    identityPending: false,
    accountWorkspaceStatus: {
      configured: false,
      state: "disabled",
      message: "Account features are not configured.",
      accountBound: false,
      workspaces: [],
      activeWorkspace: {
        localWorkspaceId: "local-default",
        name: "Local workspace",
        source: "local"
      },
      devices: []
    },
    accountWorkspacePending: false,
    signInIdentity: vi.fn().mockResolvedValue(undefined),
    recoverIdentity: vi.fn().mockResolvedValue(undefined),
    refreshIdentity: vi.fn().mockResolvedValue(undefined),
    signOutIdentity: vi.fn().mockResolvedValue(undefined),
    permissionLabel: "Ask Me",
    selectPermissionLabel: vi.fn(),
    customApprovalSettings: {
      allowSmallLocalEdits: false,
      allowPowerfulCommands: false
    },
    updateCustomApprovalSetting: vi.fn(),
    ...overrides
  } as unknown as ShellRuntime;
}

function renderTab(activeTab: React.ComponentProps<typeof SettingsPage>["activeTab"], runtime = stubRuntime()) {
  return render(
    <SettingsPage
      runtime={runtime}
      theme="dark"
      onThemeChange={() => {}}
      activeTab={activeTab}
      workspaceName="Joshua's workspace"
    />
  );
}

describe("SettingsPage", () => {
  it("keeps the unconfigured product local and does not expose account administration", () => {
    const view = renderTab("general");

    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Joshua's workspace")).toBeInTheDocument();
    expect(screen.getByText(/remain available without a Fable account/i)).toBeInTheDocument();
    expect(screen.queryByText("Optional Fable account")).not.toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/member|invitation|run history/i);
  });

  it("shows optional account controls only when the account boundary is configured", async () => {
    const signIn = vi.fn().mockResolvedValue(undefined);
    renderTab(
      "general",
      stubRuntime({
        identityStatus: {
          enabled: true,
          state: "signed-out",
          message: "Sign in when hosted features are needed.",
          scopes: []
        },
        accountWorkspaceStatus: {
          configured: true,
          state: "signed-out",
          message: "Optional account is signed out.",
          accountBound: false,
          workspaces: [],
          activeWorkspace: {
            localWorkspaceId: "local-default",
            name: "Local workspace",
            source: "local"
          },
          devices: []
        },
        signInIdentity: signIn
      })
    );

    expect(screen.getByText("Optional Fable account")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Sign-in opened in your browser.")).toBeInTheDocument();
  });

  it("renders the provider catalogue as a first-class settings area", () => {
    const provider: BackendProvider = {
      id: "openai",
      backendType: "native-api",
      label: "OpenAI",
      description: "OpenAI API",
      authState: "needs-auth",
      capabilities: [],
      models: []
    };
    renderTab("providers", stubRuntime({ backendProviders: [provider] }));

    expect(screen.getByRole("heading", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByText(/connect at least one model provider/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OpenAI \/ ChatGPT/ })).toBeInTheDocument();
    expect(screen.getByText(/credentials stay outside the interface/i)).toBeInTheDocument();
  });

  it("gives plugins their own connection directory", () => {
    renderTab("connections");

    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Installed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All connections" })).toBeInTheDocument();
    expect(screen.getByText("No connections installed yet.")).toBeInTheDocument();
  });

  it("keeps approvals, memory, and explicit local data controls together", async () => {
    const view = renderTab("privacy");

    expect(screen.getByRole("heading", { name: "Privacy & data" })).toBeInTheDocument();
    expect(screen.getByText("Personal memory")).toBeInTheDocument();
    expect(screen.getByText("Local data recovery")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ask Me/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Delete local data" })).toBeDisabled();
    expect(view.container.textContent).not.toMatch(/mission|routine|schedule|workflow|run history/i);
    fireEvent.click(screen.getByRole("button", { name: "Check local health" }));
    await screen.findByText(/local health checks are available in the installed desktop app/i);
  });
});
