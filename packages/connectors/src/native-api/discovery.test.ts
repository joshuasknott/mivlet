import { describe, expect, it } from "vitest";
import type { BackendModel } from "@fable/protocol";
import { catalogueCapabilities } from "./model-catalogue";
import { mergeDiscoveredModels, type DiscoveredModel } from "./discovery";

const catalogueModels: BackendModel[] = [
  { id: "gpt-5", label: "GPT-5", available: true },
  { id: "gpt-4.1", label: "GPT-4.1", available: true },
  { id: "ghost", label: "Ghost", available: true }
];

describe("mergeDiscoveredModels", () => {
  it("marks discovered ids available and attaches catalogue capabilities", () => {
    const discovered: DiscoveredModel[] = [{ id: "gpt-5", available: true }];
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered,
      connected: true,
      discoveryRan: true
    });
    const gpt5 = merged.find((m) => m.id === "gpt-5");
    expect(gpt5?.available).toBe(true);
    expect(gpt5?.capabilities).toEqual(catalogueCapabilities("openai", "gpt-5"));
  });

  it("marks a catalogue-only id unavailable when discovery ran but omitted it", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered: [{ id: "gpt-5", available: true }],
      connected: true,
      discoveryRan: true
    });
    // gpt-4.1 and ghost are in the catalogue but not discovered → unavailable.
    expect(merged.find((m) => m.id === "gpt-4.1")?.available).toBe(false);
    expect(merged.find((m) => m.id === "ghost")?.available).toBe(false);
  });

  it("keeps catalogue ids available when discovery did NOT run (offline fallback)", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered: [],
      connected: true,
      discoveryRan: false
    });
    expect(merged.find((m) => m.id === "gpt-5")?.available).toBe(true);
    expect(merged.find((m) => m.id === "gpt-4.1")?.available).toBe(true);
  });

  it("marks catalogue ids unavailable when offline and not connected", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered: [],
      connected: false,
      discoveryRan: false
    });
    expect(merged.every((m) => m.available === false)).toBe(true);
  });

  it("enables a newly discovered generation id with conservative default capabilities", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered: [{ id: "gpt-6-future", available: true }],
      connected: true,
      discoveryRan: true
    });
    const future = merged.find((m) => m.id === "gpt-6-future");
    expect(future?.available).toBe(true);
    expect(future?.label).toBe("gpt-6-future");
    expect(future?.capabilities).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 4_096,
      streaming: true,
      tools: false
    });
  });

  it("respects an explicit unavailable flag from discovery (e.g. Gemini embeddings)", () => {
    const merged = mergeDiscoveredModels({
      providerId: "gemini",
      catalogueModels: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", available: true }],
      discovered: [
        { id: "gemini-2.5-pro", available: true },
        { id: "text-embedding-004", available: false }
      ],
      connected: true,
      discoveryRan: true
    });
    expect(merged.find((m) => m.id === "text-embedding-004")?.available).toBe(false);
  });

  it("dedupes a model that appears in both discovery and the catalogue", () => {
    const merged = mergeDiscoveredModels({
      providerId: "openai",
      catalogueModels,
      discovered: [{ id: "gpt-5", available: true }],
      connected: true,
      discoveryRan: true
    });
    expect(merged.filter((m) => m.id === "gpt-5")).toHaveLength(1);
  });
});
