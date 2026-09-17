import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { listBackendProviders } from "@mivlet/connectors";
import { ProviderOnboardingGate } from "./ProviderOnboardingPage";
import type { ComponentProps } from "react";

function runtime() {
  return {
    backendProviders: listBackendProviders(),
    connectedBackendIds: [],
    connectedAgentBackends: [],
    connectBackendWithVerify: vi.fn(async () => ({
      providerId: "openai",
      outcome: "auth-failed" as const,
      message: "Key rejected",
    })),
    checkBackendConnection: vi.fn(),
    startBackendBrowserLogin: vi.fn(async () => ({
      providerId: "codex",
      outcome: "failed" as const,
      message: "Sign-in cancelled",
    })),
    refreshModels: vi.fn(),
    signOutIdentity: vi.fn(async () => {}),
  } as unknown as ComponentProps<typeof ProviderOnboardingGate>["runtime"];
}
describe("required provider onboarding", () => {
  it("shows nine icon choices, expands providers, and does not mount chat until runtime has a usable connection", async () => {
    const user = userEvent.setup();
    const setup = runtime();
    const chat = vi.fn(() => <p>Conversation workspace</p>);
    const Chat = chat;
    const { container, rerender } = render(
      <ProviderOnboardingGate runtime={setup}>
        <Chat />
      </ProviderOnboardingGate>,
    );
    expect(chat).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".provider-catalogue-item")).toHaveLength(
      9,
    );
    expect(screen.queryByRole("button", { name: /skip|continue/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More providers" }));
    expect(
      container.querySelectorAll(".provider-catalogue-item").length,
    ).toBeGreaterThan(9);
    await user.type(screen.getByRole("searchbox"), "OpenAI");
    await user.click(screen.getByRole("button", { name: "ChatGPT" }));
    expect(screen.getByText("API usage is billed separately.")).toHaveClass(
      "provider-onboarding-billing",
    );
    await user.click(screen.getByRole("button", { name: "Use an API key" }));
    await user.type(screen.getByLabelText("OpenAI API key"), "test-key");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Key rejected/)).toBeInTheDocument();
    expect(chat).not.toHaveBeenCalled();
    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
    rerender(
      <ProviderOnboardingGate
        runtime={{
          ...setup,
          connectedAgentBackends: [setup.backendProviders[0]!],
        }}
      >
        <Chat />
      </ProviderOnboardingGate>,
    );
    expect(screen.getByText("Conversation workspace")).toBeInTheDocument();
    expect(screen.queryByRole("main", { name: "Connect your AI" })).toBeNull();
  });
  it("starts browser sign-in directly and stays in setup when it fails", async () => {
    const user = userEvent.setup();
    const setup = runtime();
    setup.backendProviders = setup.backendProviders.map((provider) =>
      provider.id === "codex"
        ? { ...provider, authState: "sign-in-required" }
        : provider,
    );
    render(
      <ProviderOnboardingGate runtime={setup}>
        <p>Conversation workspace</p>
      </ProviderOnboardingGate>,
    );
    await user.click(screen.getByRole("button", { name: "ChatGPT" }));
    await user.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );
    expect(setup.startBackendBrowserLogin).toHaveBeenCalledWith("codex");
    expect(await screen.findByText(/Sign-in cancelled/)).toBeInTheDocument();
    expect(screen.queryByText("Conversation workspace")).toBeNull();
  });
});
