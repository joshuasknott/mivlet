import { beforeEach, expect, it, vi } from "vitest";
const getDocument = vi.hoisted(() => vi.fn((_options: Record<string, unknown>) => ({ promise: Promise.resolve({}), destroy: vi.fn() })));
vi.mock("pdfjs-dist", () => ({ getDocument, GlobalWorkerOptions: {} }));
import { openPdfPreview } from "./pdf-preview";

beforeEach(() => { vi.clearAllMocks(); });
it("passes native bytes instead of a URL and restricts assets and active features", async () => {
  const bytes = btoa("%PDF-1.7\nowned native bytes");
  await openPdfPreview(bytes);
  const options = getDocument.mock.calls[0][0] as unknown as { data: Uint8Array; BinaryDataFactory: new () => { fetch(input: {kind:string; filename:string}):Promise<Uint8Array> } };
  expect(new TextDecoder().decode(options.data)).toBe(atob(bytes));
  expect(options).not.toHaveProperty("url");
  expect(options).toMatchObject({ enableXfa:false, useWorkerFetch:false, useWasm:false, disableFontFace:true, disableAutoFetch:true, disableStream:true, maxImageSize:8_000_000 });
  const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal("fetch", fetcher);
  const factory = new options.BinaryDataFactory();
  try {
    await expect(factory.fetch({kind:"standardFontDataUrl",filename:"LiberationSans-Regular.ttf"})).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher.mock.calls[0][0]).toContain("LiberationSans-Regular.ttf");
    expect(fetcher.mock.calls[0][1]).toEqual({ credentials:"omit" });
    for (const input of [
      {kind:"standardFontDataUrl",filename:"../../secret"},
      {kind:"cMapUrl",filename:"https://example.test/private"},
      {kind:"url",filename:"LiberationSans-Regular.ttf"},
    ]) await expect(factory.fetch(input)).rejects.toThrow("unavailable packaged");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
it("rejects external URLs, malformed and oversized payloads before loading the renderer", async () => {
  for (const input of ["https://example.test/report.pdf", "", btoa("not PDF"), "A".repeat(Math.ceil(8*1024*1024/3)*4+1)]) {
    await expect(openPdfPreview(input)).rejects.toThrow();
  }
  expect(getDocument).not.toHaveBeenCalled();
});
