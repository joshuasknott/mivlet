import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Only packaged renderer assets can be fetched. Document URLs never reach fetch.
const fonts = import.meta.glob<string>("/node_modules/pdfjs-dist/standard_fonts/*.{ttf,pfb}", { query: "?url", import: "default", eager: true });
const cmaps = import.meta.glob<string>("/node_modules/pdfjs-dist/cmaps/*.bcmap", { query: "?url", import: "default", eager: true });
class PackagedPdfData {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const table = kind === "standardFontDataUrl" ? fonts : kind === "cMapUrl" ? cmaps : null;
    const directory = kind === "standardFontDataUrl" ? "standard_fonts" : "cmaps";
    const url = table?.[`/node_modules/pdfjs-dist/${directory}/${filename}`];
    if (!url) throw new Error("This PDF needs an unavailable packaged renderer asset.");
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error("The packaged PDF renderer asset could not be loaded.");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function openPdfPreview(base64: string): Promise<PDFDocumentLoadingTask> {
  if (!base64 || base64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("Choose a PDF up to 8 MB for page preview.");
  }
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (bytes.length > 8 * 1024 * 1024 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("The preview did not contain PDF bytes.");
  }
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdf.getDocument({
    data: bytes, BinaryDataFactory: PackagedPdfData, useWorkerFetch: false,
    enableXfa: false, disableFontFace: true, useSystemFonts: false, useWasm: false,
    disableAutoFetch: true, disableStream: true, disableRange: true, stopAtErrors: true,
    maxImageSize: 8_000_000, canvasMaxAreaInBytes: 32_000_000,
  });
}
