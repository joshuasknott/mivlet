import { describe, expect, it } from "vitest";
import type { KnowledgeSource, MemoryRecord } from "@fable/protocol";
import {
  buildAgentRequest,
  buildContextPrefixForRun,
  permissionLabelFor,
  permissionModeFor,
  resolveSelectedModel
} from "./agent-run";

const memory = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "m1",
  kind: "fact",
  title: "User name",
  value: "Josh",
  source: "approved",
  freshness: "now",
  approved: true,
  pinned: true,
  ...over
});

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: "s1",
  title: "Launch notes",
  kind: "document",
  connectorId: "local-files",
  provenance: "import",
  freshness: "today",
  pinned: true,
  ...over
});

describe("buildContextPrefixForRun", () => {
  it("builds a prefix from pinned trusted memory + a pinned source", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [
        source({ trust: "trusted", contentPreview: "ship Friday" })
      ],
      pinnedSourceIds: ["s1"],
      memoryDisabled: false
    });
    expect(prefix).toContain("Trusted memory");
    expect(prefix).toContain("Josh");
    expect(prefix).toContain("Trusted knowledge");
    expect(prefix).toContain("ship Friday");
  });

  it("is empty when nothing is pinned", () => {
    expect(
      buildContextPrefixForRun({
        memoryRecords: [memory({ pinned: false })],
        knowledgeSources: [],
        pinnedSourceIds: [],
        memoryDisabled: false
      })
    ).toBe("");
  });

  it("omits memory entirely when memory is disabled", () => {
    // Even with a pinned trusted record, disabled memory yields no memory text.
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [],
      pinnedSourceIds: [],
      memoryDisabled: true
    });
    expect(prefix).toBe("");
  });

  it("omits memory when disabled even if a source is still pinned", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [memory()],
      knowledgeSources: [
        source({ trust: "trusted", contentPreview: "kept" })
      ],
      pinnedSourceIds: ["s1"],
      memoryDisabled: true
    });
    expect(prefix).not.toContain("Trusted memory");
    expect(prefix).toContain("kept");
  });

  it("excludes sources that are not in the pinned set", () => {
    const prefix = buildContextPrefixForRun({
      memoryRecords: [],
      knowledgeSources: [
        source({ id: "pinned", trust: "trusted", contentPreview: "in" }),
        source({ id: "other", trust: "trusted", contentPreview: "out" })
      ],
      pinnedSourceIds: ["pinned"],
      memoryDisabled: false
    });
    expect(prefix).toContain("in");
    expect(prefix).not.toContain("out");
  });
});

describe("buildAgentRequest", () => {
  it("shapes the model/messages into a provider-neutral AgentRunRequest", () => {
    const request = buildAgentRequest({
      model: "gpt-5",
      prompt: "Summarize the project",
      maxTokens: 2048
    });
    expect(request).toEqual({
      model: "gpt-5",
      messages: [{ role: "user", content: "Summarize the project" }],
      tools: [],
      maxTokens: 2048
    });
  });

  it("uses the selected model id rather than a hardcoded label", () => {
    const request = buildAgentRequest({
      model: "claude-sonnet-4",
      prompt: "hello",
      maxTokens: 1024
    });
    expect(request.model).toBe("claude-sonnet-4");
  });
});

describe("permission profile mapping", () => {
  it("maps each UI label to its PermissionMode", () => {
    expect(permissionModeFor("Full access")).toBe("full-access");
    expect(permissionModeFor("Standard access")).toBe("trusted-scope");
    expect(permissionModeFor("Confirm every action")).toBe("read-only");
  });

  it("round-trips the default label back from a PermissionMode", () => {
    expect(permissionLabelFor("full-access")).toBe("Full access");
    expect(permissionLabelFor("trusted-scope")).toBe("Standard access");
    expect(permissionLabelFor("read-only")).toBe("Confirm every action");
  });
});

describe("resolveSelectedModel", () => {
  const models = [
    { id: "gpt-5", label: "GPT-5", available: true },
    { id: "gpt-4.1", label: "GPT-4.1", available: false },
    { id: "o3", label: "o3", available: true }
  ];

  it("keeps the persisted model when it is still available", () => {
    expect(resolveSelectedModel(models, "o3")).toBe("o3");
  });

  it("falls back to the first available when the persisted one is gone", () => {
    expect(resolveSelectedModel(models, "old-model")).toBe("gpt-5");
  });

  it("falls back to the first available when nothing was persisted", () => {
    expect(resolveSelectedModel(models, "")).toBe("gpt-5");
  });

  it("returns empty string when no model is available", () => {
    expect(
      resolveSelectedModel(
        [{ id: "x", label: "X", available: false }],
        ""
      )
    ).toBe("");
  });
});
