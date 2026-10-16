import { describe, expect, it } from "vitest";
import { capturedFileExclusions } from "./context-selection";
import type { CapturedWorkContext } from "@mivlet/protocol";
describe("native captured file exclusions", () => {
  const capture = (text: string): CapturedWorkContext => ({
    version: 1,
    mode: "snapshot",
    source: { workspaceId: "workspace", kind: "conversation", id: "chat" },
    text,
    capturedAt: "2026-10-08T00:00:00Z",
    sourceRevision: "1",
  });
  it("uses frozen exclusions rather than mutable next-turn choices", () => {
    expect(
      capturedFileExclusions(
        capture(
          JSON.stringify({
            contextSelection: { excludedKnowledgeSourceIds: ["file-1"] },
          }),
        ),
      ),
    ).toEqual(["file-1"]);
    expect(capturedFileExclusions(capture("{}"))).toEqual([]);
  });
  it("fails closed for corrupt captured exclusions", () => {
    expect(() =>
      capturedFileExclusions(
        capture('{"contextSelection":{"excludedKnowledgeSourceIds":[null]}}'),
      ),
    ).toThrow(/saved context selection/);
  });
});
