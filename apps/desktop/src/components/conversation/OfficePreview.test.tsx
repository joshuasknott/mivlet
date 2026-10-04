import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfficePreview } from "./OfficePreview";

describe("Office content previews", () => {
  it.each(["column", "line"] as const)(
    "shows signed %s charts and accessible literal data without active markup",
    (kind) => {
      const { container } = render(
        <OfficePreview
          truncated={false}
          office={{
            kind: "spreadsheet",
            sections: [
              {
                name: "Results",
                blocks: [
                  {
                    type: "chart",
                    kind,
                    title: "Net <2026>",
                    categories: ["<script>never run</script>", "Feb"],
                    series: [{ name: "Net", values: [12, -8] }],
                  },
                ],
              },
            ],
          }}
        />,
      );
      expect(
        screen.getByRole("img", { name: `Net <2026>, ${kind} chart` }),
      ).toBeVisible();
      expect(screen.getByText(/Cached worksheet values/)).toBeVisible();
      fireEvent.click(screen.getByText("Chart data"));
      expect(screen.getByRole("cell", { name: "-8" })).toBeVisible();
      expect(
        screen.getByRole("cell", { name: "<script>never run</script>" }),
      ).toBeVisible();
      expect(container.querySelector("script")).toBeNull();
      for (const element of container.querySelectorAll("rect"))
        expect(Number(element.getAttribute("height"))).toBeGreaterThanOrEqual(
          0,
        );
      expect(container.querySelector("polyline") !== null).toBe(
        kind === "line",
      );
    },
  );
  it("refuses nonfinite or mismatched chart projections", () => {
    render(
      <OfficePreview
        truncated={false}
        office={{
          kind: "spreadsheet",
          sections: [
            {
              name: "Results",
              blocks: [
                {
                  type: "chart",
                  kind: "column",
                  title: "Invalid",
                  categories: ["A", "B"],
                  series: [{ name: "Net", values: [Infinity] }],
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Open the file to view this chart.")).toBeVisible();
  });
  it("renders document blocks in order as escaped content", () => {
    const { container } = render(
      <OfficePreview
        truncated={false}
        office={{
          kind: "document",
          sections: [
            {
              name: "Document",
              blocks: [
                { type: "paragraph", style: "title", text: "Review" },
                { type: "table", rows: [["<script>alert(1)</script>", "26"]] },
                {
                  type: "paragraph",
                  style: "paragraph",
                  text: "After the table",
                },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Review" })).toBeVisible();
    expect(
      screen.getByRole("cell", { name: "<script>alert(1)</script>" }),
    ).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    expect(
      screen
        .getByRole("table")
        .compareDocumentPosition(screen.getByText("After the table")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("retains cell positions and switches sheets without implying complete formatting", () => {
    render(
      <OfficePreview
        truncated
        office={{
          kind: "spreadsheet",
          sections: [
            {
              name: "Totals",
              blocks: [{ type: "table", rows: [[], ["", "", "26"]] }],
            },
            { name: "Notes", blocks: [{ type: "table", rows: [["Details"]] }] },
          ],
        }}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "C" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "26" })).toBeVisible();
    expect(screen.getByText(/Content preview/)).toBeVisible();
    expect(screen.getByText(/preview is truncated/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("cell", { name: "Details" })).toBeVisible();
    expect(screen.queryByRole("cell", { name: "26" })).toBeNull();
  });
});
