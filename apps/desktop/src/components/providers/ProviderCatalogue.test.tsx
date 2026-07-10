import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import {
  buildProviderFamilies,
  encodeCustomProviderSecret,
  ProviderCatalogue
} from "./ProviderCatalogue";

function provider(
  id: string,
  label: string,
  backendType: BackendProvider["backendType"] = "native-api",
  authState: BackendProvider["authState"] = "needs-auth"
): BackendProvider {
  return {
    id,
    label,
    backendType,
    authState,
    description: `${label} models`,
    capabilities: [],
    models: []
  };
}

const catalogueProviders: BackendProvider[] = [
  provider("codex", "Codex", "codex-app-server", "sign-in-required"),
  provider("openai", "OpenAI"),
  provider("anthropic", "Anthropic"),
  provider("gemini", "Gemini"),
  provider("copilot", "GitHub Copilot", "acp", "sign-in-required"),
  provider("grok", "Grok", "acp", "install-required"),
  provider("xai", "xAI"),
  provider("openrouter", "OpenRouter"),
  provider("ollama", "Ollama", "local-loopback", "unavailable"),
  provider("z-ai", "Z.AI"),
  provider("deepseek", "DeepSeek"),
  provider("minimax", "MiniMax"),
  provider("alibaba", "Alibaba Cloud"),
  provider("moonshot", "Moonshot AI"),
  provider("kimi", "Kimi CLI", "acp", "install-required"),
  provider("mistral", "Mistral AI"),
  provider("mistral-vibe", "Mistral Vibe", "acp", "install-required"),
  provider("cursor", "Cursor", "acp", "install-required"),
  provider("fireworks", "Fireworks AI")
];

function renderCatalogue(providers = catalogueProviders) {
  const onConnect = vi.fn(async (providerId: string) => ({
    providerId,
    outcome: "ready" as const
  }));
  const onCheckConnection = vi.fn(async () => {});
  const result = render(
    <ProviderCatalogue
      providers={providers}
      connectedBackendIds={[]}
      onConnect={onConnect}
      onCheckConnection={onCheckConnection}
    />
  );
  return { ...result, onConnect, onCheckConnection };
}

describe("provider families", () => {
  it("groups Codex with OpenAI and Grok with xAI while retaining unknown backends", () => {
    const families = buildProviderFamilies(catalogueProviders);
    const openai = families.find((family) => family.id === "openai");
    const xai = families.find((family) => family.id === "xai");

    expect(openai?.providers.map((entry) => entry.id)).toEqual(["codex", "openai"]);
    expect(openai?.methods.map((method) => method.kind)).toEqual([
      "oauth-browser",
      "oauth-device",
      "api-key"
    ]);
    expect(openai?.methods.map((method) => method.command)).toEqual([
      "codex login",
      "codex login --device-auth",
      undefined
    ]);
    expect(xai?.providers.map((entry) => entry.id)).toEqual(["grok", "xai"]);
    expect(xai?.methods.map((method) => method.command)).toEqual([
      "grok login",
      "grok login --device-auth",
      undefined
    ]);
    expect(families.find((family) => family.id === "copilot")?.methods[0].command).toBe(
      "copilot login"
    );
    expect(families.find((family) => family.id === "cursor")?.methods[0].command).toBe(
      "agent login"
    );
    expect(families.find((family) => family.id === "zai")?.providers).toHaveLength(1);
    expect(families.find((family) => family.id === "minimax")?.providers).toHaveLength(1);
    expect(families.find((family) => family.id === "alibaba")?.providers).toHaveLength(1);
    expect(families.find((family) => family.id === "kimi")?.providers).toHaveLength(2);
    expect(families.find((family) => family.id === "mistral")?.providers).toHaveLength(2);
    expect(families.some((family) => family.id === "deepseek")).toBe(true);
    expect(families.some((family) => family.id === "fireworks")).toBe(true);
  });

  it("encodes custom endpoint details into one structured boundary secret", () => {
    expect(
      JSON.parse(
        encodeCustomProviderSecret("https://models.example/v1/", "secret", "example-chat")
      )
    ).toEqual({
      version: 1,
      kind: "openai-compatible",
      baseUrl: "https://models.example/v1",
      modelId: "example-chat",
      apiKey: "secret"
    });
  });
});

describe("ProviderCatalogue", () => {
  it("shows the eight featured families first", () => {
    const { container } = renderCatalogue();
    const visible = Array.from(
      container.querySelectorAll('.provider-catalogue__grid [data-provider-family-id]')
    ).map((entry) => entry.getAttribute("data-provider-family-id"));

    expect(visible).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "copilot",
      "xai",
      "deepseek",
      "ollama",
      "zai"
    ]);
    expect(container.querySelector('[data-provider-family-id="cursor"]')).toBeNull();
    expect(screen.queryByText("API keys")).toBeNull();
    expect(screen.queryByText("Subscriptions")).toBeNull();
  });

  it("replaces featured providers with an alphabetical searchable list", async () => {
    const user = userEvent.setup();
    const { container } = renderCatalogue();
    await user.click(screen.getByRole("button", { name: "Show all providers" }));

    const labels = Array.from(
      container.querySelectorAll('.provider-catalogue__list .provider-catalogue-item__text strong')
    ).map((entry) => entry.textContent);
    expect(labels).toEqual([...labels].sort((a, b) => (a ?? "").localeCompare(b ?? "")));
    expect(labels).toContain("Cursor");
    expect(labels).toContain("Mistral AI");

    const search = screen.getByRole("searchbox", { name: "Search providers" });
    await user.type(search, "grok");
    expect(container.querySelectorAll('.provider-catalogue__list [data-provider-family-id]')).toHaveLength(1);
    expect(container.querySelector('[data-provider-family-id="xai"]')).toBeInTheDocument();
  });

  it("lists every OpenAI connection method before showing method detail", async () => {
    const user = userEvent.setup();
    renderCatalogue();
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));

    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT subscription")).toBeInTheDocument();
    expect(within(dialog).getByText("ChatGPT subscription with a device code")).toBeInTheDocument();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /OpenAI API key/ }));
    expect(within(dialog).getByRole("button", { name: "Back to connection methods" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("API key for openai / chatgpt")).toBeInTheDocument();
  });

  it("hands an API key directly to verification and clears the uncontrolled field", async () => {
    const user = userEvent.setup();
    const { onConnect } = renderCatalogue();
    await user.click(screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }));
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(within(dialog).getByRole("button", { name: /OpenAI API key/ }));
    const input = within(dialog).getByLabelText("API key for openai / chatgpt") as HTMLInputElement;
    await user.type(input, "sk-test-secret");
    await user.click(within(dialog).getByRole("button", { name: "Add key & connect" }));

    expect(onConnect).toHaveBeenCalledWith("openai", "sk-test-secret");
    expect(input.value).toBe("");
    expect(dialog).not.toHaveTextContent("sk-test-secret");
  });

  it("checks the local Ollama runtime without creating a credential", async () => {
    const user = userEvent.setup();
    const { onConnect, onCheckConnection } = renderCatalogue();
    await user.click(screen.getByRole("button", { name: /Ollama, / }));
    const dialog = screen.getByRole("dialog", { name: "Ollama" });
    await user.click(within(dialog).getByRole("button", { name: /Ollama on this device/ }));
    await user.click(within(dialog).getByRole("button", { name: "Check local Ollama" }));
    expect(onCheckConnection).toHaveBeenCalledWith("ollama");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps a chat-only custom endpoint runnable with an explicit model ID", async () => {
    const user = userEvent.setup();
    const { onConnect } = renderCatalogue([provider("custom", "Custom provider")]);
    await user.click(screen.getByRole("button", { name: /Custom provider, / }));
    const dialog = screen.getByRole("dialog", { name: "Custom provider" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI-compatible endpoint/ })
    );
    await user.type(
      within(dialog).getByLabelText("Custom provider base URL"),
      "https://models.example/v1"
    );
    await user.type(within(dialog).getByLabelText("Custom provider model ID"), "example-chat");
    await user.type(within(dialog).getByLabelText("API key for custom provider"), "secret");
    await user.click(within(dialog).getByRole("button", { name: "Connect endpoint" }));

    expect(onConnect).toHaveBeenCalledWith(
      "custom",
      JSON.stringify({
        version: 1,
        kind: "openai-compatible",
        baseUrl: "https://models.example/v1",
        modelId: "example-chat",
        apiKey: "secret"
      })
    );
  });

  it("labels stored direct credentials as configured rather than verified", async () => {
    const user = userEvent.setup();
    renderCatalogue([provider("deepseek", "DeepSeek", "native-api", "connected")]);

    const tile = screen.getByRole("button", { name: "DeepSeek, Configured" });
    await user.click(tile);
    const dialog = screen.getByRole("dialog", { name: "DeepSeek" });
    await user.click(within(dialog).getByRole("button", { name: /DeepSeek API key/ }));

    expect(
      within(dialog).getByText(
        "This connection is configured. A live model request is the final check."
      )
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("This connection is ready.")).toBeNull();
  });

  it("does not offer a fake Fable disconnect for provider-owned CLI sessions", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCatalogue
        providers={[provider("copilot", "GitHub Copilot", "acp", "connected")]}
        connectedBackendIds={["copilot"]}
        onConnect={async (providerId) => ({ providerId, outcome: "ready" })}
        onDisconnect={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /GitHub Copilot, Connected/ }));
    const dialog = screen.getByRole("dialog", { name: "GitHub Copilot" });
    await user.click(within(dialog).getByRole("button", { name: /GitHub account/ }));

    expect(within(dialog).getByText("This connection is ready.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("closes on Escape and returns focus to the provider tile", async () => {
    const user = userEvent.setup();
    renderCatalogue();
    const tile = screen.getByRole("button", { name: /Anthropic, / });
    await user.click(tile);
    expect(screen.getByRole("dialog", { name: "Anthropic" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tile).toHaveFocus();
  });
});
