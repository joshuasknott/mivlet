import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool } from "./tools";

describe("bounded Office tool contracts", () => {
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
