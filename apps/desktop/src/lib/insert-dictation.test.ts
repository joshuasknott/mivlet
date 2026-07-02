import { describe, expect, it } from "vitest";
import { insertDictation } from "./insert-dictation";

describe("insertDictation", () => {
  it("inserts into an empty prompt", () => {
    expect(insertDictation("", " hello ")).toEqual({
      value: "hello",
      caret: 5
    });
  });

  it("appends without destroying existing text", () => {
    expect(insertDictation("Plan this", "tomorrow")).toEqual({
      value: "Plan this tomorrow",
      caret: 18
    });
  });

  it("inserts at a caret with readable boundary spacing", () => {
    expect(insertDictation("beforeafter", "middle", 6, 6)).toEqual({
      value: "before middle after",
      caret: 14
    });
  });

  it("replaces only the selected range and preserves punctuation", () => {
    expect(insertDictation("Say old, please", "new words", 4, 7)).toEqual({
      value: "Say new words, please",
      caret: 13
    });
  });

  it("leaves the prompt unchanged for an empty result", () => {
    expect(insertDictation("Keep me", "   ", 2, 5)).toEqual({
      value: "Keep me",
      caret: 2
    });
  });
});
