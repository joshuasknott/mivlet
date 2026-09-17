import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceStatus, IdentityStatus } from "@mivlet/protocol";
import type { ShellRuntime } from "../hooks/useShellRuntime";

const runtimeState = vi.hoisted(() => ({
  current: {} as ShellRuntime,
}));

vi.mock("../hooks/useShellRuntime", () => ({
  useShellRuntime: () => runtimeState.current,
}));

vi.mock("../runtime/adapters/select", () => ({
  hasNativeRuntimeAdapter: () => false,
}));

vi.mock("./ActiveWorkspace", () => ({
  ActiveWorkspace: ({ theme }: { theme: string }) => (
    <div data-testid="active-workspace" data-theme={theme}>
      active
    </div>
  ),
}));

vi.mock("./workspace-lazy", () => ({
  OnboardingPage: () => <div data-testid="onboarding">onboarding</div>,
}));

import { TeammateWorkspace } from "./TeammateWorkspace";

const identity: IdentityStatus = {
  enabled: false,
  state: "disabled",
  message: "",
  scopes: [],
};

function runtime(patch: Partial<ShellRuntime> = {}): ShellRuntime {
  const account: AccountWorkspaceStatus = {
    configured: true,
    state: "ready",
    message: "Open your workspace",
    accountBound: true,
    workspaces: [],
    activeWorkspace: {
      localWorkspaceId: "ws",
      name: "Local workspace",
      source: "local",
    },
    devices: [],
  };
  return {
    accountWorkspacePending: false,
    runtimeSnapshotReady: true,
    runtimeSnapshotError: null,
    onboardingRequired: false,
    accountWorkspaceStatus: account,
    identityStatus: identity,
    identityPending: false,
    connectedAgentBackends: ["codex"],
    signInIdentity: vi.fn(),
    reconcileAccountWorkspace: vi.fn(),
    ...patch,
  } as ShellRuntime;
}

describe("TeammateWorkspace composition", () => {
  beforeEach(() => {
    runtimeState.current = runtime();
    delete document.documentElement.dataset.theme;
  });

  it("keeps DesktopShell's public entry as the account owner", () => {
    runtimeState.current = runtime({ accountWorkspacePending: true });
    render(<TeammateWorkspace />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening your workspace…",
    );
  });

  it("routes unbound or onboarding accounts to the lazy onboarding island", () => {
    runtimeState.current = runtime({
      accountWorkspaceStatus: {
        ...runtime().accountWorkspaceStatus,
        accountBound: false,
        state: "signed-out",
      },
    });
    render(<TeammateWorkspace />);
    expect(screen.getByTestId("onboarding")).toHaveTextContent("onboarding");
  });

  it("composes ActiveWorkspace for a ready local workspace and publishes theme", () => {
    render(<TeammateWorkspace />);
    expect(screen.getByTestId("active-workspace")).toHaveAttribute(
      "data-theme",
      "light",
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
