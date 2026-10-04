import { describe, expect, it } from "vitest";
import { buildToolApproval } from "./approvals";
import { lookupTool } from "./tools";

describe("bounded Office tool contracts", () => {
  it("shares slide authoring with exact content approvals", () => {
    const tool = lookupTool("create-presentation")!;
    expect(tool).toMatchObject({
      defaultMode: "full-access",
      defaultRisk: "high",
    });
    const schema = JSON.parse(tool.parameters);
    expect(schema.properties.slides.maxItems).toBe(30);
    expect(schema.properties.slides.items.additionalProperties).toBe(false);
    const args = {
      path: "slides/review.pptx",
      title: "Review",
      slides: [{ title: "Results", bullets: ["One"] }],
    };
    const approval = buildToolApproval(
      "luna",
      "create-presentation",
      JSON.stringify(args),
    );
    expect(approval).toMatchObject({
      mode: "full-access",
      confirmationPhrase: "approve create-presentation",
    });
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

  it("binds chart data and source ranges into the same exact document approval", () => {
    const schema = JSON.parse(lookupTool("create-spreadsheet")!.parameters);
    const charts = schema.properties.sheets.items.properties.charts;
    expect(charts.maxItems).toBe(2);
    expect(charts.items.properties.type.enum).toEqual(["column", "line"]);
    expect(charts.items.properties.series.maxItems).toBe(3);
    expect(charts.items.additionalProperties).toBe(false);
    const args = {
      path: "report.xlsx",
      sheets: [
        {
          name: "Data",
          rows: [
            ["Jan", 12],
            ["Feb", -8],
          ],
          charts: [
            {
              title: "Net",
              type: "column",
              categories: "A1:A2",
              series: [{ name: "Net", values: "B1:B2" }],
            },
          ],
        },
      ],
    };
    const approval = buildToolApproval(
      "luna",
      "create-spreadsheet",
      JSON.stringify(args),
    );
    expect(JSON.stringify(approval.dataUsed)).toContain("B1:B2");
    const changed = structuredClone(args);
    changed.sheets[0]!.charts[0]!.series[0]!.values = "C1:C2";
    expect(
      buildToolApproval("luna", "create-spreadsheet", JSON.stringify(changed))
        .dataUsed,
    ).not.toEqual(approval.dataUsed);
  });
});
