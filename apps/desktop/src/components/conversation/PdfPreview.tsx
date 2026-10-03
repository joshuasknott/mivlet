import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { openPdfPreview } from "../../lib/pdf-preview";
import "./pdf-preview.css";

export function PdfPreview({ base64, title }: { base64: string; title: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(640);
  const [zoom, setZoom] = useState("fit");
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let current = true;
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(null); setPage(1); setLoading(true); setError(""); setText("");
    void openPdfPreview(base64).then(async opened => {
      task = opened;
      if (!current) { await task.destroy(); return; }
      const loaded = await task.promise;
      if (current) {
        if (loaded.numPages < 1 || loaded.numPages > 10_000) throw new Error("Invalid page count");
        setDocument(loaded);
      }
    }).catch(() => { if (current) setError("This PDF could not be previewed. Open the saved file in your PDF app."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; void task?.destroy().catch(() => undefined); };
  }, [base64]);
  useEffect(() => {
    const container = frame.current;
    if (!container) return;
    const resize = () => setWidth(Math.max(1, container.clientWidth || 640));
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let current = true;
    let render: RenderTask | undefined;
    setRendering(true); setError(""); setText("");
    const surface = canvas.current;
    surface.width = 1; surface.height = 1;
    void document.getPage(page).then(async source => {
      if (!current) return;
      const natural = source.getViewport({ scale: 1 });
      const viewScale = zoom === "fit" ? Math.min(1.5, width / natural.width) : Number(zoom);
      const scale = Math.min(2, window.devicePixelRatio || 1) * viewScale;
      const viewport = source.getViewport({ scale });
      if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0 || viewport.width * viewport.height > 8_000_000) {
        throw new Error("PDF page exceeds the rendering limit");
      }
      surface.width = Math.ceil(viewport.width); surface.height = Math.ceil(viewport.height);
      surface.style.width = `${natural.width * viewScale}px`;
      render = source.render({ canvas: surface, viewport });
      await render.promise;
      const content = await source.getTextContent();
      if (current) setText(content.items.map(item => "str" in item ? item.str : "").join(" ").slice(0, 32_768));
    }).catch(() => { if (current) setError("This page could not be rendered. Open the saved PDF to inspect it."); })
      .finally(() => { if (current) setRendering(false); });
    return () => { current = false; render?.cancel(); };
  }, [document, page, width, zoom]);
  return <section className="pdf-preview" aria-label={`${title} pages`}>
    <nav aria-label="PDF pages">
      <button type="button" disabled={!document || page <= 1} onClick={() => setPage(value => value - 1)} aria-label="Previous PDF page">Previous</button>
      <span aria-live="polite">{document ? `Page ${page} of ${document.numPages}` : "PDF preview"}</span>
      <button type="button" disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)} aria-label="Next PDF page">Next</button>
      <select aria-label="PDF zoom" value={zoom} onChange={event => setZoom(["fit", "1", "1.5", "2"].includes(event.target.value) ? event.target.value : "fit")}><option value="fit">Fit width</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select>
    </nav>
    {(loading || rendering) && <p role="status">Loading page…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="pdf-preview__page" ref={frame} tabIndex={0} role="region" aria-label="PDF page scroll area"><canvas ref={canvas} role="img" aria-label={`Page ${page} of ${title}`} hidden={!document || Boolean(error)} /></div>
    {document && !rendering && !error && <details key={page}><summary>Page text</summary><pre>{text || "No readable text was detected. This page may contain images."}</pre><p>Text may omit images or use a different reading order. No OCR runs; text is limited to 32 KB per page.</p></details>}
  </section>;
}
