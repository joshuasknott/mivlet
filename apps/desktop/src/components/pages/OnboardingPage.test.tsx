import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import { OnboardingPage } from "./OnboardingPage";

const providers: BackendProvider[] = [
  {
    id: "codex",
    backendType: "codex-app-server",
    label: "Codex",
    description: "ChatGPT subscription",
    authState: "sign-in-required",
    capabilities: [],
    models: []
  },
  {
    id: "openai",
    backendType: "native-api",
    label: "OpenAI",
    description: "OpenAI API",
    authState: "needs-auth",
    capabilities: [],
    models: []
  },
  {
    id: "deepseek",
    backendType: "native-api",
    label: "DeepSeek",
    description: "DeepSeek API",
    authState: "needs-auth",
    capabilities: [],
    models: []
  }
];

describe("OnboardingPage providers", () => {
  it("uses the same provider-first catalogue and method modal as Settings", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingPage
        providers={providers}
        connectedBackendIds={[]}
        status={null}
        onConnectWithVerify={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Add a model provider" })).toBeInTheDocument();
    expect(screen.queryByText("Subscriptions")).toBeNull();
    expect(screen.queryByText("API keys")).toBeNull();

    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();
  });
});
