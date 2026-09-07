import { useEffect, useRef, useState } from "react";
import type { LocalComputerArtifactPreview } from "@fable/protocol";
import { parseComputerArtifact, previewComputerArtifact } from "../../lib/computer-artifacts";
import { ComputerArtifacts } from "../ComputerArtifacts";
import { MessageMarkdown } from "./MessageMarkdown";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";

export function ArtifactPreview({ output, workspaceId, agentId, generation, onClose }: {
  output: string; workspaceId: string; agentId: string; generation?: number; onClose: () => void;
}) {
  const artifact = parseComputerArtifact(output);
  const [preview, setPreview] = useState<LocalComputerArtifactPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useModalFocusTrap({ active: narrow, containerRef: panel, initialFocusRef: close, onClose });
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError(""); setLoading(true);
    if (!artifact || generation === undefined) { setLoading(false); setError("Open the computer to preview this file."); return; }
    void previewComputerArtifact({ workspaceId, agentId, artifactId: artifact.id, expectedGeneration: generation })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not preview this file."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifact?.id, workspaceId, agentId, generation]);
  if (!artifact) return null;
  return <aside ref={panel} className="artifact-preview" role={narrow ? "dialog" : "complementary"}
    aria-modal={narrow || undefined} aria-label={`${artifact.title} preview`} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <header><div><h2>{artifact.title}</h2></div><button type="button" ref={close} onClick={onClose} aria-label="Close file preview">×</button></header>
    <div className="artifact-preview__body">
      {loading ? <p role="status">Loading your file…</p> : error ? <p role="alert">{error}</p> : preview?.text !== null && preview?.text !== undefined ? <>
        {artifact.mimeType === "text/markdown" ? <MessageMarkdown content={preview.text} /> : <pre tabIndex={0}>{preview.text || "This file is empty."}</pre>}
        {preview.truncated ? <p className="turn-notice">Showing the first 256 KB. Open the file to see the rest.</p> : null}
      </> : preview?.imageDataUrl ? <img src={preview.imageDataUrl} alt={artifact.title} /> : <div className="artifact-preview__unsupported"><p>This file is ready to open.</p><p>Open it in your document or image app to view its contents.</p></div>}
    </div>
    <footer><ComputerArtifacts compact output={output} workspaceId={workspaceId} agentId={agentId} expectedGeneration={generation} /></footer>
  </aside>;
}
