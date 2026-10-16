import { describe, expect, it } from "vitest";
import { buildRichInterfaceInstructions } from "./rich-interface-prompt";
import instructions from "./rich-interface-instructions.json";
import { extractGeneratedInterface } from "./generated-interface";
import { validateRichInterface } from "../components/conversation/generated/rich-interface-guard";

describe("production OpenUI prompt contract", () => {
  it("does not advertise instructions or syntax rejected by Mivlet's guard", () => {
    const prompt = instructions.instructions;
    expect(prompt).toContain("exactly one fenced openui-v2 block");
    expect(prompt).not.toContain("ENTIRE response");
    for (const unsupported of ["@OpenUrl", "@Each", "@Filter", "@Sort", "@Run", "query.field", "data[index]"])
      expect(prompt).not.toContain(unsupported);
  });
  it("round-trips the actual shipped example through extraction and the production AST guard", () => {
    const extracted = extractGeneratedInterface(instructions.instructions);
    expect(extracted?.profile).toBe("mivlet-v2");
    expect(extracted?.complete).toBe(true);
    expect(validateRichInterface(extracted!.code, new Set(["Stack", "Input", "TextContent", "Button"])).error).toBeUndefined();
  });
  it("preserves generated signatures while excluding generic upstream capabilities", () => {
    const generated = buildRichInterfaceInstructions("Generic instructions\n## Component Signatures\n\nTextContent(text: string) — Actual signature.\n\n## Built-in Functions\n@Each unsupported");
    expect(generated).toContain("TextContent(text: string) — Actual signature.");
    expect(generated).not.toContain("@Each");
    expect(() => buildRichInterfaceInstructions("Changed upstream format")).toThrow(/catalogue/);
  });
});
