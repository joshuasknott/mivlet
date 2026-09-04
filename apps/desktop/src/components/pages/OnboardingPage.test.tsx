import { listSupportedConnectors } from "@fable/connectors";
import { listBackendProviders } from "@fable/connectors/backends/registry";
import type { BackendProvider, IdentityStatus } from "@fable/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage";

const providers: BackendProvider[] = [
  {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "ChatGPT subscription",
    authState: "sign-in-required",
    capabilities: [],
    models: [],
  },
  {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "needs-auth",
    capabilities: [],
    models: [],
  },
  {
    id: "anthropic",
    backendType: "native-api",
    label: "Anthropic",
    description: "Anthropic API",
    authState: "needs-auth",
    capabilities: [],
    models: [],
  },
  {
    id: "antigravity",
    backendType: "antigravity-acp",
    label: "Google Antigravity",
    description: "Gemini through Antigravity ACP",
    authState: "install-required",
    capabilities: [],
    models: [],
  },
  {
    id: "xai",
    backendType: "native-api",
    label: "xAI",
    description: "xAI API",
    authState: "needs-auth",
    capabilities: [],
    models: [],
  },
  {
    id: "custom",
    backendType: "native-api",
    label: "Custom provider",
    description: "OpenAI-compatible API",
    authState: "needs-auth",
    capabilities: [],
    models: [],
  },
];

const signedOut: IdentityStatus = {
  enabled: true,
  state: "signed-out",
  message: "Sign in to continue.",
  scopes: [],
};

const signedIn: IdentityStatus = {
  enabled: true,
  state: "signed-in",
  message: "Signed in.",
  scopes: ["account:read"],
  authentication: {
    provider: "clerk",
    normalizedIssuer: "https://accounts.fable.test",
    subject: "person-1",
    authenticationEventRef: "event-1",
    sessionRef: "session-1",
    authenticatedAt: "2026-08-31T12:00:00.000Z",
    expiresAt: "2026-08-31T13:00:00.000Z",
    verifiedAttributes: [],
  },
};

function renderOnboarding(
  overrides: Partial<ComponentProps<typeof OnboardingPage>> = {},
) {
  return render(
    <OnboardingPage
      providers={providers}
      connectedBackendIds={[]}
      status={null}
      identityStatus={signedOut}
      identityPending={false}
      onSignIn={vi.fn().mockResolvedValue(undefined)}
      onStartBrowserLogin={vi.fn(async (providerId) => ({
        providerId,
        outcome: "ready" as const,
      }))}
      onConnectWithVerify={vi.fn(async (providerId) => ({
        providerId,
        outcome: "ready" as const,
      }))}
      connectors={listSupportedConnectors().map((connector) => ({ ...connector, status: "needs-auth" }))}
      connectorStatus={null}
      onConnectConnector={vi.fn().mockResolvedValue(undefined)}
      onComplete={vi.fn()}
      {...overrides}
    />,
  );
}

describe("OnboardingPage", () => {
  it("starts with classic Google-first account entry and quiet secondary actions", () => {
    renderOnboarding();

    expect(screen.getByRole("heading", { name: "Welcome to Fable" })).toBeInTheDocument();
    expect(screen.getByText("Sign in or create an account to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toHaveClass("og-primary-button");
    expect(screen.getByRole("button", { name: "Continue with email" })).toHaveClass("og-text-button");
    expect(screen.queryByText("Already have an account?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Onboarding step 1 of 3")).toBeInTheDocument();
    expect(screen.queryByText(/Chief of Staff/i)).not.toBeInTheDocument();
  });

  it("uses the same clear account entry for email sign in and sign up", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    renderOnboarding({ onSignIn });

    await user.click(screen.getByRole("button", { name: "Continue with email" }));
    expect(onSignIn).toHaveBeenCalledWith("email");
  });

  it("opens account sign-in and advances only after identity is authenticated", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    const view = renderOnboarding({ onSignIn });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(onSignIn).toHaveBeenCalledWith("google");
    expect(screen.getByRole("heading", { name: "Welcome to Fable" })).toBeInTheDocument();

    view.rerender(
      <OnboardingPage
        providers={providers}
        connectedBackendIds={[]}
        status={null}
        identityStatus={signedIn}
        identityPending={false}
        onSignIn={onSignIn}
        onStartBrowserLogin={vi.fn()}
        onConnectWithVerify={vi.fn()}
        connectors={listSupportedConnectors()}
        connectorStatus={null}
        onConnectConnector={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Choose your provider" })).toBeInTheDocument();
  });

  it("makes subscription primary and the API key an underlined secondary path", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("button", { name: "OpenAI and ChatGPT" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Claude" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Google Antigravity" })).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Grok" })).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Custom provider" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More providers" })).toBeInTheDocument();
    expect(document.querySelector('[data-provider-brand="anthropic"]')).toBeTruthy();
    expect(document.querySelector('[data-provider-brand="antigravity"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toHaveClass("og-primary-button");
    const apiKeyPath = screen.getByRole("button", { name: "Use an OpenAI API key instead" });
    expect(apiKeyPath).toHaveClass("og-text-button");

    await user.click(apiKeyPath);
    expect(screen.getByLabelText("OpenAI / ChatGPT API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect with API key" })).toBeInTheDocument();
  });

  it("offers custom API-key setup below the four provider logos", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(await screen.findByRole("button", { name: "More providers" }));
    await user.click(screen.getByRole("button", { name: "Custom provider" }));

    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
    expect(screen.getByLabelText("API key (optional)")).toBeInTheDocument();
  });

  it("can go back from provider setup to account entry", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("heading", { name: "Choose your provider" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("heading", { name: "Welcome to Fable" })).toBeInTheDocument();
  });

  it("shows API key setup directly when a provider has no subscription path", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(await screen.findByRole("button", { name: "Claude" }));

    expect(screen.getByLabelText("Claude API key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /subscription/i })).not.toBeInTheDocument();
  });

  it("replaces teammate setup with optional live connector actions", async () => {
    const user = userEvent.setup();
    const onConnectConnector = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn();
    renderOnboarding({
      identityStatus: signedIn,
      connectedBackendIds: ["codex"],
      onConnectConnector,
      onComplete,
    });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(await screen.findByRole("button", { name: "Continue with OpenAI / ChatGPT" }));
    expect(await screen.findByRole("heading", { name: "Connect the apps you use" })).toBeInTheDocument();
    expect(screen.queryByText(/first teammate|Chief of Staff/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Choose your provider" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect the apps you use" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue with OpenAI / ChatGPT" }));

    await user.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    await waitFor(() => expect(onConnectConnector).toHaveBeenCalledWith(expect.objectContaining({ id: "google-drive" })));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("exposes every additional provider without crowding the initial choices", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn, providers: listBackendProviders() });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(screen.queryByRole("button", { name: "Cursor" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More providers" }));
    for (const name of ["Cursor", "OpenCode", "Custom provider"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Cursor" }));
    expect(screen.getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps failed account sign-in recoverable", async () => {
    const user = userEvent.setup();
    const onSignIn = vi.fn().mockRejectedValueOnce(new Error("Browser sign-in could not open.")).mockResolvedValue(undefined);
    renderOnboarding({ onSignIn });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Browser sign-in could not open.");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));
    expect(onSignIn).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects a successful result for a different provider", async () => {
    const user = userEvent.setup();
    renderOnboarding({ identityStatus: signedIn, onStartBrowserLogin: vi.fn(async () => ({ providerId: "anthropic", outcome: "ready" as const })) });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not verify this connection");
    expect(screen.getByRole("heading", { name: "Choose your provider" })).toBeInTheDocument();
  });

  it("ignores a provider result after leaving that setup screen", async () => {
    const user = userEvent.setup();
    let finish!: (result: { providerId: string; outcome: "ready" }) => void;
    const result = new Promise<{ providerId: string; outcome: "ready" }>((resolve) => { finish = resolve; });
    renderOnboarding({ identityStatus: signedIn, onStartBrowserLogin: vi.fn(() => result) });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(screen.getByRole("button", { name: "Claude" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await act(async () => finish({ providerId: "codex", outcome: "ready" }));
    expect(screen.getByRole("heading", { name: "Welcome to Fable" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect the apps you use" })).not.toBeInTheDocument();
  });

  it("reports a connector failure and keeps optional setup skippable", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    renderOnboarding({ identityStatus: signedIn, connectedBackendIds: ["codex"], onComplete, onConnectConnector: vi.fn().mockRejectedValue(new Error("Google connection could not finish.")) });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(screen.getByRole("button", { name: "Continue with OpenAI / ChatGPT" }));
    await user.click(screen.getByRole("button", { name: "Connect Google Drive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google connection could not finish.");
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("does not start authorization for an unconfigured connector", async () => {
    const user = userEvent.setup();
    const onConnectConnector = vi.fn();
    renderOnboarding({ identityStatus: signedIn, connectedBackendIds: ["codex"], connectors: listSupportedConnectors().map((connector) => ({ ...connector, status: "unconfigured" })), onConnectConnector });
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));
    await user.click(screen.getByRole("button", { name: "Continue with OpenAI / ChatGPT" }));
    const drive = screen.getByRole("button", { name: "Connect Google Drive" });
    expect(drive).toBeDisabled();
    await user.click(drive);
    expect(onConnectConnector).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  });

  it("shows local privacy information with keyboard dismissal and focus return", async () => {
    const user = userEvent.setup();
    renderOnboarding();
    const privacy = screen.getByRole("button", { name: "Privacy & data" });
    await user.click(privacy);
    const dialog = screen.getByRole("dialog", { name: "Privacy & data" });
    expect(within(dialog).getByText("Model providers")).toBeInTheDocument();
    expect(within(dialog).getByText(/Clerk handles account sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Privacy Policy" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(privacy).toHaveFocus();
  });
});
