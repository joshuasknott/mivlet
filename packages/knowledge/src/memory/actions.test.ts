import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@mivlet/protocol";
import {
  disableMemory,
  editMemory,
  exportMemories,
  forgetMemory,
  pinMemory,
  unpinMemory
} from "./actions";

const NOW = "2026-06-28T12:00:00.000Z";

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    kind: "fact",
    title: "Prefers concise answers",
    value: "The user prefers concise answers.",
    source: "chat",
    freshness: "Today",
    approved: true,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

describe("editMemory", () => {
  it("updates editable fields and bumps updatedAt, immutably", () => {
    const original = makeMemory();
    const edited = editMemory(original, { value: "The user prefers short answers." }, NOW);
    expect(edited.value).toBe("The user prefers short answers.");
    expect(edited.updatedAt).toBe(NOW);
    expect(original.value).toBe("The user prefers concise answers.");
  });

  it("scrubs secret-shaped values before they are stored", () => {
    const leaked = "sk-12345678901234567890abc123";
    const edited = editMemory(
      makeMemory(),
      { value: `Keep the launch key ${leaked} in the vault.` },
      NOW
    );
    expect(edited.value).toContain("Keep the launch key");
    expect(edited.value).not.toContain(leaked);
    expect(edited.value).toContain("[REDACTED]");
  });
});

describe("pinMemory / unpinMemory", () => {
  it("sets pinned true / false without mutating input", () => {
    const original = makeMemory({ pinned: false });
    expect(pinMemory(original).pinned).toBe(true);
    expect(unpinMemory(makeMemory({ pinned: true })).pinned).toBe(false);
    expect(original.pinned).toBe(false);
  });
});

describe("disableMemory", () => {
  it("sets disabled true", () => {
    expect(disableMemory(makeMemory(), NOW).disabled).toBe(true);
  });
});

describe("forgetMemory", () => {
  it("sets forgottenAt to now", () => {
    const forgotten = forgetMemory(makeMemory(), NOW);
    expect(forgotten.forgottenAt).toBe(NOW);
    expect(forgotten.updatedAt).toBe(NOW);
  });
});

describe("exportMemories", () => {
  it("exports live memories and excludes forgotten/disabled", () => {
    const records = [
      makeMemory({ id: "live", title: "Prefers concise answers" }),
      makeMemory({ id: "forgotten", forgottenAt: NOW }),
      makeMemory({ id: "disabled", disabled: true })
    ];
    const blob = exportMemories(records);
    expect(blob).toContain("Prefers concise answers");
    expect(blob).not.toContain("forgotten");
    expect(blob).not.toContain("disabled");
  });
});
