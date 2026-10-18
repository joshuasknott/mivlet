import { afterEach, describe, expect, it, vi } from "vitest";
import * as artifacts from "./computer-artifacts";
import { publishedArtifactParts } from "./conversation-artifacts";
import type { ResponsePart } from "./conversation-presentation-types";

function receipt(index: number, title = `File ${index}`): ResponsePart {
  return {
    id: `tool-${index}-${title}`,
    kind: "tool",
    tool: "publish-artifact",
    state: "succeeded",
    content: JSON.stringify({
      kind: "computer-artifact",
      version: 1,
      id: `artifact-${index.toString(16).padStart(64, "0")}`,
      computerId: `local-${"a".repeat(24)}`,
      title,
      relativePath: `reports/${index}.md`,
      mimeType: "text/markdown",
      sizeBytes: 10,
      createdAt: "2026-10-18T10:00:00Z",
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("published conversation artifacts", () => {
  it("keeps the first valid successful receipt and its original tool metadata", () => {
    const first = receipt(1);
    const second = receipt(2);
    const parts: ResponsePart[] = [
      { ...first, kind: "tool", tool: "publish-artifact", state: "failed" },
      { ...first, kind: "tool", tool: "publish-artifact", state: "running" },
      {
        ...first,
        kind: "tool",
        tool: "publish-artifact",
        state: "succeeded",
        content: "invalid",
      },
      { id: "text", kind: "text", content: first.content },
      first,
      second,
      receipt(1, "Later duplicate"),
    ];
    expect(publishedArtifactParts(parts)).toEqual([first, second]);
    expect(publishedArtifactParts(parts)[0]).toBe(first);
  });

  it("validates each candidate once as a retained turn grows", () => {
    const parse = vi.spyOn(artifacts, "parseComputerArtifact");
    const parts = Array.from({ length: 1_000 }, (_, index) => receipt(index));
    expect(publishedArtifactParts(parts)).toHaveLength(1_000);
    expect(parse).toHaveBeenCalledTimes(1_000);
    parse.mockClear();
    expect(publishedArtifactParts([...parts, ...parts])).toEqual(parts);
    expect(parse).toHaveBeenCalledTimes(2_000);
  });
});
