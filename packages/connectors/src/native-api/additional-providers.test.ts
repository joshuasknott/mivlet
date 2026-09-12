import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { additionalNativeProviderCatalog, additionalModelCapabilities } from "../backends/additional-native";
import { isEmbeddedNativeProvider, nativeProviderCatalog } from "../backends/catalog";
import { listBackendProviders, resolveNativeProvider } from "../backends/registry";
import { mergeDiscoveredModels } from "./discovery";
import { supportsNativeComputerVision } from "./computer-vision";
import { shapeOpenAiRequest } from "./openai-compat";
import { validateReasoningEffort } from "./reasoning";

const nativeCatalog = readFileSync(new URL("../../../../apps/desktop/src-tauri/src/backends.rs", import.meta.url), "utf8");
const nativeProfiles = readFileSync(new URL("../../../../apps/desktop/src-tauri/src/native_api.rs", import.meta.url), "utf8");

describe.each(additionalNativeProviderCatalog)("$label direct API route", (entry) => {
  it("has reachable setup, runtime admission, and matching native model routes", () => {
    expect(listBackendProviders().find(provider => provider.id === entry.providerId)).toMatchObject({
      instanceId: entry.providerId, authState: "needs-auth", capabilities: [], setup: { kind: "api-key" },
    });
    expect(isEmbeddedNativeProvider(entry.providerId)).toBe(true);
    const native = nativeCatalog.split(`id: "${entry.providerId}",`)[1]?.split("BackendCatalogEntry")[0];
    expect(native).toContain('driver_kind: "native-api"');
    for (const model of entry.models) {
      expect(native).toContain(`("${model.id}", "${model.label}")`);
    }
    const profile = nativeProfiles.split(`id: "${entry.providerId}",`)[1]?.split("OpenAiCompatProfile")[0];
    expect(profile).toContain("https://");
    expect(profile).toContain('auth_required: true');
  });

  it("admits curated tools without inferring vision, reasoning, or unknown model capabilities", () => {
    const connected = resolveNativeProvider(entry.providerId, "connected");
    const model = connected.models[0];
    expect(connected.capabilities).toContain("tool-requests");
    expect(additionalModelCapabilities(entry.providerId, model.id)).toMatchObject({ tools: true, vision: false, reasoning: false });
    expect(additionalModelCapabilities(entry.providerId, "unknown-model")).toBeUndefined();
    expect(supportsNativeComputerVision(entry.providerId, { ...model, capabilities: { vision: true, tools: true } })).toBe(false);
    expect(() => validateReasoningEffort(entry.providerId, model, "high")).toThrow(/reasoning/);
  });

  it("does not keep a retired model available after successful discovery", () => {
    const models = mergeDiscoveredModels({
      providerId: entry.providerId, catalogueModels: resolveNativeProvider(entry.providerId, "connected").models,
      discovered: [{ id: "new-model", available: true }], connected: true, discoveryRan: true,
    });
    expect(models.filter(model => model.available).map(model => model.id)).toEqual(["new-model"]);
    expect(models.find(model => model.id === "new-model")?.capabilities?.tools).not.toBe(true);
  });

  it("shapes multi-turn function results with the exact provider model and token field", () => {
    const body = shapeOpenAiRequest({
      providerId: entry.providerId, model: entry.models[0].id, maxTokens: 256, tools: [],
      messages: [
        { role: "user", content: "Read the file." },
        { role: "assistant", content: "", toolCalls: [{ callId: "call-1", tool: "read-file", arguments: '{"path":"note.txt"}' }] },
        { role: "tool", content: "File content", toolCallId: "call-1" },
      ],
    });
    expect(body).toMatchObject({
      model: entry.models[0].id, stream: true, max_tokens: 256,
      messages: [expect.anything(), { role: "assistant", tool_calls: [{ id: "call-1", type: "function" }] }, { tool_call_id: "call-1", content: "File content" }],
    });
    expect(body).not.toHaveProperty("apiKey");
  });
});

it("only admits registered direct API instances", () => {
  expect(isEmbeddedNativeProvider("unregistered")).toBe(false);
  expect(isEmbeddedNativeProvider("codex")).toBe(false);
  expect(new Set(nativeProviderCatalog.map(entry => entry.providerId)).size).toBe(nativeProviderCatalog.length);
});

