import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const open = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pdf-preview", () => ({ openPdfPreview: open }));
import { PdfPreview } from "./PdfPreview";

function documentFixture() {
  const cancel = vi.fn();
  const page = { getViewport:({scale}:{scale:number}) => ({width:595*scale,height:842*scale}), render:vi.fn(() => ({promise:Promise.resolve(),cancel})), getTextContent:vi.fn(() => Promise.resolve({items:[{str:"Readable page 731"}]})) };
  const document = {numPages:2, getPage:vi.fn(() => Promise.resolve(page))};
  const destroy = vi.fn(() => Promise.resolve());
  return {document,page,cancel,destroy,task:{promise:Promise.resolve(document),destroy}};
}
beforeEach(() => { vi.clearAllMocks(); });
it("renders and navigates pages with readable text and cancels on close", async () => {
  const fixture = documentFixture(); open.mockResolvedValue(fixture.task);
  const view = render(<PdfPreview base64="owned" title="Report" />);
  await screen.findByText("Readable page 731");
  expect(fixture.document.getPage).toHaveBeenCalledWith(1);
  fireEvent.change(screen.getByRole("combobox", {name:"PDF zoom"}), {target:{value:"1"}});
  await waitFor(() => expect(fixture.page.render).toHaveBeenLastCalledWith(expect.objectContaining({viewport:{width:595,height:842}})));
  expect(screen.getByRole("button",{name:"Previous PDF page"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Next PDF page"}));
  await waitFor(() => expect(fixture.document.getPage).toHaveBeenCalledWith(2));
  await screen.findByText("Page 2 of 2");
  expect(screen.getByRole("button",{name:"Next PDF page"})).toBeDisabled();
  view.unmount();
  expect(fixture.destroy).toHaveBeenCalledOnce();
  expect(fixture.cancel).toHaveBeenCalled();
});
it("destroys a late file load without rendering it after the viewer closes", async () => {
  const fixture = documentFixture(); let resolve!: (task:typeof fixture.task) => void;
  open.mockReturnValue(new Promise(value => { resolve=value; }));
  const view = render(<PdfPreview base64="late" title="Old file" />);
  view.unmount();
  await act(async () => { resolve(fixture.task); });
  expect(fixture.destroy).toHaveBeenCalledOnce();
  expect(fixture.document.getPage).not.toHaveBeenCalled();
});
it("shows a recoverable error for an unsupported PDF", async () => {
  open.mockRejectedValue(new Error("malformed bytes"));
  render(<PdfPreview base64="invalid" title="Bad file" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Open the saved file");
  expect(screen.getByRole("button",{name:"Next PDF page"})).toBeDisabled();
});
