import { describe, expect, it } from "vitest";
import { selectedSourcePassage } from "./response-selection";

describe("response source selection", () => {
  it("anchors formatted rendered text to literal saved source", () => {
    expect(selectedSourcePassage("A **quiet** conversation with `tools`.", "quiet conversation with tools")).toBe("**quiet** conversation with `tools`");
    expect(selectedSourcePassage("First paragraph.\n\nNext paragraph.", "First paragraph.\nNext paragraph.")).toBe("First paragraph.\n\nNext paragraph.");
  });
  it("fails closed for content outside the saved source or bounds", () => {
    expect(selectedSourcePassage("A response", "Different response")).toBe("");
    expect(selectedSourcePassage("x".repeat(9000), "x".repeat(8001))).toBe("");
    expect(selectedSourcePassage("A response", " ** ")).toBe("");
  });
});
