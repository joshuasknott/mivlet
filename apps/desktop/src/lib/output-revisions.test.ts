import { describe, expect, it } from "vitest";
import {
  appendOutputRevision,
  createOutputDocument,
  currentOutputRevision,
  outputRevisionDiff,
  restoreOutputRevision,
  setOutputPinned,
  StaleOutputRevisionError,
} from "./output-revisions";

const source = {
  conversationId: "thread-1",
  messageId: "message-1",
  agentId: "mira",
};

function output() {
  return createOutputDocument({
    id: "output-1",
    title: "Decision brief",
    format: "markdown",
    mimeType: "text/markdown",
    source,
    content: "# First draft",
    now: "2026-10-08T10:00:00.000Z",
  });
}

describe("durable output revisions", () => {
  it("keeps immutable history and advances the current revision", () => {
    const first = output();
    const second = appendOutputRevision(first, {
      outputId: first.id,
      expectedRevisionId: first.currentRevisionId,
      expectedRevisionNumber: 1,
      content: "# Edited draft",
      author: "user",
      provenance: { ...source, reason: "direct-edit" },
      revisionId: "revision-2",
      now: "2026-10-08T10:01:00.000Z",
    });
    expect(first.revisions).toHaveLength(1);
    expect(second.revisions).toHaveLength(2);
    expect(currentOutputRevision(second).content).toBe("# Edited draft");
  });

  it("rejects a stale pane instead of overwriting newer user edits", () => {
    const first = output();
    const second = appendOutputRevision(first, {
      outputId: first.id,
      expectedRevisionId: first.currentRevisionId,
      expectedRevisionNumber: 1,
      content: "newer",
      author: "user",
      provenance: { ...source, reason: "direct-edit" },
      revisionId: "revision-2",
    });
    expect(() =>
      appendOutputRevision(second, {
        outputId: second.id,
        expectedRevisionId: first.currentRevisionId,
        expectedRevisionNumber: 1,
        content: "stale agent response",
        author: "agent",
        provenance: { ...source, reason: "agent-revision" },
      }),
    ).toThrow(StaleOutputRevisionError);
  });

  it("restores through a new revision and exposes a comparison", () => {
    const first = output();
    const second = appendOutputRevision(first, {
      outputId: first.id,
      expectedRevisionId: first.currentRevisionId,
      expectedRevisionNumber: 1,
      content: "second",
      author: "user",
      provenance: { ...source, reason: "direct-edit" },
      revisionId: "revision-2",
    });
    const restored = restoreOutputRevision(
      second,
      1,
      second.currentRevisionId,
      2,
      source,
      "2026-10-08T10:02:00.000Z",
    );
    expect(restored.revisions).toHaveLength(3);
    expect(currentOutputRevision(restored).content).toBe("# First draft");
    expect(outputRevisionDiff(restored, 1, 2).changed).toBe(true);
  });

  it("pins and unpins without changing output identity", () => {
    const pinned = setOutputPinned(output(), true, "2026-10-08T10:03:00.000Z");
    expect(pinned.pinned).toBe(true);
    expect(pinned.pinnedAt).toBe("2026-10-08T10:03:00.000Z");
    expect(setOutputPinned(pinned, false).pinned).toBe(false);
  });

  it("keeps a pin anchored to an older revision after appending", () => {
    const first = output();
    const pinned = setOutputPinned(first, true, "2026-10-08T10:03:00.000Z", source, first.currentRevisionId);
    const next = appendOutputRevision(pinned, {
      outputId: pinned.id,
      expectedRevisionId: pinned.currentRevisionId,
      expectedRevisionNumber: pinned.currentRevisionNumber,
      content: "# Second draft",
      author: "user",
      provenance: { ...source, reason: "direct-edit" },
      now: "2026-10-08T10:04:00.000Z",
    });
    expect(next.pinned).toBe(true);
    expect(next.pin?.revisionId).toBe(first.currentRevisionId);
    expect(next.pin?.source).toEqual(source);
  });
});
