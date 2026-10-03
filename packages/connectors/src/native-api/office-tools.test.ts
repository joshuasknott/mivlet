import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool } from "./tools";

describe("bounded Office tool contracts", () => {
  it("shares slide authoring with exact content approvals", () => {
    const tool = lookupTool("create-presentation")!;
    expect(tool).toMatchObject({ defaultMode: "full-access", defaultRisk: "high" });
    const schema = JSON.parse(tool.parameters);
    expect(schema.properties.slides.maxItems).toBe(30);
    expect(schema.properties.slides.items.additionalProperties).toBe(false);
    const args = { path: "slides/review.pptx", title: "Review", slides: [{ title: "Results", bullets: ["One"] }] };
    const approval = buildToolApproval("luna", "create-presentation", JSON.stringify(args));
    expect(approval).toMatchObject({ mode: "full-access", confirmationPhrase: "approve create-presentation" });
    expect(JSON.stringify(approval.dataUsed)).toContain("One");
  });
  it("advertises formula-bearing XLSX input without arbitrary expressions", () => {
    const tool = lookupTool("create-spreadsheet");
    expect(tool).toMatchObject({
      defaultMode: "full-access",
      defaultRisk: "high",
    });
    const schema = JSON.parse(tool!.parameters);
    const formula =
      schema.properties.sheets.items.properties.rows.items.items.oneOf[3];
    expect(formula.properties.formula.enum).toEqual([
      "sum",
      "average",
      "min",
      "max",
      "count",
    ]);
    expect(formula.properties.range.pattern).toContain("[A-Z]");
    expect(schema.properties.sheets.maxItems).toBe(8);
  });

  it("keeps document creation bounded and behind an exact high-risk approval", () => {
    const args = JSON.stringify({
      path: "reports/summary.docx",
      title: "Audit summary",
      blocks: [{ type: "paragraph", text: "The total is 26." }],
    });
    const tool = lookupTool("create-document");
    const schema = JSON.parse(tool!.parameters);
    expect(schema.properties.blocks.maxItems).toBe(500);
    expect(buildToolApproval("luna", "create-document", args)).toMatchObject({
      mode: "full-access",
      riskLevel: "high",
      confirmationPhrase: "approve create-document",
    });
  });
});
