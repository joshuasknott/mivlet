import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspaceStatus, BackendProvider } from "@fable/protocol";
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
];

const localWorkspace: AccountWorkspaceStatus = {
  configured: false,
  state: "ready",
  message: "Local workspace ready.",
  accountBound: true,
  workspaces: [],
  activeWorkspace: {
    localWorkspaceId: "default",
    name: "On this PC",
    source: "local",
  },
  activeContextOwner: { internalUserId: "local-device" },
  devices: [],
};

function renderOnboarding(
  overrides: Partial<ComponentProps<typeof OnboardingPage>> = {},
) {
  return render(
    <OnboardingPage
      providers={providers}
      connectedBackendIds={[]}
      status={null}
      accountWorkspaceStatus={localWorkspace}
      accountWorkspacePending={false}
      onStartBrowserLogin={vi.fn(async (providerId) => ({
        providerId,
        outcome: "ready" as const,
      }))}
      initialTeammateName="Chief of Staff"
      initialTeammatePurpose="Coordinate my work."
      onConfigureTeammate={vi.fn()}
      onComplete={vi.fn()}
      {...overrides}
    />,
  );
}

async function startSetup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Set up Fable" }));
}

describe("OnboardingPage local-first journey", () => {
  it("moves directly from the local welcome to required provider setup", async () => {
    const user = userEvent.setup();
    renderOnboarding();

    expect(
      screen.getByRole("heading", { name: "Meet your teammates on this PC" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await startSetup(user);

    expect(
      screen.getByRole("heading", { name: "Add a model provider" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Fable account/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue without a provider" }),
    ).not.toBeInTheDocument();
  });

  it("offers supported subscription and API-key provider paths", async () => {
    const user = userEvent.setup();
    renderOnboarding();
    await startSetup(user);

    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();
  });

  it("starts the official ChatGPT browser login from onboarding", async () => {
    const user = userEvent.setup();
    const onStartBrowserLogin = vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const,
      message: "ChatGPT connected.",
    }));
    renderOnboarding({ onStartBrowserLogin });

    await startSetup(user);
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /^ChatGPT subscription/i }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Continue in browser" }),
    );
    expect(onStartBrowserLogin).toHaveBeenCalledWith("codex");
  });

  it("saves the first teammate before entering Fable", async () => {
    const user = userEvent.setup();
    const onConfigureTeammate = vi.fn();
    const onComplete = vi.fn();
    renderOnboarding({
      connectedBackendIds: ["codex"],
      onConfigureTeammate,
      onComplete,
    });

    await startSetup(user);
    expect(
      screen.getByRole("heading", { name: "Create your first teammate" }),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Teammate name"));
    await user.type(screen.getByLabelText("Teammate name"), "Research partner");
    await user.clear(screen.getByLabelText("What should they help with?"));
    await user.type(
      screen.getByLabelText("What should they help with?"),
      "Research and explain decisions.",
    );
    await user.click(screen.getByRole("button", { name: "Enter Fable" }));

    expect(onConfigureTeammate).toHaveBeenCalledWith({
      name: "Research partner",
      purpose: "Research and explain decisions.",
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
