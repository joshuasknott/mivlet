import { describe, expect, it } from "vitest";
import type { SearchResult } from "@fable/protocol";
import {
  describeSearchContext,
  highlightSegments,
  searchKindLabel,
  searchResultKey,
  searchTokens,
} from "./results";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    reference: { workspaceId: "ws", kind: "conversation", id: "thread-1" },
    objectKind: "conversation",
    title: "Aurora planning",
    snippet: "the aurora borealis",
    matchedField: "title",
    score: 4,
    archived: false,
    context: {},
    ...overrides,
  };
}

describe("scoped search result presentation", () => {
  it("tokenizes the same bounded ASCII vocabulary as native search", () => {
    expect(searchTokens("Aurora a AURORA borealis!")).toEqual([
      "aurora",
      "borealis",
    ]);
    expect(searchTokens("x")).toEqual([]);
  });

  it("highlights case-insensitive matches without reordering text", () => {
    const segments = highlightSegments("The Aurora borealis", "aurora");
    expect(segments).toEqual([
      { text: "The ", match: false },
      { text: "Aurora", match: true },
      { text: " borealis", match: false },
    ]);
  });

  it("caps display text so a row never renders a whole transcript", () => {
    const segments = highlightSegments("a".repeat(500), "aurora", 20);
    expect(segments.reduce((total, part) => total + part.text.length, 0)).toBe(
      21,
    );
  });

  it("labels object types and owning context from native fields only", () => {
    expect(searchKindLabel("conversation")).toBe("Chat");
    expect(searchKindLabel("file")).toBe("File");
    expect(
      describeSearchContext(
        result({
          objectKind: "work",
          context: { agentName: "Nova", workStatus: "running" },
        }),
      ),
    ).toBe("Work · Nova · running");
    expect(
      describeSearchContext(
        result({
          objectKind: "file",
          context: { fileKind: "artifact", agentName: "Nova" },
        }),
      ),
    ).toBe("Artifact · Nova");
    expect(
      describeSearchContext(
        result({
          objectKind: "agent",
          reference: { workspaceId: "ws", kind: "agent", id: "agent-1" },
          context: { agentName: "Nova" },
        }),
      ),
    ).toBe("Agent · Nova");
  });

  it("dedupes paged results by type, kind and id", () => {
    expect(searchResultKey(result())).toBe("conversation:conversation:thread-1");
  });
});
