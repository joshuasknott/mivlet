import { describe, expect, it } from "vitest";
import type { BackendProvider } from "@fable/protocol";
import {
  modelsForProvider,
  providerModelOptions,
  resolveProviderModelOption
} from "./provider-models";

function provider(id: string, label: string): BackendProvider {
  return {
    id,
    label,
    description: "",
    backendType: "native-api",
    authState: "connected",
    capabilities: ["streaming"],
    models: []
  };
}

describe("provider model choices", () => {
  it("always qualifies ids so later provider connections cannot reroute a selection", () => {
    const options = providerModelOptions([
      {
        provider: provider("openai", "OpenAI"),
        models: [
          { id: "gpt-5", label: "GPT-5", available: true },
          { id: "shared", label: "Shared", available: true }
        ]
      },
      {
        provider: provider("openrouter", "OpenRouter"),
        models: [{ id: "shared", label: "Shared", available: true }]
      }
    ]);

    expect(options.map((option) => option.id)).toEqual([
      "openai::gpt-5",
      "openai::shared",
      "openrouter::shared"
    ]);
  });

  it("returns provider wire ids for an unambiguous legacy selection", () => {
    const options = providerModelOptions([
      {
        provider: provider("openai", "OpenAI"),
        models: [{ id: "shared", label: "Shared", available: true }]
      },
      {
        provider: provider("openrouter", "OpenRouter"),
        models: [{ id: "different", label: "Different", available: true }]
      }
    ]);

    expect(resolveProviderModelOption(options, "shared")?.providerId).toBe("openai");
    expect(modelsForProvider(options, "openrouter")).toEqual([
      { id: "different", label: "Different", available: true }
    ]);
  });

  it("never reroutes an unavailable qualified selection to another provider", () => {
    const options = providerModelOptions([
      {
        provider: provider("openai", "OpenAI"),
        models: [{ id: "shared", label: "Shared", available: false }]
      },
      {
        provider: provider("openrouter", "OpenRouter"),
        models: [{ id: "shared", label: "Shared", available: true }]
      }
    ]);

    expect(resolveProviderModelOption(options, "openai::shared")).toBeUndefined();
  });

  it("never guesses between ambiguous legacy provider routes", () => {
    const options = providerModelOptions([
      {
        provider: provider("openai", "OpenAI"),
        models: [{ id: "shared", label: "Shared", available: true }]
      },
      {
        provider: provider("openrouter", "OpenRouter"),
        models: [{ id: "shared", label: "Shared", available: true }]
      }
    ]);

    expect(resolveProviderModelOption(options, "shared")).toBeUndefined();
  });

  it("selects the first eligible route only when no selection has been saved", () => {
    const options = providerModelOptions([
      {
        provider: provider("openai", "OpenAI"),
        models: [
          { id: "old", label: "Old", available: false },
          { id: "current", label: "Current", available: true }
        ]
      }
    ]);

    expect(resolveProviderModelOption(options, "")?.id).toBe("openai::current");
  });
});
