import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createOutputDocument } from "../../lib/output-revisions";
import { OutputEditor } from "./OutputEditor";

const runtime = vi.hoisted(() => ({
  append: vi.fn(),
  export: vi.fn(),
  restore: vi.fn(),
  pin: vi.fn(),
  get: vi.fn(),
}));
vi.mock("../../runtime/domains/outputs", () => ({
  appendRuntimeOutputRevision: runtime.append,
  exportRuntimeOutput: runtime.export,
  restoreRuntimeOutputRevision: runtime.restore,
  setRuntimeOutputPinned: runtime.pin,
  getRuntimeOutput: runtime.get,
}));

function output() {
  return createOutputDocument({
    id: "output-1",
    title: "Notes",
    format: "markdown",
    mimeType: "text/markdown",
    source: { conversationId: "thread-1", messageId: "message-1" },
    content: "first",
    now: "2026-10-08T10:00:00.000Z",
  });
}

describe("OutputEditor", () => {
  it("saves a user revision with exact optimistic base", async () => {
    const first = output();
    const second = {
      ...first,
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
      revisions: [
        ...first.revisions,
        {
          ...first.revisions[0],
          id: "revision-2",
          number: 2,
          baseNumber: 1,
          content: "second",
          author: "user" as const,
        },
      ],
    };
    runtime.append.mockResolvedValue(second);
    const onChange = vi.fn();
    render(
      <OutputEditor
        output={first}
        source={first.source}
        workspaceId="workspace"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Notes content" }), {
      target: { value: "second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(second));
    expect(runtime.append).toHaveBeenCalledWith(
      expect.objectContaining({
        outputId: "output-1",
        expectedRevisionId: first.currentRevisionId,
        expectedRevisionNumber: 1,
        content: "second",
        author: "user",
      }),
      "workspace",
    );
  });

  it("shows revision history and offers restore", () => {
    const first = output();
    const second = {
      ...first,
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
      revisions: [
        ...first.revisions,
        {
          ...first.revisions[0],
          id: "revision-2",
          number: 2,
          baseNumber: 1,
          content: "second",
          author: "user" as const,
        },
      ],
    };
    runtime.restore.mockResolvedValue(second);
    render(
      <OutputEditor
        output={second}
        source={second.source}
        workspaceId="workspace"
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/Revision history/));
    fireEvent.change(screen.getByLabelText("Compare or restore"), {
      target: { value: "1" },
    });
    expect(screen.getByText("Restore as new revision")).toBeVisible();
  });

  it("anchors an agent revision request to the selected text and exact base", () => {
    const first = output();
    const request = vi.fn();
    render(
      <OutputEditor
        output={first}
        source={first.source}
        workspaceId="workspace"
        onChange={() => {}}
        onRequestRevision={request}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Notes content" });
    fireEvent.select(editor, {
      target: { selectionStart: 0, selectionEnd: 5 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revise selection" }));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        outputId: first.id,
        expectedRevisionId: first.currentRevisionId,
        expectedRevisionNumber: first.currentRevisionNumber,
        selection: "first",
        source: first.source,
      }),
    );
  });

  it("preserves a dirty draft when an incoming revision reuses an id with changed content", async () => {
    const first = output();
    const { rerender } = render(
      <OutputEditor
        output={first}
        source={first.source}
        workspaceId="workspace"
        onChange={() => {}}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Notes content" });
    fireEvent.change(editor, { target: { value: "local draft" } });
    const incoming = {
      ...first,
      revisions: [{ ...first.revisions[0], content: "remote content" }],
    };
    rerender(
      <OutputEditor
        output={incoming}
        source={incoming.source}
        workspaceId="workspace"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Notes content" })).toHaveValue("local draft");
    expect(screen.getByRole("button", { name: "Reload latest revision" })).toBeVisible();
  });

  it("preserves a dirty draft when an older branch revision arrives", () => {
    const first = output();
    const second = {
      ...first,
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
      revisions: [
        ...first.revisions,
        { ...first.revisions[0], id: "revision-2", number: 2, baseNumber: 1, content: "remote" },
      ],
    };
    const { rerender } = render(
      <OutputEditor output={second} source={second.source} workspaceId="workspace" onChange={() => {}} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Notes content" }), { target: { value: "local" } });
    rerender(<OutputEditor output={first} source={first.source} workspaceId="workspace" onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Notes content" })).toHaveValue("local");
    expect(screen.getByRole("button", { name: "Reload latest revision" })).toBeVisible();
  });

  it("anchors a CSV cell revision request to its row and column", async () => {
    const csv = createOutputDocument({
      id: "csv-1",
      title: "Data",
      format: "csv",
      mimeType: "text/csv",
      source: { conversationId: "thread-1" },
      content: "Name,Formula\r\nTotal,=SUM(A1:A2)",
      now: "2026-10-08T10:00:00.000Z",
    });
    const request = vi.fn();
    render(<OutputEditor output={csv} source={csv.source} workspaceId="workspace" onChange={() => {}} onRequestRevision={request} />);
    fireEvent.focus(await screen.findByRole("textbox", { name: "Cell R2C2" }));
    fireEvent.click(screen.getByRole("button", { name: "Revise selection" }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ selection: "CSV cell R2C2: =SUM(A1:A2)", expectedRevisionNumber: 1 }));
  });

  it("pins the selected historical revision and keeps its identity", async () => {
    const first = output();
    const second = {
      ...first,
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
      revisions: [
        ...first.revisions,
        { ...first.revisions[0], id: "revision-2", number: 2, baseNumber: 1, content: "second" },
      ],
    };
    runtime.pin.mockResolvedValue({ ...second, pinned: true, pin: { revisionId: first.currentRevisionId, source: first.source } });
    render(<OutputEditor output={second} source={second.source} workspaceId="workspace" onChange={() => {}} />);
    fireEvent.click(screen.getByText(/Revision history/));
    fireEvent.change(screen.getByLabelText("Compare or restore"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin revision 1" }));
    await waitFor(() => expect(runtime.pin).toHaveBeenCalledWith("output-1", true, second.source, "workspace", first.currentRevisionId));
  });

  it("shows an older pinned revision while keeping the current revision editable", () => {
    const first = output();
    const current = {
      ...first,
      currentRevisionId: "revision-2",
      currentRevisionNumber: 2,
      revisions: [
        ...first.revisions,
        { ...first.revisions[0], id: "revision-2", number: 2, baseNumber: 1, content: "current" },
      ],
      pinned: true,
      pin: { revisionId: first.currentRevisionId, source: first.source },
    };
    render(<OutputEditor output={current} source={current.source} workspaceId="workspace" onChange={() => {}} />);
    expect(screen.getByRole("region", { name: "Pinned revision 1" })).toHaveTextContent("first");
    expect(screen.getByRole("textbox", { name: "Notes content" })).toHaveValue("current");
    expect(screen.getByText(/editing current revision 2/)).toBeVisible();
  });

  it("reloads the authoritative output before discarding a conflicted draft", async () => {
    const first = output();
    const incoming = { ...first, revisions: [{ ...first.revisions[0], content: "remote" }] };
    const onChange = vi.fn();
    runtime.get.mockResolvedValue(incoming);
    const { rerender } = render(<OutputEditor output={first} source={first.source} workspaceId="workspace" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Notes content" }), { target: { value: "local" } });
    rerender(<OutputEditor output={incoming} source={incoming.source} workspaceId="workspace" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest revision" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Notes content" })).toHaveValue("remote"));
    expect(runtime.get).toHaveBeenCalledWith("output-1", "workspace");
    expect(onChange).toHaveBeenCalledWith(incoming);
  });

  it("reports the native export destination and prevents duplicate dialogs", async () => {
    let resolveExport!: (destination: string) => void;
    runtime.export.mockImplementation(
      () => new Promise<string>((resolve) => {
        resolveExport = resolve;
      }),
    );
    const first = output();
    render(
      <OutputEditor
        output={first}
        source={first.source}
        workspaceId="workspace"
        onChange={() => {}}
      />,
    );
    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);
    expect(runtime.export).toHaveBeenCalledTimes(1);
    expect(exportButton).toBeDisabled();
    resolveExport("C:\\Exports\\Notes.md");
    await waitFor(() =>
      expect(screen.getByText("Exported to C:\\Exports\\Notes.md")).toBeVisible(),
    );
    expect(screen.getByText("Exported")).toBeVisible();
  });

  it("keeps structured output formats explicitly read-only outside the native artifact editor", () => {
    const spreadsheet = createOutputDocument({
      id: "sheet-1",
      title: "Budget",
      format: "spreadsheet",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      source: { conversationId: "thread-1", artifactId: "artifact-1", agentId: "agent-1" },
      content: "native workbook preview",
      now: "2026-10-08T10:00:00.000Z",
    });
    render(
      <OutputEditor
        output={spreadsheet}
        source={spreadsheet.source}
        workspaceId="workspace"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/keeps its native structure and formulas/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Budget content" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Save revision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request agent revision" })).toBeDisabled();
  });
});
