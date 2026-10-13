import { describe, expect, it } from "vitest";
import type { CollaborationWorkItem } from "@mivlet/protocol";
import { collectLibraryArtifacts } from "./library-artifacts";

const receipt = (letter: string, title: string) =>
  JSON.stringify({
    kind: "computer-artifact",
    version: 1,
    id: `artifact-${letter.repeat(64)}`,
    computerId: `local-${"a".repeat(24)}`,
    title,
    relativePath: "reports/result.md",
    mimeType: "text/markdown",
    sizeBytes: 10,
    createdAt: "2026-10-12T10:00:00Z",
  });
const work = (agentId: string, texts: string[]) =>
  ({
    agentId,
    outputs: texts.map((text) => ({ text })),
  }) as CollaborationWorkItem;

describe("Library artifact selection", () => {
  it("retains ordered first matching receipts and separate agent ownership", () => {
    const first = receipt("a", "First");
    const second = receipt("b", "Second");
    const result = collectLibraryArtifacts(
      [
        work("mira", ["plain answer", first, second, first]),
        work("rowan", [first]),
      ],
      "",
    );
    expect(result.map((item) => [item.agentId, item.artifact.title])).toEqual([
      ["mira", "First"],
      ["mira", "Second"],
      ["rowan", "First"],
    ]);
    expect(result[0].output).toBe(first);
  });
  it("filters before deduplication and refuses invalid artifact receipts", () => {
    const result = collectLibraryArtifacts(
      [
        work("mira", [
          receipt("a", "Old title"),
          receipt("a", "New title"),
          receipt("z", "New invalid"),
        ]),
      ],
      "new",
    );
    expect(result).toHaveLength(1);
    expect(result[0].artifact.title).toBe("New title");
  });
  it("handles a large retained history without duplicating its artifacts", () => {
    const result = collectLibraryArtifacts(
      Array.from({ length: 10_000 }, (_, index) =>
        work(index % 2 ? "mira" : "rowan", [receipt("a", "Report")]),
      ),
      "report",
    );
    expect(result.map((item) => item.agentId)).toEqual(["rowan", "mira"]);
  });
});
