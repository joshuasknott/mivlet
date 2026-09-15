import { describe, expect, it } from "vitest";
import type { KnowledgeSource } from "@mivlet/protocol";
import { disableSource, enableSource, markFailed, markHealthy, markIndexing } from "./lifecycle";
import { isLiveSource } from "../store";

function baseSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: "s1",
    title: "notes.md",
    kind: "document",
    connectorId: "local-files",
    provenance: "Local file - 1.0 KB",
    freshness: "Imported now",
    pinned: false,
    status: "ok",
    ...overrides
  };
}

describe("lifecycle: disable / enable", () => {
  it("disable sets disabled=true and the source becomes non-live", () => {
    const source = disableSource(baseSource());
    expect(source.disabled).toBe(true);
    expect(isLiveSource(source)).toBe(false);
  });

  it("enable clears the disabled flag", () => {
    const disabled = disableSource(baseSource());
    const enabled = enableSource(disabled);
    expect(enabled.disabled).toBeUndefined();
    expect(isLiveSource(enabled)).toBe(true);
  });

  it("disable is immutable (original untouched)", () => {
    const original = baseSource();
    disableSource(original);
    expect(original.disabled).toBeUndefined();
  });
});

describe("lifecycle: status transitions", () => {
  it("markIndexing sets status indexing", () => {
    expect(markIndexing(baseSource()).status).toBe("indexing");
  });

  it("markHealthy clears stale status and message", () => {
    const stale = baseSource({ status: "stale", statusMessage: "old" });
    const healthy = markHealthy(stale);
    expect(healthy.status).toBe("ok");
    expect(healthy.statusMessage).toBeUndefined();
  });

  it("markHealthy preserves error status unless clearError is true", () => {
    const failed = baseSource({ status: "error", statusMessage: "boom" });
    expect(markHealthy(failed).status).toBe("error");
    expect(markHealthy(failed, true).status).toBe("ok");
  });

  it("markFailed sets error status with a message", () => {
    const failed = markFailed(baseSource(), "extraction failed");
    expect(failed.status).toBe("error");
    expect(failed.statusMessage).toBe("extraction failed");
  });
});
