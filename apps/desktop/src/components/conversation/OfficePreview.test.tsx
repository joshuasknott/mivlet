import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OfficePreview } from "./OfficePreview";

const office = {
  kind: "spreadsheet" as const,
  sections: [
    {
      name: "Budget",
      sourceEntry: "xl/worksheets/sheet7.xml",
      blocks: [
        {
          type: "table" as const,
          rows: [
            ["Item", "Cost"],
            ["Rent", "900"],
          ],
        },
      ],
    },
  ],
};

describe("OfficePreview", () => {
  it("lets a user target a spreadsheet cell before requesting an agent change", () => {
    const request = vi.fn();
    render(
      <OfficePreview
        office={office}
        truncated={false}
        onRequestRevision={request}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /select budget row 2 column 2/i }),
    );
    expect(screen.getByText(/Selected cell B2: 900/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Request agent change" }),
    );
    expect(request).toHaveBeenCalledWith({
      section: "Budget",
      sourceEntry: "xl/worksheets/sheet7.xml",
      sectionIndex: 0,
      row: 1,
      column: 1,
      value: "900",
    });
  });

  it("exposes exact contextual actions for a selected spreadsheet cell", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview
        office={office}
        truncated={false}
        onSelectionAction={action}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /select budget row 2 column 2/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Quote / ask" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith(
      {
        section: "Budget",
        sourceEntry: "xl/worksheets/sheet7.xml",
        sectionIndex: 0,
        row: 1,
        column: 1,
        value: "900",
      },
      "quote",
    ));
    expect(screen.getByRole("button", { name: "Save to memory" })).toBeEnabled();
  });

  it("saves an existing spreadsheet cell through the direct edit boundary", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview office={office} truncated={false} onEditCell={edit} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /select budget row 2 column 2/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit cell" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement cell value" }), {
      target: { value: "950" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edited copy" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(
      { section: "Budget", sourceEntry: "xl/worksheets/sheet7.xml", row: 1, column: 1, value: "900" },
      "950",
    ));
  });

  it("allows clearing a selected spreadsheet string or cell value", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview office={office} truncated={false} onEditCell={edit} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /select budget row 2 column 2/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit cell" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement cell value" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edited copy" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(
      { section: "Budget", sourceEntry: "xl/worksheets/sheet7.xml", row: 1, column: 1, value: "900" },
      "",
    ));
  });

  it("exposes bounded paragraph editing for DOCX previews", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview
        office={{
          kind: "document",
          sections: [{ name: "Document", sourceEntry: "word/document.xml", blocks: [{ type: "paragraph", style: "paragraph", text: "Old" }] }],
        }}
        truncated={false}
        onEditParagraph={edit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit paragraph" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement paragraph text" }), {
      target: { value: "New" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edited copy" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(
      { section: "Document", sectionIndex: 0, sourceEntry: "word/document.xml", paragraph: 0, value: "Old" },
      "New",
    ));
  });

  it("exposes contextual actions for a selected paragraph", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview
        office={{
          kind: "document",
          sections: [{ name: "Document", sourceEntry: "word/document.xml", blocks: [{ type: "paragraph", style: "paragraph", text: "Old" }] }],
        }}
        truncated={false}
        onEditParagraph={vi.fn().mockResolvedValue(undefined)}
        onSelectionAction={action}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit paragraph" }));
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith(
      {
        section: "Document",
        sectionIndex: 0,
        sourceEntry: "word/document.xml",
        paragraph: 0,
        value: "Old",
      },
      "explain",
    ));
  });

  it("allows clearing a selected paragraph", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    render(
      <OfficePreview
        office={{
          kind: "document",
          sections: [{ name: "Document", sourceEntry: "word/document.xml", blocks: [{ type: "paragraph", style: "paragraph", text: "Old" }] }],
        }}
        truncated={false}
        onEditParagraph={edit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit paragraph" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Replacement paragraph text" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edited copy" }));
    await waitFor(() => expect(edit).toHaveBeenCalledWith(
      { section: "Document", sectionIndex: 0, sourceEntry: "word/document.xml", paragraph: 0, value: "Old" },
      "",
    ));
  });

  it("does not expose direct cell editing when the native source entry is absent", () => {
    render(
      <OfficePreview
        office={{
          kind: "spreadsheet",
          sections: [{ name: "Budget", blocks: [{ type: "table", rows: [["900"]] }] }],
        }}
        truncated={false}
        onEditCell={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /select budget row 1 column 1/i }));
    expect(screen.queryByRole("button", { name: "Edit cell" })).not.toBeInTheDocument();
  });
});
