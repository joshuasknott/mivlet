import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceStatus, BackendProvider, IdentityStatus } from "@fable/protocol";
import { OnboardingPage } from "./OnboardingPage";

const providers: BackendProvider[] = [
  { id: "codex", backendType: "codex-app-server", label: "Codex", description: "ChatGPT subscription", authState: "sign-in-required", capabilities: [], models: [] },
  { id: "openai", backendType: "native-api", label: "OpenAI", description: "OpenAI API", authState: "needs-auth", capabilities: [], models: [] }
];

const signedOut: IdentityStatus = { enabled: true, state: "signed-out", message: "Sign in to continue.", scopes: [] };
const readyWorkspace: AccountWorkspaceStatus = {
  configured: true, state: "ready", message: "Your workspace is ready.", accountBound: true,
  workspaces: [], activeWorkspace: { localWorkspaceId: "local-1", name: "Personal", source: "hosted" }, devices: []
};

function renderOnboarding({
  identityStatus = signedOut,
  accountWorkspaceStatus = { ...readyWorkspace, state: "signed-out", message: "Sign in to open your workspace." },
  ...overrides
}: Partial<ComponentProps<typeof OnboardingPage>> = {}) {
  return render(
    <OnboardingPage
      providers={providers}
      connectedBackendIds={[]}
      status={null}
      identityStatus={identityStatus}
      identityPending={false}
      accountWorkspaceStatus={accountWorkspaceStatus}
      accountWorkspacePending={false}
      onSignIn={vi.fn()}
      onRecover={vi.fn()}
      onRefreshAccount={vi.fn()}
      onComplete={vi.fn()}
      {...overrides}
    />
  );
}

describe("OnboardingPage account and provider journey", () => {
  it("starts with system-browser account sign-in and never renders password or skip controls", async () => {
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    renderOnboarding({ onSignIn });

    expect(screen.getByRole("heading", { name: "Start with your Fable account" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Fable" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText(/skip onboarding/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign in to Fable" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("offers account recovery for expired or revoked sessions", async () => {
    const onRecover = vi.fn();
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: { ...signedOut, state: "expired", message: "Your session has expired." }, onRecover });

    await user.click(screen.getByRole("button", { name: "Recover account" }));
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("uses the provider catalogue only after a ready account and requires a connected provider", async () => {
    const user = userEvent.setup();
    renderOnboarding({
      identityStatus: {
        ...signedOut,
        state: "signed-in",
        authentication: {
          provider: "clerk", normalizedIssuer: "https://accounts.fable.test", subject: "user-1", authenticationEventRef: "event-1", sessionRef: "session-1",
          authenticatedAt: "2026-07-10T12:00:00Z", expiresAt: "2026-07-11T12:00:00Z", verifiedAttributes: [],
          verifiedDisplayAttributes: { displayName: "Ari" }
        }
      },
      accountWorkspaceStatus: readyWorkspace
    });

    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start using Fable" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();
  });

  it("keeps an already bound workspace usable when both account checks are offline", () => {
    renderOnboarding({
      identityStatus: { ...signedOut, state: "offline", message: "You’re offline." },
      accountWorkspaceStatus: { ...readyWorkspace, state: "offline", message: "You’re offline. Local work is still available." }
    });

    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Start with your Fable account" })).toBeNull();
  });

  it("keeps an unbound offline account on the account step", () => {
    renderOnboarding({
      identityStatus: { ...signedOut, state: "offline", message: "You’re offline." },
      accountWorkspaceStatus: { ...readyWorkspace, state: "offline", accountBound: false, message: "Connect to open your workspace." }
    });

    expect(screen.getByRole("heading", { name: "Start with your Fable account" })).toBeInTheDocument();
  });
});
