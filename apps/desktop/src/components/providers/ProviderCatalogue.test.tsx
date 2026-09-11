import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import { listBackendProviders } from "@fable/connectors";
import {
  buildProviderFamilies,
  encodeCustomProviderSecret,
  ProviderCatalogue,
} from "./ProviderCatalogue";

function provider(
  id: string,
  label: string,
  backendType: BackendProvider["backendType"] = "native-api",
  authState: BackendProvider["authState"] = "needs-auth",
): BackendProvider {
  return {
    id,
    label,
    backendType,
    authState,
    description: `${label} models`,
    capabilities: [],
    models: [],
  };
}

const catalogueProviders: BackendProvider[] = [
  provider("codex", "Codex", "codex-app-server", "sign-in-required"),
  provider("openai", "OpenAI"),
  provider("anthropic", "Anthropic"),
  provider(
    "antigravity",
    "Google Antigravity",
    "antigravity-acp",
    "install-required",
  ),
  provider("xai", "xAI"),
  provider("custom", "Custom provider"),
];

function renderCatalogue(providers = catalogueProviders) {
  const onConnect = vi.fn(async (providerId: string) => ({
    providerId,
    outcome: "ready" as const,
  }));
  const onCheckConnection = vi.fn(async () => {});
  const onStartBrowserLogin = vi.fn(async (providerId: string) => ({
    providerId,
    outcome: "ready" as const,
    message: "ChatGPT sign-in completed in your browser.",
  }));
  const result = render(
    <ProviderCatalogue
      providers={providers}
      connectedBackendIds={[]}
      onConnect={onConnect}
      onCheckConnection={onCheckConnection}
      onStartBrowserLogin={onStartBrowserLogin}
    />,
  );
  return { ...result, onConnect, onCheckConnection, onStartBrowserLogin };
}

describe("provider families", () => {
  it("groups every built-in account driver with its advanced connection route", () => {
    const families = buildProviderFamilies(listBackendProviders());
    expect(families.map((family) => family.id).sort()).toEqual([
      "anthropic",
      "antigravity",
      "cursor",
      "custom",
      "openai",
      "opencode",
      "openrouter",
      "xai",
    ]);
    expect(
      families
        .find((family) => family.id === "anthropic")
        ?.providers.map((entry) => entry.id),
    ).toEqual(["claude", "anthropic"]);
    expect(
      families
        .find((family) => family.id === "anthropic")
        ?.methods.map((method) => method.kind),
    ).toEqual(["provider-cli", "api-key"]);
    expect(
      families
        .find((family) => family.id === "xai")
        ?.providers.map((entry) => entry.id),
    ).toEqual(["grok", "xai"]);
  });

  it("groups Codex with OpenAI while keeping xAI API-only", () => {
    const families = buildProviderFamilies(catalogueProviders);
    const openai = families.find((family) => family.id === "openai");
    const xai = families.find((family) => family.id === "xai");

    expect(openai?.providers.map((entry) => entry.id)).toEqual([
      "codex",
      "openai",
    ]);
    expect(openai?.methods.map((method) => method.kind)).toEqual([
      "oauth-browser",
      "api-key",
    ]);
    expect(xai?.providers.map((entry) => entry.id)).toEqual(["xai"]);
    expect(xai?.methods.map((method) => method.kind)).toEqual(["api-key"]);
    expect(families.map((family) => family.id).sort()).toEqual([
      "anthropic",
      "antigravity",
      "custom",
      "openai",
      "xai",
    ]);
  });

  it("encodes custom endpoint details into one structured boundary secret", () => {
    expect(
      JSON.parse(
        encodeCustomProviderSecret(
          "https://models.example/v1/",
          "secret",
          "example-chat",
        ),
      ),
    ).toEqual({
      version: 1,
      kind: "openai-compatible",
      baseUrl: "https://models.example/v1",
      modelId: "example-chat",
      apiKey: "secret",
    });
  });
});

describe("ProviderCatalogue", () => {
  it("shows only the four quiet account-first families initially", () => {
    const { container } = renderCatalogue();
    const visible = Array.from(
      container.querySelectorAll(
        ".provider-catalogue__grid [data-provider-family-id]",
      ),
    ).map((entry) => entry.getAttribute("data-provider-family-id"));

    expect(visible).toEqual(["openai", "anthropic", "antigravity", "xai"]);
    expect(
      container.querySelector('[data-provider-family-id="copilot"]'),
    ).toBeNull();
    expect(screen.queryByText("API keys")).toBeNull();
    expect(screen.queryByText("Subscriptions")).toBeNull();
  });

  it("replaces featured providers with an alphabetical searchable list", async () => {
    const user = userEvent.setup();
    const { container } = renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: "Show all providers" }),
    );

    const labels = Array.from(
      container.querySelectorAll(
        ".provider-catalogue__list .provider-catalogue-item__text strong",
      ),
    ).map((entry) => entry.textContent);
    expect(labels).toEqual(
      [...labels].sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    );
    expect(labels).toContain("Claude");
    expect(labels).toContain("Grok");

    const search = screen.getByRole("searchbox", { name: "Search providers" });
    await user.type(search, "grok");
    expect(
      container.querySelectorAll(
        ".provider-catalogue__list [data-provider-family-id]",
      ),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-provider-family-id="xai"]'),
    ).toBeInTheDocument();
  });

  it("lists every OpenAI connection method before showing method detail", async () => {
    const user = userEvent.setup();
    renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }),
    );

    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    expect(within(dialog).getByText("ChatGPT account")).toBeInTheDocument();
    expect(within(dialog).queryByText(/device code/i)).toBeNull();
    expect(within(dialog).getByText("OpenAI API key")).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    expect(
      within(dialog).getByRole("button", {
        name: "Back to connection methods",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("API key for openai / chatgpt"),
    ).toBeInTheDocument();
  });

  it("starts managed ChatGPT sign-in through Mivlet without showing a terminal command", async () => {
    const user = userEvent.setup();
    const { onStartBrowserLogin } = renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /ChatGPT account/ }),
    );

    expect(dialog).toHaveTextContent("Provider-supported browser sign-in");
    expect(dialog).not.toHaveTextContent("codex login");
    await user.click(
      within(dialog).getByRole("button", { name: "Continue in browser" }),
    );

    expect(onStartBrowserLogin).toHaveBeenCalledWith("codex");
    expect(
      await within(dialog).findByText("Connected and verified."),
    ).toBeInTheDocument();
  });

  it("does not offer browser sign-in until the Codex runtime is installed", async () => {
    const user = userEvent.setup();
    const missingCodex = {
      ...provider("codex", "Codex", "codex-app-server", "install-required"),
      installHint:
        "Install the Codex desktop app components, then reopen Mivlet.",
    };
    const { onCheckConnection, onStartBrowserLogin } = renderCatalogue([
      missingCodex,
      provider("openai", "OpenAI"),
    ]);

    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /ChatGPT account/ }),
    );

    expect(
      within(dialog).queryByRole("button", { name: "Continue in browser" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Check for Codex" }),
    );
    expect(onCheckConnection).toHaveBeenCalledWith("codex");
    expect(onStartBrowserLogin).not.toHaveBeenCalled();
  });

  it("continues with Google while Antigravity installation stays internal", async () => {
    const user = userEvent.setup();
    const { onCheckConnection, onStartBrowserLogin } = renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: /Google Antigravity, / }),
    );
    const dialog = screen.getByRole("dialog", { name: "Google Antigravity" });
    await user.click(
      within(dialog).getByRole("button", { name: /Google account/ }),
    );
    expect(within(dialog).queryByLabelText(/API key/i)).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Continue with Google" }),
    );
    expect(onStartBrowserLogin).toHaveBeenCalledWith("antigravity");
    expect(onCheckConnection).not.toHaveBeenCalled();
  });

  it("adds an API-key provider through verification and clears the uncontrolled field", async () => {
    const user = userEvent.setup();
    const { onConnect } = renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, / }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    const input = within(dialog).getByLabelText(
      "API key for openai / chatgpt",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test-secret" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Add key & connect" }),
    );

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith("openai", "sk-test-secret");
    });
    expect(input.value).toBe("");
    expect(dialog).not.toHaveTextContent("sk-test-secret");
  });

  it("offers the Grok family through its available xAI API route", async () => {
    const user = userEvent.setup();
    renderCatalogue();
    await user.click(
      screen.getByRole("button", { name: "Show all providers" }),
    );

    await user.click(screen.getByRole("button", { name: /Grok, / }));
    const dialog = screen.getByRole("dialog", { name: "Grok" });
    expect(within(dialog).getByText("xAI API key")).toBeInTheDocument();
    expect(within(dialog).queryByText("Grok account")).not.toBeInTheDocument();
  });

  it("offers setup for an installed provider-owned execution adapter", async () => {
    const user = userEvent.setup();
    const { onCheckConnection } = renderCatalogue(listBackendProviders());
    await user.click(
      screen.getByRole("button", { name: "Show all providers" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Cursor, Install required" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Cursor" });
    await user.click(
      within(dialog).getByRole("button", { name: /Cursor account/ }),
    );

    expect(dialog).toHaveTextContent("Provider-owned local sign-in");
    expect(dialog).toHaveTextContent("Install the official Cursor Agent CLI");
    await user.click(
      within(dialog).getByRole("button", { name: "Check for Cursor" }),
    );
    expect(onCheckConnection).toHaveBeenCalledWith("cursor");
  });

  it("keeps a chat-only custom endpoint runnable with an explicit model ID", async () => {
    const user = userEvent.setup();
    const { onConnect } = renderCatalogue([
      provider("custom", "Custom provider"),
    ]);
    await user.click(screen.getByRole("button", { name: /Custom provider, / }));
    const dialog = screen.getByRole("dialog", { name: "Custom provider" });
    await user.click(
      within(dialog).getByRole("button", {
        name: /OpenAI-compatible endpoint/,
      }),
    );
    await user.type(
      within(dialog).getByLabelText("Custom provider base URL"),
      "https://models.example/v1",
    );
    await user.type(
      within(dialog).getByLabelText("Custom provider model ID"),
      "example-chat",
    );
    await user.type(
      within(dialog).getByLabelText("API key for custom provider"),
      "secret",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Connect endpoint" }),
    );

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        "custom",
        JSON.stringify({
          version: 1,
          kind: "openai-compatible",
          baseUrl: "https://models.example/v1",
          modelId: "example-chat",
          apiKey: "secret",
        }),
      );
    });
  });

  it("accepts a validated custom endpoint as configured without claiming verification", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCatalogue
        providers={[provider("custom", "Custom provider")]}
        connectedBackendIds={[]}
        onConnect={async (providerId) => ({
          providerId,
          outcome: "configured",
          message: "Custom endpoint configuration saved.",
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Custom provider, / }));
    const dialog = screen.getByRole("dialog", { name: "Custom provider" });
    await user.click(
      within(dialog).getByRole("button", {
        name: /OpenAI-compatible endpoint/,
      }),
    );
    await user.type(
      within(dialog).getByLabelText("Custom provider base URL"),
      "http://127.0.0.1:17778/v1",
    );
    await user.type(
      within(dialog).getByLabelText("Custom provider model ID"),
      "fable-smoke",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Connect endpoint" }),
    );

    expect(await within(dialog).findByText("Configured")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /will check this endpoint when you send a message/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Connected and verified."),
    ).not.toBeInTheDocument();
  });

  it("labels stored direct credentials as configured rather than verified", async () => {
    const user = userEvent.setup();
    renderCatalogue([
      provider("anthropic", "Anthropic", "native-api", "connected"),
    ]);

    const tile = screen.getByRole("button", { name: "Claude, Configured" });
    await user.click(tile);
    const dialog = screen.getByRole("dialog", { name: "Claude" });
    await user.click(
      within(dialog).getByRole("button", { name: /Anthropic API key/ }),
    );

    expect(
      within(dialog).getByText(
        "This connection is configured. A live model request is the final check.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("This connection is ready.")).toBeNull();
  });

  it("checks provider health and reports a verified connection", async () => {
    const user = userEvent.setup();
    const onCheckConnection = vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const,
    }));
    render(
      <ProviderCatalogue
        providers={[provider("openai", "OpenAI", "native-api", "connected")]}
        connectedBackendIds={["openai"]}
        onConnect={async (providerId) => ({ providerId, outcome: "ready" })}
        onCheckConnection={onCheckConnection}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, Configured/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Check health" }),
    );

    expect(onCheckConnection).toHaveBeenCalledWith("openai");
    expect(
      within(dialog).getByText("Connected and verified."),
    ).toBeInTheDocument();
  });

  it("reconnects a configured provider by replacing and re-verifying its key", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn(async (providerId: string) => ({
      providerId,
      outcome: "ready" as const,
    }));
    render(
      <ProviderCatalogue
        providers={[provider("openai", "OpenAI", "native-api", "connected")]}
        connectedBackendIds={["openai"]}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, Configured/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Replace key" }),
    );
    await user.type(
      within(dialog).getByLabelText("API key for openai / chatgpt"),
      "sk-replacement",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Replace key & reconnect" }),
    );

    expect(onConnect).toHaveBeenCalledWith("openai", "sk-replacement");
    expect(
      within(dialog).getByText("Connected and verified."),
    ).toBeInTheDocument();
  });

  it("treats a revoked or expired key as disconnected after a health check", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCatalogue
        providers={[provider("openai", "OpenAI", "native-api", "connected")]}
        connectedBackendIds={["openai"]}
        onConnect={async (providerId) => ({ providerId, outcome: "ready" })}
        onCheckConnection={async (providerId) => ({
          providerId,
          outcome: "auth-failed",
        })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, Configured/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Check health" }),
    );

    expect(
      within(dialog).getByText(/rejected or has expired/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Add key & connect" }),
    ).toBeInTheDocument();
  });

  it("removes a local key only after explaining provider-side revocation", async () => {
    const user = userEvent.setup();
    const onDisconnect = vi.fn(async () => {});
    render(
      <ProviderCatalogue
        providers={[provider("openai", "OpenAI", "native-api", "connected")]}
        connectedBackendIds={["openai"]}
        onConnect={async (providerId) => ({ providerId, outcome: "ready" })}
        onDisconnect={onDisconnect}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /OpenAI \/ ChatGPT, Configured/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "OpenAI / ChatGPT" });
    await user.click(
      within(dialog).getByRole("button", { name: /OpenAI API key/ }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Remove from Mivlet" }),
    );
    expect(
      within(dialog).getByText(/does not revoke the key at the provider/i),
    ).toBeInTheDocument();
    expect(onDisconnect).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Remove key" }),
    );
    expect(onDisconnect).toHaveBeenCalledWith("openai");
    expect(
      await within(dialog).findByText(/Removed from Mivlet/i),
    ).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the provider tile", async () => {
    const user = userEvent.setup();
    renderCatalogue();
    const tile = screen.getByRole("button", { name: /Claude, / });
    await user.click(tile);
    expect(screen.getByRole("dialog", { name: "Claude" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tile).toHaveFocus();
  });
});
