import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import { SettingsPage } from "./SettingsPage";
import type { ShellRuntime } from "../../hooks/useShellRuntime";

/**
 * Focused Settings → Providers UX coverage. These exercise the *display* layer
 * that turns real provider/runtime state into honest, recoverable UI, without
 * driving the full Tauri boundary (the hook tests own the runtime path).
 *
 * Only the ShellRuntime fields ProviderAccessView reads are stubbed; the rest
 * is cast through Partial so the component sees a well-typed runtime.
 */
function stubRuntime(over: Partial<ShellRuntime> = {}): ShellRuntime {
  return { ...(over as ShellRuntime) } as ShellRuntime;
}

const nativeProvider = (over: Partial<BackendProvider> = {}): BackendProvider => ({
  id: "openai",
  backendType: "native-api",
  label: "OpenAI",
  description: "OpenAI native",
  authState: "needs-auth",
  capabilities: [],
  models: [],
  ...over
});

function renderProviders(runtime: ShellRuntime) {
  return render(
    <SettingsPage
      runtime={runtime}
      theme="dark"
      onThemeChange={() => {}}
      activeTab="providers"
      workspaceName="Fable"
    />
  );
}

/** Provider rows are keyed by data-provider-id (not data-testid). */
function providerRow(id: string): HTMLElement {
  const el = document.querySelector(`[data-provider-id="${id}"]`);
  if (!el) throw new Error(`No provider row for ${id}`);
  return el as HTMLElement;
}

describe("Settings → Providers UX states", () => {
  it("shows 'Needs API key' for a connected-missing provider (missing key)", () => {
    const provider = nativeProvider({ authState: "needs-auth" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: [],
        backendStatus: null,
        modelDiscoveryByProvider: {},
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai");
    expect(row.textContent).toMatch(/needs api key/i);
    // Not connected: no Refresh models affordance yet.
    expect(screen.queryByLabelText(/refresh models for openai/i)).toBeNull();
  });

  it("renders connected + capability-bearing with a model refresh affordance", () => {
    const provider = nativeProvider({
      authState: "connected",
      capabilities: ["streaming", "threads"],
      models: [{ id: "gpt-4o", label: "GPT-4o", available: true }]
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "success" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: refresh
      })
    );

    expect(providerRow("openai").textContent).toMatch(/connected/i);
    const refreshBtn = screen.getByLabelText(/refresh models for openai/i);
    fireEvent.click(refreshBtn);
    expect(refresh).toHaveBeenCalledWith("openai");
  });

  it("shows a refresh spinner and disables retry while discovery is loading", () => {
    const provider = nativeProvider({ authState: "connected" });
    const refresh = vi.fn();
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "loading" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: refresh
      })
    );

    const refreshBtn = screen.getByLabelText(
      /refresh models for openai/i
    ) as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
    expect(providerRow("openai").textContent).toMatch(/refreshing models/i);
  });

  it("surfaces a recoverable, non-alarming hint when discovery failed (degraded)", () => {
    const provider = nativeProvider({ authState: "connected" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "offline" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai").textContent ?? "";
    // Degraded is recoverable: the hint must reassure the key is fine and offer retry.
    expect(row).toMatch(/your key is fine/i);
    expect(row.toLowerCase()).toMatch(/refresh|retry|try again/);
    // The refresh button becomes "Retry" for a degraded provider.
    expect(screen.getByRole("button", { name: /refresh models for openai/i })).toBeTruthy();
  });

  it("does not blame the key for an empty model list (account, not auth)", () => {
    const provider = nativeProvider({ authState: "connected" });
    renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: ["openai"],
        backendStatus: null,
        modelDiscoveryByProvider: { openai: "empty" },
        connectBackendWithVerify: vi.fn(),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    const row = providerRow("openai").textContent ?? "";
    // Empty is an account/plan condition, not a key problem.
    expect(row.toLowerCase()).not.toMatch(/key (was |is )?(rejected|invalid|wrong)/);
  });

  it("distinguishes a missing key from a rejected key in the connect status", async () => {
    const provider = nativeProvider({ authState: "needs-auth" });
    const { rerender } = renderProviders(
      stubRuntime({
        backendProviders: [provider],
        connectedBackendIds: [],
        backendStatus: null,
        modelDiscoveryByProvider: {},
        connectBackendWithVerify: vi.fn(async () => ({
          providerId: "openai",
          outcome: "auth-failed" as const,
          // The Rust boundary's missing_key_message signature.
          message: "Add an openai API key to connect."
        })),
        disconnectBackend: vi.fn(),
        refreshModels: vi.fn()
      })
    );

    // Reveal the key form, enter a key, and submit. The key input is
    // uncontrolled on purpose; set the DOM value directly like a user.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const keyInput = screen.getByLabelText(/api key for openai/i) as HTMLInputElement;
    keyInput.value = "sk-test";
    fireEvent.submit(keyInput.closest("form")!);

    // Missing key: the status must read as a configuration gap, NOT a rejected
    // key — it should not say "rejected"/"invalid"/"expired".
    const status = await screen.findByRole("status");
    expect(status.textContent?.toLowerCase()).toMatch(/no api key stored|add a key/);
    expect(status.textContent?.toLowerCase()).not.toMatch(/reject|invalid|expired/);

    // Now a rejected key must read the opposite.
    rerender(
      <SettingsPage
        runtime={stubRuntime({
          backendProviders: [provider],
          connectedBackendIds: [],
          backendStatus: null,
          modelDiscoveryByProvider: {},
          connectBackendWithVerify: vi.fn(async () => ({
            providerId: "openai",
            outcome: "auth-failed" as const,
            message: "401 Unauthorized"
          })),
          disconnectBackend: vi.fn(),
          refreshModels: vi.fn()
        })}
        theme="dark"
        onThemeChange={() => {}}
        activeTab="providers"
        workspaceName="Fable"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const keyInput2 = screen.getByLabelText(/api key for openai/i) as HTMLInputElement;
    keyInput2.value = "sk-bad";
    fireEvent.submit(keyInput2.closest("form")!);
    const rejectedStatus = await screen.findByRole("status");
    expect(rejectedStatus.textContent?.toLowerCase()).toMatch(/reject|expired/);
  });
});
