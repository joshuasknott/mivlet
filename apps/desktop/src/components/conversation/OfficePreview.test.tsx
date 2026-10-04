import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfficePreview } from "./OfficePreview";

describe("Office content previews", () => {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  it("renders native thumbnails and literal alt text in slide order", () => {
    const { container } = render(
      <OfficePreview
        truncated={false}
        office={{
          kind: "presentation",
          sections: [
            {
              name: "Slide 1",
              blocks: [
                { type: "paragraph", text: "Results", style: "title" },
                {
                  type: "image",
                  dataUrl: pixel,
                  alt: "<script>Chart</script>",
                  width: 1,
                  height: 1,
                },
                { type: "paragraph", text: "After image", style: "paragraph" },
              ],
            },
            {
              name: "Slide 2",
              blocks: [{ type: "paragraph", text: "Next", style: "title" }],
            },
          ],
        }}
      />,
    );
    const image = screen.getByRole("img", { name: "<script>Chart</script>" });
    expect(image).toHaveAttribute("src", pixel);
    expect(
      image.compareDocumentPosition(screen.getByText("After image")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Slide 2" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("heading", { name: "Next" })).toBeVisible();
  });

  it.each([
    ["https://example.test/image.png", 32, 32],
    ["data:image/svg+xml;base64,PHN2Zy8+", 32, 32],
    [pixel, 4096, 32],
    [pixel, NaN, 32],
    ["data:image/png;base64," + "a".repeat(1_500_000), 32, 32],
  ])(
    "refuses external, active or out-of-bounds image projections",
    (dataUrl, width, height) => {
      render(
        <OfficePreview
          truncated={false}
          office={{
            kind: "presentation",
            sections: [
              {
                name: "Slide 1",
                blocks: [
                  {
                    type: "image",
                    dataUrl: String(dataUrl),
                    alt: "Unsupported",
                    width: Number(width),
                    height: Number(height),
                  },
                ],
              },
            ],
          }}
        />,
      );
      expect(screen.queryByRole("img")).toBeNull();
      expect(
        screen.getByText("Open the file to view this image."),
      ).toBeVisible();
    },
  );
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
