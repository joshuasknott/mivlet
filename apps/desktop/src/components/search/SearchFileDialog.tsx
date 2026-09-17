import { useEffect, useRef, useState } from "react";
import { useModalFocusTrap } from "../../hooks/useModalFocusTrap";
import { previewRuntimeLocalComputerFile } from "../../runtime/domains/local-computer";
import type { SearchNavigationTarget } from "../../lib/search/navigation";

export function SearchFileDialog({ target, title, text, imageDataUrl, onClose, embedded = false }: {
  target?: Extract<SearchNavigationTarget, { type: "artifact" | "knowledge-file" }>;
  title: string;
  text?: string;
  imageDataUrl?: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState(text ?? "Loading preview…");
  useModalFocusTrap({ active: !embedded, containerRef: panel, onClose });
  useEffect(() => {
    setContent(text ?? "Loading preview…");
    if (target?.type !== "artifact") return;
    let current = true;
    void previewRuntimeLocalComputerFile({ workspaceId: target.workspaceId, agentId: target.agentId, path: target.relativePath })
      .then(preview => { if (current) setContent(preview ? preview.content + (preview.truncated ? "\n[Preview truncated]" : "") : "Preview requires the desktop app."); })
      .catch(error => { if (current) setContent(error instanceof Error ? error.message : "This file is unavailable."); });
    return () => { current = false; };
  }, [target, text]);
  if (embedded) return <div className="right-panel__library" ref={panel} aria-label={`${title} preview`}><h2 style={{ fontSize: 14, fontWeight: 500 }}>{title}</h2><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{content}</pre></div>;
  return <div className="side-chat-dialog-backdrop"><div ref={panel} className="side-chat-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button onClick={onClose} aria-label="Close file preview">×</button></header>
    {imageDataUrl && /^data:image\/(png|jpeg|gif|webp);base64,/.test(imageDataUrl) ? <img src={imageDataUrl} alt={title} style={{ display: "block", maxWidth: "100%", maxHeight: "75vh", objectFit: "contain", margin: "auto" }} /> : <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "65vh", overflow: "auto" }}>{content}</pre>}
  </div></div>;
}
