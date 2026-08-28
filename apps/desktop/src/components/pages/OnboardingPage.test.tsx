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
const localWorkspace: AccountWorkspaceStatus = {
  ...readyWorkspace,
  configured: false,
  message: "Local workspace ready.",
  activeWorkspace: { localWorkspaceId: "default", name: "On this PC", source: "local" },
  activeContextOwner: { internalUserId: "local-device" }
};
const localIdentity: IdentityStatus = {
  enabled: false,
  state: "disabled",
  message: "Cloud account setup is not configured.",
  scopes: []
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
      onStartBrowserLogin={vi.fn(async (providerId) => ({ providerId, outcome: "ready" as const }))}
      initialTeammateName="Chief of Staff"
      initialTeammatePurpose="Coordinate my work."
      onConfigureTeammate={vi.fn()}
      onComplete={vi.fn()}
      {...overrides}
    />
  );
}

async function startSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Set up Fable" }));
}

describe("OnboardingPage complete first-run journey", () => {
  it("starts with a welcome, then uses system-browser account sign-in without password or skip controls", async () => {
    const onSignIn = vi.fn();
    const user = userEvent.setup();
    renderOnboarding({ onSignIn });

    expect(screen.getByRole("heading", { name: "Meet your teammates on this PC" })).toBeInTheDocument();
    await startSetup(user);
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

    await startSetup(user);
    await user.click(screen.getByRole("button", { name: "Recover account" }));
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("shows an identity failure instead of masking it with stale workspace status", async () => {
    const user = userEvent.setup();
    renderOnboarding({
      identityStatus: { ...signedOut, state: "error", message: "Fable could not store cloud identity credentials." },
      accountWorkspaceStatus: { ...readyWorkspace, state: "signed-out", accountBound: false, message: "Sign in to open your workspace." }
    });

    await startSetup(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Fable could not store cloud identity credentials.");
  });

  it("uses the provider catalogue only after a ready account", async () => {
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

    await startSetup(user);
    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();
  });

  it("keeps an already bound workspace usable when both account checks are offline", async () => {
    const user = userEvent.setup();
    renderOnboarding({
      identityStatus: { ...signedOut, state: "offline", message: "You’re offline." },
      accountWorkspaceStatus: { ...readyWorkspace, state: "offline", message: "You’re offline. Local work is still available." }
    });

    await startSetup(user);
    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
  });

  it("keeps an unbound offline account on the account step", async () => {
    const user = userEvent.setup();
    renderOnboarding({
      identityStatus: { ...signedOut, state: "offline", message: "You’re offline." },
      accountWorkspaceStatus: { ...readyWorkspace, state: "offline", accountBound: false, message: "Connect to open your workspace." }
    });

    await startSetup(user);
    expect(screen.getByRole("heading", { name: "Start with your Fable account" })).toBeInTheDocument();
  });

  it("opens an unconfigured native install as a local workspace but still requires a provider", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: localIdentity, accountWorkspaceStatus: localWorkspace });

    await startSetup(user);
    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue without a provider" })).not.toBeInTheDocument();
  });

  it("starts the supported ChatGPT browser login from onboarding", async () => {
    const user = userEvent.setup();
    const onStartBrowserLogin = vi.fn(async (providerId: string) => ({ providerId, outcome: "ready" as const, message: "ChatGPT connected." }));
    renderOnboarding({ identityStatus: localIdentity, accountWorkspaceStatus: localWorkspace, onStartBrowserLogin });

    await startSetup(user);
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(within(dialog).getByRole("button", { name: /^ChatGPT subscription/i }));
    await user.click(within(dialog).getByRole("button", { name: "Continue in browser" }));
    expect(onStartBrowserLogin).toHaveBeenCalledWith("codex");
  });

  it("saves the first teammate before entering Fable", async () => {
    const user = userEvent.setup();
    const onConfigureTeammate = vi.fn();
    const onComplete = vi.fn();
    renderOnboarding({
      connectedBackendIds: ["codex"],
      identityStatus: localIdentity,
      accountWorkspaceStatus: localWorkspace,
      onConfigureTeammate,
      onComplete
    });

    await startSetup(user);
    expect(screen.getByRole("heading", { name: "Create your first teammate" })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Teammate name"));
    await user.type(screen.getByLabelText("Teammate name"), "Research partner");
    await user.clear(screen.getByLabelText("What should they help with?"));
    await user.type(screen.getByLabelText("What should they help with?"), "Research and explain decisions.");
    await user.click(screen.getByRole("button", { name: "Enter Fable" }));

    expect(onConfigureTeammate).toHaveBeenCalledWith({ name: "Research partner", purpose: "Research and explain decisions." });
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
